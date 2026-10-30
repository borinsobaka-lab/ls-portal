import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  TREND_CHART_HEIGHT,
  fmt,
  rub,
  trendLabelPosition,
  type RevenueBar,
  type SalesTrend,
  type TrendPoint,
  type TrendSeries,
} from "@/lib/analytics/onec-reports/mycity";

/**
 * Графики доски «Мой город» (recharts, отдельным чанком — lazy в
 * mycity-board.tsx): «Выручка по месяцам» и «Динамика продаж». Что и как
 * считается — их (lib/analytics/onec-reports/mycity.ts), вид — как у
 * графиков дашборда.
 */

const tick = { fontSize: 11, fill: "var(--muted-foreground)" };

function TooltipBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium">{title}</div>
      {children}
    </div>
  );
}

/**
 * Выручка по месяцам: высота столбика — их доля от самого высокого (не
 * меньше 2 %), поэтому оси значений нет; сумма — в подсказке.
 */
export function RevenueBars({ bars, color }: { bars: RevenueBar[]; color: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={bars} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <XAxis
          dataKey="tick"
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tickMargin={6}
        />
        <YAxis hide domain={[0, 100]} />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={({ active, payload }) => {
            const bar = active ? (payload?.[0]?.payload as RevenueBar | undefined) : null;
            if (!bar) return null;
            return (
              <TooltipBox title={bar.label}>
                <div className="mt-1 text-sm font-semibold tabular-nums">{rub(bar.value)}</div>
              </TooltipBox>
            );
          }}
        />
        <Bar
          dataKey="height"
          fill={color}
          radius={[4, 4, 0, 0]}
          maxBarSize={38}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Поля графика динамики — по ним и высоте считается место подписей. */
const MARGIN = { top: 24, right: 8, bottom: 0, left: 0 };
const X_AXIS_HEIGHT = 30;
const PLOT_HEIGHT = TREND_CHART_HEIGHT - MARGIN.top - MARGIN.bottom - X_AXIS_HEIGHT;

const SERIES: { key: TrendSeries; label: string }[] = [
  { key: "newSales", label: "Новые продажи" },
  { key: "repeatSales", label: "Продления" },
];

/**
 * Динамика продаж: новые продажи и продления за шесть месяцев, значение у
 * каждой точки (место подписи — их правило, trendLabelPosition), шкала 0 —
 * середина — верх.
 */
export function SalesTrendPlot({
  trend,
  colors,
}: {
  trend: SalesTrend;
  colors: Record<TrendSeries, string>;
}) {
  const yOf = (v: number) => MARGIN.top + PLOT_HEIGHT - (v / trend.ceiling) * PLOT_HEIGHT;
  const dot =
    (series: TrendSeries) =>
    ({ cx, cy, index, key }: { cx?: number; cy?: number; index?: number; key?: string }) => {
      const point = index === undefined ? undefined : trend.points[index];
      if (cx === undefined || cy === undefined || !point) return <g key={key} />;
      const value = point[series];
      const other = series === "newSales" ? point.repeatSales : point.newSales;
      const pos = trendLabelPosition({
        series,
        pointY: yOf(value),
        otherY: yOf(other),
        top: MARGIN.top,
        plotHeight: PLOT_HEIGHT,
      });
      return (
        <g key={key}>
          <circle
            cx={cx}
            cy={cy}
            r={4.5}
            fill="var(--background)"
            stroke={colors[series]}
            strokeWidth={3}
          />
          <text
            x={cx + pos.dx}
            y={cy + pos.y - yOf(value)}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
            fill="var(--foreground)"
          >
            {fmt(value)}
          </text>
        </g>
      );
    };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={trend.points} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tick={tick}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          height={X_AXIS_HEIGHT}
          padding={{ left: 24, right: 24 }}
        />
        <YAxis
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={40}
          domain={[0, trend.ceiling]}
          ticks={trend.ticks}
          tickFormatter={(v: number) => fmt(v)}
        />
        <Tooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as TrendPoint | undefined) : null;
            if (!point) return null;
            return (
              <TooltipBox title={point.label}>
                {SERIES.map((s) => (
                  <div key={s.key} className="mt-1 flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: colors[s.key] }}
                    />
                    {s.label}: <b className="tabular-nums">{fmt(point[s.key])}</b>
                  </div>
                ))}
              </TooltipBox>
            );
          }}
        />
        {SERIES.map((s) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            stroke={colors[s.key]}
            strokeWidth={3}
            dot={dot(s.key)}
            activeDot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
