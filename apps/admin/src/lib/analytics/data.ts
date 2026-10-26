/**
 * «Аналитика сети» — загрузка и запись (React Query + RPC an_*,
 * db/migrations/2026-10-26_zzz_analytics_network.sql). Отчёты — только
 * агрегаты по студиям, которые видит сотрудник (все — «Аналитика сети: все
 * клубы», свои города — «свои города»); строки приходят массивами и
 * раскладываются здесь (lib/analytics/types.ts). Ключи — ["analytics", …].
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  AnAccess,
  AnKind,
  AnScope,
  AnSource,
  AnStudio,
  ClassRow,
  Period,
  RevenueRow,
  SaleOrigin,
  SalesData,
  TrialRow,
  ZeroRow,
} from "./types";

export const ANALYTICS_KEY = "analytics";

export type Bucket = "day" | "month";

export async function anRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => String(v ?? "");

export type { AnAccess } from "./types";

export const analyticsAccessQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "access"],
  queryFn: () => anRpc<AnAccess>("an_access"),
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить права в «Аналитике»" },
});

type RawStudio = {
  id: string;
  name: string;
  city: string | null;
  partner: string | null;
  source: AnSource;
  brand_id: string | null;
  brand_name: string | null;
  closed_on: string | null;
  needs_review: boolean;
};

export function parseStudio(s: RawStudio): AnStudio {
  return {
    id: s.id,
    name: s.name,
    city: s.city,
    partner: s.partner,
    source: s.source,
    brandId: s.brand_id,
    brandName: s.brand_name,
    closedOn: s.closed_on,
    needsReview: s.needs_review,
  };
}

export const analyticsScopeQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "scope"],
  queryFn: async (): Promise<AnScope> => {
    const raw = await anRpc<{
      today: string;
      can_manage: boolean;
      studios: RawStudio[];
      targets: Record<string, number | string>;
      loaded: AnScope["loaded"];
    }>("an_scope");
    return {
      today: raw.today,
      canManage: raw.can_manage,
      studios: raw.studios.map(parseStudio),
      targets: Object.fromEntries(Object.entries(raw.targets).map(([c, v]) => [c, Number(v)])),
      loaded: raw.loaded,
    };
  },
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить студии аналитики" },
});

const args = (ids: string[] | null, p: Period, bucket?: Bucket) => ({
  p_studio_ids: ids,
  p_from: p.from,
  p_to: p.to,
  ...(bucket ? { p_bucket: bucket } : {}),
});

const key = (name: string, ids: string[] | null, p: Period, bucket?: Bucket) => [
  ANALYTICS_KEY,
  name,
  ids ? ids.join(",") : "all",
  p.from,
  p.to,
  bucket ?? "",
];

export function revenueQuery(ids: string[] | null, p: Period, bucket: Bucket = "day") {
  return queryOptions({
    queryKey: key("revenue", ids, p, bucket),
    queryFn: async (): Promise<RevenueRow[]> =>
      (await anRpc<unknown[][]>("an_revenue_report", args(ids, p, bucket))).map((r) => ({
        studioId: str(r[0]),
        date: str(r[1]),
        income: num(r[2]),
        expense: num(r[3]),
      })),
    meta: { errorMessage: "Не удалось загрузить выручку" },
  });
}

export function salesQuery(ids: string[] | null, p: Period, bucket: Bucket = "day") {
  return queryOptions({
    queryKey: key("sales", ids, p, bucket),
    queryFn: async (): Promise<SalesData> => {
      const raw = await anRpc<{ sold: unknown[][]; names: Record<string, string> }>(
        "an_sales_report",
        args(ids, p, bucket),
      );
      return {
        names: raw.names,
        sold: raw.sold.map((r) => ({
          studioId: str(r[0]),
          date: str(r[1]),
          nomenclatureId: str(r[2]),
          origin: r[3] as SaleOrigin,
          count: num(r[4]),
          paid: num(r[5]),
          cost: num(r[6]),
        })),
      };
    },
    meta: { errorMessage: "Не удалось загрузить продажи" },
  });
}

export function classesQuery(ids: string[] | null, p: Period, bucket: Bucket = "day") {
  return queryOptions({
    queryKey: key("classes", ids, p, bucket),
    queryFn: async (): Promise<ClassRow[]> =>
      (await anRpc<unknown[][]>("an_classes_report", args(ids, p, bucket))).map((r) => ({
        studioId: str(r[0]),
        date: str(r[1]),
        direction: str(r[2]),
        classes: num(r[3]),
        booked: num(r[4]),
        attended: num(r[5]),
      })),
    meta: { errorMessage: "Не удалось загрузить занятия" },
  });
}

export function trialsQuery(ids: string[] | null, p: Period, bucket: Bucket = "day") {
  return queryOptions({
    queryKey: key("trials", ids, p, bucket),
    queryFn: async (): Promise<TrialRow[]> =>
      (await anRpc<unknown[][]>("an_trials_report", args(ids, p, bucket))).map((r) => ({
        studioId: str(r[0]),
        date: str(r[1]),
        membership: str(r[2]),
        trials: num(r[3]),
        attended: num(r[4]),
        day0: num(r[5]),
        d14: num(r[6]),
        open: num(r[7]),
      })),
    meta: { errorMessage: "Не удалось загрузить пробные" },
  });
}

export function zeroQuery(ids: string[] | null, p: Period) {
  return queryOptions({
    queryKey: key("zero", ids, p),
    queryFn: async (): Promise<ZeroRow[]> =>
      (await anRpc<unknown[][]>("an_zero_report", args(ids, p))).map((r) => ({
        studioId: str(r[0]),
        name: str(r[1]),
        category: str(r[2]),
        count: num(r[3]),
        lastOn: str(r[4]),
      })),
    meta: { errorMessage: "Не удалось загрузить нулевые продажи" },
  });
}

// ---------------------------------------------------------------------------
// Справочники и загрузки (право «Аналитика сети: загрузка и справочники»)

export type AnStudioRow = AnStudio & {
  note: string | null;
  /** Клуб портала за студией выгрузки (доступ «Аналитика сети: свои клубы»). */
  clubId: string | null;
  clubName: string | null;
  firstDay: string | null;
  lastDay: string | null;
};

export const anStudiosListQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "studios-list"],
  queryFn: async (): Promise<AnStudioRow[]> =>
    (
      await anRpc<
        (RawStudio & {
          note: string | null;
          club_id: string | null;
          club_name: string | null;
          first_day: string | null;
          last_day: string | null;
        })[]
      >("an_studios_list")
    ).map((s) => ({
      ...parseStudio({ ...s, brand_name: null }),
      note: s.note,
      clubId: s.club_id,
      clubName: s.club_name,
      firstDay: s.first_day,
      lastDay: s.last_day,
    })),
  meta: { errorMessage: "Не удалось загрузить студии" },
});

export type AnNomenclatureRow = {
  id: string;
  source: AnSource;
  code: string;
  name: string;
  category: string;
  direction: string | null;
};

export const anNomenclatureQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "nomenclature"],
  queryFn: async (): Promise<AnNomenclatureRow[]> => {
    const out: AnNomenclatureRow[] = [];
    // Справочник бывает больше лимита PostgREST (1000 строк на ответ).
    for (let lo = 0; ; lo += 1000) {
      const { data, error } = await supabase
        .from("an_nomenclature")
        .select("id, source, code, name, category, direction")
        .order("name")
        .order("id")
        .range(lo, lo + 999);
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as AnNomenclatureRow[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  },
  meta: { errorMessage: "Не удалось загрузить номенклатуру" },
});

export type AnImportRow = {
  id: string;
  kind: AnKind;
  source: AnSource;
  file_name: string | null;
  date_from: string;
  date_to: string;
  rows_count: number;
  status: "loading" | "done";
  created_at: string;
  created_by_name: string | null;
  studio_ids: string[];
};

export const anImportsQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "imports"],
  queryFn: async (): Promise<AnImportRow[]> => {
    const { data, error } = await supabase
      .from("an_imports")
      .select(
        "id, kind, source, file_name, date_from, date_to, rows_count, status, created_at, created_by_name, studio_ids",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as AnImportRow[];
  },
  meta: { errorMessage: "Не удалось загрузить журнал загрузок" },
});

export type AnPartner = { user_id: string; name: string | null; email: string; cities: string[] };

export const anPartnersQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "partners"],
  queryFn: () => anRpc<AnPartner[]>("an_partners_list"),
  meta: { errorMessage: "Не удалось загрузить партнёров" },
});

/** Точки 0 всех городов (для справочника) — из an_scope у управляющего. */
export function invalidateAnalytics(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: [ANALYTICS_KEY] });
}
