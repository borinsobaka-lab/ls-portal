import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { mskToday } from "./core";
import { ANALYTICS_JOBS, isJobEnabled, runJob } from "./server/jobs.server";
import { encryptSecret } from "./server/secrets.server";
import { syncVkAccount } from "./server/vk-ads.server";

/**
 * VK Ads: действия с кабинетами, которым нужен сервер — API-ключ шифрует
 * сервер (ANALYTICS_SECRETS_KEY) и отдаёт базе шифртекстом от имени
 * вызывающего (RPC an_vk_* сами проверяют администратора аналитики и пишут
 * журнал), загрузку периода выполняет сервер. Только администратору
 * аналитики (an_me от имени вызывающего).
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

/** Ключ шифруется только непустой: пустой база отклонит своим текстом. */
const cipher = (token: string) => (token.trim() ? encryptSecret(token.trim()) : "");

const text = (max: number) => z.string().max(max);

export const createVkAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: text(500),
        vkAccountId: text(100),
        city: text(200),
        partnerName: text(200),
        brand: text(40),
        token: text(4000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { data: id, error } = await context.supabase.rpc("an_vk_account_create", {
      p_name: data.name,
      p_vk_account_id: data.vkAccountId,
      p_city: data.city,
      p_partner_name: data.partnerName,
      p_brand: data.brand,
      p_token_cipher: cipher(data.token),
    });
    if (error) throw new Error(error.message);
    return { id: id as number };
  });

export const setVkAccountToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), token: text(4000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const { error } = await context.supabase.rpc("an_vk_account_set_token", {
      p_id: data.id,
      p_token_cipher: cipher(data.token),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Их «Проверить и загрузить»: ключ и расходы, кампании, связи ЛФ за период. */
export const syncVkAccountPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        id: z.number().int().positive(),
        from: z.string().regex(ISO),
        to: z.string().regex(ISO),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      if (data.to < data.from) throw new Error("Дата окончания не может быть раньше даты начала.");
      if (data.to > mskToday()) throw new Error("Нельзя загрузить будущую дату.");
      const result = await syncVkAccount(data.id, data.from, data.to);
      await getSupabaseAdmin().rpc("an_audit_add", {
        _user_id: context.userId,
        _event: "vk_ads_account_period_synced",
        _details: `${data.id}: ${data.from}—${data.to}`,
      });
      return {
        message:
          `Ключ проверен. Загружен период ${ruDate(data.from)}—${ruDate(data.to)}: ` +
          `кампаний ${result.campaigns}, строк статистики ${result.rows}.`,
      };
    } catch (e) {
      throw new Error(`Загрузка не выполнена: ${(e as Error).message}`);
    }
  });

/**
 * Их «Импортировать рекламные кабинеты» (VK Ads Panel, файл API_VK_ADS.xlsx):
 * строки разбирает браузер, ключи шифрует сервер; после импорта — сразу
 * сбор всех кабинетов (у них — systemctl start lady-vk-ads.service).
 */
export const importVkAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        records: z
          .array(
            z
              .object({
                name: text(2000),
                vk_account_id: text(2000),
                token: text(4000),
                city: text(2000),
                partner_name: text(2000),
                brand: text(200),
              })
              .strict(),
          )
          .max(5000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const records = data.records.map(({ token, ...r }) => ({ ...r, token_cipher: cipher(token) }));
    const { data: result, error } = await context.supabase.rpc("an_vk_accounts_import", {
      p_records: records,
    });
    if (error) throw new Error(error.message);
    const job = ANALYTICS_JOBS.find((j) => j.key === "vk_ads");
    if (job && (await isJobEnabled(job.key))) void runJob(job);
    return result as { created: number; updated: number; skipped: number };
  });
