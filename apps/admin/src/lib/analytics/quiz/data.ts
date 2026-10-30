/**
 * Квиз: запросы лендинга (RPC an_quiz_landing — без входа) и страниц
 * администратора аналитики (an_quiz_* — права проверяет база; схема —
 * db/migrations/2026-10-30_zzzzzzzzzzzz_analytics_quiz.sql). Заявку лендинг
 * шлёт на сервер портала — /api/analytics/quiz/leads.
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";

export const QUIZ_KEY = [ANALYTICS_KEY, "quiz"] as const;

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type QuizLocation = {
  address: string;
  landmark: string;
  phone_display: string;
  phone_href: string;
};

/** Город лендинга (их config.js). */
export type QuizLanding = {
  slug: string;
  city: string;
  trial_price: number;
  completed_count: string;
  landing_version: string;
  locations: QuizLocation[];
  operator_name: string;
  operator_inn: string;
};

export const quizLandingQuery = (slug: string) => ({
  queryKey: ["quiz-landing", slug],
  queryFn: () => rpc<QuizLanding | null>("an_quiz_landing", { p_slug: slug }),
  staleTime: 5 * 60_000,
  retry: 1,
});

export type QuizCityRow = QuizLanding & {
  id: number;
  spreadsheet_id: string;
  sheet_name: string;
  is_default: boolean;
  updated_at: string;
  leads: number;
  pending: number;
};

export type QuizOverview = {
  cities: QuizCityRow[];
  total: number;
  pending: number;
  errors: number;
  last_at: string | null;
};

export const quizOverviewQuery = {
  queryKey: [...QUIZ_KEY, "overview"],
  queryFn: () => rpc<QuizOverview>("an_quiz_overview"),
  meta: { errorMessage: "Не удалось загрузить квиз-лендинги" },
};

export type QuizLeadRow = {
  id: number;
  created_at: string;
  city: string;
  name: string;
  phone: string;
  recommendation: string;
  pain: string;
  duration: string;
  barrier: string;
  utm: Record<string, string>;
  consent_at: string;
  sheet_synced_at: string | null;
  sheet_error: string;
};

export type QuizLeadsPage = { total: number; cities: string[]; rows: QuizLeadRow[] };

export const quizLeadsQuery = (city: string, status: string, page: number, pageSize: number) => ({
  queryKey: [...QUIZ_KEY, "leads", city, status, page, pageSize],
  queryFn: () =>
    rpc<QuizLeadsPage>("an_quiz_leads", {
      p_city: city,
      p_status: status,
      p_limit: pageSize,
      p_offset: (page - 1) * pageSize,
    }),
  placeholderData: (prev: QuizLeadsPage | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить заявки квиза" },
});

/** Поля окна города (RPC an_quiz_city_save). */
export type QuizCityInput = {
  slug: string;
  city: string;
  trial_price: string;
  completed_count: string;
  landing_version: string;
  locations: QuizLocation[];
  operator_name: string;
  operator_inn: string;
  spreadsheet_id: string;
  sheet_name: string;
  is_default: boolean;
};

export const quizRpc = {
  saveCity: (id: number | null, data: QuizCityInput) =>
    rpc<number>("an_quiz_city_save", { p_id: id, p_data: data }),
  removeCity: (id: number) => rpc<null>("an_quiz_city_delete", { p_id: id }),
  removeLead: (id: number) => rpc<null>("an_quiz_lead_delete", { p_id: id }),
};

export function invalidateQuiz(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: QUIZ_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}
