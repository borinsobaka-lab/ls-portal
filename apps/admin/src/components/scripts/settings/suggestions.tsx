/**
 * Предложения сотрудников — что они просят поправить в скриптах.
 *
 * Новые (пришедшие после прошлого просмотра этим сотрудником, не свои)
 * подсвечены; открыть вкладку — значит прочитать, и значок в меню гаснет.
 * Сделанное отмечают кнопкой — оно остаётся в списке, приглушённым.
 */
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyCard } from "@/components/scripts/empty-card";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScriptsFeedSkeleton } from "@/components/page-skeletons";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { usePlaybook } from "@/lib/scripts/data";
import { findById, formatWhen } from "@/lib/scripts/logic";
import type { ScriptSuggestion } from "@/lib/scripts/types";
import { cn } from "@/lib/utils";
import { LoadMore, ScriptTitle } from "./shared";
import { afterCursor, PAGE_SIZE, usePaged, type Cursor, type PagedData } from "./use-paged";
import { useOpenScript } from "./use-open-script";

export const SUGGESTIONS_KEY = "scripts_suggestions";

const COLUMNS =
  "id, author_id, author_name, item_id, item_title, text, status, created_at, resolved_at, resolved_by";

async function loadSuggestions(cursor: Cursor | null) {
  let q = supabase.from("scripts_suggestions").select(COLUMNS);
  if (cursor) q = q.or(afterCursor("created_at", cursor));
  return unwrap<ScriptSuggestion[]>(
    q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE),
  );
}

/**
 * Что считать новым: прежняя отметка просмотра (до открытия вкладки) и кто
 * смотрит. undefined — отметка ещё не прочитана, подсветки пока нет.
 */
export type SeenBefore = { at: string | null; userId: string | null };

export function SuggestionsTab({
  canEdit,
  seenBefore,
}: {
  canEdit: boolean;
  seenBefore: SeenBefore | undefined;
}) {
  const { items, loading, hasMore, loadingMore, more, sentinel } = usePaged({
    queryKey: [SUGGESTIONS_KEY],
    load: loadSuggestions,
    cursorOf: (s: ScriptSuggestion) => ({ at: s.created_at, id: s.id }),
    errorMessage: "Не удалось загрузить предложения",
  });

  if (loading) return <ScriptsFeedSkeleton />;
  if (!items.length)
    return (
      <EmptyCard title="Предложений пока нет">
        Сотрудники отправляют их кнопкой «Предложить изменения» над скриптами.
      </EmptyCard>
    );

  const isNew = (s: ScriptSuggestion) =>
    !!seenBefore &&
    s.author_id !== seenBefore.userId &&
    (seenBefore.at === null || Date.parse(s.created_at) > Date.parse(seenBefore.at));

  return (
    <div className="space-y-3">
      {items.map((s) => (
        <SuggestionCard key={s.id} item={s} canEdit={canEdit} unread={isNew(s)} />
      ))}
      <LoadMore sentinel={sentinel} hasMore={hasMore} loading={loadingMore} onMore={more} />
    </div>
  );
}

function SuggestionCard({
  item,
  canEdit,
  unread,
}: {
  item: ScriptSuggestion;
  canEdit: boolean;
  unread: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: sections = [] } = usePlaybook();
  const openScript = useOpenScript();
  const [busy, setBusy] = useState(false);
  const done = item.status === "done";
  // Скрипт жив — ведём к нему; удалён — остаётся название на момент отправки.
  const live = item.item_id ? findById(sections, item.item_id) : null;

  const toggle = async () => {
    setBusy(true);
    try {
      // Когда и кто отметил — ставит триггер в базе.
      const { data, error } = await supabase
        .from("scripts_suggestions")
        .update({ status: done ? "open" : "done" })
        .eq("id", item.id)
        .select(COLUMNS)
        .single();
      if (error) {
        toast.error("Не удалось отметить предложение", { description: error.message });
        return;
      }
      const next = data as ScriptSuggestion;
      queryClient.setQueryData<PagedData<ScriptSuggestion>>([SUGGESTIONS_KEY], (prev) =>
        prev
          ? { ...prev, pages: prev.pages.map((p) => p.map((x) => (x.id === next.id ? next : x))) }
          : prev,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={cn(
        "space-y-2 rounded-lg border bg-background p-4",
        unread && "border-blue-300",
        done && "opacity-60",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {unread && <StatusChip tone="info">Новое</StatusChip>}
        <span className="font-medium">{item.author_name || "—"}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatWhen(item.created_at)}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {done && (
            <span className="text-xs text-emerald-700">
              ✓ Сделано{item.resolved_by ? ` · ${item.resolved_by}` : ""}
              {item.resolved_at ? ` · ${formatWhen(item.resolved_at)}` : ""}
            </span>
          )}
          {/* Отмечают сделанным те, кто правит скрипты: они и вносят правку. */}
          {canEdit && (
            <Button size="sm" variant={done ? "ghost" : "outline"} disabled={busy} onClick={toggle}>
              {busy ? <Loader2 className="animate-spin" /> : done ? <RotateCcw /> : <Check />}
              {done ? "Вернуть" : "Сделано"}
            </Button>
          )}
        </span>
      </header>
      {item.item_title && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-xs text-muted-foreground">Скрипт</span>
          <ScriptTitle
            title={live ? live.item.title : item.item_title}
            onOpen={live ? () => openScript(live.section.id, live.item.id) : null}
          />
          {live?.section.title && (
            <span className="text-muted-foreground">· {live.section.title}</span>
          )}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
    </article>
  );
}
