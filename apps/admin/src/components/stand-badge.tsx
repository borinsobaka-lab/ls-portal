import { IS_STAND } from "@/lib/brand";

/**
 * Метка тестового стенда «Аналитики» (`VITE_STAND=true`, DEPLOY.md, шаг 18):
 * оранжевая полоса по верхнему краю и плашка «Тестовый стенд» внизу по
 * центру. Не перехватывает нажатия. На рабочем портале не рисуется.
 */
export function StandBadge() {
  if (!IS_STAND) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100]">
      <div className="h-1 bg-amber-500" />
      <div className="fixed bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white shadow-md">
        Тестовый стенд — не рабочий портал
      </div>
    </div>
  );
}
