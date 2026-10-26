import { useRef, useState } from "react";
import { Bold, Heading2, Italic, Link, List, ListOrdered } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormattedText } from "@/lib/formatted-text";
import { cn } from "@/lib/utils";

/**
 * Поле текста с форматированием (lib/formatted-text.tsx): кнопки над полем
 * оборачивают выделение разметкой, ниже — «Как увидит клиент». Хранится
 * обычный текст — его же показывает клиентское приложение.
 */
export function FormattedTextarea({
  value,
  onChange,
  placeholder,
  rows = 6,
  id,
  previewLabel = "Как увидит клиент",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
  /** Подпись кнопки предпросмотра: текст не для клиента — «Как увидят сотрудники». */
  previewLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  /** Заменить выделение (или вставить в курсор) и поставить курсор/выделение. */
  const apply = (
    make: (selected: string) => { text: string; selectFrom: number; selectTo: number },
  ) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const { text, selectFrom, selectTo } = make(value.slice(start, end));
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + selectFrom, start + selectTo);
    });
  };

  const wrap = (mark: string, fallback: string) =>
    apply((sel) => {
      const inner = sel || fallback;
      return {
        text: `${mark}${inner}${mark}`,
        selectFrom: mark.length,
        selectTo: mark.length + inner.length,
      };
    });

  /** Префикс в начало каждой выделенной строки (список, заголовок). */
  const prefixLines = (prefix: (i: number) => string, fallback: string) => {
    const el = ref.current;
    if (!el) return;
    // Расширяем выделение до начала первой строки.
    const lineStart = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    el.setSelectionRange(lineStart, el.selectionEnd);
    apply((sel) => {
      const lines = (sel || fallback).split("\n");
      const text = lines
        .map((l, i) => prefix(i) + l.replace(/^\s*([-*•]|\d+[.)]|#{1,3})\s+/, ""))
        .join("\n");
      return { text, selectFrom: text.length, selectTo: text.length };
    });
  };

  const tools = [
    { label: "Жирный", icon: Bold, run: () => wrap("**", "жирный текст") },
    { label: "Курсив", icon: Italic, run: () => wrap("*", "курсив") },
    { label: "Заголовок", icon: Heading2, run: () => prefixLines(() => "## ", "Заголовок") },
    { label: "Список", icon: List, run: () => prefixLines(() => "- ", "пункт") },
    {
      label: "Нумерованный список",
      icon: ListOrdered,
      run: () => prefixLines((i) => `${i + 1}. `, "пункт"),
    },
    {
      label: "Ссылка",
      icon: Link,
      run: () =>
        apply((sel) => {
          const label = sel || "текст ссылки";
          const text = `[${label}](https://)`;
          // Курсор — на адрес: его вписывают следом.
          const at = label.length + 3;
          return { text, selectFrom: at, selectTo: at + "https://".length };
        }),
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {tools.map((t) => (
          <Button
            key={t.label}
            variant="ghost"
            size="icon-sm"
            title={t.label}
            aria-label={t.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.run}
          >
            <t.icon />
          </Button>
        ))}
        <Button
          variant="link"
          size="inline"
          className={cn("ml-auto", preview && "underline")}
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? "Скрыть предпросмотр" : previewLabel}
        </Button>
      </div>
      <Textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
      />
      {preview && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {value.trim() ? (
            <FormattedText text={value} />
          ) : (
            <span className="text-muted-foreground">Пусто</span>
          )}
        </div>
      )}
    </div>
  );
}
