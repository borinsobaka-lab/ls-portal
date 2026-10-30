import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { amoConnectionCheck, amoTokenCheck } from "./amo/rules";
import {
  amoToken,
  beginAmoSync,
  fetchAmoMetadata,
  runAmoSync,
  verifyAmo,
} from "./server/amocrm.server";
import { saveSecret } from "./server/secrets.server";

/**
 * amoCRM, «Интеграция amoCRM» (их /admin/crm/amocrm/*): новое подключение,
 * проверка и замена токена, загрузка справочников, полная сверка сделок.
 * Правила, ответственные и квалификация — RPC an_amo_* из браузера. Только
 * администратору аналитики (an_me от имени вызывающего); журнал — их события.
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

const idInput = (data: unknown) =>
  z.object({ id: z.number().int().positive() }).strict().parse(data);

/** Их save_connection: название, адрес amoCRM, долгоживущий токен (зашифрованно). */
export const createAmoConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: z.string().max(500),
        baseUrl: z.string().max(500),
        token: z.string().max(5000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const v = amoConnectionCheck(data);
    const admin = getSupabaseAdmin();
    const { data: dup } = await admin
      .from("an_amo_connections")
      .select("id")
      .eq("base_url", v.baseUrl)
      .maybeSingle();
    if (dup) throw new Error("Подключение с таким адресом AmoCRM уже есть.");
    const { data: row, error } = await admin
      .from("an_amo_connections")
      .insert({ name: v.name, base_url: v.baseUrl, token_updated_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: number }).id;
    try {
      await saveSecret(amoToken(id), v.token, context.userId);
    } catch (e) {
      await admin.from("an_amo_connections").delete().eq("id", id);
      throw e;
    }
    await audit(context.userId, "amocrm_connection_created", String(id));
    return { id, message: "Подключение сохранено. Теперь нажмите «Проверить»." };
  });

/** Их verify: /api/v4/account. */
export const verifyAmoConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const name = await verifyAmo(data.id);
    await audit(context.userId, "amocrm_connection_verified", String(data.id));
    return { message: `Доступ AmoCRM подтверждён: ${name}` };
  });

/** Их token: новый токен (настройки и собранные сделки остаются) и проверка. */
export const replaceAmoToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), token: z.string().max(5000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      const token = amoTokenCheck(data.token);
      const admin = getSupabaseAdmin();
      const { data: row } = await admin
        .from("an_amo_connections")
        .select("id")
        .eq("id", data.id)
        .maybeSingle();
      if (!row) throw new Error("Подключение AmoCRM не найдено.");
      await saveSecret(amoToken(data.id), token, context.userId);
      const now = new Date().toISOString();
      const { error } = await admin
        .from("an_amo_connections")
        .update({
          token_updated_at: now,
          updated_at: now,
          last_verified_at: null,
          last_verification_status: null,
          last_verification_details: "",
        })
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      const name = await verifyAmo(data.id);
      await audit(context.userId, "amocrm_connection_token_reconnected", String(data.id));
      return { message: `Токен сохранён, доступ AmoCRM подтверждён: ${name}` };
    } catch (e) {
      throw new Error(`Не удалось переподключить токен: ${(e as Error).message}`);
    }
  });

/** Их metadata: воронки, поля сделки, ответственные. */
export const refreshAmoMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const [pipelines, fields, users] = await fetchAmoMetadata(data.id);
    await audit(context.userId, "amocrm_metadata_refreshed", String(data.id));
    return {
      message: `AmoCRM загружена: воронок — ${pipelines}, полей сделки — ${fields}, ответственных — ${users}.`,
    };
  });

/**
 * Их sync: полная сверка всех сделок с 01.09.2026. У них шла внутри запроса
 * страницы; у нас — фоном (страница показывает ход и итог последнего сбора),
 * ошибки до начала сбора — сразу.
 */
export const startAmoFullSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const started = await beginAmoSync(data.id, "full");
    await audit(context.userId, "amocrm_marketing_sync_started", String(data.id));
    void runAmoSync(data.id, "full", started).catch((e: Error) =>
      console.error("[analytics] amoCRM: полная сверка", data.id, e.message),
    );
    return { message: "Полная сверка запущена. Итог появится в блоке «Сбор сделок»." };
  });
