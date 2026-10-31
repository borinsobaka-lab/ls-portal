import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { casefold } from "./onec/rules";
import { fbRevenueToday } from "./fitbase/reports";
import {
  FB_BRANDS,
  FbError,
  fbAttendanceWindow,
  fbConnectionInput,
  fbRevenuePeriod,
} from "./fitbase/rules";
import { fbStartAll, fbStartJob, removeFbBlobs, type FbAction } from "./server/fitbase.server";
import { fbTrialLoadCatalog, fbTrialRecompute } from "./server/fitbase-trials.server";
import {
  fbWebAcceptSession,
  fbWebForgetSession,
  fbWebIssueToken,
  fbWebNetworkOrigin,
} from "./server/fitbase-web.server";
import { FbWebError } from "./fitbase/web";
import { encryptSecret } from "./server/secrets.server";

/**
 * FitBase: действия «Интеграции FitBase», которым нужен сервер — ключ API
 * шифрует сервер (ANALYTICS_SECRETS_KEY) и отдаёт базе шифртекстом от имени
 * вызывающего (RPC an_fb_* сами проверяют администратора аналитики и пишут
 * журнал), загрузки студий и общая очередь идут на сервере в фоне. Правила
 * статусов записей — RPC из браузера. Только администратору аналитики.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

async function audit(userId: string, event: string, details: string) {
  await getSupabaseAdmin().rpc("an_audit_add", {
    _user_id: userId,
    _event: event,
    _details: details,
  });
}

/** Ошибки загрузки — их тексты; прочее — общий текст. */
function shown(e: unknown): never {
  if (e instanceof FbError) throw new Error(e.message);
  throw e;
}

/** Их save(): студия, направление, город (их canonical_city), партнёр, домен, ключ. */
export const saveFitbaseConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        id: z.number().int().positive().nullable(),
        name: z.string().max(1000),
        brand: z.enum(FB_BRANDS),
        city: z.string().max(1000),
        partner: z.string().max(1000),
        domain: z.string().max(1000),
        key: z.string().max(20000),
        marketingDisabled: z.boolean(),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    let v;
    try {
      v = fbConnectionInput(data);
    } catch (e) {
      shown(e);
    }
    const { data: saved, error } = await context.supabase.rpc("an_fb_connection_save", {
      p_id: data.id,
      p_name: v.name,
      p_brand: data.brand,
      p_city: v.city,
      p_domain: v.domain,
      p_partner: v.partner,
      p_marketing_disabled: data.marketingDisabled,
      p_key_cipher: v.key ? encryptSecret(v.key) : "",
    });
    if (error) throw new Error(error.message);
    const result = saved as { id: number; removed_paths: string[] };
    await removeFbBlobs(result.removed_paths ?? []);
    return { id: result.id };
  });

const ACTIONS = ["verify", "sync", "sales", "attendance", "revenue", "all"] as const;

/** Их действия студии: проверить, обновить, «Обновить всё» и разделы. */
export const startFitbaseAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), action: z.enum(ACTIONS) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      await fbStartJob(data.id, data.action as FbAction);
    } catch (e) {
      shown(e);
    }
    await audit(context.userId, `fitbase_${data.action}`, String(data.id));
    return { ok: true };
  });

/** Их «Загрузить всё»: студии по очереди в фоне. */
export const startFitbaseBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    try {
      await fbStartAll();
    } catch (e) {
      shown(e);
    }
    await audit(context.userId, "fitbase_sync_all", "all studios");
    return { ok: true };
  });

/** Их rules(): клуб, исходы этапов, бюджеты источников; затем обновление лидов. */
export const saveFitbaseRules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        id: z.number().int().positive(),
        club: z.string().max(200),
        steps: z.record(z.string(), z.string().max(40)),
        sources: z.record(z.string(), z.string().max(40)),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { data: saved, error } = await context.supabase.rpc("an_fb_rules_save", {
      p_id: data.id,
      p_club: data.club,
      p_steps: data.steps,
      p_sources: data.sources,
    });
    if (error) throw new Error(error.message);
    await removeFbBlobs((saved as { removed_paths?: string[] })?.removed_paths ?? []);
    try {
      await fbStartJob(data.id, "sync");
    } catch (e) {
      shown(e);
    }
    return { ok: true };
  });

/**
 * Их refresh_revenue («Обновить выручку»): выручка студий с клубом под
 * фильтрами отчёта за его период (история и текущий месяц по вчера) — в фоне;
 * занятая студия пропускается («busy»).
 */
export const startFitbaseRevenueRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        offset: z.number().int(),
        search: z.string().max(200),
        status: z.string().max(20),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    let period;
    try {
      period = fbRevenuePeriod(data.offset, fbRevenueToday());
      if (!["", "active", "archived"].includes(data.status)) {
        throw new FbError("Проверьте фильтр студий.");
      }
    } catch (e) {
      shown(e);
    }
    const { data: rows, error } = await getSupabaseAdmin()
      .from("an_fb_connections")
      .select("id, name, city, club_id, studio_status")
      .order("id");
    if (error) throw new Error(error.message);
    const search = casefold(data.search.trim());
    const selected = (rows ?? []).filter(
      (c) =>
        c.club_id &&
        (!data.status || c.studio_status === data.status) &&
        (!search || casefold(c.city).includes(search) || casefold(c.name).includes(search)),
    );
    if (!selected.length) throw new Error("Нет подключённых студий для выбранных фильтров.");
    let busy = false;
    for (const c of selected) {
      try {
        await fbStartJob(c.id as number, "revenue", { start: period.fromDate, end: period.cutoff });
      } catch (e) {
        if (!(e instanceof FbError)) throw e;
        busy = true;
      }
    }
    await audit(context.userId, "fitbase_revenue_refresh", String(selected.length));
    return { busy, ids: selected.map((c) => c.id as number) };
  });

/**
 * Их refresh_attendance («Обновить данные» отчёта занятий): занятия студий с
 * клубом под фильтрами города, студии и статуса за выбранный период (и те же
 * дни месяц и год назад) — в фоне; занятая студия пропускается.
 */
export const startFitbaseAttendanceRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        from: z.string().max(10),
        to: z.string().max(10),
        city: z.string().max(200),
        studio: z.string().max(20),
        status: z.string().max(20),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      fbAttendanceWindow(data.from, data.to);
    } catch (e) {
      shown(e);
    }
    const { data: rows, error } = await getSupabaseAdmin()
      .from("an_fb_connections")
      .select("id, city, club_id, studio_status")
      .order("id");
    if (error) throw new Error(error.message);
    const selected = (rows ?? []).filter(
      (c) =>
        c.club_id &&
        (!data.city || c.city === data.city) &&
        (!data.studio || String(c.id) === data.studio) &&
        (!data.status || c.studio_status === data.status),
    );
    if (!selected.length) throw new Error("Нет подключённых студий для выбранных фильтров.");
    let busy = false;
    for (const c of selected) {
      try {
        await fbStartJob(c.id as number, "attendance", { start: data.from, end: data.to });
      } catch (e) {
        if (!(e instanceof FbError)) throw e;
        busy = true;
      }
    }
    await audit(context.userId, "fitbase_attendance_refresh", String(selected.length));
    return { busy, ids: selected.map((c) => c.id as number) };
  });

/**
 * Их «Уточнить пробные по выбранным студиям» (fitbase_trials.route): общая
 * очередь «trials» (их repair_metadata) для студий воронки под фильтрами.
 */
export const startFitbaseTrialsRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        from: z.string().max(10),
        to: z.string().max(10),
        city: z.string().max(200),
        studio: z.string().max(20),
        brand: z.string().max(20),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      fbAttendanceWindow(data.from, data.to);
      if (!["", "Lady Jump", "Lady Stretch"].includes(data.brand)) {
        throw new FbError("Проверьте направление.");
      }
    } catch (e) {
      shown(e);
    }
    const { data: rows, error } = await getSupabaseAdmin()
      .from("an_fb_connections")
      .select("id, city, brand, club_id")
      .order("id");
    if (error) throw new Error(error.message);
    const ids = (rows ?? [])
      .filter(
        (c) =>
          c.club_id &&
          (!data.city || c.city === data.city) &&
          (!data.studio || String(c.id) === data.studio) &&
          (!data.brand || c.brand === data.brand),
      )
      .map((c) => c.id as number);
    try {
      await fbStartAll({ action: "trials", ids });
    } catch (e) {
      shown(e);
    }
    return { ids };
  });

/** Их «Обновить список услуг из FitBase» (load_catalog): каталог услуг клуба. */
export const loadFitbaseTrialCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.number().int().positive() }).strict().parse(data))
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      await fbTrialLoadCatalog(data.id);
    } catch (e) {
      shown(e);
    }
    return { ok: true };
  });

/**
 * Их «Сохранить пробные услуги» (save): проверки и запись — RPC от имени
 * администратора, затем типы записей студии пересчитываются по новому выбору.
 */
export const saveFitbaseTrialServices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        id: z.number().int().positive(),
        owner: z.string().max(400),
        mode: z.string().max(20),
        selected: z.array(z.string().max(100)).max(5000),
        revision: z.string().max(20),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { error } = await context.supabase.rpc("an_fb_trial_services_save", {
      p_id: data.id,
      p_owner: data.owner,
      p_mode: data.mode,
      p_selected: data.selected,
      p_revision: data.revision,
    });
    if (error) throw new Error(error.message);
    await fbTrialRecompute(data.id);
    return { ok: true };
  });

/** Ошибки сборщика оснований — свои тексты; прочее — общий текст. */
function shownWeb(e: unknown): never {
  if (e instanceof FbWebError) throw new Error(e.message);
  throw e;
}

/**
 * Код помощника входа (их authorize.py → configure_session): помощник на
 * компьютере владельца после входа в FitBase передаёт сессию порталу с этим
 * кодом. Код — адрес портала, одноразовый ключ на 15 минут и адрес FitBase.
 */
export const issueFitbaseWebCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    const portal = (process.env.ADMIN_APP_URL || "").replace(/\/+$/, "");
    if (!portal)
      throw new Error("На сервере не задан ADMIN_APP_URL — адрес портала для помощника.");
    // Код помощника: адрес портала, одноразовый ключ и адрес FitBase сети.
    let origin = "";
    try {
      origin = await fbWebNetworkOrigin();
    } catch (e) {
      shownWeb(e);
    }
    const token = await fbWebIssueToken(context.userId);
    const code = Buffer.from(JSON.stringify({ u: portal, t: token, o: origin }), "utf8").toString(
      "base64url",
    );
    await audit(context.userId, "fitbase_web_code", "15 min");
    return { code };
  });

/** Сессия FitBase, вставленная вручную (JSON помощника входа). */
export const saveFitbaseWebSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ json: z.string().max(200000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    let payload: unknown;
    try {
      payload = JSON.parse(data.json);
    } catch {
      throw new Error("Нужна сессия помощника входа: {origin, cookies}.");
    }
    let studios = 0;
    try {
      studios = await fbWebAcceptSession(payload, context.userId);
    } catch (e) {
      shownWeb(e);
    }
    await audit(context.userId, "fitbase_web_session", String(studios));
    return { studios };
  });

/** Удалить сессию FitBase (сборщик остановится до нового входа). */
export const forgetFitbaseWebSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    await fbWebForgetSession();
    await audit(context.userId, "fitbase_web_session_removed", "");
    return { ok: true };
  });
