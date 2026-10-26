/**
 * Раздел скриптов: название, иконка в меню и — при создании — тип
 * (текстовые скрипты или звонок; у готового раздела тип не меняется).
 */
import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CALL_SECTION_ICON, DEFAULT_SECTION_ICON, SECTION_ICONS } from "@/lib/scripts/icons";
import { cn } from "@/lib/utils";

/** Колонок в сетке иконок — для стрелок ↑/↓. */
const ICON_COLUMNS = 7;

export type SectionFormValue = { title: string; icon: string; kind: "text" | "call" };

const KINDS = [
  {
    key: "text",
    label: "Текстовые скрипты",
    hint: "Сообщения для чата и звонков: копируются одной кнопкой.",
  },
  {
    key: "call",
    label: "Звонок",
    hint: "Один сценарий звонка: читать с экрана и кликать ответы клиента.",
  },
] as const;

export function SectionDialogContent({
  initial,
  isNew,
  onSubmit,
  onClose,
}: {
  initial?: { title: string; icon: string };
  isNew: boolean;
  onSubmit: (value: SectionFormValue) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [icon, setIcon] = useState(initial?.icon || DEFAULT_SECTION_ICON);
  const [kind, setKind] = useState<"text" | "call">("text");
  const [saving, setSaving] = useState(false);
  const iconRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const iconIndex = Math.max(
    SECTION_ICONS.findIndex((i) => i.key === icon),
    0,
  );

  // Сетка иконок — radiogroup: в неё попадают Tab-ом на выбранную, дальше
  // стрелками (←/→ — соседняя, ↑/↓ — строка выше/ниже, Home/End — края).
  function onIconKeyDown(e: React.KeyboardEvent) {
    const last = SECTION_ICONS.length - 1;
    const next =
      e.key === "ArrowRight"
        ? iconIndex + 1
        : e.key === "ArrowLeft"
          ? iconIndex - 1
          : e.key === "ArrowDown"
            ? iconIndex + ICON_COLUMNS
            : e.key === "ArrowUp"
              ? iconIndex - ICON_COLUMNS
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? last
                  : null;
    if (next === null) return;
    e.preventDefault();
    const to = Math.min(Math.max(next, 0), last);
    setIcon(SECTION_ICONS[to].key);
    iconRefs.current[to]?.focus();
  }

  async function handleSave() {
    if (!title.trim()) {
      toast.error("Назовите раздел");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ title: title.trim(), icon, kind });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isNew ? "Новый раздел" : "Раздел"}</DialogTitle>
        <DialogDescription>Раздел — пункт меню «Скриптов LS».</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            {isNew && (
              <FormField label="Тип раздела" required htmlFor={null}>
                <RadioGroup
                  value={kind}
                  onValueChange={(v) => {
                    const next = v as "text" | "call";
                    setKind(next);
                    if (next === "call" && icon === DEFAULT_SECTION_ICON)
                      setIcon(CALL_SECTION_ICON);
                  }}
                  className="rounded-md border p-3"
                >
                  {KINDS.map((k) => (
                    <label key={k.key} className="flex cursor-pointer items-start gap-2 text-sm">
                      <RadioGroupItem value={k.key} className="mt-0.5" />
                      <span>
                        <span className="font-medium">{k.label}</span>
                        <span className="block text-xs text-muted-foreground">{k.hint}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </FormField>
            )}
            <FormField label="Название" required>
              <Input
                autoFocus
                value={title}
                maxLength={255}
                placeholder="Например: «Работа с отзывами»"
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <FormField label="Иконка в меню" required htmlFor={null}>
              <div
                className="grid grid-cols-7 gap-1 rounded-md border p-2"
                role="radiogroup"
                aria-label="Иконка в меню"
                onKeyDown={onIconKeyDown}
              >
                {SECTION_ICONS.map(({ key, label, Icon }, i) => (
                  <button
                    key={key}
                    ref={(el) => {
                      iconRefs.current[i] = el;
                    }}
                    type="button"
                    tabIndex={i === iconIndex ? 0 : -1}
                    role="radio"
                    aria-checked={icon === key}
                    aria-label={label}
                    title={label}
                    className={cn(
                      "flex aspect-square cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
                      icon === key &&
                        "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                    )}
                    onClick={() => setIcon(key)}
                  >
                    <Icon active={icon === key} className="size-5" />
                  </button>
                ))}
              </div>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {isNew ? "Создать" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
