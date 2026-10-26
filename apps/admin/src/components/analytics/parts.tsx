import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { FieldHint } from "@/components/ui/field-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { formatChange } from "@/lib/analytics/logic";
import { cn } from "@/lib/utils";

/** Сравнение показателя: подпись («к пр. месяцу») и изменение в %. */
export type KpiDelta = { label: string; value: number | null; goodWhenUp?: boolean };

/**
 * Плитка показателя отчёта: подпись с «?», значение, под ним — сравнения
 * (к тем же датам прошлого месяца и прошлого года, как у Lady Stretch).
 * Изменение — относительное, %; нет базы — «нет базы сравнения».
 */
export function KpiTile({
  label,
  tip,
  value,
  note,
  deltas = [],
  loading,
}: {
  label: string;
  tip?: ReactNode;
  value: ReactNode;
  /** Строка под значением (например, «из них новых 12»). */
  note?: ReactNode;
  deltas?: KpiDelta[];
  loading?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3">
      <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground sm:text-sm">
        <span className="truncate">{label}</span>
        {tip && <FieldHint>{tip}</FieldHint>}
      </p>
      {loading ? (
        <>
          <Skeleton className="mt-1.5 h-6 w-24" />
          {deltas.length > 0 && <Skeleton className="mt-1.5 h-3 w-28" />}
        </>
      ) : (
        <>
          <p className="mt-0.5 truncate text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
          {note && <p className="truncate text-xs text-muted-foreground">{note}</p>}
          {deltas.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {deltas.map((d) => (
                <Delta key={d.label} {...d} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Delta({ label, value, goodWhenUp = true }: KpiDelta) {
  if (value === null)
    return <span className="text-xs text-muted-foreground">{label}: нет базы</span>;
  const flat = Math.round(value) === 0;
  const up = value > 0;
  const good = flat ? null : up === goodWhenUp;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs tabular-nums",
        good === null ? "text-muted-foreground" : good ? "text-emerald-700" : "text-rose-600",
      )}
    >
      <Icon className="h-3 w-3" />
      {formatChange(value)}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** Сетка плиток: на телефоне по две, шире — по `cols`. */
export function KpiGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 | 6 }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2 sm:gap-3",
        cols === 3 && "lg:grid-cols-3",
        cols === 4 && "lg:grid-cols-4",
        cols === 6 && "lg:grid-cols-3 2xl:grid-cols-6",
      )}
    >
      {children}
    </div>
  );
}

/** Белая карточка с таблицей и заголовком (таблица — без своей рамки). */
export function TableCard({
  title,
  tip,
  actions,
  children,
}: {
  title: string;
  tip?: ReactNode;
  /** Справа от заголовка (переключатель «Все / Новые / Продления»). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          {title}
          {tip && <FieldHint>{tip}</FieldHint>}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Пустой блок отчёта. */
export function EmptyBlock({ children = "Нет данных за период" }: { children?: ReactNode }) {
  return (
    <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
