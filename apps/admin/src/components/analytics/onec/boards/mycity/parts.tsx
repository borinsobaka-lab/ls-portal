import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Кирпичики доски «Мой город»: блок с заголовком и пояснением справа,
 * плитка показателя (подпись, число, пояснение — строки общей сетки, как
 * на дашборде), белая панель с заголовком, стрелка изменения и полоса
 * воронки. Тексты — их (partner.html), вид — наш.
 */

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h2 className="text-lg leading-tight font-semibold">{title}</h2>
        {typeof aside === "string" ? (
          <p className="text-sm text-muted-foreground">{aside}</p>
        ) : (
          aside
        )}
      </div>
      {children}
    </section>
  );
}

/** Ряд плиток: две на телефоне, четыре с lg. */
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">{children}</div>;
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    // Подпись, число и пояснение — строки общей сетки ряда (subgrid): числа
    // плиток ряда на одной высоте, даже если подпись заняла две строки.
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3">
      <span className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</span>
      <span className="min-w-0 text-lg font-semibold break-words tabular-nums sm:text-xl">
        {value}
      </span>
      {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : <span />}
    </div>
  );
}

export function Panel({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-background p-3 sm:p-4", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** Подпись и значение внутри панели («Цель Lady Stretch», «Ключевые конверсии»). */
export function PanelValue({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** Их up / down: стрелка и значение зелёным (рост) или красным (падение). */
export function Change({ up, children }: { up: boolean; children: ReactNode }) {
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium",
        up ? "text-emerald-700" : "text-rose-600",
      )}
    >
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">{up ? "рост" : "падение"}</span>
      {children}
    </span>
  );
}

/** Их значение up / down без стрелки (точка 0). */
export function Tone({ up, children }: { up: boolean; children: ReactNode }) {
  return (
    <span className={cn("font-medium", up ? "text-emerald-700" : "text-rose-600")}>{children}</span>
  );
}

/**
 * «Путь клиента за период»: шаг, полоса (доля от записавшихся) и число.
 * Ширина — их (без обрезки снизу, как у них).
 */
export function FunnelRows({
  steps,
  color,
}: {
  steps: { label: string; value: string; width: number }[];
  color: string;
}) {
  return (
    <ol className="space-y-2.5">
      {steps.map((s) => (
        <li
          key={s.label}
          className="grid grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_5rem]"
        >
          <span className="min-w-0">{s.label}</span>
          <span className="h-5 overflow-hidden rounded-md bg-muted">
            <span
              className="block h-full rounded-md"
              style={{ width: `${s.width}%`, backgroundColor: color }}
            />
          </span>
          <span className="text-right font-semibold tabular-nums">{s.value}</span>
        </li>
      ))}
    </ol>
  );
}
