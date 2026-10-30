import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { avitoKeyValue, avitoTotalsText } from "./avito/rules";
import { mskToday } from "./core";
import { checkAvitoAccount, syncAvitoHistory, syncAvitoStructure } from "./server/avito.server";
import { encryptSecret } from "./server/secrets.server";

/**
 * Авито: действия с кабинетами, которым нужен сервер — client_id и
 * client_secret шифрует сервер (ANALYTICS_SECRETS_KEY) и отдаёт базе
 * шифртекстом от имени вызывающего (RPC an_avito_* сами проверяют
 * администратора аналитики, их тексты и журнал); проверку, структуру и
 * историю выполняет сервер. Только администратору аналитики.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

/** Ключ для базы: '' — не введён, 'long' — длиннее 200 (их _clean), иначе шифртекст. */
function keyCipher(value: string): string {
  const v = avitoKeyValue(value);
  return v.kind === "ok" ? encryptSecret(v.value) : v.kind === "long" ? "long" : "";
}

async function audit(userId: string, event: string, details: string) {
  await getSupabaseAdmin().rpc("an_audit_add", {
    _user_id: userId,
    _event: event,
    _details: details,
  });
}

const text = (max: number) => z.string().max(max);
const idInput = (data: unknown) =>
  z.object({ id: z.number().int().positive() }).strict().parse(data);

/** Их «Сохранить подключение»: тот же ID аккаунта — обновление. */
export const saveAvitoAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: text(2000),
        avitoAccountId: text(2000),
        city: text(2000),
        brand: text(100),
        clientId: text(2000),
        clientSecret: text(2000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { error } = await context.supabase.rpc("an_avito_account_save", {
      p_name: data.name,
      p_avito_account_id: data.avitoAccountId,
      p_city: data.city,
      p_brand: data.brand,
      p_client_id_cipher: keyCipher(data.clientId),
      p_client_secret_cipher: keyCipher(data.clientSecret),
    });
    if (error) throw new Error(`Не удалось сохранить подключение: ${error.message}`);
    return { message: "Подключение сохранено. Теперь выполните проверку API." };
  });

/** Их «Заменить API»: новые ключи, кабинет и история остаются. */
export const setAvitoCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), clientId: text(2000), clientSecret: text(2000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { error } = await context.supabase.rpc("an_avito_set_credentials", {
      p_id: data.id,
      p_client_id_cipher: keyCipher(data.clientId),
      p_client_secret_cipher: keyCipher(data.clientSecret),
    });
    if (error) throw new Error(`Не удалось заменить ключи: ${error.message}`);
    return { message: "Ключи заменены. Кабинет и история сохранены. Нажмите «Проверить API»." };
  });

/** Их «Проверить API». */
export const checkAvito = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      const totals = await checkAvitoAccount(data.id);
      await audit(context.userId, "avito_ads_account_checked", String(data.id));
      return {
        message: `API подтверждён. Получено: ${avitoTotalsText(totals) || "структура без записей"}.`,
      };
    } catch (e) {
      throw new Error(`Проверка API не выполнена: ${(e as Error).message}`);
    }
  });

/** Их «Структура». */
export const syncAvitoStructureFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      const totals = await syncAvitoStructure(data.id);
      await audit(context.userId, "avito_ads_structure_synced", String(data.id));
      return { message: `Структура загружена: ${avitoTotalsText(totals)}.` };
    } catch (e) {
      throw new Error(`Загрузка структуры не выполнена: ${(e as Error).message}`);
    }
  });

/** Их «Загрузить историю»: по сегодня (МСК), затем — реестр за этот период. */
export const loadAvitoHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idInput)
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const to = mskToday();
    try {
      const { from, saved } = await syncAvitoHistory(data.id, to);
      await audit(context.userId, "avito_ads_history_synced", `${data.id}:${from}:${to}:${saved}`);
      return {
        from,
        to,
        message: `История загружена за период ${from} — ${to}: ${saved} строк статистики.`,
      };
    } catch (e) {
      throw new Error(`Историю загрузить не удалось: ${(e as Error).message}`);
    }
  });
