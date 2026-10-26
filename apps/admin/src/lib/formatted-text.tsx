/**
 * Текст с простой разметкой — описания абонементов и тренировок, биография
 * тренера, полный текст новостей и услуг,
 * «О студии» для клиентского приложения (решение владельца 2026-10-11).
 *
 * Хранится обычным текстом с разметкой в духе Markdown (старые описания без
 * разметки показываются как были, с переносами строк):
 * - **жирный**, *курсив*;
 * - строка «## Заголовок»;
 * - строки «- пункт» — список, «1. пункт» — нумерованный;
 * - [текст](https://…) и голые ссылки https://… — кликабельны;
 * - пустая строка — новый абзац.
 *
 * HTML не используется: всё рендерит React, поэтому вставить скрипт или
 * чужую вёрстку нельзя. Тот же разбор — в apps/client/src/lib/formatted-text.tsx
 * (менять синхронно).
 */
import type { ReactNode } from "react";

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^\s*#{1,3}\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const push = (b: Block) => blocks.push(b);
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const last = blocks[blocks.length - 1];
    if (!raw.trim()) {
      // Пустая строка закрывает абзац или список.
      if (last && !(last.kind === "p" && last.lines.length === 0)) push({ kind: "p", lines: [] });
      continue;
    }
    const heading = HEADING_RE.exec(raw);
    const bullet = BULLET_RE.exec(raw);
    const number = NUMBER_RE.exec(raw);
    if (heading) push({ kind: "h", text: heading[1] });
    else if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else push({ kind: "ul", items: [bullet[1]] });
    } else if (number) {
      if (last?.kind === "ol") last.items.push(number[1]);
      else push({ kind: "ol", items: [number[1]] });
    } else if (last?.kind === "p") last.lines.push(raw);
    else push({ kind: "p", lines: [raw] });
  }
  return blocks.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

const INLINE_RE =
  /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()«»"]+[^\s<>()«»".,;:!?])/g;

function inline(text: string, keyPrefix: string, linkClass: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] != null) out.push(<strong key={key}>{inline(m[1], key, linkClass)}</strong>);
    else if (m[2] != null) out.push(<em key={key}>{inline(m[2], key, linkClass)}</em>);
    else {
      const href = m[4] ?? m[5];
      out.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {m[3] ?? m[5]}
        </a>,
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function FormattedText({
  text,
  className,
  linkClass = "underline underline-offset-2",
}: {
  text: string | null | undefined;
  className?: string;
  linkClass?: string;
}) {
  if (!text?.trim()) return null;
  const blocks = parseBlocks(text);
  return (
    <div className={["space-y-2 break-words", className].filter(Boolean).join(" ")}>
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        if (b.kind === "h")
          return (
            <div key={key} className="pt-1 text-[1.05em] font-semibold">
              {inline(b.text, key, linkClass)}
            </div>
          );
        if (b.kind === "ul" || b.kind === "ol") {
          const List = b.kind === "ul" ? "ul" : "ol";
          return (
            <List
              key={key}
              className={`space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}
            >
              {b.items.map((item, ii) => (
                <li key={ii}>{inline(item, `${key}-${ii}`, linkClass)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={key}>
            {b.lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {inline(line, `${key}-${li}`, linkClass)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Текст без разметки — для превью в одну строку (таблица). */
export function stripFormatting(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/^\s*(#{1,3}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
