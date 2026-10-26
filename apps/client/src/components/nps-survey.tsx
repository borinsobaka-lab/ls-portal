import { Suspense, lazy, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";

import { useAuth } from "@/hooks/use-auth";
import type { NpsSurvey } from "@/lib/nps";
import { npsSurveyQuery } from "@/lib/nps-data";

// Окно — отдельным чанком: оно нужно редко, а этот компонент — в каркасе.
const NpsSurveyDialog = lazy(() => import("@/components/nps-survey-dialog"));

/**
 * Через сколько после открытия главной показать опрос: экран успевает
 * отрисоваться, салют после входа — отгреметь.
 */
const SHOW_DELAY_MS = 2500;

/**
 * NPS-опрос (решение владельца 2026-10-15): какой опрос положен клиенту,
 * решает база (lib/nps-data.ts); показывается на главной — не посреди записи
 * на тренировку или покупки. Опрос проверяется при открытии главной и при
 * возвращении в приложение (React Query, раз в 5 минут). Стоит в AppShell
 * (`__root.tsx`) — только у вошедшего клиента после анкеты.
 */
export function NpsSurveyHost() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const onHome = useRouterState({ select: (s) => s.location.pathname === "/" });
  const options = npsSurveyQuery(userId);
  const { data: survey } = useQuery({ ...options, enabled: options.enabled && onHome });
  const [active, setActive] = useState<NpsSurvey | null>(null);

  useEffect(() => {
    if (!onHome || !survey || active) return;
    const timer = window.setTimeout(() => setActive(survey), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [onHome, survey, active]);

  // Другой клиент вошёл на этом телефоне — чужой опрос не показываем.
  useEffect(() => {
    setActive(null);
  }, [userId]);

  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <NpsSurveyDialog
        survey={active}
        onDone={() => {
          // Закрыт или отвечен — в базе он больше не положен.
          queryClient.setQueryData(options.queryKey, null);
          setActive(null);
        }}
      />
    </Suspense>
  );
}
