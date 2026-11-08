/**
 * Текст сообщения из документа редактора (ProseMirror JSON) — React-узлами,
 * без HTML: неизвестные узлы показываются текстом, ссылки — только
 * безопасные (safeHref), упоминание — имя, по нажатию — карточка сотрудника.
 * Ссылки в обычном тексте (вставили адрес без форматирования) тоже
 * нажимаются.
 */
import { Fragment, type ReactNode } from "react";

import { PersonButton } from "@/components/people/person-card";
import { safeHref, URL_RE } from "@/lib/chats/content";
import type { ChatNode } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

function linkify(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)]+$/, "");
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a
        key={`${keyBase}-${at}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-sky-700 underline underline-offset-2 dark:text-sky-300"
      >
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderText(node: ChatNode, key: string, mine: boolean): ReactNode {
  let el: ReactNode = <Fragment key={key}>{linkify(node.text ?? "", key)}</Fragment>;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        el = <strong key={key}>{el}</strong>;
        break;
      case "italic":
        el = <em key={key}>{el}</em>;
        break;
      case "underline":
        el = <u key={key}>{el}</u>;
        break;
      case "strike":
        el = <s key={key}>{el}</s>;
        break;
      case "code":
        el = (
          <code
            key={key}
            className={cn(
              "rounded px-1 py-0.5 font-mono text-[0.85em]",
              mine ? "bg-black/10" : "bg-muted",
            )}
          >
            {node.text}
          </code>
        );
        break;
      case "link": {
        const href = safeHref(mark.attrs?.href);
        if (href)
          el = (
            <a
              key={key}
              href={href}
              target={href.startsWith("/") ? undefined : "_blank"}
              rel="noopener noreferrer"
              className="text-sky-700 underline underline-offset-2 dark:text-sky-300"
            >
              {node.text}
            </a>
          );
        break;
      }
    }
  }
  return el;
}

function render(node: ChatNode, key: string, mine: boolean): ReactNode {
  const kids = () => node.content?.map((c, i) => render(c, `${key}.${i}`, mine));
  switch (node.type) {
    case "doc":
      return <Fragment key={key}>{kids()}</Fragment>;
    case "paragraph":
      return (
        <p key={key} className="min-h-[1.25em] whitespace-pre-wrap break-words">
          {kids()}
        </p>
      );
    case "bulletList":
      return (
        <ul key={key} className="list-disc pl-5">
          {kids()}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="list-decimal pl-5">
          {kids()}
        </ol>
      );
    case "listItem":
      return <li key={key}>{kids()}</li>;
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-current/30 pl-2 opacity-90">
          {kids()}
        </blockquote>
      );
    case "hardBreak":
      return <br key={key} />;
    case "text":
      return renderText(node, key, mine);
    case "mention": {
      const id = String(node.attrs?.id ?? "");
      const label = `@${String(node.attrs?.label ?? "")}`;
      if (id === "all")
        return (
          <span key={key} className="font-semibold text-chat-accent">
            {label}
          </span>
        );
      return (
        <PersonButton
          key={key}
          userId={id}
          className="inline font-semibold text-chat-accent hover:underline"
        >
          {label}
        </PersonButton>
      );
    }
    default:
      return node.text ? (
        <Fragment key={key}>{node.text}</Fragment>
      ) : (
        <Fragment key={key}>{kids()}</Fragment>
      );
  }
}

export function MessageContent({
  doc,
  text,
  mine = false,
  className,
}: {
  doc: ChatNode | null;
  text: string;
  mine?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1 text-[15px] leading-snug", className)}>
      {doc && doc.type === "doc" ? (
        render(doc, "d", mine)
      ) : (
        <p className="whitespace-pre-wrap break-words">{linkify(text, "t")}</p>
      )}
    </div>
  );
}
