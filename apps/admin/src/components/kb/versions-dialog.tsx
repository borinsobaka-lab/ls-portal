import { lazy, Suspense, useMemo, useState } from "react";
import { History, Loader2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useKbRevisionContents, useKbRevisions, type KbRevision } from "@/lib/kb/data";
import { diffLines, diffStats, type KbDiffLine } from "@/lib/kb/diff";
import { documentLines } from "@/lib/kb/document";
import { formatDateTime } from "@/lib/format";
import type { KbTreeNode } from "@/lib/kb/types";
import { cn } from "@/lib/utils";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/** Сколько неизменных строк оставлять вокруг правки. */
const CONTEXT = 2;

/**
 * «Версии» статьи (№36): каждая публикация — снимок kb_revisions. Слева —
 * список (кто и когда), справа — что изменилось относительно предыдущей
 * версии или как статья выглядела. «Вернуть» кладёт текст версии в
 * черновик правок: читатели увидят его после «Опубликовать».
 */
export function KbVersionsForm({
  baseId,
  node,
  authorName,
  canRestore,
  onRestore,
}: {
  baseId: string;
  node: KbTreeNode;
  authorName: (id: string | null) => string;
  /** false — открыт редактор: сначала закрыть его. */
  canRestore: boolean;
  onRestore: (revision: KbRevision, content: unknown[]) => Promise<void>;
}) {
  const { data: revisions, isLoading } = useKbRevisions(node.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"changes" | "page">("changes");
  const [restoring, setRestoring] = useState(false);

  const list = revisions ?? [];
  const index = Math.max(
    0,
    list.findIndex((r) => r.id === selectedId),
  );
  const selected = list[index];
  const previous = list[index + 1];
  const ids = [selected?.id, previous?.id].filter((x): x is string => !!x);
  const { data: contents, isLoading: contentLoading } = useKbRevisionContents(ids);
  const content = selected ? contents?.get(selected.id) : undefined;
  const previousId = previous?.id;

  const lines = useMemo(() => {
    // У первой версии сравнивать не с чем — «до» пустое.
    const before = previousId ? contents?.get(previousId) : [];
    return content && before ? diffLines(documentLines(before), documentLines(content)) : null;
  }, [content, contents, previousId]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Версии статьи</DialogTitle>
        <DialogDescription>
          Каждая публикация сохраняется. «Вернуть эту версию» кладёт её текст в черновик — читатели
          увидят его после «Опубликовать».
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="p-0 sm:p-0">
        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Загружаем версии…
          </div>
        ) : list.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            Статью ещё не публиковали — версий пока нет. Первая появится после «Опубликовать».
          </p>
        ) : (
          <div className="grid min-h-0 md:grid-cols-[15rem_1fr]">
            <ul className="max-h-48 space-y-0.5 overflow-y-auto border-b p-2 md:max-h-[60vh] md:border-r md:border-b-0">
              {list.map((r, i) => (
                <li key={r.id}>
                  <ListItemButton
                    active={r.id === selected?.id}
                    onClick={() => setSelectedId(r.id)}
                    className="h-auto flex-col items-start gap-0 py-2"
                  >
                    <span className="text-sm font-medium">{formatDateTime(r.published_at)}</span>
                    <span className="text-xs text-muted-foreground">
                      {authorName(r.published_by) || "—"}
                      {i === 0 && node.status === "published" && " · сейчас у читателей"}
                    </span>
                  </ListItemButton>
                </li>
              ))}
            </ul>
            <div className="min-w-0 space-y-3 p-4 sm:p-6 md:max-h-[60vh] md:overflow-y-auto">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                  aria-label="Что показать"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "changes", label: "Что изменилось" },
                    { value: "page", label: "Как выглядела" },
                  ]}
                />
                {selected && selected.title !== node.title && (
                  <span className="text-xs text-muted-foreground">
                    Название тогда: «{selected.title}»
                  </span>
                )}
              </div>
              {contentLoading || !content ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Загружаем текст…
                </div>
              ) : view === "page" ? (
                <div className="-mx-3 rounded-lg border py-3 sm:-mx-0">
                  <Suspense fallback={null}>
                    <KbDocument
                      key={selected.id}
                      baseId={baseId}
                      nodeId={node.id}
                      initial={content}
                      editable={false}
                    />
                  </Suspense>
                </div>
              ) : (
                <DiffView lines={lines ?? []} first={!previous} />
              )}
            </div>
          </div>
        )}
      </DialogBody>
      {selected && (
        <DialogFooter className="flex-wrap items-center">
          {!canRestore && (
            <span className="mr-auto text-xs text-muted-foreground">
              Чтобы вернуть версию, закройте редактор.
            </span>
          )}
          <Button
            disabled={!canRestore || restoring || !content}
            onClick={async () => {
              if (!content) return;
              setRestoring(true);
              try {
                await onRestore(selected, content);
              } finally {
                setRestoring(false);
              }
            }}
          >
            {restoring ? <Loader2 className="animate-spin" /> : <Undo2 />}
            Вернуть эту версию
          </Button>
        </DialogFooter>
      )}
    </>
  );
}

/** Изменения построчно: добавленное — зелёным, убранное — красным и зачёркнутым. */
function DiffView({ lines, first }: { lines: KbDiffLine[]; first: boolean }) {
  const { added, removed } = diffStats(lines);
  if (first) {
    return (
      <InfoNote>
        <span className="inline-flex items-center gap-1.5">
          <History className="size-4" /> Первая публикация — сравнивать не с чем. Текст — во вкладке
          «Как выглядела».
        </span>
      </InfoNote>
    );
  }
  if (added === 0 && removed === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Текст не менялся (могли поменяться только оформление, размеры картинок или название).
      </p>
    );
  }
  // Длинные куски без изменений сворачиваем, оставляя пару строк вокруг правок.
  const keep = lines.map((l, i) =>
    l.op !== "same"
      ? true
      : lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.op !== "same"),
  );
  const rows: ({ line: KbDiffLine } | { skipped: number })[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) rows.push({ line });
    else {
      const last = rows[rows.length - 1];
      if (last && "skipped" in last) last.skipped++;
      else rows.push({ skipped: 1 });
    }
  });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Относительно предыдущей версии: добавлено строк — {added}, убрано — {removed}.
      </p>
      <div className="overflow-hidden rounded-lg border text-sm">
        {rows.map((row, i) =>
          "skipped" in row ? (
            <div key={i} className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              … без изменений: {row.skipped}
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "flex gap-2 border-b px-3 py-1 last:border-b-0",
                row.line.op === "add" && "bg-emerald-50 text-emerald-950",
                row.line.op === "del" && "bg-red-50 text-red-900 line-through decoration-red-400",
                row.line.op === "same" && "text-muted-foreground",
              )}
              style={{ paddingLeft: 12 + row.line.depth * 16 }}
            >
              <span className="w-3 shrink-0 font-mono" aria-hidden>
                {row.line.op === "add" ? "+" : row.line.op === "del" ? "−" : ""}
              </span>
              <span
                className={cn(
                  "min-w-0 break-words",
                  row.line.kind === "heading" && "font-semibold",
                )}
              >
                {row.line.text || "(пустая строка)"}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
