import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { FB_BRANDS, FbError, fbConnectionInput } from "./fitbase/rules";
import { fbStartAll, fbStartJob, removeFbBlobs, type FbAction } from "./server/fitbase.server";
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
