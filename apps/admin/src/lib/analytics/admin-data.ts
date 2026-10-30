/**
 * «Аналитика» → «Администрирование»: запросы партнёров, посещаемости,
 * журнала и ключей API (RPC an_* — права проверяет база; схема —
 * db/migrations/2026-10-30_zz_analytics_core_admin.sql).
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import type { AnActivityRow } from "./core";
import { ANALYTICS_KEY } from "./data";

/** Человек портала в «Аналитике»: имя, должность, почта, может ли войти. */
export type AnPerson = {
  user_id: string;
  full_name: string;
  position: string | null;
  email: string | null;
  active: boolean;
};

export type AnPartner = AnPerson & {
  cities: string[];
  /** Из маркетинга и отзывов: «mkt.ls», «mkt.lj», «reviews». */
  reports: string[];
};

export type AnPartnerCard = AnPerson & {
  profile: {
    phone: string;
    telegram: string;
    max_messenger: string;
    individual_entrepreneur: string;
    inn: string;
  };
  cities: {
    city: string;
    trial_price: string;
    directions: string;
    studios: { name: string; status: string }[];
  }[];
};

export type AnAuditRow = {
  id: number;
  created_at: string;
  user_id: string | null;
  full_name: string | null;
  event: string;
  details: string | null;
};

export type AnApiOverview = {
  keys: {
    id: number;
    label: string;
    is_active: boolean;
    created_at: string;
    last_used_at: string | null;
    requests_30d: number;
  }[];
  requests: {
    id: number;
    requested_at: string;
    label: string | null;
    method: string;
    path: string;
    query: string;
    status_code: number;
    response_bytes: number;
  }[];
};

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export const AN_PARTNERS_KEY = [ANALYTICS_KEY, "partners"] as const;

export const anPartnersQuery = {
  queryKey: [...AN_PARTNERS_KEY, "list"],
  queryFn: () => rpc<AnPartner[]>("an_partners"),
  meta: { errorMessage: "Не удалось загрузить партнёров" },
};

export const anPartnerCandidatesQuery = {
  queryKey: [...AN_PARTNERS_KEY, "candidates"],
  queryFn: () => rpc<AnPerson[]>("an_partner_candidates"),
  meta: { errorMessage: "Не удалось загрузить пользователей" },
};

export const anPartnerCitiesQuery = {
  queryKey: [...AN_PARTNERS_KEY, "cities"],
  queryFn: () => rpc<string[]>("an_partner_city_options"),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить города" },
};

export const anPartnerCardQuery = (userId: string) => ({
  queryKey: [...AN_PARTNERS_KEY, "card", userId],
  queryFn: () => rpc<AnPartnerCard>("an_partner_card", { p_user: userId }),
  meta: { errorMessage: "Не удалось загрузить карточку партнёра" },
});

export const anPartnerRpc = {
  add: (user: string, cities: string[]) =>
    rpc<null>("an_partner_add", { p_user: user, p_cities: cities }),
  setCities: (user: string, cities: string[]) =>
    rpc<null>("an_partner_set_cities", { p_user: user, p_cities: cities }),
  remove: (user: string) => rpc<null>("an_partner_remove", { p_user: user }),
  saveCard: (
    user: string,
    card: AnPartnerCard["profile"] & {
      cities: { city: string; trial_price: string; directions: string }[];
    },
  ) => rpc<null>("an_partner_card_save", { p_user: user, p: card }),
};

/** После правки партнёров: списки, карточка и журнал. */
export function invalidatePartners(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: AN_PARTNERS_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}

/** Их activity_page: «Обновляется раз в минуту». */
export const anActivityQuery = (from: string, to: string) => ({
  queryKey: [ANALYTICS_KEY, "activity", from, to],
  queryFn: () => rpc<AnActivityRow[]>("an_activity_report", { p_from: from, p_to: to }),
  refetchInterval: 60_000,
  placeholderData: (prev: AnActivityRow[] | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить посещаемость" },
});

/** Их «Последняя активность» — последние 20 действий; дальше — по страницам. */
export const anJournalQuery = (page: number, size: number) => ({
  queryKey: [ANALYTICS_KEY, "journal", page, size],
  queryFn: () =>
    rpc<{ total: number; rows: AnAuditRow[] }>("an_audit_list", {
      p_limit: size,
      p_offset: (page - 1) * size,
    }),
  placeholderData: (prev: { total: number; rows: AnAuditRow[] } | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить журнал" },
});

export const anApiQuery = {
  queryKey: [ANALYTICS_KEY, "api"],
  queryFn: () => rpc<AnApiOverview>("an_api_overview"),
  meta: { errorMessage: "Не удалось загрузить ключи API" },
};

export const anApiRpc = {
  create: (label: string, hash: string) =>
    rpc<number>("an_api_key_create", { p_label: label, p_hash: hash }),
  setActive: (id: number, active: boolean) =>
    rpc<null>("an_api_key_set_active", { p_id: id, p_active: active }),
};
