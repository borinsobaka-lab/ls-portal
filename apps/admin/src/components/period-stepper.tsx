import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Листание периода в плашке фильтров: ← «Текущая неделя» → и подпись
 * периода. Одно на «Расписание» (неделя), «График администраторов» и
 * «Зарплаты» (месяц). Кнопки круглые и пилюлей, как все кнопки.
 *
 * На телефоне отдельной подписи нет места: кнопка между стрелками
 * показывает сам период и по-прежнему возвращает к текущему.
 * `children` — справа от подписи (спиннер обновления).
 */
export function PeriodStepper({
  label,
  unit,
  onPrev,
  onNext,
  onCurrent,
  isCurrent,
  children,
}: {
  /** Подпись периода: «Октябрь 2026», «6–12 окт.». */
  label: string;
  /** Что листаем — для подписей кнопок. */
  unit: "week" | "month";
  onPrev: () => void;
  onNext: () => void;
  onCurrent: () => void;
  /** Уже открыт текущий период — кнопка возврата неактивна. */
  isCurrent: boolean;
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const t =
    unit === "week"
      ? { prev: "Предыдущая неделя", next: "Следующая неделя", current: "Текущая неделя" }
      : { prev: "Предыдущий месяц", next: "Следующий месяц", current: "Текущий месяц" };
  return (
    <div className="toolbar-full flex items-center gap-2">
      <Button variant="outline" size="icon" aria-label={t.prev} onClick={onPrev}>
        <ChevronLeft />
      </Button>
      <Button
        variant="outline"
        className="max-sm:flex-1"
        onClick={onCurrent}
        // На телефоне кнопка — ещё и подпись периода: серой её не делаем.
        disabled={isCurrent && !isMobile}
      >
        <span className="sm:hidden">{label}</span>
        <span className="max-sm:hidden">{t.current}</span>
      </Button>
      <Button variant="outline" size="icon" aria-label={t.next} onClick={onNext}>
        <ChevronRight />
      </Button>
      <span className="ml-1 text-sm font-semibold max-sm:hidden">{label}</span>
      {children}
    </div>
  );
}
