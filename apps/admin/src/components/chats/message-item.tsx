/**
 * Сообщение в переписке: пузырь (свои — справа, цветом бренда), имя и
 * аватарка автора у первого в серии (в группе), ответ и пересланное,
 * вложения, реакции, время, «изменено», отметки прочтения. Действия — по
 * правой кнопке, долгому нажатию и кнопке «⋯» при наведении (бриф 2.8,
 * 2.10, 2.12, 2.13). На сенсорном экране пузырь не выделяется и без
 * системного меню (`.chat-touch-menu`): долгое нажатие открывает только наше
 * меню, текст — «Скопировать текст»; свайп вправо — «Ответить», как в
 * Telegram (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 3.3). В реакциях — «+»: любое
 * эмодзи из общего окна.
 */
import { lazy, memo, Suspense, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  BarChart3,
  Check,
  CheckCheck,
  Copy,
  Eye,
  Forward,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Reply,
  CheckSquare,
  Trash2,
  Video,
} from "lucide-react";

import { Attachments } from "@/components/chats/attachments";
import { PollView } from "@/components/chats/chat-extras";
import { AckBar } from "@/components/chats/chat-sources";
import { MessageContent } from "@/components/chats/message-content";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QUICK_REACTIONS, systemText, tasksWord, timeOf } from "@/lib/chats/content";
import { isLocal } from "@/lib/chats/data";
import type { ChatDoc, ChatMessage, ChatSystem } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

const EmojiPicker = lazy(() => import("@/components/chats/emoji-picker"));

/** Свайп вправо дальше этого — «Ответить». */
const SWIPE_REPLY_PX = 64;

const coarse = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export type MessageActions = {
  reply: (m: ChatMessage) => void;
  react: (m: ChatMessage, emoji: string) => void;
  copyText: (m: ChatMessage) => void;
  copyLink: (m: ChatMessage) => void;
  forward: (m: ChatMessage) => void;
  /** «Поставить задачу» из сообщения (этап 2, 1.18). */
  task: (m: ChatMessage) => void;
  /** «Прочитал» у поста канала и окно «Кто прочитал». */
  ack: (m: ChatMessage) => void;
  acks: (m: ChatMessage) => void;
  pin: (m: ChatMessage, on: boolean) => void;
  receipts: (m: ChatMessage) => void;
  /** «Закрыть опрос» — с подтверждением (3.10). */
  closePoll: (m: ChatMessage) => void;
  edit: (m: ChatMessage) => void;
  remove: (m: ChatMessage) => void;
  jump: (seq: number) => void;
  retry: (m: ChatMessage) => void;
  discard: (m: ChatMessage) => void;
};

type Props = {
  m: ChatMessage;
  me: string;
  /** Первое в серии автора: имя и аватарка (группа). */
  first: boolean;
  showAuthor: boolean;
  /** Прочитано собеседником (личный чат) / кем-то (группа). */
  readByOthers: boolean;
  highlighted: boolean;
  canPin: boolean;
  canDelete: boolean;
  /** Автор или админ: видит, кто отметил «Прочитал», закрывает опрос. */
  canManage: boolean;
  name: (id: string | null) => string;
  avatar: (id: string | null) => string | null;
  actions: MessageActions;
};

type MenuItem = { label: string; icon: typeof Reply; run: () => void; destructive?: boolean };

function menuItems(p: Props): MenuItem[] {
  const { m, me, actions } = p;
  if (m.deleted || isLocal(m)) return [];
  const mine = m.author_id === me;
  const items: MenuItem[] = [{ label: "Ответить", icon: Reply, run: () => actions.reply(m) }];
  if (m.text)
    items.push({ label: "Скопировать текст", icon: Copy, run: () => actions.copyText(m) });
  items.push({ label: "Скопировать ссылку", icon: Link2, run: () => actions.copyLink(m) });
  items.push({ label: "Переслать", icon: Forward, run: () => actions.forward(m) });
  if (m.kind === "text")
    items.push({ label: "Поставить задачу", icon: CheckSquare, run: () => actions.task(m) });
  if (p.canPin)
    items.push(
      m.pinned
        ? { label: "Открепить", icon: PinOff, run: () => actions.pin(m, false) }
        : { label: "Закрепить", icon: Pin, run: () => actions.pin(m, true) },
    );
  if (mine) items.push({ label: "Кто прочитал", icon: Eye, run: () => actions.receipts(m) });
  if (m.poll && !m.poll.closed && p.canManage)
    items.push({ label: "Закрыть опрос", icon: BarChart3, run: () => actions.closePoll(m) });
  if (mine && m.kind === "text" && !m.poll)
    items.push({ label: "Изменить", icon: Pencil, run: () => actions.edit(m) });
  if (p.canDelete)
    items.push({ label: "Удалить", icon: Trash2, run: () => actions.remove(m), destructive: true });
  return items;
}

function ReactionsRow({
  m,
  me,
  name,
  onReact,
}: {
  m: ChatMessage;
  me: string;
  name: Props["name"];
  onReact: (e: string) => void;
}) {
  if (m.reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {m.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onReact(r.emoji)}
          title={r.users.map((u) => (u === me ? "Вы" : name(u))).join(", ")}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
            r.mine
              ? "border-chat-accent/40 bg-chat-accent-soft text-chat-accent font-semibold"
              : "bg-background hover:bg-muted",
          )}
        >
          <span className="text-sm leading-none">{r.emoji}</span>
          {r.count}
        </button>
      ))}
    </div>
  );
}

function SystemLine({
  m,
  name,
  onJump,
}: {
  m: ChatMessage;
  name: Props["name"];
  onJump: (seq: number) => void;
}) {
  const system = (m.content as { system?: ChatSystem } | null)?.system;
  if (system?.type === "task_created") {
    const nums = system.numbers ?? [];
    const count = system.count ?? nums.length;
    return (
      <div className="my-2 flex justify-center px-4">
        <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
          <CheckSquare className="size-3.5 shrink-0" />
          <span>
            {m.author_id ? name(m.author_id) : "Кто-то"} поставил(а){" "}
            {count > 1 ? `${count} ${tasksWord(count)}:` : "задачу"}
          </span>
          {nums.map((n) => (
            <Link
              key={n}
              to="/tasks/$number"
              params={{ number: String(n) }}
              className="font-medium text-chat-accent hover:underline"
            >
              #{n}
            </Link>
          ))}
          {count > nums.length && <span>…</span>}
          {count <= 1 && system.title && (
            <span className="max-w-64 truncate">«{system.title}»</span>
          )}
          {system.seq != null && (
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onJump(system.seq!)}
            >
              к сообщению
            </button>
          )}
        </span>
      </div>
    );
  }
  if (system?.type === "call") {
    const missed = system.state === "ended" && system.reason !== "finished";
    return (
      <div className="my-2 flex justify-center px-4">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-center text-xs",
            missed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <Video className="size-3.5 shrink-0" />
          {systemText(system, m.author_id, (id) => name(id))}
          <span className="opacity-70">· {timeOf(m.created_at)}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="my-2 flex justify-center px-4">
      <span className="rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
        {systemText(system, m.author_id, (id) => name(id))}
      </span>
    </div>
  );
}

function Quote({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 block w-full rounded-md border-l-2 border-chat-accent bg-black/5 px-2 py-1 text-left text-sm hover:bg-black/10"
    >
      {children}
    </button>
  );
}

export const MessageItem = memo(function MessageItem(p: Props) {
  const { m, me, first, showAuthor, readByOthers, highlighted, name, avatar, actions } = p;
  const [menuOpen, setMenuOpen] = useState(false);
  // Окно эмодзи: из «⋯» — тем же окном, из контекстного меню — у пузыря.
  const [menuEmoji, setMenuEmoji] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; dx: number; horizontal: boolean | null } | null>(
    null,
  );
  if (m.kind === "system") return <SystemLine m={m} name={name} onJump={actions.jump} />;
  const mine = m.author_id === me;
  const items = menuItems(p);
  const local = isLocal(m) ? m.local : null;
  const canReply = items.length > 0;

  // Свайп вправо — ответить (только палец, только по горизонтали).
  const setShift = (dx: number) => {
    if (!row.current) return;
    row.current.style.transform = dx ? `translateX(${dx}px)` : "";
    row.current.style.transition = dx ? "none" : "transform 150ms ease-out";
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (!canReply || e.touches.length !== 1) return;
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, horizontal: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = swipe.current;
    if (!t) return;
    const dx = e.touches[0].clientX - t.x;
    const dy = e.touches[0].clientY - t.y;
    if (t.horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8))
      t.horizontal = Math.abs(dx) > Math.abs(dy) && dx > 0;
    if (!t.horizontal) return;
    t.dx = Math.max(0, Math.min(dx, SWIPE_REPLY_PX + 24));
    setShift(t.dx);
  };
  const onTouchEnd = () => {
    const t = swipe.current;
    swipe.current = null;
    if (!t) return;
    setShift(0);
    if (t.horizontal && t.dx >= SWIPE_REPLY_PX) {
      navigator.vibrate?.(10);
      actions.reply(m);
    }
  };

  const reactionsRow = (onPick: (e: string) => void, onMore: () => void, asMenu: boolean) => (
    <div className="mb-1 flex justify-between gap-0.5 border-b px-1 pb-1">
      {QUICK_REACTIONS.map((e) =>
        asMenu ? (
          <ContextMenuItem key={e} className="p-1 text-lg" onSelect={() => onPick(e)}>
            {e}
          </ContextMenuItem>
        ) : (
          <button
            key={e}
            type="button"
            className="rounded p-1 text-lg hover:bg-muted"
            onClick={() => onPick(e)}
          >
            {e}
          </button>
        ),
      )}
      {asMenu ? (
        <ContextMenuItem
          className="p-1.5"
          aria-label="Другая реакция"
          title="Другая реакция"
          onSelect={onMore}
        >
          <Plus className="size-4" />
        </ContextMenuItem>
      ) : (
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Другая реакция"
          title="Другая реакция"
          onClick={onMore}
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
  const emojiFallback = (
    <div className="flex h-[min(380px,60dvh)] items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );

  const bubble = (
    <div
      className={cn(
        // Входящие и исходящие — одинаковые отступы и радиус 16 px, без теней
        // и «хвостиков»: их различает цвет (решение владельца 2026-11-08).
        "chat-touch-menu group/msg relative max-w-full rounded-2xl px-3.5 py-2.5",
        mine ? "bg-chat-mine" : "bg-background",
        highlighted && "ring-2 ring-chat-accent",
        local === "failed" && "ring-1 ring-destructive",
      )}
    >
      {showAuthor && first && !mine && (
        <PersonButton
          userId={m.author_id}
          className="mb-0.5 block text-sm font-semibold text-chat-accent hover:underline"
        >
          {name(m.author_id)}
        </PersonButton>
      )}
      {m.forward && (
        <Link
          to="/chats/$chatId"
          params={{ chatId: m.forward.chat_id }}
          search={{ m: m.forward.seq }}
          title="Открыть исходное сообщение"
          className="mb-1 block text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          <Forward className="mr-1 inline size-3" />
          Переслано от <span className="font-medium">{name(m.forward.author_id)}</span>
        </Link>
      )}
      {m.reply && (
        <Quote onClick={() => actions.jump(m.reply!.seq)}>
          <span className="block font-medium text-chat-accent">{name(m.reply.author_id)}</span>
          <span className="block truncate text-muted-foreground">
            {m.reply.deleted ? "Сообщение удалено" : m.reply.text || (m.reply.files ? "Файл" : "")}
          </span>
        </Quote>
      )}
      {m.deleted ? (
        <p className="text-sm text-muted-foreground italic">Сообщение удалено</p>
      ) : (
        <>
          {m.attachments.length > 0 && (
            <div className={cn(m.text && "mb-1")}>
              <Attachments files={m.attachments} mine={mine} />
            </div>
          )}
          {m.poll ? (
            <PollView m={m} />
          ) : (
            m.text && <MessageContent doc={m.content as ChatDoc | null} text={m.text} mine={mine} />
          )}
          {m.ack && !local && (
            <AckBar
              m={m}
              mine={mine}
              canSeeAcks={p.canManage}
              onAck={() => actions.ack(m)}
              onOpenList={() => actions.acks(m)}
            />
          )}
        </>
      )}
      <div className="mt-1 flex items-center justify-end gap-1 text-[11px] leading-none text-chat-meta">
        {m.pinned && <Pin className="size-3" aria-label="Закреплено" />}
        {m.edited_at && !m.deleted && <span>изменено</span>}
        <span>{timeOf(m.created_at)}</span>
        {mine && !m.deleted && (
          <span
            aria-label={
              local === "sending"
                ? "Отправляется"
                : local === "failed"
                  ? "Не отправлено"
                  : readByOthers
                    ? "Прочитано"
                    : "Отправлено"
            }
          >
            {local === "sending" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : local === "failed" ? (
              <AlertCircle className="size-3.5 text-destructive" />
            ) : readByOthers ? (
              <CheckCheck className="size-3.5 text-chat-accent" />
            ) : (
              <Check className="size-3.5" />
            )}
          </span>
        )}
      </div>
      {items.length > 0 && (
        <Popover
          open={menuOpen}
          onOpenChange={(o) => {
            setMenuOpen(o);
            if (!o) setMenuEmoji(false);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Действия с сообщением"
              title="Действия с сообщением"
              className={cn(
                "absolute top-1 flex size-7 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 max-md:hidden",
                mine ? "-left-9" : "-right-9",
                menuOpen && "opacity-100",
              )}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align={mine ? "end" : "start"}
            className={cn(menuEmoji ? "w-[min(22rem,calc(100vw-1rem))] p-0" : "w-64 p-1")}
          >
            {menuEmoji ? (
              <Suspense fallback={emojiFallback}>
                <EmojiPicker
                  autoFocus
                  onPick={(e) => {
                    setMenuOpen(false);
                    setMenuEmoji(false);
                    actions.react(m, e);
                  }}
                />
              </Suspense>
            ) : (
              <>
                {reactionsRow(
                  (e) => {
                    setMenuOpen(false);
                    actions.react(m, e);
                  },
                  () => setMenuEmoji(true),
                  false,
                )}
                {items.map((it) => (
                  <button
                    key={it.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      it.run();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
                      it.destructive && "text-destructive",
                    )}
                  >
                    <it.icon className="size-4" />
                    {it.label}
                  </button>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );

  return (
    <div
      ref={row}
      id={`msg-${m.seq}`}
      data-seq={m.seq}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className={cn(
        "flex gap-2 px-3 sm:px-4",
        first ? "mt-2" : "mt-0.5",
        mine ? "justify-end" : "justify-start",
      )}
    >
      {showAuthor && !mine && (
        <span className="w-8 shrink-0">
          {first && (
            <PersonButton userId={m.author_id}>
              <StaffAvatar
                value={avatar(m.author_id)}
                name={name(m.author_id)}
                className="size-8 text-[10px]"
              />
            </PersonButton>
          )}
        </span>
      )}
      <div
        className={cn(
          // Ширину ограничивает колонка: проценты у самого пузыря считались бы
          // от ширины его же текста — короткие строки переносились.
          "flex max-w-[min(36rem,85%)] min-w-0 flex-col",
          mine ? "items-end" : "items-start",
        )}
      >
        {items.length > 0 ? (
          // Не модальное: «Ответить» и «Изменить» ставят курсор в поле прямо
          // в касании пункта — иначе iPhone не покажет клавиатуру (модальное
          // меню держало фокус у себя). После закрытия фокус никуда не
          // переводим — его ставит само действие.
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverAnchor asChild>
              <div className="max-w-full">
                <ContextMenu modal={false}>
                  <ContextMenuTrigger asChild>{bubble}</ContextMenuTrigger>
                  <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
                    {reactionsRow(
                      (e) => actions.react(m, e),
                      () => setPickerOpen(true),
                      true,
                    )}
                    {items.map((it, i) => (
                      <div key={it.label}>
                        {it.destructive && i > 0 && <ContextMenuSeparator />}
                        <ContextMenuItem
                          onSelect={it.run}
                          className={cn(
                            "gap-2",
                            it.destructive && "text-destructive focus:text-destructive",
                          )}
                        >
                          <it.icon className="size-4" />
                          {it.label}
                        </ContextMenuItem>
                      </div>
                    ))}
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            </PopoverAnchor>
            <PopoverContent
              align={mine ? "end" : "start"}
              className="w-[min(22rem,calc(100vw-1rem))] p-0"
            >
              <Suspense fallback={emojiFallback}>
                <EmojiPicker
                  autoFocus={!coarse()}
                  onPick={(e) => {
                    setPickerOpen(false);
                    actions.react(m, e);
                  }}
                />
              </Suspense>
            </PopoverContent>
          </Popover>
        ) : (
          bubble
        )}
        <ReactionsRow m={m} me={me} name={name} onReact={(e) => actions.react(m, e)} />
        {local === "failed" && (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-destructive">Не отправлено</span>
            <Button size="sm" variant="outline" onClick={() => actions.retry(m)}>
              <RefreshCw /> Повторить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => actions.discard(m)}>
              Удалить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
