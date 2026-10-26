import { Fragment, useState } from "react";

import { textOnTint } from "@/lib/color-contrast";
import { WEEKDAYS, classesText, type HeatCell } from "@/lib/dashboard-classes";
import { formatStat } from "@/lib/dashboard-stats";
import { cn } from "@/lib/utils";

/**
 * «Загрузка расписания» на дашборде «Занятия»: сетка дни недели × часы
 * начала, в ячейке — сколько человек в среднем приходит на занятие, цвет —
 * насыщеннее, чем больше. Подробности ячейки — строкой под сеткой (наведение
 * или касание: на телефоне всплывающих подсказок нет). Без recharts — обычная
 * сетка, отдельный чанк не нужен.
 */
export function ScheduleHeatmap({
  cells,
  hours,
  max,
  color,
}: {
  cells: HeatCell[];
  hours: number[];
  max: number;
  color: string;
}) {
  const [picked, setPicked] = useState<HeatCell | null>(null);
  const byKey = new Map(cells.map((c) => [`${c.weekday}|${c.hour}`, c]));
  const best = cells.reduce<HeatCell | null>((b, c) => (!b || c.avg > b.avg ? c : b), null);
  const shown = picked ?? best;
  const solid = resolveColor(color);

  return (
    <div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "2.75rem repeat(7, minmax(0, 1fr))" }}
        onPointerLeave={() => setPicked(null)}
      >
        <div />
        {WEEKDAYS.map((d) => (
          <div key={d} className="pb-0.5 text-center text-xs text-muted-foreground">
            {d}
          </div>
        ))}
        {hours.map((hour) => (
          <Fragment key={hour}>
            <div className="pr-1 text-right text-xs leading-7 text-muted-foreground tabular-nums">
              {hour}:00
            </div>
            {WEEKDAYS.map((_, weekday) => {
              const cell = byKey.get(`${weekday}|${hour}`);
              if (!cell) return <div key={weekday} className="h-7 rounded-md bg-muted/50" />;
              // Пустая ячейка — серая; занятия без посещений — едва заметный цвет.
              const ratio = max ? cell.avg / max : 0;
              const share = Math.round(12 + ratio * 88);
              const active = picked === cell;
              return (
                <button
                  type="button"
                  key={weekday}
                  aria-label={cellText(cell)}
                  title={cellText(cell)}
                  onPointerEnter={() => setPicked(cell)}
                  onFocus={() => setPicked(cell)}
                  onClick={() => setPicked(cell)}
                  className={cn(
                    "flex h-7 cursor-pointer items-center justify-center rounded-md text-xs font-medium tabular-nums transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    // Цвет текста — по фактической заливке: белый на
                    // розовом бренде давал ~2,7:1.
                    textOnTint(solid, share / 100) === "light" ? "text-white" : "text-foreground",
                    active && "ring-2 ring-foreground/40",
                  )}
                  style={{
                    backgroundColor: `color-mix(in srgb, ${color} ${share}%, transparent)`,
                  }}
                >
                  {formatStat("decimal", cell.avg)}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
      <p className="mt-3 min-h-8 text-xs text-muted-foreground">
        {shown && (
          <>
            {picked ? "" : "Самое посещаемое время: "}
            <span className="font-medium text-foreground">{cellText(shown)}</span>
          </>
        )}
      </p>
    </div>
  );
}

function cellText(c: HeatCell) {
  const parts = [
    `${WEEKDAYS[c.weekday]}, ${c.hour}:00–${c.hour + 1}:00`,
    classesText(c.classes),
    `в среднем ${formatStat("decimal", c.avg)} чел.`,
  ];
  if (c.fill !== null) parts.push(`заполняемость ${formatStat("percent", c.fill)}`);
  return parts.join(" · ");
}

/** `var(--brand)` → значение токена: для выбора цвета текста нужен hex. */
function resolveColor(color: string) {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  if (!m || typeof document === "undefined") return color;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || color;
}
