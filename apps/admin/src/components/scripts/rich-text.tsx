/**
 * Текст скрипта с разметкой поверх простого текста.
 *
 * В базе тексты лежат ровно такими, какими уйдут в чат: без звёздочек и
 * тегов. Разметка добавляется только при показе:
 * - {админ}, {студия}, свои переменные — подставлены значением на языке
 *   текста (синим); если значения нет, переменная подсвечена оранжевым и
 *   объясняет почему;
 * - [день], [время] — места, которые надо заполнить перед отправкой;
 * - ссылки кликабельны (карта, отзывы, приложение — их проверяют глазами);
 * - «Название скрипта» в пояснениях ведёт к этому скрипту;
 * - слова поиска подсвечены.
 *
 * Formatted — подсказки «Как использовать» и «Дальше» (и реплики звонка):
 * **жирный**, __подчёркнутый__, «• » списки, [фраза](script:<id>) — ссылка
 * на скрипт по id (переживает переименование), [[текст]] — текст с кнопкой
 * «Копировать». Тексты сообщений клиенту не форматируются — они уходят в чат.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import {
  copyText,
  normalize,
  resolveText,
  stripMarkup,
  VARIABLE_RE,
  type VarResolver,
} from "@/lib/scripts/logic";
import { cn } from "@/lib/utils";

const URL_RE = /https?:\/\/[^\s<>"«»]+/g;
const PLACEHOLDER_RE = /\[[^[\]\n]{1,40}\]/g;
const REF_RE = /«([^«»\n]{1,120})»/g;
const URL_TAIL = /[.,;:!?)\]]+$/;

/** Подставленная переменная, пустая переменная и место «заполнить руками». */
export const VAR_CLASS = "rounded-sm bg-blue-100 px-0.5 text-blue-700";
export const VAR_MISSING_CLASS =
  "cursor-help rounded-sm bg-amber-100 px-0.5 font-medium text-amber-800";
export const PLACEHOLDER_CLASS = "rounded-sm bg-muted px-0.5 font-medium text-foreground";
/** Ссылка в тексте скрипта — на другой скрипт и на сайт, один вид (токен --link). */
const LINK_CLASS =
  "cursor-pointer text-link underline underline-offset-2 hover:text-link-hover focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

type Piece =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "var"; key: string; value: string | null; why?: string }
  | { kind: "ref"; value: string; open: () => void };

function splitUrls(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    // Точка или скобка после ссылки — знак препинания предложения, а не
    // часть адреса: с ними ссылка ведёт в никуда.
    const url = match[0].replace(URL_TAIL, "");
    if (start > last) out.push({ kind: "text", value: text.slice(last, start) });
    out.push({ kind: "url", value: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

function splitPattern(
  pieces: Piece[],
  re: RegExp,
  make: (match: RegExpMatchArray) => Piece | null,
): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "text") {
      out.push(piece);
      continue;
    }
    let last = 0;
    for (const match of piece.value.matchAll(re)) {
      const made = make(match);
      if (!made) continue;
      const start = match.index ?? 0;
      if (start > last) out.push({ kind: "text", value: piece.value.slice(last, start) });
      out.push(made);
      last = start + match[0].length;
    }
    if (last < piece.value.length) out.push({ kind: "text", value: piece.value.slice(last) });
  }
  return out;
}

/**
 * Подсветка слов поиска. Индексы берутся из нормализованной строки — она
 * той же длины, что исходная, поэтому режется исходный текст как есть.
 */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const norm = normalize(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = norm.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = norm.indexOf(term, at + term.length);
    }
  }
  if (!ranges.length) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([...range]);
  }
  const nodes: ReactNode[] = [];
  let last = 0;
  merged.forEach(([start, end], i) => {
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <mark key={i} className="rounded-sm bg-amber-100 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    last = end;
  });
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

export function RichText({
  text,
  terms = [],
  resolveRef,
  resolveVar,
}: {
  text: string;
  terms?: string[];
  /** Переход к скрипту с таким названием или null, если его нет. */
  resolveRef?: (title: string) => (() => void) | null;
  /** Подстановка переменных; без неё {…} остаются текстом. */
  resolveVar?: VarResolver;
}) {
  let pieces = splitUrls(text);
  if (resolveVar) {
    pieces = splitPattern(pieces, new RegExp(VARIABLE_RE.source, "g"), (m) => {
      const found = resolveVar(m[1]);
      return found ? { kind: "var", key: m[1], value: found.value, why: found.why } : null;
    });
  }
  pieces = splitPattern(pieces, PLACEHOLDER_RE, (m) => ({ kind: "placeholder", value: m[0] }));
  if (resolveRef) {
    pieces = splitPattern(pieces, REF_RE, (m) => {
      const open = resolveRef(m[1]);
      return open ? { kind: "ref", value: m[1], open } : null;
    });
  }
  return (
    <>
      {pieces.map((piece, i) => {
        switch (piece.kind) {
          case "url":
            return (
              <a
                key={i}
                href={piece.value}
                target="_blank"
                rel="noreferrer noopener"
                className={cn(LINK_CLASS, "break-all")}
              >
                <Highlight text={piece.value} terms={terms} />
              </a>
            );
          case "var":
            return piece.value !== null ? (
              <span key={i} className={VAR_CLASS} title={`Подставлено из {${piece.key}}`}>
                <Highlight text={piece.value} terms={terms} />
              </span>
            ) : (
              <span key={i} className={VAR_MISSING_CLASS} title={piece.why}>
                {`{${piece.key}}`}
              </span>
            );
          case "placeholder":
            return (
              <span key={i} className={PLACEHOLDER_CLASS} title="Заполнить перед отправкой">
                <Highlight text={piece.value} terms={terms} />
              </span>
            );
          case "ref":
            return (
              <button key={i} type="button" className={LINK_CLASS} onClick={piece.open}>
                «<Highlight text={piece.value} terms={terms} />»
              </button>
            );
          default:
            return <Highlight key={i} text={piece.value} terms={terms} />;
        }
      })}
    </>
  );
}

/** Значок «Копировать» в строке подсказки — отвечает галочкой на месте. */
function MiniCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground [&_svg]:size-3.5",
        done && "text-emerald-700",
      )}
      title={done ? "Скопировано" : `Копировать: ${text}`}
      aria-label={done ? "Скопировано" : "Копировать"}
      onClick={async () => {
        if (!(await copyText(text))) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

const INLINE_RE =
  /\[\[([^\]\n]+?)\]\]|\[([^\]\n]+)\]\(script:([0-9a-fA-F-]{36})\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g;
const LIST_RE = /^\s*[•\-–]\s+/;

type FormatCtx = {
  terms: string[];
  resolveRef?: (title: string) => (() => void) | null;
  resolveVar?: VarResolver;
  /** Переход к скрипту по id; null — такого скрипта больше нет. */
  resolveId: (id: string) => { open: () => void; title: string } | null;
};

function Inline({ text, ctx }: { text: string; ctx: FormatCtx }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      nodes.push(
        <RichText
          key={i++}
          text={text.slice(last, start)}
          terms={ctx.terms}
          resolveRef={ctx.resolveRef}
          resolveVar={ctx.resolveVar}
        />,
      );
    }
    if (m[1] !== undefined) {
      // Копируется то, что видно: без разметки, с подставленными переменными.
      const plain = stripMarkup(m[1]);
      const copy = ctx.resolveVar ? resolveText(plain, ctx.resolveVar) : plain;
      nodes.push(
        <span
          key={i++}
          className="inline-flex max-w-full items-center gap-0.5 rounded-md border bg-background py-0 pr-0.5 pl-2 align-middle"
        >
          <span className="min-w-0 font-medium">
            <Inline text={m[1]} ctx={ctx} />
          </span>
          <MiniCopy text={copy} />
        </span>,
      );
    } else if (m[2] !== undefined) {
      const target = ctx.resolveId(m[3]);
      nodes.push(
        target ? (
          <button
            key={i++}
            type="button"
            className={LINK_CLASS}
            title={`Открыть «${target.title}»`}
            onClick={target.open}
          >
            <Inline text={m[2]} ctx={ctx} />
          </button>
        ) : (
          <span
            key={i++}
            className="cursor-help text-muted-foreground line-through"
            title="Скрипт, на который вела ссылка, удалён"
          >
            <Inline text={m[2]} ctx={ctx} />
          </span>
        ),
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <strong key={i++} className="font-semibold">
          <Inline text={m[4]} ctx={ctx} />
        </strong>,
      );
    } else {
      nodes.push(
        <u key={i++} className="underline-offset-2">
          <Inline text={m[5]} ctx={ctx} />
        </u>,
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <RichText
        key={i++}
        text={text.slice(last)}
        terms={ctx.terms}
        resolveRef={ctx.resolveRef}
        resolveVar={ctx.resolveVar}
      />,
    );
  }
  return <>{nodes}</>;
}

export function Formatted({
  text,
  className,
  ...ctx
}: { text: string; className?: string } & FormatCtx) {
  // Строки собираются в блоки: подряд идущие пункты — в один список,
  // остальное — абзацами с сохранёнными переносами.
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const list = LIST_RE.test(line);
    const prev = blocks[blocks.length - 1];
    const content = list ? line.replace(LIST_RE, "") : line;
    if (prev && prev.list === list) prev.lines.push(content);
    else blocks.push({ list, lines: [content] });
  }
  return (
    <div className={cn("space-y-2", className)}>
      {blocks.map((b, bi) =>
        b.list ? (
          <ul key={bi} className="list-disc space-y-0.5 pl-5">
            {b.lines.map((l, li) => (
              <li key={li}>
                <Inline text={l} ctx={ctx} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={bi}>
            {b.lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                <Inline text={l} ctx={ctx} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
