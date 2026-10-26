import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";

import { DocumentText, Folder } from "@/components/nav-icons";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { canEditKb } from "@/lib/kb/access";
import { kbBasesQuery, snippetParts, useKbNodeTags, useKbSearch, useKbTree } from "@/lib/kb/data";
import { kbTagColor, matchTags, tagArticleCounts } from "@/lib/kb/tags";
import { KB_TABS_SLOT } from "@/lib/kb/header-layout";
import { kbIcon } from "@/lib/kb/icons";
import { ancestorsOf, indexTree, readerNodes, type KbTreeIndex } from "@/lib/kb/tree";
import { KB_LAST_BASE_KEY, useMyKbBases } from "@/lib/kb/my-bases";
import { kbBaseIdOf } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";

/**
 * Вкладки баз знаний в шапке (решение владельца 2026-10-25): раздел рейки
 * один, базы — вкладками с иконкой и подписью вкладки (rail_title), порядок
 * — как в «Управлении» → «Знания». Вкладка открывает главную базы, меню
 * слева переключается на её дерево. activationMode="manual", как у
 * StaffTabs: стрелки двигают фокус, переход — по клику, Enter или пробелу.
 */
export function KbBaseTabs() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const baseId = kbBaseIdOf(pathname);
  const { bases, loading } = useMyKbBases();
  // Выбранная вкладка — сразу по клику, не дожидаясь новой страницы: плашка
  // начинает переезд тут же (шапка — часть страницы и заводится заново,
  // поэтому плашка ещё и помнит прежнее место — indicatorMemoryKey).
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [baseId]);

  useEffect(() => {
    if (!baseId) return;
    try {
      window.localStorage.setItem(KB_LAST_BASE_KEY, baseId);
    } catch {
      // приватный режим — рейка откроет первую базу
    }
  }, [baseId]);

  if (loading)
    return (
      <div className={cn("flex gap-1", KB_TABS_SLOT)}>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-full" />
        ))}
      </div>
    );

  return (
    <Tabs
      value={picked ?? baseId ?? ""}
      onValueChange={(id) => {
        setPicked(id);
        void navigate({ to: "/kb/$baseId", params: { baseId: id } });
      }}
      activationMode="manual"
      className={KB_TABS_SLOT}
    >
      {/* Баз больше, чем ширины, — вкладки прокручиваются. */}
      <TabsList
        aria-label="Базы знаний"
        indicatorMemoryKey="kb-bases"
        className="max-w-full justify-start overflow-x-auto [scrollbar-width:none]"
      >
        {bases.map((b) => {
          const Icon = kbIcon(b.icon);
          return (
            <TabsTrigger
              key={b.id}
              value={b.id}
              title={b.title}
              className="gap-1.5 px-3"
              onMouseEnter={() =>
                router.preloadRoute({ to: "/kb/$baseId", params: { baseId: b.id } }).catch(() => {})
              }
            >
              {/* Иконка открытой базы — её цвет (--brand внутри базы — цвет базы). */}
              <Icon
                active={b.id === (picked ?? baseId)}
                className={cn("size-4 shrink-0", b.id === baseId && "text-brand-on-dark")}
              />
              {b.rail_title || b.title}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

/**
 * Поиск по открытой базе — по центру шапки (вместо поиска клиента,
 * решение владельца 2026-10-25; раскладка — lib/kb/header-layout.ts).
 * Результаты — списком под полем; «Только в …» сужает поиск до папки, где
 * стоим. Стрелка вниз из поля —
 * к результатам, Esc — стереть.
 */
export function KbHeaderSearch({ baseId, className }: { baseId: string; className?: string }) {
  const access = useAdminAccess();
  const canEdit = canEditKb(access?.kbAdmin ? "manage" : access?.kb?.[baseId]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentId = /^\/kb\/[^/]+\/([0-9a-f-]{36})/.exec(pathname)?.[1] ?? null;
  const { data: allNodes } = useKbTree(baseId);
  const index = useMemo(
    () => indexTree(canEdit ? (allNodes ?? []) : readerNodes(allNodes ?? [])),
    [allNodes, canEdit],
  );
  const current = currentId ? index.byId.get(currentId) : undefined;
  const scopeFolder = current
    ? current.kind === "folder"
      ? current
      : index.byId.get(current.parent_id ?? "")
    : undefined;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [inFolder, setInFolder] = useState(false);
  const debounced = useDebouncedValue(query, 300);
  const folderId = inFolder && scopeFolder ? scopeFolder.id : null;
  const search = useKbSearch(baseId, debounced, folderId);
  // Теги под запрос — сразу, без ожидания поиска: у читателя — только теги
  // видимых ему статей (архив не в счёт).
  const { data: nodeTags, tags } = useKbNodeTags(baseId);
  const tagCounts = useMemo(
    () =>
      nodeTags
        ? tagArticleCounts(nodeTags, (id) => {
            const n = index.byId.get(id);
            return !!n && n.kind === "article" && n.status !== "archived";
          })
        : new Map<string, number>(),
    [nodeTags, index],
  );
  const foundTags = matchTags(
    (tags ?? []).filter((t) => (tagCounts.get(t.id) ?? 0) > 0),
    query,
  ).slice(0, 6);

  // Что ищут — в аналитику базы (kb_log_search): запрос, сколько нашлось,
  // перешёл ли по результату. Пишем, когда пришёл ответ на этот запрос.
  const logged = useRef<{ key: string; id: number | null }>({ key: "", id: null });
  const hits = search.data;
  useEffect(() => {
    const q = debounced.trim();
    if (!hits || q.length < 2) return;
    const key = `${q}|${folderId ?? ""}`;
    if (logged.current.key === key) return;
    logged.current = { key, id: null };
    void supabase
      .rpc("kb_log_search", {
        p_base: baseId,
        p_query: q,
        p_results: hits.length,
        p_in_folder: !!folderId,
      })
      .then(({ data }) => {
        if (logged.current.key === key) logged.current.id = (data as number | null) ?? null;
      });
  }, [hits, debounced, folderId, baseId]);
  const onPick = (nodeId: string) => {
    setOpen(false);
    const id = logged.current.id;
    if (id) void supabase.rpc("kb_log_search_click", { p_id: id, p_node: nodeId }).then(() => {});
  };
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = open && query.trim().length >= 2;

  // Стрелки по результатам: из поля — к первому, с первого вверх — в поле.
  const moveFocus = (e: KeyboardEvent, from: "input" | "list") => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    if (!links.length) return;
    e.preventDefault();
    if (from === "input") {
      if (e.key === "ArrowDown") links[0].focus();
      return;
    }
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = at + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0) inputRef.current?.focus();
    else links[Math.min(next, links.length - 1)].focus();
  };

  return (
    <div
      className={cn("relative", className)}
      // Фокус ушёл за пределы поля и списка — список закрывается.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open && !query) setOpen(false);
      }}
    >
      <SearchInput
        ref={inputRef}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => moveFocus(e, "input")}
        placeholder="Поиск по базе"
        aria-label="Поиск по базе знаний"
        aria-expanded={shown}
        aria-controls="kb-header-search-results"
      />
      {shown && (
        <div
          id="kb-header-search-results"
          ref={listRef}
          onKeyDown={(e) => moveFocus(e, "list")}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-[min(28rem,70vh)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg lg:left-auto lg:w-[28rem]"
        >
          {scopeFolder && (
            <label className="flex cursor-pointer items-center gap-2 border-b px-2 pt-1 pb-2 text-xs text-muted-foreground">
              <Checkbox checked={inFolder} onCheckedChange={(v) => setInFolder(v === true)} />
              <span className="truncate">Только в «{scopeFolder.title}»</span>
            </label>
          )}
          {foundTags.length > 0 && (
            <div className="border-b px-1 pt-1 pb-2">
              <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">Теги</p>
              <ul aria-label="Найденные теги" className="flex flex-wrap gap-1">
                {foundTags.map((t) => (
                  <li key={t.id}>
                    <Link
                      to="/kb/$baseId"
                      params={{ baseId }}
                      search={{ tag: t.id }}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex items-center gap-1 rounded-full px-2 py-0.5 text-sm outline-none hover:ring-2 hover:ring-current/30 focus-visible:ring-2 focus-visible:ring-current/50",
                        kbTagColor(t.color).chip,
                      )}
                    >
                      <Hash className="size-3.5 opacity-60" />
                      {t.name}
                      <span className="text-xs tabular-nums opacity-60">{tagCounts.get(t.id)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <SearchResults
            baseId={baseId}
            index={index}
            hits={search.data}
            loading={search.isLoading || debounced !== query}
            onPick={onPick}
            hasTags={foundTags.length > 0}
            tagNames={(id) => {
              const ids = nodeTags?.get(id) ?? [];
              return ids
                .map((tagId) => tags?.find((t) => t.id === tagId)?.name)
                .filter((n): n is string => !!n);
            }}
          />
        </div>
      )}
    </div>
  );
}

function SearchResults({
  baseId,
  index,
  hits,
  loading,
  onPick,
  hasTags,
  tagNames,
}: {
  baseId: string;
  index: KbTreeIndex;
  hits: ReturnType<typeof useKbSearch>["data"];
  loading: boolean;
  onPick: (nodeId: string) => void;
  /** Выше нашлись теги — «Ничего не нашлось» не пишем. */
  hasTags: boolean;
  /** Теги статьи — строкой под путём. */
  tagNames: (nodeId: string) => string[];
}) {
  if (loading && !hits?.length)
    return (
      <div className="space-y-1 p-1">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  if (!hits?.length)
    return hasTags ? (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        Статей с такими словами в тексте нет
      </p>
    ) : (
      <p className="py-6 text-center text-sm text-muted-foreground">Ничего не нашлось</p>
    );
  return (
    <ul className="space-y-0.5 pt-1" aria-label="Найдено">
      {hits.map((h) => {
        const path = ancestorsOf(index, h.id)
          .map((a) => a.title)
          .join(" › ");
        return (
          <li key={h.id}>
            <Link
              to="/kb/$baseId/$nodeId"
              params={{ baseId, nodeId: h.id }}
              onClick={() => onPick(h.id)}
              className="block rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span className="flex items-center gap-1.5 font-medium">
                {h.kind === "folder" ? (
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <DocumentText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn("truncate", h.status !== "published" && "text-muted-foreground")}
                >
                  {h.title || "Без названия"}
                </span>
              </span>
              {path && <span className="block truncate text-xs text-muted-foreground">{path}</span>}
              {tagNames(h.id).length > 0 && (
                <span className="block truncate text-xs text-muted-foreground">
                  {tagNames(h.id)
                    .map((n) => `#${n}`)
                    .join(" ")}
                </span>
              )}
              {h.snippet && (
                <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {snippetParts(h.snippet).map((p, i) =>
                    p.hit ? (
                      <mark
                        key={i}
                        className="rounded-sm bg-transparent font-semibold text-foreground"
                      >
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Заголовок служебной страницы базы («Отчёт по чтению», «Шаблоны»,
 * «Корзина»): в шапке базы знаний вместо заголовка — вкладки, поэтому он
 * над содержимым, с надзаголовком-базой, как крошки статьи.
 */
export function KbPageHeading({ baseId, title }: { baseId: string; title: string }) {
  const { data: bases } = useQuery(kbBasesQuery);
  const base = bases?.find((b) => b.id === baseId);
  return (
    <div className="px-1 pb-1">
      <Link
        to="/kb/$baseId"
        params={{ baseId }}
        className="text-sm font-semibold text-brand-on-light hover:underline"
      >
        {base?.title ?? "База знаний"}
      </Link>
      <h2 className="mt-0.5 text-2xl leading-tight font-semibold">{title}</h2>
    </div>
  );
}
