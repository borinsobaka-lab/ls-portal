import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { FieldHint } from "@/components/ui/field-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { KB_READ_STATE, percentText, type KbReadState } from "@/lib/kb/analytics";
import { cn } from "@/lib/utils";

/**
 * Кирпичики аналитики базы знаний: плитка показателя (как на дашборде —
 * подпись с «?», значение, сравнение с прошлым периодом), полоса чтения
 * «прочитали / прежнюю версию / не открывали» с подписями и бейдж
 * состояния. Цвета состояний — KB_READ_STATE (lib/kb/analytics.ts), у
 * каждого цвета — подпись: цветом одним смысл не передаём.
 */

export function KpiTile({
  label,
  tip,
  value,
  hint,
  delta,
  loading,
}: {
  label: string;
  tip: ReactNode;
  value: string;
  /** Пояснение рядом со значением: «из 12», «за 30 дней». */
  hint?: string;
  delta?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground sm:text-sm">
        {label}
        <FieldHint>{tip}</FieldHint>
      </span>
      {loading ? (
        <Skeleton className="mt-0.5 h-6 w-24" />
      ) : (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="text-lg font-semibold tabular-nums sm:text-xl">{value}</span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </span>
      )}
      {loading ? <Skeleton className="mt-0.5 h-3 w-20" /> : (delta ?? <span />)}
    </div>
  );
}

/** Сравнение с прошлым периодом: стрелка, разница и «к пред. периоду». */
export function Delta({
  current,
  previous,
  goodWhenUp = true,
  format = (n) => String(n),
}: {
  current: number;
  previous: number;
  goodWhenUp?: boolean;
  format?: (n: number) => string;
}) {
  const diff = current - previous;
  if (diff === 0)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" /> без изменений
      </span>
    );
  const up = diff > 0;
  const good = up === goodWhenUp;
  const pct = previous === 0 ? null : Math.round((Math.abs(diff) / previous) * 100);
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-x-1 text-xs",
        good ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300",
      )}
    >
      <Icon className="h-3 w-3" />
      {up ? "+" : "−"}
      {pct === null ? format(Math.abs(diff)) : `${pct}% · ${format(Math.abs(diff))}`}
      <span className="text-muted-foreground max-sm:hidden">к пред. периоду</span>
    </span>
  );
}

/**
 * Полоса чтения: сегменты «прочитали актуальное», «читали прежнюю
 * версию», «не открывали» — между сегментами просвет. `legend` — подписи
 * с числами под полосой.
 */
export function ReadBar({
  current,
  outdated,
  total,
  legend,
  className,
}: {
  current: number;
  outdated: number;
  total: number;
  legend?: boolean;
  className?: string;
}) {
  const unread = Math.max(total - current - outdated, 0);
  const parts: { state: KbReadState; value: number }[] = [
    { state: "current", value: current },
    { state: "outdated", value: outdated },
    { state: "unread", value: unread },
  ];
  return (
    <div className={className}>
      <div
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={`${KB_READ_STATE.current.short}: ${current}, ${KB_READ_STATE.outdated.short.toLowerCase()}: ${outdated}, ${KB_READ_STATE.unread.short.toLowerCase()}: ${unread}`}
      >
        {total === 0 ? (
          <div className="h-full w-full rounded-full bg-muted" />
        ) : (
          parts
            .filter((p) => p.value > 0)
            .map((p) => (
              <div
                key={p.state}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(p.value / total) * 100}%`,
                  backgroundColor: KB_READ_STATE[p.state].color,
                }}
              />
            ))
        )}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {parts.map((p) => (
            <li key={p.state} className="inline-flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: KB_READ_STATE[p.state].color }}
              />
              {KB_READ_STATE[p.state].short}
              <span className="font-medium text-foreground tabular-nums">{p.value}</span>
              {total > 0 && <span className="tabular-nums">· {percentText(p.value, total)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Бейдж состояния чтения: «Прочитал», «Читал прежнюю версию», «Не открывал». */
export function ReadStateChip({ state, short }: { state: KbReadState; short?: boolean }) {
  const s = KB_READ_STATE[state];
  return (
    <StatusChip tone={s.tone} size="sm">
      {short && state === "outdated" ? "Прежняя версия" : s.label}
    </StatusChip>
  );
}

/** Пустое состояние блока. */
export function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
