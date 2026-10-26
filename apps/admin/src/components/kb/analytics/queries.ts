import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  KbOverview,
  KbPeriod,
  KbPersonDetail,
  KbPersonRow,
  KbReader,
  KbReportRow,
  KbSearchStats,
} from "@/lib/kb/analytics";
import type { KbRatingsReport } from "@/lib/kb/ratings";
import { unwrap } from "@/lib/query";

/**
 * Запросы аналитики базы знаний (RPC — редакторам базы и владельцам).
 * Смена периода показывает прежние цифры, пока грузятся новые
 * (keepPreviousData): страница не мигает болванками.
 */

export function useKbOverview(baseId: string, period: KbPeriod, enabled: boolean) {
  return useQuery({
    queryKey: ["kb_analytics_overview", baseId, period],
    queryFn: () =>
      unwrap<KbOverview>(
        supabase.rpc("kb_analytics_overview", { p_base: baseId, p_days: Number(period) }),
      ),
    enabled,
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить аналитику" },
  });
}

/** Только журнал поиска — без пар сотрудник × статья, которые считает обзор. */
export function useKbSearchStats(baseId: string, period: KbPeriod) {
  return useQuery({
    queryKey: ["kb_analytics_search", baseId, period],
    queryFn: () =>
      unwrap<KbSearchStats>(
        supabase.rpc("kb_analytics_search", { p_base: baseId, p_days: Number(period) }),
      ),
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить статистику поиска" },
  });
}

export function useKbPeople(baseId: string, period: KbPeriod, enabled: boolean) {
  return useQuery({
    queryKey: ["kb_analytics_people", baseId, period],
    queryFn: () =>
      unwrap<KbPersonRow[]>(
        supabase.rpc("kb_analytics_people", { p_base: baseId, p_days: Number(period) }),
      ),
    enabled,
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить сотрудников" },
  });
}

export function useKbPerson(baseId: string, userId: string | null) {
  return useQuery({
    queryKey: ["kb_analytics_person", baseId, userId],
    queryFn: () =>
      unwrap<KbPersonDetail>(
        supabase.rpc("kb_analytics_person", { p_base: baseId, p_user: userId }),
      ),
    enabled: !!userId,
    meta: { errorMessage: "Не удалось загрузить чтение сотрудника" },
  });
}

export function useKbReport(baseId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["kb_report", baseId],
    queryFn: () => unwrap<KbReportRow[]>(supabase.rpc("kb_report", { p_base: baseId })),
    enabled,
    meta: { errorMessage: "Не удалось загрузить статьи" },
  });
}

export const KB_READERS_KEY = "kb_article_readers";

/** Кто должен прочитать статью и что с чтением (RPC kb_article_readers; редакторам). */
export function useKbReaders(nodeId: string, enabled = true) {
  return useQuery({
    queryKey: [KB_READERS_KEY, nodeId],
    queryFn: () => unwrap<KbReader[]>(supabase.rpc("kb_article_readers", { p_node: nodeId })),
    enabled,
    meta: { errorMessage: "Не удалось загрузить, кто прочитал статью" },
  });
}

/** Оценки статей базы: итоги, по статьям, хронология (RPC kb_ratings_report). */
export function useKbRatings(baseId: string, period: KbPeriod, enabled = true) {
  return useQuery({
    queryKey: ["kb_ratings_report", baseId, period],
    queryFn: () =>
      unwrap<KbRatingsReport>(
        supabase.rpc("kb_ratings_report", { p_base: baseId, p_days: Number(period) }),
      ),
    enabled,
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить оценки статей" },
  });
}
