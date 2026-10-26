import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { setActiveStudioId, useActiveStudioId } from "@/hooks/use-active-studio";
import { useStudios, type Studio } from "@/hooks/use-studios";
import { unwrap } from "@/lib/query";
import {
  groupWorkday,
  tbilisiNow,
  workdaySummary,
  type WorkdayCheck,
  type WorkdayData,
  type WorkdayItem,
  type WorkdaySection,
} from "@/lib/workday/logic";

/** Ключ кэша: ["workday", studioId, day]. После правки — invalidate ["workday"]. */
export const WORKDAY_KEY = "workday";

/**
 * Пункты клуба и отметки за сегодня. Отмечают несколько человек сразу —
 * раз в минуту и при возврате на вкладку список перезапрашивается.
 */
export function useWorkday(studioId: string | null, day: string) {
  return useQuery({
    queryKey: [WORKDAY_KEY, studioId, day],
    queryFn: async (): Promise<WorkdayData> => {
      const [sections, items, checks] = await Promise.all([
        unwrap<WorkdaySection[]>(
          supabase
            .from("workday_sections")
            .select("id, studio_id, title, sort_order")
            .eq("studio_id", studioId!),
        ),
        unwrap<WorkdayItem[]>(
          supabase
            .from("workday_items")
            .select("id, studio_id, section_id, title, details, due_time, sort_order")
            .eq("studio_id", studioId!),
        ),
        unwrap<WorkdayCheck[]>(
          supabase
            .from("workday_checks")
            .select("item_id, day, checked_by, checked_by_name, checked_at")
            .eq("studio_id", studioId!)
            .eq("day", day),
        ),
      ]);
      return { sections, items, checks };
    },
    enabled: !!studioId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    meta: { errorMessage: "Не удалось загрузить рабочий день" },
  });
}

/** Сейчас по Тбилиси; обновляется раз в 30 секунд — «просрочено» загорается само. */
export function useTbilisiClock() {
  const [now, setNow] = useState(() => tbilisiNow());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(tbilisiNow()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Клуб «Рабочего дня» — клуб из шапки (выбор клуба справа): пункты у каждого
 * клуба свои и меняются вместе с ним (решение владельца 2026-10-26). Выбор
 * клуба в шторке переключает тот же клуб шапки.
 */
export function useWorkdayStudio(): {
  studios: Studio[];
  studio: Studio | null;
  setStudioId: (id: string) => void;
} {
  const { data: studios = [] } = useStudios();
  const activeId = useActiveStudioId();
  const studio = studios.find((s) => s.id === activeId) ?? studios[0] ?? null;
  return { studios, studio, setStudioId: setActiveStudioId };
}

/** Блоки, пункты и итог дня выбранного клуба — общий расчёт кнопки и панели. */
export function useWorkdayGroups(studioId: string | null) {
  const now = useTbilisiClock();
  const query = useWorkday(studioId, now.day);
  const groups = useMemo(
    () => (query.data ? groupWorkday(query.data, now.minutes) : []),
    [query.data, now.minutes],
  );
  return { query, now, groups, summary: workdaySummary(groups) };
}
