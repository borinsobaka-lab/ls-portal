import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { CommentSaver } from "@/lib/comment-saver";
import { cn } from "@/lib/utils";

/**
 * Заметка или комментарий в таблице и списке — едва тёплая подложка без
 * рамки и тени (решение владельца 2026-10-11: в таблице заметка не должна
 * перетягивать на себя внимание, только отличаться от остального текста).
 */
export const noteChipClass = "rounded-md bg-note-soft px-2 py-1";

/** Заметка в окне (обработка обратной связи) — тон поля заметки, с рамкой, без тени. */
export const noteBoxClass =
  "rounded-md border border-note-border bg-note px-3 py-2.5 text-note-foreground";

/** Заметка, которую ищут глазами (карточка клиента), — как поле заметки, с лёгкой тенью. */
export const noteCardClass = `${noteBoxClass} shadow-[var(--note-shadow)]`;

/**
 * Комментарий в ячейке таблицы: в строке — первые две строки текста, по
 * клику — весь комментарий во всплывающем окне (переносы строк сохраняются).
 * С `onSave` — там же и правка (решение владельца 2026-10-19: комментарий
 * дописывают на месте, не открывая редактирование записи); пустой — кнопка
 * «+ Комментарий». Кнопка, а не просто текст: касание по ней на телефоне не
 * открывает меню строки (RowContextMenu пропускает интерактивные элементы).
 */
export function CommentCell({
  text,
  onSave,
  onSaved,
}: {
  text: string | null | undefined;
  onSave?: CommentSaver;
  /** После успешного сохранения — обновить таблицу. */
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const value = text?.trim();
  if (!value && !onSave) return <span className="text-muted-foreground">—</span>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={
            onSave
              ? value
                ? "Показать или изменить комментарий"
                : "Добавить комментарий"
              : "Показать комментарий целиком"
          }
          className={cn(
            "line-clamp-2 min-w-[140px] max-w-[260px] cursor-pointer whitespace-pre-wrap break-words rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value
              ? cn(noteChipClass, "hover:bg-note")
              : // Пустой «+ Комментарий» в таблице — по наведению на строку:
                // одинаковая серая надпись в каждой строке рябила. На тач-экране
                // и с клавиатуры виден всегда.
                "text-muted-foreground transition-opacity hover:text-foreground pointer-fine:[tr_&]:opacity-0 pointer-fine:[tr:hover_&]:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
          )}
        >
          {value || (
            <span className="inline-flex items-center gap-1">
              <Plus className="h-3.5 w-3.5" />
              Комментарий
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Комментарий</div>
        {onSave ? (
          // Содержимое монтируется при каждом открытии — поле сбрасывать не нужно.
          <CommentForm
            text={text ?? ""}
            onSave={onSave}
            onDone={() => {
              setOpen(false);
              onSaved?.();
            }}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <p
            className={cn(
              noteBoxClass,
              "max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm",
            )}
          >
            {value}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CommentForm({
  text: initial,
  onSave,
  onDone,
  onCancel,
}: {
  text: string;
  onSave: CommentSaver;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);

  const handleSave = async (e?: FormEvent) => {
    e?.preventDefault();
    // Всплытие submit в форму окна, из которого открыта таблица, не нужно.
    e?.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      const error = await onSave(text.trim() || null);
      if (error) {
        toast.error("Не удалось сохранить комментарий: " + error);
        return;
      }
      toast.success("Комментарий сохранён");
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <Textarea
        note
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Ctrl/⌘+Enter — сохранить, Enter — новая строка.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void handleSave();
          }
        }}
        aria-label="Комментарий"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </div>
    </form>
  );
}
