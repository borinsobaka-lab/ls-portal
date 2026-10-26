import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Frown, Meh, Smile } from "lucide-react";
import { toast } from "sonner";

import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { kbErrorText } from "@/lib/kb/data";
import { KB_SCORES, type KbScore } from "@/lib/kb/ratings";
import { articleNeighbors, type KbTreeIndex } from "@/lib/kb/tree";
import type { KbTreeNode } from "@/lib/kb/types";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";

const SCORE_ICON = { 1: Frown, 2: Meh, 3: Smile } as const;

const KB_RATINGS_KEY = "kb_ratings";

/** Версия статьи, которую оценивают (как в RPC kb_rate). */
const versionOf = (node: KbTreeNode) => node.published_at ?? node.created_at;
const sameTime = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/**
 * «Была ли статья полезной?» — в конце статьи (решение владельца
 * 2026-10-25): три смайлика, при наведении — красный, жёлтый, зелёный.
 * Оценка — своя на каждую опубликованную версию (RPC kb_rate), её можно
 * поменять. Сколько и как оценили — только в аналитике базы (вкладка
 * «Оценки»), под статьёй этого нет (решение владельца 2026-10-25).
 */
export function KbArticleRating({ node }: { node: KbTreeNode }) {
  const qc = useQueryClient();
  const { data: me } = useStaffProfile();
  // Своя оценка текущей версии (редактору RLS отдал бы и чужие — берём свою).
  const { data: rows } = useQuery({
    queryKey: [KB_RATINGS_KEY, node.id],
    queryFn: () =>
      unwrap<{ score: KbScore; version_at: string; rated_at: string }[]>(
        supabase
          .from("kb_ratings")
          .select("score, version_at, rated_at")
          .eq("node_id", node.id)
          .eq("user_id", me!.id)
          .order("rated_at", { ascending: false }),
      ),
    enabled: !!me?.id,
    meta: { errorMessage: "Не удалось загрузить оценку статьи" },
  });
  const mine = rows?.find((r) => sameTime(r.version_at, versionOf(node)))?.score;
  const [picked, setPicked] = useState<KbScore | null>(null);
  const [busy, setBusy] = useState(false);
  const current = picked ?? mine ?? null;

  const rate = async (score: KbScore) => {
    if (busy || score === current) return;
    setBusy(true);
    setPicked(score);
    try {
      const { error } = await supabase.rpc("kb_rate", { p_node: node.id, p_score: score });
      if (error) {
        setPicked(null);
        toast.error(
          error.message.includes("kb_rating_off")
            ? "Оценка у этой статьи выключена"
            : kbErrorText(error.message, "Не удалось сохранить оценку"),
        );
        return;
      }
      await qc.invalidateQueries({ queryKey: [KB_RATINGS_KEY, node.id] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Оценка статьи" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-4 py-3 sm:px-5">
        <p className="text-sm font-medium">
          {current ? "Спасибо за оценку!" : "Была ли статья полезной?"}
        </p>
        <div className="flex items-center gap-2" role="radiogroup" aria-label="Оценка статьи">
          {KB_SCORES.map((s) => {
            const Icon = SCORE_ICON[s.score];
            const on = current === s.score;
            return (
              <button
                key={s.score}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={s.label}
                title={s.label}
                disabled={busy && !on}
                onClick={() => void rate(s.score)}
                style={{ "--kb-score": s.color } as React.CSSProperties}
                className={cn(
                  "inline-flex size-10 cursor-pointer items-center justify-center rounded-full border text-muted-foreground transition-colors",
                  "hover:border-(--kb-score) hover:bg-(--kb-score)/10 hover:text-(--kb-score) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  on && "border-(--kb-score) bg-(--kb-score)/10 text-(--kb-score)",
                  current && !on && "opacity-60 hover:opacity-100",
                )}
              >
                <Icon className="size-5" />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * «Назад / Дальше» внизу статьи (решение владельца 2026-10-25): сверху
 * подпись со стрелкой, под ней — название соседней статьи;
 * соседние статьи по порядку дерева базы, через папки (articleNeighbors).
 */
export function KbArticlePager({
  baseId,
  index,
  nodeId,
}: {
  baseId: string;
  index: KbTreeIndex;
  nodeId: string;
}) {
  const { prev, next } = articleNeighbors(index, nodeId);
  if (!prev && !next) return null;
  const card =
    "group flex min-w-0 flex-col gap-1 rounded-lg border bg-background px-4 py-3 outline-none transition-colors hover:border-brand-on-light/50 focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <nav aria-label="Соседние статьи" className="mt-6 grid gap-3 sm:grid-cols-2">
      {prev && (
        <Link to="/kb/$baseId/$nodeId" params={{ baseId, nodeId: prev.id }} className={card}>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="size-3.5" />
            Назад
          </span>
          <span className="truncate font-semibold group-hover:text-brand-on-light">
            {prev.title || "Без названия"}
          </span>
        </Link>
      )}
      {next && (
        <Link
          to="/kb/$baseId/$nodeId"
          params={{ baseId, nodeId: next.id }}
          className={cn(card, "items-end text-right", !prev && "sm:col-start-2")}
        >
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            Дальше
            <ArrowRight className="size-3.5" />
          </span>
          <span className="max-w-full truncate font-semibold group-hover:text-brand-on-light">
            {next.title || "Без названия"}
          </span>
        </Link>
      )}
    </nav>
  );
}
