import { ArrowDown, ArrowUp } from "lucide-react";

import { SALES_CARD_TREND_NOTE, salesCardTrendText } from "@/lib/analytics/onec-reports/sales";
import { cn } from "@/lib/utils";

/**
 * Плитки доски «Продажи абонементов» — вид плиток дашборда: подпись, число и
 * (у верхних шести) сравнение с тем же диапазоном прошлого месяца. Подпись,
 * число и сравнение — строки общей сетки ряда (subgrid): числа ряда на одной
 * высоте, даже если чья-то подпись в две строки.
 */
export function SalesMetricCard({
  label,
  value,
  trend,
}: {
  label: string;
  value: string;
  /** undefined — плитка без сравнения (средние чеки). */
  trend?: number | null;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3",
        trend === undefined ? "row-span-2" : "row-span-3",
      )}
    >
      <span className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums sm:text-xl">{value}</span>
      {trend !== undefined && <TrendLine delta={trend} />}
    </div>
  );
}

function TrendLine({ delta }: { delta: number | null }) {
  const { arrow, text } = salesCardTrendText(delta);
  // Цвет — только у числа, которое есть: «+0%» и «—» обычным цветом.
  const color =
    delta === null || delta === 0
      ? "text-muted-foreground"
      : arrow === "down"
        ? "text-rose-700"
        : "text-emerald-700";
  const Icon = arrow === "down" ? ArrowDown : ArrowUp;
  return (
    <span className="flex flex-wrap items-center gap-x-1 self-end text-xs">
      <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", color)}>
        {arrow && <Icon aria-hidden className="size-3" />}
        {text}
      </span>
      <span className="text-muted-foreground">{SALES_CARD_TREND_NOTE}</span>
    </span>
  );
}

/** Их плашка-цитата рядом со средними чеками. */
export function SalesQuoteCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-4 rounded-lg border bg-background px-4 py-3",
        className,
      )}
    >
      <p className="min-w-0 flex-1 text-sm font-medium text-muted-foreground">
        Развитие начинается с людей,
        <br />а растет — в цифрах
      </p>
      <span className="shrink-0 border-l pl-4 text-xs font-semibold tracking-widest text-muted-foreground">
        LADY STRETCH
      </span>
    </div>
  );
}
