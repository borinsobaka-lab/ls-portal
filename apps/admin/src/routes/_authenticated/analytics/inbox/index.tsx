import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Link2, RotateCcw } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { InboxThreadView } from "@/components/analytics/inbox/thread";
import { AnalyticsInboxPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  INBOX_KEY,
  inboxOpen,
  inboxQueueKey,
  inboxQueuePage,
  inboxRpc,
  inboxThreadKey,
  type InboxFilters,
  type InboxQueueDialog,
} from "@/lib/analytics/inbox/data";
import { kickInboxProfiles } from "@/lib/analytics/inbox.functions";
import { inboxCustomerName, inboxPreview, inboxTime } from "@/lib/analytics/inbox/rules";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

type InboxSearch = {
  community?: number;
  unread?: 1;
  q?: string;
  dialog?: number;
  before?: number;
};

// Адрес, набранный руками, роутер читает числом или строкой.
const id = (v: unknown) => {
  const n = Number(String(v ?? ""));
  return /^\d{1,15}$/.test(String(v ?? "")) && n > 0 ? n : undefined;
};
const ALL = "__all__";
const LIVE_MS = 8000;

export const Route = createFileRoute("/_authenticated/analytics/inbox/")({
  head: () => ({ meta: [{ title: "Диалоги VK — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): InboxSearch => ({
    community: id(s.community),
    unread: String(s.unread ?? "") === "1" ? 1 : undefined,
    q: typeof s.q === "string" && s.q.trim() ? s.q.slice(0, 200) : undefined,
    dialog: id(s.dialog),
    before: id(s.before),
  }),
  pendingComponent: AnalyticsInboxPageSkeleton,
  component: AnalyticsInboxPage,
});

const nearBottom = (el: HTMLElement | null) =>
  !el || el.scrollHeight - el.scrollTop - el.clientHeight < 50;

/**
 * «Диалоги VK» → «Все диалоги» — их центр сообщений (/admin/vk-inbox):
 * очередь всех доступных групп (поиск по имени и тексту, группа, «Все /
 * Непрочитанные»), переписка и ответ в VK. Прочтение — своё у каждого:
 * открыл диалог — прочитан. Раз в 8 секунд — проверка новых сообщений (их
 * inbox-live.js): очередь и переписка обновляются, поле ответа не трогается.
 */
function AnalyticsInboxPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const [query, setQuery] = useState(search.q ?? "");
  const debounced = useDebouncedValue(query, 400);
  const filters: InboxFilters = {
    community: search.community ?? null,
    unread: search.unread === 1,
    q: search.q ?? "",
  };
  const keep = { community: search.community, unread: search.unread, q: search.q };

  useEffect(() => {
    const q = debounced.trim() ? debounced : undefined;
    if (q !== search.q)
      void navigate({
        search: (s) => ({ ...s, q, dialog: undefined, before: undefined }),
        replace: true,
      });
  }, [debounced, search.q, navigate]);

  useEffect(() => {
    void kickInboxProfiles().catch(() => undefined);
  }, []);

  const queue = useInfiniteQuery({
    queryKey: inboxQueueKey(filters),
    queryFn: ({ pageParam }) => inboxQueuePage(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_offset ?? undefined,
    staleTime: Infinity,
    meta: { errorMessage: "Не удалось загрузить диалоги VK" },
  });
  const first = queue.data?.pages[0];
  const dialogs = useMemo(() => {
    const seen = new Set<number>();
    const out: InboxQueueDialog[] = [];
    for (const p of queue.data?.pages ?? [])
      for (const d of p.dialogs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
      }
    return out;
  }, [queue.data]);

  // Их выбор: явно открытый диалог, иначе первый в очереди (без прочтения).
  const explicit = search.dialog ?? null;
  const selected = explicit ?? dialogs[0]?.id ?? null;
  const before = search.before ?? null;
  const markNext = useRef(explicit !== null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  const thread = useQuery({
    queryKey: inboxThreadKey(selected ?? 0, filters.community, before),
    enabled: selected !== null && !!first,
    staleTime: Infinity,
    queryFn: async () => {
      const mark = markNext.current;
      markNext.current = false;
      const r = await inboxOpen(selected!, filters.community, mark, before);
      if (mark) void qc.invalidateQueries({ queryKey: [...INBOX_KEY, "queue"] });
      return r;
    },
    meta: { errorMessage: "Не удалось открыть диалог" },
  });

  // Живое обновление: метка без загрузки очереди, изменилась — очередь и переписка.
  const marker = useRef<string | null>(null);
  const liveQueue = useRef(false);
  // Метка — та, по которой загружена очередь (смена фильтра — своя метка).
  const firstMarker = first?.marker ?? null;
  useEffect(() => {
    marker.current = firstMarker;
  }, [firstMarker]);
  const refreshAll = async () => {
    // Их preserve_read: история, не внизу переписки или окно не в фокусе — не читать.
    markNext.current = before === null && nearBottom(messagesRef.current) && document.hasFocus();
    liveQueue.current = true;
    if (selected !== null && before === null) await thread.refetch();
    else markNext.current = false;
    await queue.refetch();
  };
  // Опрос раз в 8 с берёт свежие фильтры и диалог из ref, сам таймер — один.
  const live = useRef({ community: filters.community, refreshAll });
  live.current = { community: filters.community, refreshAll };
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || sendingRef.current || marker.current === null) return;
      try {
        const next = await inboxRpc<string>("an_inbox_marker", {
          p_community: live.current.community,
        });
        if (!next || next === marker.current) return;
        marker.current = next;
        await live.current.refreshAll();
      } catch {
        /* связь восстановится на следующем опросе */
      }
    }, LIVE_MS);
    return () => clearInterval(t);
  }, []);

  const open = (dialogId: number) => {
    markNext.current = true;
    qc.removeQueries({ queryKey: [...INBOX_KEY, "thread", dialogId] });
    void navigate({ search: { ...keep, dialog: dialogId } });
  };

  const err = queue.error as Error | null;
  const counts = first?.counts ?? { total: 0, unread: 0 };
  const showThread = explicit !== null;

  return (
    <AdminShell title={AN_TITLES.inbox}>
      {err && !first ? (
        <InfoNote variant="warning">{err.message}</InfoNote>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/analytics/inbox/templates">
                <FileText />
                Мои шаблоны
              </Link>
            </Button>
            {first?.admin && (
              <Button asChild variant="outline" size="sm">
                <Link to="/analytics/inbox/communities">
                  <Link2 />
                  Подключённые группы
                </Link>
              </Button>
            )}
          </div>
          <div className="flex gap-3 lg:h-[calc(100dvh-10.5rem)] lg:min-h-[560px]">
            <aside
              className={cn(
                "flex w-full min-w-0 flex-col rounded-lg border bg-background lg:w-96 lg:shrink-0",
                showThread && "max-lg:hidden",
              )}
            >
              <div className="space-y-2 border-b p-3">
                <h2 className="text-base font-semibold">Диалоги</h2>
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder="Поиск по имени или сообщению..."
                  aria-label="Поиск по имени или сообщению"
                />
                <Select
                  value={first?.community ? String(first.community) : ALL}
                  onValueChange={(v) =>
                    void navigate({
                      search: {
                        unread: search.unread,
                        q: search.q,
                        community: v === ALL ? undefined : Number(v),
                      },
                    })
                  }
                >
                  <SelectTrigger aria-label="Группа">
                    <SelectValue placeholder="Все группы" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Все группы</SelectItem>
                    {(first?.communities ?? []).map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.city} · {c.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <SegmentedControl
                    aria-label="Какие диалоги показать"
                    className="flex-1"
                    fullWidth
                    value={filters.unread ? "unread" : "all"}
                    onChange={(v) =>
                      void navigate({
                        search: {
                          community: search.community,
                          q: search.q,
                          unread: v === "unread" ? 1 : undefined,
                        },
                      })
                    }
                    options={[
                      { value: "all", label: `Все ${counts.total}` },
                      { value: "unread", label: `Непрочитанные ${counts.unread}` },
                    ]}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label="Сбросить фильтры"
                    title="Сбросить фильтры"
                    onClick={() => {
                      setQuery("");
                      void navigate({ search: {} });
                    }}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              </div>
              <QueueList
                dialogs={dialogs}
                loading={!first}
                selected={selected}
                filters={filters}
                totalAll={counts.total}
                liveRef={liveQueue}
                onOpen={open}
                onEnd={() => {
                  if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage();
                }}
              />
            </aside>
            <div className={cn("min-w-0 flex-1 flex-col", showThread ? "flex" : "hidden lg:flex")}>
              {thread.data && selected !== null ? (
                <InboxThreadView
                  key={selected}
                  thread={thread.data}
                  history={before !== null}
                  backSearch={keep}
                  messagesRef={messagesRef}
                  sendingRef={sendingRef}
                  olderSearch={
                    thread.data.has_more && thread.data.messages.length
                      ? { ...keep, dialog: selected, before: thread.data.messages[0].id }
                      : null
                  }
                  latestSearch={before !== null ? { ...keep, dialog: selected } : null}
                  onSent={refreshAll}
                />
              ) : thread.error ? (
                <InfoNote variant="warning">{(thread.error as Error).message}</InfoNote>
              ) : selected !== null || !first ? (
                <Skeleton className="h-full min-h-96 rounded-lg" />
              ) : (
                <EmptyThread filters={filters} total={counts.total} />
              )}
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}

function EmptyThread({ filters, total }: { filters: InboxFilters; total: number }) {
  const [title, text] = filters.q
    ? ["Диалоги не найдены", "Попробуйте другое имя или текст сообщения либо сбросьте фильтры."]
    : filters.unread && total
      ? [
          "Нет непрочитанных диалогов",
          "Все сообщения в выбранных группах прочитаны. Переключитесь на «Все», чтобы открыть переписку.",
        ]
      : [
          "Диалогов пока нет",
          "После первого сообщения клиента в подключённую группу VK диалог появится здесь автоматически.",
        ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-lg border bg-background p-8 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** Очередь (их .inbox-dialog-list): листание вниз — ещё 100; живое обновление не двигает список, пока его листают. */
function QueueList({
  dialogs,
  loading,
  selected,
  filters,
  totalAll,
  liveRef,
  onOpen,
  onEnd,
}: {
  dialogs: InboxQueueDialog[];
  loading: boolean;
  selected: number | null;
  filters: InboxFilters;
  totalAll: number;
  liveRef: React.MutableRefObject<boolean>;
  onOpen: (id: number) => void;
  onEnd: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(dialogs);
  const pending = useRef<InboxQueueDialog[] | null>(null);
  useEffect(() => {
    if (liveRef.current && (list.current?.scrollTop ?? 0) > 20) pending.current = dialogs;
    else {
      setShown(dialogs);
      pending.current = null;
    }
    liveRef.current = false;
  }, [dialogs, liveRef]);

  if (loading)
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-md" />
        ))}
      </div>
    );
  return (
    <div
      ref={list}
      className="min-h-0 flex-1 overflow-y-auto p-1.5 max-lg:max-h-[70dvh]"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop <= 20 && pending.current) {
          setShown(pending.current);
          pending.current = null;
        }
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 260) onEnd();
      }}
    >
      {shown.map((d) => (
        <QueueItem key={d.id} d={d} active={d.id === selected} onOpen={onOpen} />
      ))}
      {!shown.length && (
        <div className="p-6 text-center">
          <h3 className="text-sm font-semibold">
            {filters.q
              ? "Ничего не найдено"
              : filters.unread && totalAll
                ? "Нет непрочитанных"
                : "Пока нет сообщений"}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {filters.q
              ? "Измените запрос или сбросьте фильтры."
              : filters.unread && totalAll
                ? "Все сообщения уже прочитаны."
                : "Когда клиенты напишут в группу, их диалоги появятся здесь."}
          </p>
        </div>
      )}
    </div>
  );
}

function QueueItem({
  d,
  active,
  onOpen,
}: {
  d: InboxQueueDialog;
  active: boolean;
  onOpen: (id: number) => void;
}) {
  const name = inboxCustomerName(d);
  const avatar = d.customer_avatar_url?.startsWith("https://") ? d.customer_avatar_url : "";
  const title = d.has_unread ? "Есть непрочитанные сообщения" : "Сообщения прочитаны вами";
  return (
    <button
      type="button"
      onClick={() => onOpen(d.id)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-foreground/[0.07] hover:bg-foreground/[0.07]",
      )}
    >
      <span className="relative shrink-0">
        <span className="flex size-10 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-semibold">
          {avatar ? (
            <img
              src={avatar}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            name.slice(0, 1).toUpperCase()
          )}
        </span>
        {d.has_unread && (
          <span
            title={title}
            className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-background bg-brand"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <b
            className={cn("truncate text-sm", d.has_unread ? "font-semibold" : "font-medium")}
            title={name}
          >
            {name}
          </b>
          <time className="shrink-0 text-[11px] text-muted-foreground">
            {inboxTime(d.last_sent_at || d.last_message_at)}
          </time>
        </span>
        <small className="block truncate text-xs text-muted-foreground">{d.community_name}</small>
        <small className="block truncate text-xs text-muted-foreground">
          {d.city}
          {d.has_unread && <span className="font-semibold text-brand-on-light"> · Новое</span>}
        </small>
        <em className="mt-0.5 block truncate text-xs text-foreground/80 not-italic">
          {d.last_direction === "outgoing" && <strong>Вы: </strong>}
          {inboxPreview(d.last_body)}
        </em>
        <span
          title={title}
          className={cn(
            "mt-1 inline-block text-[11px]",
            d.has_unread ? "font-semibold text-brand-on-light" : "text-muted-foreground",
          )}
        >
          {d.has_unread ? "Новое сообщение" : "Прочитано"}
        </span>
      </span>
    </button>
  );
}
