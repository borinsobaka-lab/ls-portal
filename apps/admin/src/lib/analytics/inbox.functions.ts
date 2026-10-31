import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { mskToday } from "./core";
import {
  STATS_TEXT,
  inboxStatsScope,
  inboxStatsView,
  summarizeLeadStatistics,
  summarizeResponseStatistics,
  type LeadRow,
  type ManagerStatRow,
  type PhoneRow,
  type ReplyRow,
  type StatsContext,
  type WorkRow,
} from "./inbox/stats";
import {
  INBOX_MAX_IMAGE_BYTES,
  INBOX_SEND_TEXT,
  INBOX_TEXT,
  InboxError,
  inboxDisplayName,
  inboxSecretValid,
} from "./inbox/rules";
import { kickAnalyticsJob } from "./server/jobs.server";
import { encryptSecret } from "./server/secrets.server";
import { must } from "./server/vk-ads.server";
import {
  inboxNewSecret,
  inboxSecretHash,
  inboxSendReply,
  resolveVkCommunity,
} from "./server/vk-inbox.server";

/**
 * «Диалоги VK» → «Подключения»: действия, которым нужен сервер. Токен
 * сообщества шифрует сервер (ANALYTICS_SECRETS_KEY), секрет Callback он же
 * придумывает и хранит только SHA-256; RPC an_inbox_* вызываются от имени
 * вызывающего и сами проверяют администратора аналитики, тексты и журнал.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

/** Их POST /admin/vk-inbox/communities: группа, затем URL и секрет — один раз. */
export const registerInboxCommunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        brand: z.string().max(100),
        city: z.string().max(1000),
        displayName: z.string().max(1000),
        vkCommunity: z.string().max(500),
        confirmationCode: z.string().max(500),
        token: z.string().max(2000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const token = data.token.trim();
    const code = data.confirmationCode.trim();
    const city = data.city.trim();
    let name = data.displayName.trim();
    if (!name || !city || !token || !code) throw new Error(INBOX_TEXT.requiredFields);
    let vk: { id: number; name: string };
    try {
      vk = await resolveVkCommunity(data.vkCommunity, token);
    } catch (e) {
      throw new Error(e instanceof InboxError ? e.message : INBOX_TEXT.resolveNetwork);
    }
    name = inboxDisplayName(name, vk.name);
    const secret = inboxNewSecret();
    const { data: id, error } = await context.supabase.rpc("an_inbox_community_register", {
      p_vk_community_id: vk.id,
      p_display_name: name,
      p_brand: data.brand.trim(),
      p_city: city,
      p_confirmation_code: code,
      p_secret_hash: inboxSecretHash(secret),
      p_token_cipher: encryptSecret(token),
    });
    if (error) throw new Error(error.message);
    return {
      id: Number(id),
      secret,
      displayName: name,
      message: `Подключение «${name}» создано. Настройте Callback API в VK.`,
    };
  });

/** Их «Синхр.»: текущий секрет Callback из VK — в базу только его SHA-256. */
export const syncInboxSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), secret: z.string().max(2000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    if (!inboxSecretValid(data.secret)) throw new Error(INBOX_TEXT.secretLength);
    const { error } = await context.supabase.rpc("an_inbox_secret_save", {
      p_id: data.id,
      p_secret_hash: inboxSecretHash(data.secret.trim()),
    });
    if (error) throw new Error(error.message);
    return { message: "Секрет Callback API синхронизирован. Отправьте новое тестовое сообщение." };
  });

/**
 * Их /admin/vk-inbox/dialogs/<id>/send: текст и до 4 картинок (FormData:
 * dialog, body, images). Ошибка VK — их текстом; сбой после отправки — «Не
 * удалось подтвердить отправку…» (сообщение могло уйти).
 */
export const sendInboxReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => {
    if (!(data instanceof FormData)) throw new Error("Неизвестный формат формы.");
    return data;
  })
  .handler(async ({ context, data }) => {
    const dialog = Number(data.get("dialog"));
    if (!Number.isSafeInteger(dialog) || dialog <= 0) throw new Error("Диалог не найден.");
    const body = data.get("body");
    const text = typeof body === "string" ? body : "";
    if (Buffer.byteLength(text, "utf8") > 20_000) throw new Error(INBOX_SEND_TEXT.fieldTooLong);
    const files = data.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.reduce((s, f) => s + f.size, 0) > INBOX_MAX_IMAGE_BYTES + 80_000)
      throw new Error(INBOX_SEND_TEXT.formTooLarge);
    const images = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        data: new Uint8Array(await f.arrayBuffer()),
        mime: f.type,
      })),
    );
    try {
      await inboxSendReply(context.supabase, context.userId, dialog, text, images);
    } catch (e) {
      if (e instanceof InboxError) throw new Error(e.message);
      console.error("[inbox] ответ не подтверждён:", (e as Error).name);
      throw new Error(INBOX_SEND_TEXT.unconfirmed);
    }
    return { ok: true, message: "Сообщение отправлено в VK." };
  });

let lastProfilesKick = 0;

/**
 * Их refresh_inbox_profiles_in_background при открытии диалогов: имена и
 * аватарки новых клиентов сразу, не дожидаясь расписания (не чаще раза в 2
 * минуты на сервер).
 */
export const kickInboxProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("an_me");
    if (!(data as { inbox?: boolean } | null)?.inbox) return { ok: false };
    if (Date.now() - lastProfilesKick < 120_000) return { ok: true };
    lastProfilesKick = Date.now();
    void kickAnalyticsJob("inbox_profiles");
    return { ok: true };
  });

/**
 * Их /admin/vk-inbox/statistics: фильтры (период до 366 дней, менеджеры,
 * группы), затем их manager_statistics, lead_statistics и
 * response_statistics по выборке. Строки (в том числе тексты с номерами)
 * сервер читает сервисным ключом и отдаёт только итоги.
 */
export const loadInboxStatistics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        from: z.string().max(20).optional(),
        to: z.string().max(20).optional(),
        managers: z.array(z.string().max(60)).max(500),
        groups: z.array(z.string().max(30)).max(500),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { data: ctx, error } = await context.supabase.rpc("an_inbox_stats_context");
    if (error) throw new Error(error.message);
    const c = ctx as StatsContext;
    const scope = inboxStatsScope(c, data, mskToday());
    if (scope.error) return inboxStatsView(c, scope, [], null, null, scope.error);
    const groups = [...scope.scopeGroups];
    const managers = scope.managerIds ? [...scope.managerIds] : null;
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    try {
      const admin = getSupabaseAdmin();
      const [stat, replies, leads] = await Promise.all([
        must(
          admin.rpc("an_inbox_stat_managers", {
            p_start: iso(scope.start),
            p_end: iso(scope.end),
            p_groups: groups,
          }),
        ),
        must(
          admin.rpc("an_inbox_stat_reply_rows", {
            p_start: iso(scope.start),
            p_end: iso(scope.end),
            p_managers: managers,
            p_groups: groups,
          }),
        ),
        must(
          admin.rpc("an_inbox_stat_lead_rows", {
            p_start: iso(scope.start),
            p_end: iso(scope.end),
            p_groups: groups,
          }),
        ),
      ]);
      const l = leads as { work: WorkRow[]; leads: LeadRow[]; phones: PhoneRow[] };
      const num = <T extends Record<string, unknown>>(rows: T[], keys: (keyof T)[]) =>
        rows.map((r) => {
          const o = { ...r };
          for (const k of keys)
            if (o[k] !== null && o[k] !== undefined) (o[k] as unknown) = Number(o[k]);
          return o;
        });
      const funnel = summarizeLeadStatistics(
        num(l.leads, ["dialog_id", "lead_at", "incoming_at", "community_id", "reply_at"]),
        num(l.phones, ["id", "dialog_id", "sent_at"]),
        l.work,
        scope.start,
        scope.end,
        null,
        new Set(groups),
      );
      const speed = summarizeResponseStatistics(
        (replies as ReplyRow[]).map((r) => [Number(r[0]), Number(r[1]), r[2], r[3], Number(r[4])]),
        scope.start,
        scope.end,
        scope.managerIds,
        new Set(groups),
      );
      const rows = (stat as ManagerStatRow[]).map((r) => ({
        ...r,
        replies: Number(r.replies),
        dialogs: Number(r.dialogs),
        first_responses: Number(r.first_responses),
        median_seconds: r.median_seconds === null ? null : Number(r.median_seconds),
        p90_seconds: r.p90_seconds === null ? null : Number(r.p90_seconds),
      }));
      return inboxStatsView(c, scope, rows, funnel, speed, null);
    } catch (e) {
      console.error("[inbox] статистика:", (e as Error).message.slice(0, 200));
      return inboxStatsView(c, scope, [], null, null, STATS_TEXT.failed);
    }
  });
