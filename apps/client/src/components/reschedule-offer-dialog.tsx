import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * После отмены записи на групповую тренировку — предложение выбрать другое
 * время (решение владельца 2026-10-21, вместо вопроса о причине отмены).
 * «Выбрать время» — в расписание: с главной переход, в расписании —
 * закрыть шторку тренировки.
 */
export function RescheduleOfferDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>{t("Запись отменена")}</DialogTitle>
          <DialogDescription>{t("Хотите выбрать другое время для тренировки?")}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={cn(buttonVariants(), "flex-1 bg-muted text-foreground hover:bg-muted/80")}
          >
            {t("Не сейчас")}
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onPick();
            }}
            className={cn(buttonVariants(), "flex-1")}
          >
            {t("Выбрать время")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
