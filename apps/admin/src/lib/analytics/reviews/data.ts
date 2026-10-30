/**
 * «Аналитика» → «Отзывы»: запросы и записи (RPC an_rv_* — права проверяет
 * база; схема — db/migrations/2026-10-30_zzzz_analytics_reviews.sql).
 */
import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import type { Inflate } from "../onec/xlsx-read";
import { reviewPeriod, reviewRecords, type ReviewRecord } from "./parse";

export const RV_KEY = [ANALYTICS_KEY, "reviews"] as const;

export type RvComment = {
  id: number;
  client_name: string;
  studio: string;
  rating: number;
  comment: string;
  trainer: string;
  service: string;
  rating_date: string;
};

export type RvTrainer = {
  trainer: string;
  count: number;
  average: number;
  negative: number;
  comments: number;
};

export type RvReport = {
  total: number;
  period_from: string | null;
  period_to: string | null;
  average: number;
  negative: number;
  ratings: { rating: number; count: number }[];
  trainers: RvTrainer[];
  comments: RvComment[];
};

export type RvReportResult = { cities: string[]; city: string; report: RvReport | null };

export type RvUpload = {
  id: number;
  filename: string;
  imported_by: string;
  imported_at: string;
  row_count: number;
  period_from: string;
  period_to: string;
};

export type RvStaffLink = {
  user_id: string;
  full_name: string;
  position: string | null;
  link_id: number | null;
  token: string | null;
  is_active: boolean | null;
};

export type RvStaffEmployee = {
  name: string;
  position: string;
  count: number;
  professionalism_average: number;
  next_steps_average: number;
  overall_average: number;
  comments: number;
};

export type RvStaffResponse = {
  id: number;
  full_name: string;
  position: string | null;
  partner_name: string;
  partner_city: string;
  professionalism_rating: number;
  professionalism_comment: string;
  next_steps_rating: number;
  next_steps_comment: string;
  submitted_at: string;
};

export type RvStaffReport = {
  total: number;
  employees: RvStaffEmployee[];
  responses: RvStaffResponse[];
};

const rpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

/** Их «Статистика клиентов»: город (не тот — первый разрешённый) и период. */
export const rvReportQuery = (city: string, from: string, to: string) => ({
  queryKey: [...RV_KEY, "report", city, from, to],
  queryFn: () => rpc<RvReportResult>("an_rv_report", { p_city: city, p_from: from, p_to: to }),
  placeholderData: (prev: RvReportResult | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить отзывы" },
});

export const rvUploadsQuery = {
  queryKey: [...RV_KEY, "uploads"],
  queryFn: () => rpc<RvUpload[]>("an_rv_uploads"),
  meta: { errorMessage: "Не удалось загрузить историю выгрузок" },
};

export const rvStaffLinksQuery = {
  queryKey: [...RV_KEY, "staff-links"],
  queryFn: () => rpc<RvStaffLink[]>("an_rv_staff_links"),
  meta: { errorMessage: "Не удалось загрузить ссылки сотрудников" },
};

export const rvStaffReportQuery = (from: string, to: string) => ({
  queryKey: [...RV_KEY, "staff-report", from, to],
  queryFn: () => rpc<RvStaffReport>("an_rv_staff_report", { p_from: from, p_to: to }),
  placeholderData: (prev: RvStaffReport | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить отзывы партнёров" },
});

export const rvRpc = {
  deleteUpload: (id: number) => rpc<null>("an_rv_upload_delete", { p_upload: id }),
  createLink: (userId: string) => rpc<string>("an_rv_staff_link_create", { p_user: userId }),
  setLinkActive: (linkId: number, active: boolean) =>
    rpc<null>("an_rv_staff_link_set_active", { p_link: linkId, p_active: active }),
};

export function invalidateReviews(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: RV_KEY }),
    qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "journal"] }),
  ]);
}

const browserInflate: Inflate = async function* (data) {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
};

/** Строк в одном вызове: пачка ~1 МБ запроса. */
const IMPORT_CHUNK = 2000;

/**
 * Их import_reviews: файл разбирается в браузере их правилами, затем —
 * запись загрузки, строки пачками (повторы база не добавит), итог в журнал.
 */
export async function importReviews(
  file: File,
  onProgress: (text: string) => void,
): Promise<{ rows: number; duplicates: number }> {
  onProgress("Читаю выгрузку…");
  const records = await reviewRecords(
    file.name,
    new Uint8Array(await file.arrayBuffer()),
    browserInflate,
  );
  const period = reviewPeriod(records);
  const uploadId = await rpc<number>("an_rv_import_start", {
    p_filename: file.name.split(/[\\/]/).pop() ?? file.name,
    p_period_from: period.from,
    p_period_to: period.to,
  });
  for (let i = 0; i < records.length; i += IMPORT_CHUNK) {
    onProgress(
      `Добавляю оценки: ${Math.min(i + IMPORT_CHUNK, records.length).toLocaleString("ru-RU")} из ${records.length.toLocaleString("ru-RU")}`,
    );
    const chunk: ReviewRecord[] = records.slice(i, i + IMPORT_CHUNK);
    await rpc<number>("an_rv_import_rows", { p_upload: uploadId, p_rows: chunk });
  }
  const result = await rpc<{ rows: number; duplicates: number }>("an_rv_import_finish", {
    p_upload: uploadId,
    p_total: records.length,
  });
  return result;
}

// --- Публичная форма ---------------------------------------------------------------

export type RvFormInfo = { full_name: string; position: string | null } | null;

export const rvFormQuery = (token: string) => ({
  queryKey: ["analytics-feedback", token],
  queryFn: () => rpc<RvFormInfo>("an_rv_feedback_form", { p_token: token }),
  staleTime: Infinity,
  retry: false,
});

export type RvFeedback = {
  partnerName: string;
  partnerCity: string;
  professionalismRating: string;
  professionalismComment: string;
  nextStepsRating: string;
  nextStepsComment: string;
};

export function submitFeedback(token: string, f: RvFeedback) {
  return rpc<{ full_name: string }>("an_rv_feedback_submit", {
    p_token: token,
    p_partner_name: f.partnerName,
    p_partner_city: f.partnerCity,
    p_professionalism_rating: f.professionalismRating,
    p_professionalism_comment: f.professionalismComment,
    p_next_steps_rating: f.nextStepsRating,
    p_next_steps_comment: f.nextStepsComment,
  });
}
