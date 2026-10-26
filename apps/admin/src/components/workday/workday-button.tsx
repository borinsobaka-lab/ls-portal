import { lazy, Suspense, useState } from "react";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkdayGroups, useWorkdayStudio } from "@/lib/workday/data";
import { cn } from "@/lib/utils";

// Панель с пунктами и настройкой — отдельным чанком: в шапке базы знаний
// нужна только кнопка с отметкой «просрочено». Наведение грузит заранее.
const loadPanel = () => import("@/components/workday/workday-panel");
const WorkdayPanel = lazy(() => loadPanel().then((m) => ({ default: m.WorkdayPanel })));

/**
 * «Рабочий день» — справа от поиска клиента в шапке разделов клуба: Дашборд,
 * Клуб, Приложение, Скрипты, Управление; в базе знаний и «Академии» её нет
 * (решения владельца 2026-10-25, 2026-10-26): порядок дня администратора клуба с отметками. Есть пункт,
 * время которого прошло, а отметки нет, — на кнопке красный «!». Видна
 * сотрудникам клубов (owner/admin/trainer).
 */
export function WorkdayButton({ className }: { className?: string }) {
  const { studios, studio, setStudioId } = useWorkdayStudio();
  const { summary } = useWorkdayGroups(studio?.id ?? null);
  const [open, setOpen] = useState(false);
  if (!studio) return null;

  const label =
    summary.overdue > 0 ? `Рабочий день, просрочено пунктов: ${summary.overdue}` : "Рабочий день";
  return (
    <>
      <Button
        variant="outline"
        className={cn(
          "relative shrink-0 max-sm:w-10 max-sm:px-0 lg:max-xl:w-10 lg:max-xl:px-0",
          className,
        )}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadPanel()}
        onFocus={() => void loadPanel()}
      >
        <ClipboardList />
        {/* С lg до xl в шапке тесно — только иконка (подпись — в title). */}
        <span className="max-sm:hidden lg:max-xl:hidden">Рабочий день</span>
        {summary.overdue > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-destructive text-xs leading-none font-bold text-white"
          >
            !
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
          <Suspense
            fallback={
              <div className="space-y-3 p-6">
                <SheetTitle>Рабочий день</SheetTitle>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            }
          >
            {open && <WorkdayPanel studios={studios} studio={studio} onStudio={setStudioId} />}
          </Suspense>
        </SheetContent>
      </Sheet>
    </>
  );
}
