import { lazy, Suspense, useState } from "react";
import { Bug } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { BUG_BUTTON_CLASS } from "@/lib/floating-layout";
import { cn } from "@/lib/utils";

// Форма — отдельным чанком: каркас портала (admin-shell) держим лёгким.
const BugReportForm = lazy(() => import("@/components/bug-report-form"));

/**
 * «Сообщить об ошибке» (решение владельца 2026-11-01): тёмная кнопка внизу
 * справа во всех разделах портала. Портал сам запоминает страницу, на которой
 * стоит человек (путь и заголовок), человек описывает, что не так.
 * С sm — пилюля с подписью, на телефоне — круглая кнопка-иконка. Рабочая
 * область оставляет под кнопкой запас (`.admin-main` в styles.css), поэтому
 * конец статьи или таблицы прокручивается из-под неё.
 */
export function BugReportButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void import("@/components/bug-report-form")}
        aria-label="Сообщить об ошибке"
        className={cn(BUG_BUTTON_CLASS, "pointer-events-auto", className)}
      >
        <Bug className="size-5 sm:size-4" />
        <span className="max-sm:sr-only">Сообщить об ошибке</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          {open && (
            <Suspense fallback={<div className="h-80" />}>
              <BugReportForm onDone={() => setOpen(false)} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
