/**
 * amoCRM: запросы и записи страниц «Интеграции amoCRM» (RPC an_amo_* —
 * права проверяет база; схема — db/migrations/2026-10-30_zzzzzzzzz_analytics_amocrm.sql).
 * Токены, справочники и сбор — серверные функции lib/analytics/amo.functions.ts.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { MktPayload, MktResult } from "./marketing";
import type { AmoField, AmoPipeline, AmoSettings, AmoUser } from "./rules";

export const AMO_KEY = [ANALYTICS_KEY, "amo"] as const;

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type AmoConnectionRow = {
  id: number;
  name: string;
  base_url: string;
  is_active: boolean;
  last_verified_at: string | null;
  last_verification_status: number | null;
  last_verification_details: string;
  configured: boolean;
};

export type AmoResponsibleRow = {
  amo_user_id: string;
  amo_user_name: string;
  brand: string;
  city: string;
  partner_name: string;
};

export type AmoConnectionView = {
  connection: Omit<AmoConnectionRow, "configured">;
  metadata: {
    pipelines: AmoPipeline[];
    fields: AmoField[];
    users: AmoUser[];
    fetched_at: string;
  } | null;
  settings: (AmoSettings & { brand: string | null }) | null;
  responsibles: AmoResponsibleRow[];
  basis: {
    field_selected: boolean;
    values: { id: string; value: string; unqualified: boolean }[];
  };
  last_run: {
    started_at: string;
    finished_at: string | null;
    mode: string;
    status: "running" | "success" | "error";
    received: number;
    saved: number;
    details: string;
  } | null;
  running: boolean;
  leads: number;
  sync_enabled: boolean;
};

export const amoConnectionsQuery = {
  queryKey: [...AMO_KEY, "connections"],
  queryFn: () => rpc<AmoConnectionRow[]>("an_amo_connections"),
  meta: { errorMessage: "Не удалось загрузить подключения amoCRM" },
};

export const amoConnectionQuery = (id: number) => ({
  queryKey: [...AMO_KEY, "connection", id],
  queryFn: () => rpc<AmoConnectionView>("an_amo_connection", { p_id: id }),
  // Пока идёт сверка — ход и итог обновляются сами.
  refetchInterval: (q: { state: { data?: AmoConnectionView } }) =>
    q.state.data?.running ? 3000 : false,
  meta: { errorMessage: "Не удалось загрузить подключение amoCRM" },
});

export type AmoMarketingArgs = {
  brand: string;
  month?: string;
  city?: string;
  partner?: string;
  result: MktResult;
};

/** «Маркетинг Lady Stretch / Lady Jump» — фильтры, строки, бюджеты и подсказки (RPC an_amo_marketing). */
export const amoMarketingQuery = (a: AmoMarketingArgs) => ({
  queryKey: [
    ...AMO_KEY,
    "marketing",
    a.brand,
    a.month ?? "",
    a.city ?? "",
    a.partner ?? "",
    a.result,
  ],
  queryFn: () =>
    rpc<MktPayload>("an_amo_marketing", {
      p_brand: a.brand,
      p_month: a.month ?? null,
      p_city: a.city ?? null,
      p_partner: a.partner ?? null,
      p_result: a.result,
    }),
  placeholderData: (prev: MktPayload | undefined) => (prev?.brand === a.brand ? prev : undefined),
  meta: { errorMessage: "Не удалось загрузить маркетинговый отчёт" },
});

export const amoRpc = {
  saveSettings: (id: number, values: Record<string, string>) =>
    rpc<null>("an_amo_settings_save", { p_id: id, p_values: values }),
  saveResponsible: (id: number, user: string, brand: string, city: string, partner: string) =>
    rpc<null>("an_amo_responsible_save", {
      p_id: id,
      p_user: user,
      p_brand: brand,
      p_city: city,
      p_partner: partner,
    }),
  clearResponsibles: (id: number) => rpc<number>("an_amo_responsibles_clear", { p_id: id }),
  deleteResponsible: (id: number, user: string) =>
    rpc<null>("an_amo_responsible_delete", { p_id: id, p_user: user }),
  saveBasis: (id: number, ids: string[]) =>
    rpc<null>("an_amo_basis_save", { p_id: id, p_ids: ids }),
};

export function invalidateAmo(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: AMO_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}
