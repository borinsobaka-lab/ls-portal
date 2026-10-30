/**
 * VK Ads: запросы и записи страниц (RPC an_vk_* — права проверяет база;
 * схема — db/migrations/2026-10-30_zzzzz_analytics_vk.sql). Ключи и загрузка
 * периода — серверные функции lib/analytics/vk.functions.ts.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { PlanInput } from "./plans";
import type { RegisterPayload } from "./register";
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

export type VkRegisterArgs = { from: string; to: string; targetologist: string; brand: string };

export const vkRegisterQuery = (a: VkRegisterArgs) => ({
  queryKey: [...VK_KEY, "register", a.from, a.to, a.targetologist, a.brand],
  queryFn: () =>
    rpc<RegisterPayload>("an_vk_register", {
      p_from: a.from,
      p_to: a.to,
      p_targetologist: a.targetologist,
      p_brand: a.brand,
    }),
  placeholderData: (prev: RegisterPayload | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить реестр таргета" },
});

export type VkPlanRow = PlanInput & { month: string; brand: string };
export type VkPlanChange = {
  brand: string;
  city: string;
  previous_applications_plan: number | null;
  previous_target_cpl: number | null;
  applications_plan: number;
  target_cpl: number;
  changed_by: string;
  changed_at: string;
};
export type VkPlansMonth = { plans: VkPlanRow[]; changes: VkPlanChange[]; cities: string[] };

export const vkPlansQuery = (month: string) => ({
  queryKey: [...VK_KEY, "plans", month],
  queryFn: () => rpc<VkPlansMonth>("an_vk_plans_month", { p_month: month }),
  placeholderData: (prev: VkPlansMonth | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить планы таргета" },
});

export type VkTargetologists = {
  assignments: { brand: string; city: string; targetologist_name: string }[];
  people: string[];
  cities: string[];
};

export const vkTargetologistsQuery = {
  queryKey: [...VK_KEY, "targetologists"],
  queryFn: () => rpc<VkTargetologists>("an_vk_targetologists"),
  meta: { errorMessage: "Не удалось загрузить таргетологов" },
};

export type VkSsSource = {
  brand: string;
  city: string;
  leads_sheet_url: string;
  applications_sheet_url: string;
  is_active: boolean;
};
export type VkSsSources = {
  sources: VkSsSource[];
  cities: string[];
  google: { client_email: string; updated_at: string | null } | null;
};

export const vkSsSourcesQuery = {
  queryKey: [...VK_KEY, "ss-sources"],
  queryFn: () => rpc<VkSsSources>("an_vk_ss_sources"),
  meta: { errorMessage: "Не удалось загрузить источники СС" },
};

export type VkLfSource = {
  account_id: number;
  name: string;
  city: string;
  is_active: boolean;
  spreadsheet_id: string;
  sheet_name: string;
  starts_at: string;
  is_enabled: boolean;
  sent: number;
  pending: number;
  errors: number;
  last_error: string | null;
};
export type VkLfOverview = {
  drive: { client: boolean; connected: boolean; folder_id: string; updated_at: string | null };
  sheets_key: boolean;
  active_accounts: number;
  collector_enabled: boolean;
  collector_last: { at: string | null; status: string | null; message: string | null } | null;
  sources: VkLfSource[];
};

export const vkLfOverviewQuery = {
  queryKey: [...VK_KEY, "lead-forms"],
  queryFn: () => rpc<VkLfOverview>("an_vk_lf_overview"),
  meta: { errorMessage: "Не удалось загрузить сбор лид-форм" },
};

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
  savePlans: (
    brand: string,
    months: { month: string; plans: PlanInput[] }[],
    source: "manual" | "single" | "all",
  ) =>
    rpc<{ changed: number; months: number }>("an_vk_plans_save", {
      p_brand: brand,
      p_months: months,
      p_source: source,
    }),
  deletePlan: (month: string, brand: string, city: string) =>
    rpc<boolean>("an_vk_plan_delete", { p_month: month, p_brand: brand, p_city: city }),
  saveTargetologist: (brand: string, city: string, name: string) =>
    rpc<null>("an_vk_targetologist_save", { p_brand: brand, p_city: city, p_name: name }),
  deleteTargetologist: (brand: string, city: string) =>
    rpc<null>("an_vk_targetologist_delete", { p_brand: brand, p_city: city }),
  saveSsSource: (brand: string, city: string, leads: string, applications: string) =>
    rpc<null>("an_vk_ss_source_save", {
      p_brand: brand,
      p_city: city,
      p_leads_url: leads,
      p_applications_url: applications,
    }),
  deleteSsSource: (brand: string, city: string) =>
    rpc<null>("an_vk_ss_source_delete", { p_brand: brand, p_city: city }),
};

export function invalidateVk(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: VK_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}

export const VK_BRANDS = ["Lady Stretch", "Lady Jump"] as const;
