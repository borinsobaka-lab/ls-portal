/**
 * Открытый чат: шапка (кто, в сети / участников, поиск в чате, сведения),
 * полоса закреплённых (несколько, по кругу), переписка (дни, серии,
 * «Новые сообщения», подгрузка старых вверх, «к последним»), поле ввода.
 * Прочитанным отмечается то, что долистали до низа при открытой вкладке.
 *
 * Переписка виртуальная (virtua): в DOM — только сообщения у экрана, поэтому
 * длинная история не тормозит. Старые сверху — `shift` (место держит сама
 * библиотека), переходы — по номеру в списке; дата при прокрутке — плашкой
 * сверху (липкие заголовки дней в виртуальном списке не работают).
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import {
  ArrowDown,
  ArrowLeft,
  BellOff,
  FolderOpen,
  Info,
  ListChecks,
  Loader2,
  Pin,
  Search,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/chats/chat-avatar";
import { ForwardDialog, ReceiptsDialog } from "@/components/chats/dialogs";
import { MessageItem, type MessageActions } from "@/components/chats/message-item";
import type { ComposerHandle, ComposerSend, MentionCandidate } from "@/components/chats/composer";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { callErrorText } from "@/lib/chats/call-logic";
import { activeChatCallQuery, startCall, useActiveCall } from "@/lib/chats/calls";
import { useChatCallsEnabled } from "@/lib/chats/calls-config";
import { chatTitle, dayLabel, sameDay, snippetParts, timeOf } from "@/lib/chats/content";
import {
  chatErrorText,
  chatMembersQuery,
  chatPinnedQuery,
  chatWindowQuery,
  deleteMessage,
  dropLocal,
  editMessage,
  isLocal,
  loadNewer,
  loadOlder,
  markRead,
  pinMessage,
  refreshWindowTail,
  retryMessage,
  searchMessages,
  sendMessage,
  toggleReaction,
  type LocalMessage,
} from "@/lib/chats/data";
import { CHAT_BUCKET } from "@/lib/chats/files";
import { usePeople } from "@/lib/chats/people";
import { joinTypingChannel } from "@/lib/chats/realtime";
import { onChatEvent, useRealtimeConnected } from "@/lib/chats/realtime-state";
import type { ChatDoc, ChatMessage, ChatRow } from "@/lib/chats/types";
import { lastSeenLabel } from "@/lib/company";
import { cn } from "@/lib/utils";

const Composer = lazy(() => import("@/components/chats/composer"));
const NewTaskDialog = lazy(() =>
  import("@/components/tasks/task-form").then((m) => ({ default: m.NewTaskDialog })),
);

const GROUP_GAP_MS = 5 * 60_000;

export function ChatView({
  chat,
  me,
  focusSeq,
  onBack,
  onInfo,
}: {
  chat: ChatRow;
  me: string;
  /** Открыть на сообщении (?m= в адресе, поиск, упоминание). */
  focusSeq: number | null;
  onBack: () => void;
  onInfo: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const live = useRealtimeConnected();
  const { name, person } = usePeople();
  const { confirm, confirmDialog } = useConfirm();
  const title = chatTitle(chat, name);
  const win = useQuery(chatWindowQuery(chat.id, focusSeq));
  const members = useQuery({
    ...chatMembersQuery(chat.id),
    refetchInterval: live ? false : 15_000,
  });
  const pinned = useQuery(chatPinnedQuery(chat.id));
  // Видеозвонки (components/chats/call-layer.tsx): кнопка в шапке и плашка
  // «Идёт видеозвонок» у тех, кто не в нём.
  const callsEnabled = useChatCallsEnabled() && chat.kind !== "self";
  const myCall = useActiveCall();
  const liveCall = useQuery({
    ...activeChatCallQuery(chat.id),
    enabled: callsEnabled,
    refetchInterval: live ? 60_000 : 10_000,
  });
  const [calling, setCalling] = useState(false);
  const inThisCall = !!myCall && myCall.chatId === chat.id;
  const callNow = async () => {
    if (calling) return;
    setCalling(true);
    try {
      await startCall(qc, chat.id);
    } catch (e) {
      // Причина отказа Kinescope бывает длинной — даём её прочитать.
      toast.error(callErrorText(e), { duration: 20_000 });
    } finally {
      setCalling(false);
    }
  };
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<VirtualizerHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage[] | null>(null);
  const [taskFrom, setTaskFrom] = useState<ChatMessage | null>(null);
  const [receipts, setReceipts] = useState<ChatMessage | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [pinIndex, setPinIndex] = useState(0);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Граница «Новые сообщения» — какой была при открытии чата.
  const [readMark] = useState(chat.last_read_seq);
  const typingSend = useRef<((uid: string) => void) | null>(null);
  const loadingOlder = useRef(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [floatDay, setFloatDay] = useState<string | null>(null);
  const floatTimer = useRef(0);
  const pendingScroll = useRef<"bottom" | number | null>(focusSeq ?? "bottom");

  const messages = useMemo(() => win.data?.messages ?? [], [win.data]);
  const lastSeq = messages.filter((m) => !isLocal(m)).at(-1)?.seq ?? 0;
  const myRole = chat.my_role;
  const isAdmin = myRole !== "member";
  const canPin = chat.kind !== "group" || isAdmin || chat.settings?.pin === "all";
  const canPost = !(chat.kind === "group" && chat.settings?.post === "admins" && !isAdmin);

  // Сколько прочитали другие: личный — собеседник, группа — кто-нибудь.
  const othersRead = useMemo(
    () =>
      Math.max(
        0,
        ...(members.data ?? []).filter((m) => m.user_id !== me).map((m) => Number(m.last_read_seq)),
      ),
    [members.data, me],
  );

  const candidates: MentionCandidate[] = useMemo(() => {
    const list = (members.data ?? [])
      .filter((m) => m.user_id !== me)
      .map((m) => ({
        id: m.user_id,
        name: name(m.user_id),
        avatar: person(m.user_id)?.avatar_url ?? null,
        hint: person(m.user_id)?.position_name ?? undefined,
      }));
    if (chat.kind === "group" && isAdmin)
      list.unshift({ id: "all", name: "все", avatar: null, hint: "Все участники группы" });
    return list;
  }, [members.data, me, name, person, chat.kind, isAdmin]);

  // ---- Прокрутка ------------------------------------------------------------

  // Старые сообщения добавились сверху — virtua держит место от конца списка.
  // Только в тот рендер, где прежнее первое сообщение уехало вниз.
  const prevFirstId = useRef<string | undefined>(undefined);
  const prevFirstAt = prevFirstId.current
    ? messages.findIndex((m) => m.id === prevFirstId.current)
    : -1;
  const shift = prevFirstAt > 0;
  useLayoutEffect(() => {
    prevFirstId.current = messages[0]?.id;
  }, [messages]);

  const lastIndex = useRef(messages.length - 1);
  lastIndex.current = messages.length - 1;

  const scrollToSeq = useCallback(
    (seq: number) => {
      const i = messages.findIndex((m) => m.seq === seq && !isLocal(m));
      if (i < 0 || !list.current) return false;
      list.current.scrollToIndex(i, { align: "center" });
      setHighlight(seq);
      window.setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 2000);
      return true;
    },
    [messages],
  );

  const scrollToBottom = useCallback((smooth = false) => {
    if (lastIndex.current < 0) return;
    // offset — отступ под последним сообщением (pb у прокрутки).
    list.current?.scrollToIndex(lastIndex.current, { align: "end", smooth, offset: 12 });
  }, []);

  // После загрузки окна — к нужному сообщению, к первому непрочитанному или вниз.
  useLayoutEffect(() => {
    if (!win.data || pendingScroll.current === null) return;
    const target = pendingScroll.current;
    if (target === "bottom") {
      const firstUnread = messages.findIndex(
        (m) => m.seq > readMark && m.author_id !== me && m.kind === "text",
      );
      if (firstUnread >= 0 && lastSeq - readMark > 3)
        list.current?.scrollToIndex(firstUnread, { align: "start", offset: -48 });
      else scrollToBottom();
    } else scrollToSeq(target);
    pendingScroll.current = null;
  }, [win.data, messages, readMark, me, lastSeq, scrollToBottom, scrollToSeq]);

  // Новое сообщение внизу — прокручиваем, если были внизу.
  const prevLen = useRef(messages.length);
  const prevFirst = useRef(messages[0]?.seq);
  useLayoutEffect(() => {
    const grew = messages.length > prevLen.current;
    const prepended = messages[0]?.seq !== prevFirst.current;
    prevLen.current = messages.length;
    prevFirst.current = messages[0]?.seq;
    if (!grew || prepended) return;
    const lastMine = messages.at(-1)?.author_id === me;
    if (atBottom || lastMine) scrollToBottom(true);
  }, [messages, atBottom, me, scrollToBottom]);

  // Открылась клавиатура, выросло поле ввода (ответ, файлы, панель) — лента
  // стала ниже: кто был внизу, остаётся внизу, последнее сообщение не уходит
  // под поле.
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const next = el.clientHeight;
      if (next < height && atBottomRef.current) el.scrollTop = el.scrollHeight;
      height = next;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(async () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    // Дата сообщения у верхнего края — плашкой, пока листают.
    const top = list.current && messages.length ? list.current.findItemIndex(el.scrollTop) : -1;
    const at = top >= 0 ? messages[top] : undefined;
    if (at && el.scrollTop > 0) {
      setFloatDay(dayLabel(at.created_at));
      window.clearTimeout(floatTimer.current);
      floatTimer.current = window.setTimeout(() => setFloatDay(null), 1200);
    }
    if (bottom && win.data?.hasNewer) void loadNewer(qc, chat.id);
    if (el.scrollTop < 400 && win.data?.hasOlder && !loadingOlder.current) {
      loadingOlder.current = true;
      setOlderBusy(true);
      try {
        await loadOlder(qc, chat.id);
      } finally {
        loadingOlder.current = false;
        setOlderBusy(false);
      }
    }
  }, [qc, chat.id, messages, win.data?.hasOlder, win.data?.hasNewer]);
  useEffect(() => () => window.clearTimeout(floatTimer.current), []);

  // ---- Прочтение ------------------------------------------------------------

  useEffect(() => {
    if (!atBottom || win.data?.hasNewer || lastSeq === 0) return;
    const mark = () => {
      if (document.visibilityState === "visible" && document.hasFocus())
        void markRead(qc, chat.id, lastSeq).catch(() => {});
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [atBottom, lastSeq, chat.id, qc, win.data?.hasNewer]);

  // ---- Без Realtime — опрос ------------------------------------------------------

  useEffect(() => {
    if (live) return;
    const fast = window.setInterval(() => void loadNewer(qc, chat.id).catch(() => {}), 4000);
    const slow = window.setInterval(
      () => void refreshWindowTail(qc, chat.id).catch(() => {}),
      20_000,
    );
    return () => {
      window.clearInterval(fast);
      window.clearInterval(slow);
    };
  }, [live, qc, chat.id]);

  // ---- «Печатает…» --------------------------------------------------------------

  useEffect(() => {
    if (!live) return;
    const ch = joinTypingChannel(chat.id, (uid) => setTyping((t) => ({ ...t, [uid]: Date.now() })));
    typingSend.current = ch.send;
    return () => {
      typingSend.current = null;
      ch.leave();
    };
  }, [live, chat.id]);
  // Меня убрали из группы (или её удалили) — к списку чатов.
  useEffect(
    () =>
      onChatEvent((e) => {
        if (e.chat_id === chat.id && e.type === "removed") navigate({ to: "/chats" });
      }),
    [chat.id, navigate],
  );
  useEffect(() => {
    const t = window.setInterval(() => {
      setTyping((cur) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(cur).filter(([, at]) => now - at < 5000));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 1500);
    return () => window.clearInterval(t);
  }, []);
  const typingNames = Object.keys(typing)
    .filter((uid) => uid !== me)
    .map((uid) => name(uid).split(/\s+/)[1] ?? name(uid));

  // ---- Действия -----------------------------------------------------------------

  const jump = useCallback(
    async (seq: number) => {
      if (scrollToSeq(seq)) return;
      pendingScroll.current = seq;
      try {
        await qc.fetchQuery({ ...chatWindowQuery(chat.id, seq), staleTime: 0 });
      } catch (e) {
        toast.error(chatErrorText(e));
      }
    },
    [qc, chat.id, scrollToSeq],
  );

  // Переход по ?m= уже открытого чата (упоминание, поиск): только новый seq.
  const lastFocus = useRef(focusSeq);
  useEffect(() => {
    if (!focusSeq || !win.data || lastFocus.current === focusSeq) return;
    lastFocus.current = focusSeq;
    void jump(focusSeq);
  }, [focusSeq, win.data, jump]);

  const toLatest = async () => {
    if (win.data?.hasNewer) {
      pendingScroll.current = "bottom";
      await qc.fetchQuery({ ...chatWindowQuery(chat.id, null), staleTime: 0 });
    } else scrollToBottom(true);
  };

  const actions: MessageActions = useMemo(
    () => ({
      // Курсор в поле — сразу в касании пункта меню: iPhone показывает
      // клавиатуру только на фокус из действия человека, не из эффекта.
      reply: (m) => {
        setEditing(null);
        setReplyTo(m);
        composer.current?.focus();
      },
      react: (m, emoji) =>
        void toggleReaction(qc, m, emoji, me).catch((e) => toast.error(chatErrorText(e))),
      copyText: (m) =>
        void navigator.clipboard.writeText(m.text).then(() => toast.success("Текст скопирован")),
      copyLink: (m) =>
        void navigator.clipboard
          .writeText(`${window.location.origin}/chats/${m.chat_id}?m=${m.seq}`)
          .then(() => toast.success("Ссылка скопирована")),
      forward: (m) => setForwarding([m]),
      task: (m) => setTaskFrom(m),
      pin: (m, on) => void pinMessage(qc, m, on).catch((e) => toast.error(chatErrorText(e))),
      receipts: (m) => setReceipts(m),
      edit: (m) => {
        setReplyTo(null);
        setEditing(m);
        composer.current?.focus();
      },
      remove: async (m) => {
        const ok = await confirm({
          title: "Удалить сообщение?",
          description: "Его не увидит никто в чате. Вернуть нельзя.",
          confirmLabel: "Удалить",
        });
        if (ok) void deleteMessage(qc, m).catch((e) => toast.error(chatErrorText(e)));
      },
      jump: (seq) => void jump(seq),
      retry: (m) =>
        void retryMessage(qc, m as LocalMessage, me).catch((e) => toast.error(chatErrorText(e))),
      discard: (m) => dropLocal(qc, m as LocalMessage),
    }),
    [qc, me, confirm, jump],
  );

  const onSend = async (msg: ComposerSend) => {
    const reply = replyTo;
    setReplyTo(null);
    try {
      await sendMessage(qc, {
        chatId: chat.id,
        content: msg.content,
        text: msg.text,
        replyTo: reply,
        attachments: msg.attachments,
        authorId: me,
      });
    } catch (e) {
      toast.error(`Не отправлено: ${chatErrorText(e)}`);
    }
  };

  const onEdit = async (msg: ComposerSend) => {
    if (!editing) return;
    try {
      await editMessage(
        qc,
        editing.id,
        msg.content ?? ({ type: "doc", content: [] } as ChatDoc),
        msg.text,
      );
      setEditing(null);
    } catch (e) {
      toast.error(chatErrorText(e));
      throw e;
    }
  };

  const editLast = () => {
    const last = [...messages]
      .reverse()
      .find((m) => m.author_id === me && m.kind === "text" && !m.deleted && !isLocal(m));
    if (last) actions.edit(last);
  };

  // ---- Шапка ---------------------------------------------------------------------

  const peer = chat.kind === "direct" ? person(chat.peer_id) : undefined;
  const subtitle =
    typingNames.length > 0
      ? `${typingNames.join(", ")} ${typingNames.length > 1 ? "печатают" : "печатает"}…`
      : chat.kind === "self"
        ? "Заметки и пересланное для себя"
        : chat.kind === "direct"
          ? peer
            ? [lastSeenLabel(peer.last_seen_at), peer.position_name].filter(Boolean).join(" · ")
            : ""
          : `${chat.member_count} ${plural(chat.member_count, "участник", "участника", "участников")}`;
  const muted =
    chat.notify !== "all" || (chat.muted_until && new Date(chat.muted_until) > new Date());
  const pins = pinned.data ?? [];
  const pin = pins[pinIndex % Math.max(pins.length, 1)];

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-chat-bg"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files") && canPost) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canPost) return;
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2 sm:px-3 md:h-16 md:py-0">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="К списку чатов"
          onClick={onBack}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <button
          type="button"
          onClick={onInfo}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
        >
          <ChatAvatar chat={chat} title={title} size="sm" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{title}</span>
              {muted && (
                <BellOff
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label="Без звука"
                />
              )}
            </span>
            <span
              className={cn(
                "block truncate text-xs",
                typingNames.length ? "text-chat-accent" : "text-muted-foreground",
              )}
            >
              {subtitle}
            </span>
          </span>
        </button>
        {chat.kind === "project" && chat.settings?.project_id && (
          <Button variant="ghost" size="sm" asChild className="text-chat-accent">
            <Link to="/tasks/projects/$projectId" params={{ projectId: chat.settings.project_id }}>
              <FolderOpen className="size-4" />
              <span className="hidden sm:inline">Задачи проекта</span>
            </Link>
          </Button>
        )}
        {chat.kind === "task" && chat.settings?.task_number && (
          <Button variant="ghost" size="sm" asChild className="text-chat-accent">
            <Link to="/tasks/$number" params={{ number: String(chat.settings.task_number) }}>
              <ListChecks className="size-4" />
              <span className="hidden sm:inline">Задача #{chat.settings.task_number}</span>
            </Link>
          </Button>
        )}
        {callsEnabled && (
          // С md — зелёная кнопка с подписью, на телефоне — круглая зелёная
          // с иконкой: подпись занимала шапку (решения владельца 2026-11-08).
          <Button
            size="sm"
            className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700 max-md:size-10 max-md:px-0"
            aria-label={inThisCall ? "Вы в звонке" : "Видеозвонок"}
            title={inThisCall ? "Вы уже в этом звонке" : "Начать видеозвонок"}
            disabled={calling || inThisCall}
            onClick={() => void callNow()}
          >
            {calling ? <Loader2 className="animate-spin" /> : <Video />}
            <span className="max-md:hidden">{inThisCall ? "Вы в звонке" : "Видеозвонок"}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Поиск в чате"
          title="Поиск в чате"
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Search className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Сведения о чате"
          title="Сведения о чате"
          onClick={onInfo}
        >
          <Info className="size-5" />
        </Button>
      </header>

      {callsEnabled && liveCall.data && !inThisCall && (
        <div className="flex shrink-0 items-center gap-3 border-b bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
          <Video className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Идёт видеозвонок
            {(() => {
              const n = liveCall.data.members.filter((m) => m.state === "joined").length;
              return n ? ` · в звонке ${n}` : "";
            })()}
          </span>
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={calling || !liveCall.data.ready}
            onClick={() => void callNow()}
          >
            {calling && <Loader2 className="animate-spin" />}
            Присоединиться
          </Button>
        </div>
      )}

      {searchOpen && (
        <InChatSearch
          chatId={chat.id}
          name={name}
          onJump={(seq) => void jump(seq)}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {pin && (
        <button
          type="button"
          onClick={() => {
            void jump(pin.seq);
            setPinIndex((i) => i + 1);
          }}
          className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2 text-left hover:bg-muted/50"
        >
          <Pin className="size-4 shrink-0 text-chat-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-chat-accent">
              Закреплённое
              {pins.length > 1 ? ` ${(pinIndex % pins.length) + 1} из ${pins.length}` : ""}
            </span>
            <span className="block truncate text-sm">
              {pin.text || (pin.attachments.length ? "Файл" : "")}
            </span>
          </span>
        </button>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={() => void onScroll()}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {win.isPending ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {chat.kind === "self"
                ? "Пишите сюда заметки и пересылайте важное — видите только вы."
                : "Сообщений пока нет. Напишите первым!"}
            </div>
          ) : (
            <>
              {/* Короткая переписка прижата к низу, как в мессенджерах. */}
              <div className="flex-1" />
              <Virtualizer
                ref={list}
                scrollRef={scroller}
                data={messages}
                shift={shift}
                bufferSize={600}
              >
                {(m, i) => {
                  const prev = messages[i - 1];
                  const newDay = !prev || !sameDay(prev.created_at, m.created_at);
                  const first =
                    newDay ||
                    !prev ||
                    prev.author_id !== m.author_id ||
                    prev.kind === "system" ||
                    new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() >
                      GROUP_GAP_MS;
                  const unreadStart =
                    m.seq > readMark &&
                    (!prev || prev.seq <= readMark) &&
                    m.author_id !== me &&
                    readMark > 0;
                  return (
                    <div key={m.id}>
                      {newDay && (
                        <div className="my-2 flex justify-center">
                          <span className="rounded-full bg-background/90 px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-xs ring-1 ring-border">
                            {dayLabel(m.created_at)}
                          </span>
                        </div>
                      )}
                      {unreadStart && (
                        <div className="my-2 flex items-center gap-3 px-4 text-xs font-medium text-chat-accent">
                          <span className="h-px flex-1 bg-chat-accent/40" /> Новые сообщения{" "}
                          <span className="h-px flex-1 bg-chat-accent/40" />
                        </div>
                      )}
                      <MessageItem
                        m={m}
                        me={me}
                        first={first}
                        showAuthor={chat.kind !== "direct" && chat.kind !== "self"}
                        readByOthers={othersRead >= m.seq}
                        highlighted={highlight === m.seq}
                        canPin={canPin}
                        canDelete={m.author_id === me || (chat.kind === "group" && isAdmin)}
                        name={name}
                        avatar={(id) => person(id)?.avatar_url ?? null}
                        actions={actions}
                      />
                    </div>
                  );
                }}
              </Virtualizer>
              <div className="h-3 shrink-0" />
            </>
          )}
        </div>
        {(floatDay || olderBusy) && messages.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-xs ring-1 ring-border">
              {olderBusy && <Loader2 className="size-3 animate-spin" />}
              {floatDay ?? "Загружаем…"}
            </span>
          </div>
        )}
      </div>

      {(!atBottom || win.data?.hasNewer) && messages.length > 0 && (
        <Button
          variant="outline"
          size="icon"
          className="absolute right-4 bottom-24 z-20 size-10 rounded-full bg-background shadow-md"
          aria-label="К последним сообщениям"
          onClick={() => void toLatest()}
        >
          <ArrowDown className="size-5" />
          {chat.unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 rounded-full bg-chat-accent px-1.5 text-[10px] font-semibold leading-4 text-chat-accent-foreground">
              {chat.unread > 99 ? "99+" : chat.unread}
            </span>
          )}
        </Button>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-chat-accent bg-background/80 text-sm font-medium">
          Отпустите, чтобы прикрепить файлы
        </div>
      )}

      <Suspense fallback={<div className="h-14 border-t bg-background" />}>
        <Composer
          key={chat.id}
          ref={composer}
          chatId={chat.id}
          candidates={candidates}
          replyTo={replyTo}
          editing={editing}
          authorName={(id) => name(id)}
          disabledReason={canPost ? null : "В этой группе пишут только администраторы"}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => setEditing(null)}
          onSend={onSend}
          onEdit={onEdit}
          onTyping={() => typingSend.current?.(me)}
          onEditLast={editLast}
        />
      </Suspense>

      <ForwardDialog messages={forwarding} onClose={() => setForwarding(null)} />
      {taskFrom && (
        <Suspense fallback={null}>
          <NewTaskDialog
            open
            onClose={() => setTaskFrom(null)}
            fromMessage={{
              chatId: taskFrom.chat_id,
              seq: taskFrom.seq,
              text: taskFrom.text,
              authorName: name(taskFrom.author_id),
              attachments: taskFrom.attachments,
              bucket: CHAT_BUCKET,
            }}
            onCreated={() => void loadNewer(qc, chat.id)}
          />
        </Suspense>
      )}
      <ReceiptsDialog message={receipts} onClose={() => setReceipts(null)} />
      {confirmDialog}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function InChatSearch({
  chatId,
  name,
  onJump,
  onClose,
}: {
  chatId: string;
  name: (id: string | null) => string;
  onJump: (seq: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 300);
  const { data = [], isFetching } = useQuery({
    queryKey: ["chat_search", chatId, query],
    queryFn: () => searchMessages(query, chatId),
    enabled: query.length >= 2,
  });
  return (
    <div className="shrink-0 border-b bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Поиск по словам в этом чате"
          autoFocus
          wrapperClassName="flex-1"
        />
        <Button variant="ghost" size="icon" aria-label="Закрыть поиск" onClick={onClose}>
          <X className="size-5" />
        </Button>
      </div>
      {query.length >= 2 && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          {isFetching && data.length === 0 ? (
            <Loader2 className="mx-auto my-3 size-4 animate-spin text-muted-foreground" />
          ) : data.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">Ничего не нашли</p>
          ) : (
            data.map((h) => (
              <button
                key={h.message_id}
                type="button"
                onClick={() => onJump(h.seq)}
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-medium">{name(h.author_id)}</span>
                  <span className="shrink-0">
                    {dayLabel(h.created_at)}, {timeOf(h.created_at)}
                  </span>
                </span>
                <span className="line-clamp-2 text-sm">
                  {snippetParts(h.snippet).map((p, i) =>
                    p.hit ? (
                      <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-inherit">
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
