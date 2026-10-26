/**
 * Панель над полем подсказки: жирный, подчёркнутый, список, ссылка на другой
 * скрипт и «Добавить копирование». Кнопки вставляют разметку прямо в текст
 * (**…**, __…__, «• », [фраза](script:id), [[…]]) — её видно и можно
 * поправить руками, а в карточке она превращается в оформление.
 *
 * VariableChips — вставка {переменной} туда, где стоял курсор.
 */
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListItemButton } from "@/components/ui/list-item-button";
import {
  STATUS_TONE_CLASS,
  statusChipBase,
  statusChipSize,
} from "@/components/ui/status-chip-styles";
import { cn } from "@/lib/utils";
import { normalize } from "@/lib/scripts/logic";
import type { ScriptSection } from "@/lib/scripts/types";

/** mousedown не уводит фокус из текста — выделение и курсор остаются. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function FormatBar({
  targetId,
  value,
  onChange,
  sections,
}: {
  /** id textarea, к которой относится панель. */
  targetId: string;
  value: string;
  onChange: (value: string) => void;
  sections: ScriptSection[];
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // Выделение запоминается до открытия выбора скрипта: поиск забирает фокус.
  const saved = useRef<[number, number]>([0, 0]);

  const area = () => document.getElementById(targetId) as HTMLTextAreaElement | null;

  function apply(next: string, selStart: number, selEnd: number) {
    onChange(next);
    requestAnimationFrame(() => {
      const el = area();
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  function wrap(open: string, placeholder: string, close = open) {
    const el = area();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const inner = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + open + inner + close + value.slice(end);
    apply(next, start + open.length, start + open.length + inner.length);
  }

  function toggleList() {
    const el = area();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const nl = value.indexOf("\n", end);
    const lineEnd = nl === -1 ? value.length : nl;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const marked = /^\s*[•\-–]\s+/;
    const allMarked = lines.every((l) => !l.trim() || marked.test(l));
    const changed = lines
      .map((l) =>
        !l.trim() ? l : allMarked ? l.replace(marked, "") : marked.test(l) ? l : `• ${l}`,
      )
      .join("\n");
    const block = changed || "• ";
    apply(
      value.slice(0, lineStart) + block + value.slice(lineEnd),
      lineStart,
      lineStart + block.length,
    );
  }

  function openPicker() {
    const el = area();
    saved.current = [el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length];
    setQuery("");
    setPicking(true);
  }

  function link(id: string, title: string) {
    const [start, end] = saved.current;
    const text = value.slice(start, end).trim() || title;
    const token = `[${text}](script:${id})`;
    setPicking(false);
    apply(
      value.slice(0, start) + token + value.slice(end),
      start + token.length,
      start + token.length,
    );
  }

  const q = normalize(query.trim());
  const options = sections
    .flatMap((s) => s.items.map((i) => ({ id: i.id, title: i.title, section: s.title })))
    .filter((o) => !q || normalize(`${o.title} ${o.section}`).includes(q))
    .slice(0, 8);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Оформление подсказки">
        <Button
          variant="outline"
          size="sm"
          title="Жирный: выделите текст и нажмите"
          onMouseDown={keepFocus}
          onClick={() => wrap("**", "жирный текст")}
        >
          <strong>Ж</strong>
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Подчёркнутый: выделите текст и нажмите"
          onMouseDown={keepFocus}
          onClick={() => wrap("__", "подчёркнутый текст")}
        >
          <u>П</u>
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Пункты с новой строки: выделите строки и нажмите"
          onMouseDown={keepFocus}
          onClick={toggleList}
        >
          • Список
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Выделите фразу и выберите скрипт — фраза станет ссылкой на него"
          onMouseDown={keepFocus}
          onClick={openPicker}
        >
          ↗ Ссылка на скрипт
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Выделите текст — в карточке рядом с ним появится кнопка «Копировать»: название следующего скрипта, текст задачи для CRM"
          onMouseDown={keepFocus}
          onClick={() => wrap("[[", "текст для копирования", "]]")}
        >
          ⧉ Добавить копирование
        </Button>
      </div>
      {picking && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <Input
            autoFocus
            value={query}
            placeholder="Найти скрипт по названию или разделу"
            aria-label="Найти скрипт для ссылки"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setPicking(false);
              }
              if (e.key === "Enter" && options[0]) {
                e.preventDefault();
                link(options[0].id, options[0].title);
              }
            }}
          />
          <ul className="max-h-64 overflow-y-auto">
            {options.map((o) => (
              <li key={o.id}>
                <ListItemButton
                  className="items-baseline justify-between gap-3 px-2"
                  onClick={() => link(o.id, o.title)}
                >
                  <span className="font-medium">{o.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{o.section}</span>
                </ListItemButton>
              </li>
            ))}
            {!options.length && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">Ничего не нашлось</li>
            )}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {saved.current[0] !== saved.current[1]
                ? "Выделенная фраза станет ссылкой на выбранный скрипт."
                : "Ничего не выделено — вставим название скрипта ссылкой."}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Вставить {переменную} в поле, где стоял курсор. targetId — id поля или
 * функция, которая его вернёт (последнее поле в фокусе); onInsert получает
 * id поля и новый текст.
 */
export function VariableChips({
  variables,
  targetId,
  onInsert,
  onMissingTarget,
}: {
  variables: { key: string; description: string }[];
  targetId: () => string | null;
  onInsert: (fieldId: string, next: string) => void;
  onMissingTarget?: () => void;
}) {
  function insert(key: string) {
    const id = targetId();
    const el = id ? (document.getElementById(id) as HTMLTextAreaElement | null) : null;
    if (!id || !el) {
      onMissingTarget?.();
      return;
    }
    const token = `{${key}}`;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    onInsert(id, el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {variables.map((v) => (
        <button
          key={v.key}
          type="button"
          className={cn(
            statusChipBase,
            statusChipSize.default,
            STATUS_TONE_CLASS.info,
            "cursor-pointer font-mono hover:bg-blue-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
          )}
          title={v.description || undefined}
          onMouseDown={keepFocus}
          onClick={() => insert(v.key)}
        >
          {`{${v.key}}`}
        </button>
      ))}
    </div>
  );
}
