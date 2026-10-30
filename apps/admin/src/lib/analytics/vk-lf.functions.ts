import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DRIVE_CLIENT_SECRET,
  DRIVE_TOKEN_SECRET,
  driveAuthorizationUrl,
  driveExchangeCode,
  parseDriveClient,
} from "./server/google-drive.server";
import { ANALYTICS_JOBS, isJobEnabled, runJob } from "./server/jobs.server";
import { saveSecret } from "./server/secrets.server";
import {
  auditLfDates,
  collectLfAccount,
  createLfSheets,
  verifyLfSheets,
} from "./server/vk-lf.server";
import { lfFolderId } from "./vk/lf";

/**
 * VK Ads, «Сбор лид-форм» и кнопки их «VK Ads Panel»: подключение Google
 * Drive (OAuth-клиент, вход владельца таблиц), создание таблиц кабинетов,
 * проверки и ручной сбор. Только администратору аналитики (an_me от имени
 * вызывающего); журнал — их события.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

async function audit(userId: string, event: string, details = "") {
  await getSupabaseAdmin().rpc("an_audit_add", {
    _user_id: userId,
    _event: event,
    _details: details,
  });
}

async function settings(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("an_google_settings")
    .upsert({ id: true, ...patch }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

/** Их «Установить подключение Google Drive»: JSON OAuth-клиента из Google Cloud. */
export const saveDriveClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ json: z.string().max(20_000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    parseDriveClient(data.json);
    await saveSecret(DRIVE_CLIENT_SECRET, data.json, context.userId);
    await settings({ drive_client_updated_at: new Date().toISOString() });
    await audit(context.userId, "google_drive_client_saved");
    return { ok: true };
  });

/** Их google/connect: ссылка входа Google (state — на 10 минут, только этому человеку). */
export const startDriveConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    const state = randomBytes(32).toString("base64url");
    const admin = getSupabaseAdmin();
    await admin.from("an_google_oauth_states").delete().lte("expires_at", new Date().toISOString());
    const { error } = await admin.from("an_google_oauth_states").insert({
      state_hash: stateHash(state),
      user_id: context.userId,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (error) throw new Error(error.message);
    return { url: await driveAuthorizationUrl(state) };
  });

/** Их google/callback: код входа → постоянный доступ Drive (зашифрованно). */
export const finishDriveConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ code: z.string().max(4000), state: z.string().max(200) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    if (!data.state || !data.code) throw new Error("Google Drive не подтвердил подключение.");
    const admin = getSupabaseAdmin();
    const hash = stateHash(data.state);
    const { data: row } = await admin
      .from("an_google_oauth_states")
      .select("user_id")
      .eq("state_hash", hash)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    await admin.from("an_google_oauth_states").delete().eq("state_hash", hash);
    await admin.from("an_google_oauth_states").delete().lte("expires_at", new Date().toISOString());
    if (!row || (row as { user_id: string }).user_id !== context.userId) {
      throw new Error("Ссылка Google Drive устарела. Нажмите подключение ещё раз.");
    }
    const token = await driveExchangeCode(data.code);
    await saveSecret(DRIVE_TOKEN_SECRET, token, context.userId);
    await settings({ drive_updated_at: new Date().toISOString() });
    await audit(context.userId, "google_drive_connected");
    return { message: "Google Drive подключён." };
  });

/** Их lead-forms/create: таблицы для всех активных кабинетов без таблицы. */
export const createLeadFormSheets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ folderUrl: z.string().max(2000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const folderId = lfFolderId(data.folderUrl);
    const created = await createLfSheets(folderId);
    await audit(context.userId, "lead_form_sheets_created", String(created.length));
    return {
      message:
        `Новых таблиц создано: ${created.length}` +
        (created.length ? `. ${created.slice(0, 5).join(", ")}` : ". Все кабинеты уже подключены."),
    };
  });

/** Панель: «Проверить сбор новых ЛФ» — обычный сбор одного кабинета. */
export const collectLeadFormsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({ accountId: z.number().int().positive() }).strict().parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    return collectLfAccount(data.accountId);
  });

/** Панель: «Проверить Google Таблицу» — доступ к таблицам кабинетов без записи. */
export const verifyLeadFormSheets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    return verifyLfSheets();
  });

/** Панель: «Проверить даты ЛФ для расчёта» — поля дат VK по городу, без данных людей. */
export const auditLeadFormDates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ city: z.string().max(200) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    return auditLfDates(data.city);
  });

/** Панель: «Заполнить заявки ЛФ за текущий месяц» — задача счётчиков сейчас. */
export const backfillLeadFormMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    const job = ANALYTICS_JOBS.find((j) => j.key === "vk_lf_metrics");
    if (!job || !(await isJobEnabled(job.key))) {
      throw new Error(
        "Задача «заявки лид-форм за текущий месяц» выключена — включите её на «Фоновых задачах».",
      );
    }
    void runJob(job);
    return {
      message: "Заполнение заявок ЛФ за текущий месяц запущено. Итог — на «Фоновых задачах».",
    };
  });
