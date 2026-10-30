/**
 * Отчёты 1С в браузере: сведения о снимке и агрегаты (RPC an_onec_report_meta,
 * an_onec_aggregate — права и города партнёра проверяет база), из них —
 * данные доски по их full_reports.py (payload.ts).
 */
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "../data";
import {
  BOARD_NAMES,
  onecPayload,
  parseAggregate,
  type OnecBoard,
  type OnecGrain,
  type OnecParams,
  type OnecPayload,
  type OnecReportMeta,
} from "./payload";

export type OnecReportResult = { empty: true } | { empty: false; payload: OnecPayload };

/** Подпись под периодом — как их page(): что сравнивается и что значит прогноз. */
export const ONEC_BOARD_NOTICE: Record<OnecBoard, string> = {
  revenue:
    "Прогноз месяца доступен для периода с 1-го числа одного месяца. Точка 0 — месячная цель города.",
  sales: "Сравнения используют соответствующий диапазон прошлого месяца и прошлого года.",
  activities: "Сравнения используют соответствующий диапазон прошлого месяца и прошлого года.",
  partner: "Сравнения используют соответствующий диапазон прошлого месяца и прошлого года.",
  funnel: "",
  zero: "",
};

export const ONEC_BOARD_TITLES = BOARD_NAMES;

/**
 * Кнопки «С начала месяца / квартала / года»: их *-reference.js убирают их у
 * «Продаж», «Занятий», «Воронки» и «Моего города»; у «Выручки» и «Нулевой
 * номенклатуры» они остаются.
 */
export const ONEC_BOARD_PRESETS: Record<OnecBoard, boolean> = {
  revenue: true,
  zero: true,
  sales: false,
  activities: false,
  funnel: false,
  partner: false,
};

export function onecReportQuery(board: OnecBoard, params: OnecParams) {
  const studio = board === "partner" ? (params.studio ?? "") : "";
  // Город без студии данные не меняет (их partner_payload фильтрует по
  // городу только вместе со студией) — и не перезапрашивает их.
  const city = studio ? (params.city ?? "") : "";
  return {
    queryKey: [
      ANALYTICS_KEY,
      "onec-report",
      board,
      params.start ?? "",
      params.end ?? "",
      studio,
      city,
    ],
    queryFn: async (): Promise<OnecReportResult> => {
      const meta = await unwrap<OnecReportMeta | null>(
        supabase.rpc("an_onec_report_meta", { p_board: board }),
      );
      if (!meta) return { empty: true };
      const payload = await onecPayload(
        board,
        { start: params.start, end: params.end, studio, city },
        meta,
        async (report, start, end, grain: OnecGrain = "detail") =>
          parseAggregate(
            grain,
            await unwrap(
              supabase.rpc("an_onec_aggregate", {
                p_board: board,
                p_report: report,
                p_start: start,
                p_end: end,
                p_grain: grain,
                p_studio: studio,
                p_city: city,
              }),
            ),
          ),
      );
      return { empty: false, payload };
    },
    staleTime: 5 * 60_000,
    placeholderData: (prev: OnecReportResult | undefined) => prev,
    meta: { errorMessage: `Не удалось загрузить отчёт «${BOARD_NAMES[board]}»` },
  };
}

/** Ошибки базы и расчёта — по-русски (их тексты проходят как есть). */
export function onecReportErrorText(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (m.includes("an_forbidden")) return "Отчёт не назначен пользователю";
  if (m.includes("an_onec_empty")) return "Загрузите пакет обработчика";
  return m;
}
