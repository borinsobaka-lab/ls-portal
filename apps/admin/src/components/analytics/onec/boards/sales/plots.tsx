import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import type { SalesChartMonth } from "@/lib/analytics/onec-reports/sales";

/**
 * Графики доски «Продажи абонементов» (recharts, отдельный чанк — ./charts.tsx).
 * Как у них: шкала без подписей, линии сетки на четвертях, месяц периода —
 * последним столбиком другого тона; значение последнего месяца — плашкой,
 * когда мышь над графиком.
 */

const BRAND = "var(--brand)";
const MARGIN = { top: 24, right: 8, bottom: 0, left: 8 };

const axis = {
  tick: { fontSize: 11, fill: "var(--muted-foreground)" },
  tickLine: false,
  axisLine: false,
  interval: 0,
  tickMargin: 6,
} as const;

/** Линии сетки — на четвертях высоты (их chart-grid), без подписей шкалы. */
const quarterLines = ({ offset }: { offset: { top?: number; height?: number } }) =>
  [0, 0.25, 0.5, 0.75, 1].map((n) => (offset.top ?? 0) + n * (offset.height ?? 0));

type LabelContentProps = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  index?: number;
};

/**
 * Плашка значения у последнего столбика / точки: видна при наведении на
 * карточку графика (их chart-badge). Правым краем — не дальше столбика,
 * чтобы не уходить за край графика.
 */
function lastBadge(text: string, last: number, bar: boolean) {
  const LastBadge = (props: LabelContentProps): ReactNode => {
    if (props.index !== last) return null;
    const x = Number(props.x);
    const width = bar ? Number(props.width) : 0;
    const w = text.length * 6.5 + 14;
    const h = 18;
    const center = x + width / 2;
    const left = Math.min(center - w / 2, x + width + (bar ? 4 : 8) - w);
    const top = Math.max(0, Number(props.y) - h - 6);
    return (
      <g className="pointer-events-none opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <rect x={left} y={top} width={w} height={h} rx={4} fill="var(--primary)" />
        <text
          x={left + w / 2}
          y={top + h / 2}
          dy="0.35em"
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--primary-foreground)"
        >
          {text}
        </text>
      </g>
    );
  };
  return LastBadge;
}

/** «Продажи абонементов по месяцам»: столбики, месяц периода — насыщенным. */
export function SalesBarPlot({
  months,
  max,
  badge,
}: {
  months: SalesChartMonth[];
  max: number;
  badge: string;
}) {
  const last = months.length - 1;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={months} margin={MARGIN}>
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          horizontalCoordinatesGenerator={quarterLines}
        />
        <XAxis dataKey="label" {...axis} />
        <YAxis hide domain={[0, max]} />
        <Bar dataKey="sales" radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false}>
          {months.map((m, i) => (
            <Cell key={m.key} fill={BRAND} fillOpacity={i === last ? 1 : 0.3} />
          ))}
          <LabelList dataKey="sales" content={lastBadge(badge, last, true)} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** «Динамика суммы продаж»: линия с заливкой и точками. */
export function SalesAmountPlot({
  months,
  max,
  badge,
}: {
  months: SalesChartMonth[];
  max: number;
  badge: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={months} margin={MARGIN}>
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          horizontalCoordinatesGenerator={quarterLines}
        />
        <XAxis dataKey="label" {...axis} padding={{ left: 14, right: 14 }} />
        <YAxis hide domain={[0, max]} />
        <Area
          type="linear"
          dataKey="amount"
          stroke={BRAND}
          strokeWidth={2}
          fill={BRAND}
          fillOpacity={0.1}
          dot={{ r: 3, fill: BRAND, stroke: "var(--background)", strokeWidth: 1.5 }}
          activeDot={false}
          isAnimationActive={false}
        >
          <LabelList dataKey="amount" content={lastBadge(badge, months.length - 1, false)} />
        </Area>
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** «Структура продаж»: дуга — доля новых, остаток кольца — повторные. */
export function SalesSharePlot({ newShare }: { newShare: number }) {
  const data = [
    { key: "new", value: newShare, opacity: 1 },
    { key: "repeat", value: 1 - newShare, opacity: 0.25 },
  ];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          innerRadius="72%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
          stroke="none"
          isAnimationActive={false}
        >
          {data.map((d) => (
            <Cell key={d.key} fill={BRAND} fillOpacity={d.opacity} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}
