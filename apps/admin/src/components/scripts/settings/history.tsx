/**
 * Хронология изменений скриптов: кто, когда и что с чего поменял.
 *
 * Каждая запись — название скрипта, комментарий к правке и только те поля,
 * что изменились: «было → стало», удалённые слова подсвечены в «было», новые —
 * в «стало». Подгружается порциями по мере прокрутки.
 */
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { EmptyCard } from "@/components/scripts/empty-card";
import { ScriptsFeedSkeleton } from "@/components/page-skeletons";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { usePlaybook } from "@/lib/scripts/data";
import { fieldChanges, wordDiff, type Piece } from "@/lib/scripts/diff";
import { formatWhen } from "@/lib/scripts/logic";
import type { ScriptChange } from "@/lib/scripts/types";
import { LoadMore, ScriptTitle } from "./shared";
import { afterCursor, PAGE_SIZE, usePaged, type Cursor } from "./use-paged";
import { useOpenScript } from "./use-open-script";

export const HISTORY_KEY = "scripts_changes";

const ACTIONS: Record<ScriptChange["action"], { label: string; tone: StatusTone }> = {
  created: { label: "Создан", tone: "positive" },
  updated: { label: "Изменён", tone: "info" },
  deleted: { label: "Удалён", tone: "negative" },
};

async function loadChanges(cursor: Cursor | null) {
  let q = supabase
    .from("scripts_changes")
    .select("id, item_id, item_title, action, before, after, change_note, author, created_at");
  if (cursor) q = q.or(afterCursor("created_at", cursor));
  return unwrap<ScriptChange[]>(
    q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE),
  );
}

export function HistoryTab() {
  const { items, loading, hasMore, loadingMore, more, sentinel } = usePaged({
    queryKey: [HISTORY_KEY],
    load: loadChanges,
    cursorOf: (c: ScriptChange) => ({ at: c.created_at, id: c.id }),
    errorMessage: "Не удалось загрузить хронологию",
  });

  if (loading) return <ScriptsFeedSkeleton />;
  if (!items.length)
    return (
      <EmptyCard title="Изменений пока нет">
        Здесь появится каждая правка скриптов: что было, что стало, кто и зачем поменял.
      </EmptyCard>
    );

  return (
    <div className="space-y-3">
      {items.map((c) => (
        <ChangeEntry key={c.id} change={c} />
      ))}
      <LoadMore sentinel={sentinel} hasMore={hasMore} loading={loadingMore} onMore={more} />
    </div>
  );
}

function Pieces({ pieces, kind }: { pieces: Piece[]; kind: "del" | "ins" }) {
  if (!pieces.length) return <span className="italic text-muted-foreground">пусто</span>;
  return (
    <>
      {pieces.map((p, i) =>
        p.changed ? (
          <mark
            key={i}
            className={
              kind === "del"
                ? "rounded-sm bg-rose-100 text-rose-700"
                : "rounded-sm bg-emerald-100 text-emerald-700"
            }
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function ChangeEntry({ change }: { change: ScriptChange }) {
  const { data: sections } = usePlaybook();
  const openScript = useOpenScript();
  const title = change.item_title || "Без названия";
  const action = ACTIONS[change.action];
  // Запись об импорте — без скрипта и без версий: только название и итог.
  const marker = !change.item_id && !change.before && !change.after;
  const fields = marker ? [] : fieldChanges(change);

  // Скрипт ещё жив — название ведёт к нему. Скрипт — по разделу, где он
  // лежит; сценарий звонка — это сам раздел.
  const itemId = change.item_id;
  const section = itemId
    ? sections?.find((s) => s.id === itemId || s.items.some((i) => i.id === itemId))
    : undefined;
  const open =
    section && itemId
      ? () => (section.id === itemId ? openScript(section.id) : openScript(section.id, itemId))
      : null;

  return (
    <article className="space-y-3 rounded-lg border bg-background p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {marker ? (
          <span className="font-medium">{title}</span>
        ) : (
          <>
            {open ? (
              <ScriptTitle title={title} onOpen={open} />
            ) : (
              <span className="font-medium">{title}</span>
            )}
            <StatusChip tone={action.tone}>{action.label}</StatusChip>
          </>
        )}
        <span className="ml-auto flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{change.author || "—"}</span>
          <span className="tabular-nums">{formatWhen(change.created_at)}</span>
        </span>
      </header>

      {change.change_note && (marker || change.action === "updated") && (
        <p className="whitespace-pre-wrap text-sm">{change.change_note}</p>
      )}

      {fields.length > 0 ? (
        <div className="space-y-3">
          {fields.map((f, i) => {
            const d = wordDiff(f.before, f.after);
            return (
              <div key={i} className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{f.label}</p>
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_auto_1fr]">
                  <div
                    aria-label="Было"
                    className="whitespace-pre-wrap break-words rounded-md border p-2 text-sm"
                  >
                    <Pieces pieces={d.before} kind="del" />
                  </div>
                  <span aria-hidden className="text-muted-foreground max-sm:hidden sm:pt-2">
                    →
                  </span>
                  <div
                    aria-label="Стало"
                    className="whitespace-pre-wrap break-words rounded-md border p-2 text-sm"
                  >
                    <Pieces pieces={d.after} kind="ins" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        !marker &&
        change.action === "updated" && (
          <p className="text-sm text-muted-foreground">
            Тексты не менялись — сохранено без правок.
          </p>
        )
      )}
    </article>
  );
}
