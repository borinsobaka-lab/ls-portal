import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { GOOGLE_SA_SECRET, parseServiceAccount } from "./server/google-sheets.server";
import { saveSecret } from "./server/secrets.server";
import { syncSsSource, verifySsSource } from "./server/vk-ss.server";

/**
 * VK Ads, «Источники СС»: действия, которым нужен сервер — ключ сервисного
 * аккаунта Google (шифрует сервер, ANALYTICS_SECRETS_KEY; браузер его больше
 * не видит), проверка доступа к таблицам и загрузка счётчиков СС. Только
 * администратору аналитики (an_me от имени вызывающего); журнал — их события.
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

/** Ключ сервисного аккаунта (JSON-файл из Google Cloud) — проверить и сохранить. */
export const saveGoogleServiceAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ json: z.string().max(20_000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const sa = parseServiceAccount(data.json);
    await saveSecret(GOOGLE_SA_SECRET, data.json, context.userId);
    const { error } = await getSupabaseAdmin().from("an_google_settings").upsert(
      {
        id: true,
        sa_client_email: sa.client_email,
        sa_updated_at: new Date().toISOString(),
        sa_updated_by: context.userId,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(error.message);
    await audit(context.userId, "google_sheets_key_saved", sa.client_email);
    return { clientEmail: sa.client_email };
  });

export const deleteGoogleServiceAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAnAdmin(context.supabase);
    const admin = getSupabaseAdmin();
    const del = await admin
      .from("an_secrets")
      .delete()
      .eq("kind", GOOGLE_SA_SECRET.kind)
      .eq("ref", GOOGLE_SA_SECRET.ref)
      .eq("name", GOOGLE_SA_SECRET.name);
    if (del.error) throw new Error(del.error.message);
    const upd = await admin.from("an_google_settings").upsert(
      {
        id: true,
        sa_client_email: "",
        sa_updated_at: new Date().toISOString(),
        sa_updated_by: context.userId,
      },
      { onConflict: "id" },
    );
    if (upd.error) throw new Error(upd.error.message);
    await audit(context.userId, "google_sheets_key_deleted", "");
    return { ok: true };
  });

const source = z.object({ brand: z.string().max(40), city: z.string().max(200) }).strict();

/** Их «Проверить доступ»: названия таблиц и листов. */
export const verifySs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => source.parse(data))
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const c = await verifySsSource(data.brand, data.city);
    await audit(context.userId, "community_message_source_verified", `${data.brand}: ${data.city}`);
    return {
      message:
        `Доступ проверен: «${c.city}». Лиды: «${c.leadsTitle}» ` +
        `(листы: ${c.leadsSheets.join(", ")}); заявки: «${c.applicationsTitle}» ` +
        `(листы: ${c.applicationsSheets.join(", ")}).`,
    };
  });

/** Их «Загрузить данные СС»: счётчики лидов и заявок по дням. */
export const syncSs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => source.parse(data))
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const r = await syncSsSource(data.brand, data.city);
    await audit(context.userId, "community_message_source_synced", `${data.brand}: ${data.city}`);
    return {
      message:
        `Данные СС загружены: «${r.brand} · ${r.city}» — ${r.leads} лидов, ` +
        `${r.applications} заявок, дней: ${r.days}.`,
    };
  });
