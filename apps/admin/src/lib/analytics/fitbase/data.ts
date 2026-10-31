/**
 * FitBase: запросы и записи «Интеграции FitBase» (RPC an_fb_* — права
 * проверяет база; схема — db/migrations/2026-10-30_zzzzzzzzzzzzz_analytics_fitbase.sql).
 * Ключ API, загрузки и правила с перезагрузкой — серверные функции
 * lib/analytics/fitbase.functions.ts.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { FbAttendanceData } from "./attendance";
import type { FbMyCityData } from "./mycity";
import type { FbReviewData, FbTrialsData } from "./trials";
import type { FbMarketingData, FbRevenueData, FbSalesData } from "./reports";

export const FB_KEY = [ANALYTICS_KEY, "fitbase"] as const;

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type FbConnectionRow = {
  id: number;
  name: string;
  brand: string;
  city: string;
  domain: string;
  club_id: string;
  partner_name: string;
  marketing_disabled: boolean;
  studio_status: "active" | "archived";
  sync_state: string;
  busy: boolean;
  job_progress: string;
  synced_at: number | null;
  sync_attempt_at: number | null;
  sales_state: string;
  sales_synced_at: number | null;
  sales_payments_at: number | null;
  refund_state: string;
  attendance_state: string;
  attendance_synced_at: number | null;
  attendance_from: string;
  attendance_to: string;
  revenue_state: string;
  revenue_synced_at: number | null;
  revenue_from: string;
  revenue_to: string;
  full_sync: boolean;
  has_key: boolean;
};

export type FbBatch = {
  active: boolean;
  interrupted?: boolean;
  total?: number;
  completed?: number;
  errors?: number;
  message?: string;
  results?: { id: number; name: string; message: string }[];
};

export type FbNightly = { last_run_day: string; error: string };

export type FbOverview = { connections: FbConnectionRow[]; batch: FbBatch; nightly: FbNightly };

export const fbConnectionsQuery = {
  queryKey: [...FB_KEY, "connections"],
  queryFn: () => rpc<FbOverview>("an_fb_connections"),
  // Пока идёт загрузка — статусы обновляются сами (их fitbase-ui.js).
  refetchInterval: (q: { state: { data?: FbOverview } }) =>
    q.state.data && (q.state.data.batch?.active || q.state.data.connections.some((c) => c.busy))
      ? 3000
      : false,
  meta: { errorMessage: "Не удалось загрузить подключения FitBase" },
};

export type FbStep = { id: string | number; name?: string; purchase_funnel?: { name?: string } };
export type FbNamed = { id: string | number; name?: string };

export type FbStatusDetail = {
  status: string;
  count: number;
  examples: {
    registration_id: string;
    client_key: string;
    event_id: string;
    day: string;
    training_name: string;
  }[];
};

export type FbConnectionView = FbConnectionRow & {
  metadata: { clubs?: FbNamed[]; funnels?: FbNamed[]; steps?: FbStep[]; sources?: FbNamed[] };
  step_rules: Record<string, string>;
  source_rules: Record<string, string>;
  attendance_rules: Record<string, string>;
  nightly: FbNightly;
  status_details: FbStatusDetail[];
};

export const fbConnectionQuery = (id: number) => ({
  queryKey: [...FB_KEY, "connection", id],
  queryFn: () => rpc<FbConnectionView>("an_fb_connection", { p_id: id }),
  refetchInterval: (q: { state: { data?: FbConnectionView } }) =>
    q.state.data?.busy ? 3000 : false,
  meta: { errorMessage: "Не удалось загрузить подключение FitBase" },
});

/** «Выручка по городам»: подключения и выручка по дням за период (право fb.revenue). */
export const fbRevenueDataQuery = (from: string, to: string) => ({
  queryKey: [...FB_KEY, "revenue", from, to],
  queryFn: () => rpc<FbRevenueData>("an_fb_revenue_data", { p_from: from, p_to: to }),
  meta: { errorMessage: "Не удалось загрузить выручку FitBase" },
});

/** «Продажи абонементов»: продажи, история и оплаты студий (право fb.sales). */
export const fbSalesDataQuery = {
  queryKey: [...FB_KEY, "sales"],
  queryFn: () => rpc<FbSalesData>("an_fb_sales_data"),
  meta: { errorMessage: "Не удалось загрузить продажи FitBase" },
};

/** «Маркетинговый отчёт»: лиды направления за период и бюджеты VK (право fb.marketing). */
export const fbMarketingDataQuery = (brand: string, from: string, to: string) => ({
  queryKey: [...FB_KEY, "marketing", brand, from, to],
  queryFn: () =>
    rpc<FbMarketingData>("an_fb_marketing_data", { p_brand: brand, p_from: from, p_to: to }),
  meta: { errorMessage: "Не удалось загрузить маркетинговый отчёт FitBase" },
});

/** «Занятия и посещаемость»: агрегаты занятий по группам за период (право fb.attendance). */
export const fbAttendanceDataQuery = (f: {
  from: string;
  to: string;
  city: string;
  studio: string;
  training: string;
  status: string;
}) => ({
  queryKey: [...FB_KEY, "attendance", f.from, f.to, f.city, f.studio, f.training, f.status],
  queryFn: () =>
    rpc<FbAttendanceData>("an_fb_attendance_data", {
      p_from: f.from,
      p_to: f.to,
      p_city: f.city,
      p_studio: f.studio,
      p_training: f.training,
      p_status: f.status,
    }),
  meta: { errorMessage: "Не удалось загрузить занятия FitBase" },
});

type FbTrialFilters = { from: string; to: string; city: string; studio: string; brand: string };

/** «Воронка пробных»: пробные записи, покупки и оплаты студий (право fb.trials). */
export const fbTrialsDataQuery = (f: FbTrialFilters) => ({
  queryKey: [...FB_KEY, "trials", f.from, f.to, f.city, f.studio, f.brand],
  queryFn: () =>
    rpc<FbTrialsData>("an_fb_trials_data", {
      p_from: f.from,
      p_to: f.to,
      p_city: f.city,
      p_studio: f.studio,
      p_brand: f.brand,
    }),
  meta: { errorMessage: "Не удалось загрузить воронку пробных FitBase" },
});

/** «Записи без услуги / абонемента»: записи периода с неопределённым типом (право fb.trials). */
export const fbTrialsReviewQuery = (f: FbTrialFilters & { status: string }) => ({
  queryKey: [...FB_KEY, "trials-review", f.from, f.to, f.city, f.studio, f.brand, f.status],
  queryFn: () =>
    rpc<FbReviewData>("an_fb_trials_review", {
      p_from: f.from,
      p_to: f.to,
      p_city: f.city,
      p_studio: f.studio,
      p_brand: f.brand,
      p_status: f.status,
    }),
  meta: { errorMessage: "Не удалось загрузить записи без услуги FitBase" },
});

export type FbTrialServicesView = {
  id: number;
  name: string;
  club_id: string;
  owner: string;
  rule: { mode: "auto" | "selected"; selected: string[]; revision: number } | null;
  catalog: { service_id: string; name: string; archived: number }[];
};

/** Пробные услуги филиала: выбор и каталог (администратору аналитики). */
export const fbTrialServicesQuery = (id: number) => ({
  queryKey: [...FB_KEY, "trial-services", id],
  queryFn: () => rpc<FbTrialServicesView | null>("an_fb_trial_services", { p_id: id }),
  meta: { errorMessage: "Не удалось загрузить пробные услуги FitBase" },
});

export type FbBasisOverview = {
  status: { state: string; checked_at: number | null; counts: Record<string, number> } | null;
  session: { updated_at: string } | null;
  job: { enabled: boolean } | null;
  connections: { id: number; name: string; city: string; domain: string; club_id: string }[];
  jobs: {
    connection_id: number;
    month: string;
    page: number;
    seen: number;
    total: number | null;
    finished_at: number;
    failed_at: number;
    error: string;
    passes: number;
    direction: number;
    last_attempt: number;
  }[];
  basis: Record<string, number>;
  pending: number;
};

/** Сборщик оснований записей: состояние, сессия, задания (администратору аналитики). */
export const fbBasisQuery = {
  queryKey: [...FB_KEY, "basis"],
  queryFn: () => rpc<FbBasisOverview>("an_fb_basis_overview"),
  // Пока задача включена — состояние обновляется само.
  refetchInterval: (q: { state: { data?: FbBasisOverview } }) =>
    q.state.data?.job?.enabled ? 15000 : false,
  meta: { errorMessage: "Не удалось загрузить сборщик оснований FitBase" },
};

export const fbRpc = {
  attendanceSettings: (id: number, status: string, rules: Record<string, string>) =>
    rpc<null>("an_fb_attendance_settings", { p_id: id, p_status: status, p_rules: rules }),
};

export function invalidateFitbase(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: FB_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}

/** «Мой город · FitBase»: факты выбранных студий человека (назначенные или все — администратору). */
export const fbMyCityQuery = (f: { from: string; to: string; city: string; studio: string }) => ({
  queryKey: [...FB_KEY, "mycity", f.from, f.to, f.city, f.studio],
  queryFn: () =>
    rpc<FbMyCityData>("an_fb_mycity_data", {
      p_from: f.from,
      p_to: f.to,
      p_city: f.city,
      p_studio: f.studio,
    }),
  retry: false,
  meta: { errorMessage: "Не удалось загрузить «Мой город · FitBase»" },
});

export type FbPartnerAccess = {
  connections: { id: number; name: string; city: string; brand: string }[];
  people: {
    user_id: string;
    full_name: string;
    position: string | null;
    email: string | null;
    active: boolean;
    admin: boolean;
    studios: number[];
  }[];
  targets: { city: string; amount_cents: number }[];
  cities: string[];
};

/** Доступ партнёров к «Моему городу · FitBase» и точка 0 городов (администратору аналитики). */
export const fbPartnerAccessQuery = {
  queryKey: [...FB_KEY, "partner-access"],
  queryFn: () => rpc<FbPartnerAccess>("an_fb_partner_access"),
  meta: { errorMessage: "Не удалось загрузить доступ партнёров FitBase" },
};
