/**
 * VK Ads: запросы и записи страниц (RPC an_vk_* — права проверяет база;
 * схема — db/migrations/2026-10-30_zzzzz_analytics_vk.sql). Ключи и загрузка
 * периода — серверные функции lib/analytics/vk.functions.ts.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { VkAccountRow, VkSpendRow } from "./view";

export const VK_KEY = [ANALYTICS_KEY, "vk"] as const;

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type VkAccountsData = { accounts: VkAccountRow[]; cities: string[]; partners: string[] };

export const vkAccountsQuery = {
  queryKey: [...VK_KEY, "accounts"],
  queryFn: () => rpc<VkAccountsData>("an_vk_accounts"),
  meta: { errorMessage: "Не удалось загрузить рекламные кабинеты" },
};

export const vkSpendQuery = (date: string) => ({
  queryKey: [...VK_KEY, "spend", date],
  queryFn: () => rpc<VkSpendRow[]>("an_vk_spend", { p_date: date }),
  placeholderData: (prev: VkSpendRow[] | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить расходы" },
});

export const vkRpc = {
  update: (id: number, city: string, partner: string, brand: string) =>
    rpc<null>("an_vk_account_update", {
      p_id: id,
      p_city: city,
      p_partner_name: partner,
      p_brand: brand,
    }),
  toggle: (id: number) => rpc<boolean>("an_vk_account_toggle", { p_id: id }),
  remove: (id: number) => rpc<null>("an_vk_account_delete", { p_id: id }),
};

export function invalidateVk(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: VK_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}

export const VK_BRANDS = ["Lady Stretch", "Lady Jump"] as const;
