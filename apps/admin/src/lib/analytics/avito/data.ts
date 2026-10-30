/**
 * Авито: запросы и записи страниц (RPC an_avito_* — права проверяет база;
 * схема — db/migrations/2026-10-30_zzzzzzzzzzz_analytics_avito.sql). Ключи,
 * проверка, структура и история — серверные функции lib/analytics/avito.functions.ts.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { AvitoRegisterPayload } from "./register";
import type { AvitoCheckSummary } from "./rules";

export const AVITO_KEY = [ANALYTICS_KEY, "avito"] as const;

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type AvitoAccountRow = {
  id: number;
  name: string;
  avito_account_id: string;
  city: string;
  brand: string;
  last_checked_at: string | null;
  last_check_status: number | null;
  last_check_summary: AvitoCheckSummary;
  campaigns: number;
  stats_to: string | null;
};

export const avitoAccountsQuery = {
  queryKey: [...AVITO_KEY, "accounts"],
  queryFn: () => rpc<AvitoAccountRow[]>("an_avito_accounts"),
  meta: { errorMessage: "Не удалось загрузить кабинеты Авито" },
};

export type AvitoPlansMonth = {
  cities: { brand: string; city: string }[];
  plans: {
    brand: string;
    city: string;
    applications_plan: number;
    target_cpl: number;
    updated_at: string;
  }[];
};

export const avitoPlansQuery = (month: string) => ({
  queryKey: [...AVITO_KEY, "plans", month],
  queryFn: () => rpc<AvitoPlansMonth>("an_avito_plans", { p_month: month }),
  placeholderData: (prev: AvitoPlansMonth | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить планы Авито" },
});

export const avitoRegisterQuery = (from: string, to: string) => ({
  queryKey: [...AVITO_KEY, "register", from, to],
  queryFn: () => rpc<AvitoRegisterPayload>("an_avito_register", { p_from: from, p_to: to }),
  placeholderData: (prev: AvitoRegisterPayload | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить реестр Авито" },
});

export const avitoRpc = {
  savePlan: (month: string, brand: string, city: string, applications: number, cpl: number) =>
    rpc<null>("an_avito_plan_save", {
      p_month: month,
      p_brand: brand,
      p_city: city,
      p_applications: applications,
      p_target_cpl: cpl,
    }),
  remove: (id: number) => rpc<null>("an_avito_account_delete", { p_id: id }),
};

export function invalidateAvito(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: AVITO_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}
