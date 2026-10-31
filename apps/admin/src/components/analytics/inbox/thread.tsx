import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, FileText, ImagePlus, Loader2, Send, Smile } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { inboxTemplatesQuery, type InboxThread } from "@/lib/analytics/inbox/data";
import { sendInboxReply } from "@/lib/analytics/inbox.functions";
import {
  INBOX_EMOJI,
  INBOX_MAX_IMAGE_BYTES,
  INBOX_MAX_IMAGES,
  INBOX_REPLY_MAX,
  INBOX_SEND_TEXT,
  inboxCustomerName,
  inboxTime,
  insertAt,
} from "@/lib/analytics/inbox/rules";
import { cn } from "@/lib/utils";

/** Параметры адреса страницы диалогов. */
export type InboxLinkSearch = {
  community?: number;
  unread?: 1;
  q?: string;
  dialog?: number;
  before?: number;
};

const nearBottom = (el: HTMLElement | null) =>
  !el || el.scrollHeight - el.scrollTop - el.clientHeight < 50;

/** Переписка открытого диалога и окно ответа (их .inbox-thread и inbox-features.js). */
export function InboxThreadView({
  thread,
  history,
  backSearch,
  olderSearch,
  latestSearch,
  messagesRef,
  sendingRef,
  onSent,
}: {
  thread: InboxThread;
  /** Открыта история (?before=): живое обновление переписки не идёт. */
  history: boolean;
  /** Адрес «К диалогам» на телефоне. */
  backSearch: InboxLinkSearch;
  olderSearch: InboxLinkSearch | null;
  latestSearch: InboxLinkSearch | null;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  sendingRef: React.MutableRefObject<boolean>;
  onSent: () => Promise<void>;
}) {
  const d = thread.dialog;
  const name = inboxCustomerName(d);
  const messages = thread.messages;
  const newest = messages.at(-1)?.id ?? null;
  const shownNewest = useRef<number | null>(null);
  const wasNearBottom = useRef(true);
  const [notice, setNotice] = useState(false);

  // Их inbox-live.js: внизу — следим за новыми, выше — «Новые сообщения ↓».
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (shownNewest.current === null) {
      if (!history) el.scrollTop = el.scrollHeight;
    } else if (newest !== shownNewest.current && !history) {
      if (wasNearBottom.current) el.scrollTop = el.scrollHeight;
      else setNotice(true);
    }
    shownNewest.current = newest;
  }, [newest, history, messagesRef]);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border bg-background">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 lg:hidden">
            <Link to="/analytics/inbox" search={backSearch}>
              <ArrowLeft />
              Диалоги
            </Link>
          </Button>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {d.brand} · {d.city}
          </p>
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          <p className="text-sm text-muted-foreground">
            {d.community_name} ·{" "}
            <a
              className="text-brand-on-light underline-offset-2 hover:underline"
              href={`https://vk.com/id${d.customer_vk_id || d.peer_id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Открыть профиль VK
            </a>
          </p>
        </div>
        {notice && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const el = messagesRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setNotice(false);
            }}
          >
            <ArrowDown />
            Новые сообщения
          </Button>
        )}
      </header>
      <div
        ref={messagesRef}
        className="min-h-72 flex-1 space-y-3 overflow-y-auto bg-muted/30 px-3 py-4 sm:px-4"
        onScroll={(e) => {
          wasNearBottom.current = nearBottom(e.currentTarget);
          if (wasNearBottom.current) setNotice(false);
        }}
      >
        {latestSearch && <HistoryLink search={latestSearch}>К последним сообщениям</HistoryLink>}
        {olderSearch && (
          <HistoryLink search={olderSearch}>Показать предыдущие сообщения</HistoryLink>
        )}
        {messages.map((m) => {
          const out = m.direction === "outgoing";
          const media = m.media;
          const hasMedia = media.photos.length > 0 || media.stickers.length > 0;
          const text =
            m.body ||
            (hasMedia
              ? ""
              : media.has_sticker
                ? "Стикер (изображение недоступно)"
                : "[сообщение без текста]");
          return (
            <article
              key={m.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
                out ? "ml-auto bg-primary text-primary-foreground" : "mr-auto border bg-background",
              )}
            >
              {text && <p className="break-words whitespace-pre-wrap">{text}</p>}
              {media.photos.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block"
                >
                  <img
                    src={url}
                    alt="Картинка в сообщении"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="max-h-72 rounded-lg"
                  />
                </a>
              ))}
              {media.stickers.map((url) => (
                <img
                  key={url}
                  src={url}
                  alt="Стикер VK"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="mt-1 size-32 object-contain"
                />
              ))}
              <small
                className={cn(
                  "mt-1 block text-[11px]",
                  out ? "text-primary-foreground/70" : "text-muted-foreground",
                )}
              >
                {out ? "Вы" : name} · {inboxTime(m.sent_at)}
                {m.edited_at ? " · изменено" : ""}
              </small>
            </article>
          );
        })}
        {!messages.length && (
          <p className="text-sm text-muted-foreground">Сообщения этого диалога появятся здесь.</p>
        )}
      </div>
      <Composer key={d.id} dialogId={d.id} sendingRef={sendingRef} onSent={onSent} />
    </section>
  );
}

function HistoryLink({ search, children }: { search: InboxLinkSearch; children: React.ReactNode }) {
  return (
    <div className="text-center">
      <Button asChild variant="outline" size="sm">
        <Link to="/analytics/inbox" search={search}>
          {children}
        </Link>
      </Button>
    </div>
  );
}

/** Их форма ответа: текст до 4000, шаблон, смайлики, до 4 картинок JPG/PNG. */
function Composer({
  dialogId,
  sendingRef,
  onSent,
}: {
  dialogId: number;
  sendingRef: React.MutableRefObject<boolean>;
  onSent: () => Promise<void>;
}) {
  const { data: tpl } = useQuery(inboxTemplatesQuery);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [templateTitle, setTemplateTitle] = useState("Выберите шаблон");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiTab, setEmojiTab] = useState(INBOX_EMOJI[0][0]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const range = useRef({ start: 0, end: 0 });

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  // Их высота поля: от 70 до 140 px.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(70, Math.min(el.scrollHeight, 140))}px`;
    el.style.overflowY = el.scrollHeight > 140 ? "auto" : "hidden";
  }, [text]);

  const insert = (value: string, start: number, end: number, tooLong: string) => {
    const r = insertAt(text, start, end, value);
    if (!r) {
      setError(tooLong);
      return false;
    }
    setText(r.value);
    setError("");
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(r.caret, r.caret);
    });
    return true;
  };

  const pickFiles = (list: FileList | null) => {
    const images = [...(list ?? [])];
    setError("");
    if (
      images.length > INBOX_MAX_IMAGES ||
      images.reduce((s, f) => s + f.size, 0) > INBOX_MAX_IMAGE_BYTES ||
      images.some((f) => !["image/jpeg", "image/png"].includes(f.type))
    ) {
      setFiles([]);
      setError("Выберите до 4 JPG или PNG общим размером до 8 МБ.");
      return;
    }
    setFiles(images);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sendingRef.current) return;
    if (!text.trim() && !files.length) {
      setError(INBOX_SEND_TEXT.empty);
      return;
    }
    if (text.length > INBOX_REPLY_MAX) {
      setError(`Ответ не должен превышать ${INBOX_REPLY_MAX} символов.`);
      return;
    }
    const form = new FormData();
    form.set("dialog", String(dialogId));
    form.set("body", text);
    for (const f of files) form.append("images", f);
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      await sendInboxReply({ data: form });
      setText("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      sendingRef.current = false;
      setSending(false);
      await onSent();
    } catch (err) {
      setError((err as Error).message || "Ошибка связи. Проверьте историю диалога перед повтором.");
      sendingRef.current = false;
      setSending(false);
    }
  };

  const templates = tpl?.templates ?? [];
  const groups = (
    [
      ["shared", "Общие шаблоны"],
      ["personal", "Мои личные шаблоны"],
    ] as const
  )
    .map(([v, label]) => [label, templates.filter((t) => t.visibility === v)] as const)
    .filter(([, list]) => list.length);
  const canSend = !sending && (!!text.trim() || files.length > 0) && text.length <= INBOX_REPLY_MAX;

  return (
    <form className="space-y-2 border-t p-3" onSubmit={(e) => void submit(e)}>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png"
        multiple
        hidden
        aria-label="Выбрать картинки"
        onChange={(e) => pickFiles(e.target.files)}
      />
      {previews.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {previews.map((u, i) => (
            <img
              key={u}
              src={u}
              alt={files[i]?.name ?? ""}
              className="size-16 rounded-md object-cover"
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={sending}
            onClick={() => {
              setFiles([]);
              if (fileInput.current) fileInput.current.value = "";
            }}
          >
            Убрать картинки
          </Button>
        </div>
      )}
      <Textarea
        ref={area}
        value={text}
        maxLength={INBOX_REPLY_MAX}
        rows={2}
        disabled={sending}
        placeholder="Введите текст сообщения..."
        aria-label="Текст ответа"
        onChange={(e) => setText(e.target.value)}
        className="resize-none"
      />
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Popover open={templatesOpen} onOpenChange={setTemplatesOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={sending}
                onClick={() => {
                  const el = area.current;
                  range.current = {
                    start: el?.selectionStart ?? text.length,
                    end: el?.selectionEnd ?? text.length,
                  };
                }}
              >
                <FileText />
                <span className="max-w-40 truncate">{templateTitle}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="max-h-72 w-72 overflow-y-auto p-1">
              {groups.map(([label, list]) => (
                <div key={label} className="py-1">
                  <p className="px-3 py-1 text-xs font-semibold text-muted-foreground">{label}</p>
                  {list.map((t) => (
                    <ListItemButton
                      key={t.id}
                      onClick={() => {
                        setTemplatesOpen(false);
                        if (
                          insert(
                            t.body,
                            range.current.start,
                            range.current.end,
                            `Ответ вместе с шаблоном превышает ${INBOX_REPLY_MAX} символов.`,
                          )
                        )
                          setTemplateTitle(t.title);
                      }}
                    >
                      {t.title}
                    </ListItemButton>
                  ))}
                </div>
              ))}
              {!groups.length && (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Шаблонов пока нет —{" "}
                  <Link to="/analytics/inbox/templates" className="underline">
                    добавить
                  </Link>
                  .
                </p>
              )}
            </PopoverContent>
          </Popover>
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="Выбрать смайлик"
                title="Смайлики"
                disabled={sending}
                onClick={() => {
                  const el = area.current;
                  range.current = {
                    start: el?.selectionStart ?? text.length,
                    end: el?.selectionEnd ?? text.length,
                  };
                }}
              >
                <Smile />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-80 space-y-2 p-2">
              <SegmentedControl
                aria-label="Категории смайликов"
                value={emojiTab}
                onChange={setEmojiTab}
                fullWidth
                options={INBOX_EMOJI.map(([label]) => ({ value: label, label }))}
              />
              <div className="grid grid-cols-8 gap-0.5" role="group" aria-label="Смайлики">
                {(INBOX_EMOJI.find(([l]) => l === emojiTab)?.[1] ?? []).map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    type="button"
                    title={emoji}
                    aria-label={`Вставить ${emoji}`}
                    className="flex size-8 items-center justify-center rounded-md text-lg hover:bg-accent"
                    onClick={() => {
                      setEmojiOpen(false);
                      insert(
                        emoji,
                        range.current.start,
                        range.current.end,
                        `Ответ не должен превышать ${INBOX_REPLY_MAX} символов.`,
                      );
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Прикрепить картинку"
            title="Прикрепить картинку: до 4 JPG или PNG, всего до 8 МБ"
            disabled={sending}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus />
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {text.length} / {INBOX_REPLY_MAX}
          </span>
          <Button type="submit" disabled={!canSend} aria-busy={sending}>
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            {sending ? "Отправляем..." : "Отправить в VK"}
          </Button>
        </div>
      </div>
    </form>
  );
}
