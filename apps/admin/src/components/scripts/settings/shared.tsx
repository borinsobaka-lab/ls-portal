/** Общие кусочки вкладок «Настроек скриптов»: полосы, плитки, подгрузка. */
import type { ReactNode, RefObject } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Полоса доли: числа рядом всегда видны текстом — полоса только помогает глазу. */
export function Bar({
  value,
  max,
  tone = "blue",
  className,
}: {
  value: number;
  max: number;
  tone?: "blue" | "emerald";
  className?: string;
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span
      aria-hidden
      className={cn("block h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "emerald" ? "bg-emerald-500" : "bg-blue-500",
        )}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

/** Плитка с числом — как KPI в NPS и на дашборде. */
export function StatTile({
  label,
  value,
  dim,
}: {
  label: ReactNode;
  value: ReactNode;
  /** Не выбранный язык — приглушён, но виден. */
  dim?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border bg-background p-4", dim && "opacity-50")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* div, а не p: на время загрузки здесь болванка (тоже div). */}
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Низ порционного списка: сюда доезжает прокрутка — грузится следующая порция. */
export function LoadMore({
  sentinel,
  hasMore,
  loading,
  onMore,
}: {
  sentinel: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="flex justify-center py-2">
      <Button variant="outline" disabled={loading} onClick={onMore}>
        {loading && <Loader2 className="animate-spin" />}
        {loading ? "Загружаем…" : "Показать ещё"}
      </Button>
    </div>
  );
}

/** Название скрипта: жив — ссылка, удалён — зачёркнуто. */
export function ScriptTitle({
  title,
  onOpen,
  className,
}: {
  title: string;
  /** null — скрипт удалён. */
  onOpen: (() => void) | null;
  className?: string;
}) {
  if (!onOpen)
    return (
      <span className={cn("text-muted-foreground line-through", className)} title="Скрипт удалён">
        {title}
      </span>
    );
  return (
    <button
      type="button"
      title="Открыть скрипт"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        "cursor-pointer rounded-sm text-left font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {title}
    </button>
  );
}
