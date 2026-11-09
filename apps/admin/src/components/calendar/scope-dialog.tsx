/**
 * Событие серии: что изменить или удалить — «Только это событие, 11
 * ноября» или «Все события серии». Слово «повторение» в интерфейсе не
 * используем (UI_REVIEW, 5.3.13).
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ListItemButton } from "@/components/ui/list-item-button";
import { dayTitle } from "@/lib/calendar/logic";

export type ScopeAction = "edit" | "delete" | "move";

const TITLE: Record<ScopeAction, string> = {
  edit: "Изменить событие",
  delete: "Удалить событие",
  move: "Перенести событие",
};

export function ScopeDialog({
  action,
  day,
  onClose,
  onPick,
}: {
  action: ScopeAction | null;
  /** День этого события серии, YYYY-MM-DD. */
  day: string;
  onClose: () => void;
  onPick: (scope: "one" | "all") => void;
}) {
  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-sm">
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>{action ? TITLE[action] : ""}</DialogTitle>
          <DialogDescription>
            {action === "delete"
              ? "Это событие повторяется. Участники получат уведомление."
              : "Это событие повторяется. Что поменять?"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-1.5">
          <ListItemButton variant="outline" onClick={() => onPick("one")}>
            Только это событие{day ? `, ${dayTitle(day, false)}` : ""}
          </ListItemButton>
          <ListItemButton
            variant="outline"
            className={action === "delete" ? "text-destructive" : undefined}
            onClick={() => onPick("all")}
          >
            Все события серии
          </ListItemButton>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
