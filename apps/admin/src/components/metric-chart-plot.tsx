import { useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatNumber } from "@/lib/format";

/**
 * Сам график из окна показателя на дашборде (MetricChart в
 * components/dashboard/stat-cards.tsx). Вынесен в свой файл ради отдельного
 * чанка: recharts (~100 kB gzip) грузится, только когда окно открыли.
 */

export type ChartType = "bar" | "line" | "area";

export type ChartPoint = {
  tick: string;
  label: string;
  value: number | null;
  /** Знаменатель среднего в корзине: продаж (средний чек), занятий, мест… */
  n: number;
};

const compactNumber = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function MetricChartPlot({
  data,
  chartType,
  color,
  dots,
  format,
  showDeals,
  base = { label: "Продаж", empty: "нет продаж" },
  selected = null,
  onSelect,
}: {
  data: ChartPoint[];
  chartType: ChartType;
  color: string;
  /** Точки на линии (по дням их слишком много). */
  dots: boolean;
  format: (n: number) => string;
  /** Показывать в подсказке знаменатель (средние показатели). */
  showDeals: boolean;
  /** Чем считается знаменатель: подпись и текст пустой корзины. */
  base?: { label: string; empty: string };
  /** Выбранная корзина (индекс) — подсвечена, остальные бледнее. */
  selected?: number | null;
  /** Нажатие на корзину — подробный отчёт за неё (список справа в окне). */
  onSelect?: (index: number) => void;
}) {
  const gradientId = `chart-fill-${useId().replace(/:/g, "")}`;
  // У средних корзина без продаж — null, а не 0. Линия и область рисуются
  // только между соседними непустыми точками: при редких продажах от них
  // оставались одинокие точки или вовсе ничего. Поэтому пропуски соединяем
  // (connectNulls), а настоящие значения помечаем точками — так видно, где
  // данные есть, и единственная непустая корзина тоже видна.
  const gaps = data.some((d) => d.value === null);
  const dot = dots || gaps ? { r: 3, fill: color } : false;

  const axis = {
    tick: { fontSize: 11, fill: "var(--muted-foreground)" },
    tickLine: false,
    axisLine: false,
  };
  const tooltip = (
    <Tooltip
      // Иначе на корзине без продаж (null) подсказки нет вовсе, а не «нет продаж».
      filterNull={false}
      cursor={
        chartType === "bar"
          ? { fill: "var(--muted)", opacity: 0.6 }
          : { stroke: "var(--border)", strokeWidth: 1 }
      }
      content={({ active, payload }) => {
        const row = active ? payload?.[0]?.payload : null;
        if (!row) return null;
        return (
          <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
            <div className="font-medium first-letter:uppercase">{row.label}</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">
              {row.value === null ? base.empty : format(row.value)}
            </div>
            {showDeals && row.n > 0 && (
              <div className="text-muted-foreground">
                {base.label.toLowerCase()}: {formatNumber(row.n)}
              </div>
            )}
          </div>
        );
      }}
    />
  );
  const common = {
    data,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
    // Нажатие в любом месте над корзиной, а не только по столбцу: у низких
    // столбцов и у линии попасть иначе трудно.
    onClick: onSelect
      ? (state: { activeTooltipIndex?: number } | null) => {
          if (state?.activeTooltipIndex != null) onSelect(state.activeTooltipIndex);
        }
      : undefined,
    style: onSelect ? { cursor: "pointer" } : undefined,
  };
  // У линии и области выбранная корзина — вертикальной чертой.
  const band = selected !== null && data[selected] && (
    <ReferenceLine x={data[selected].tick} stroke={color} strokeDasharray="4 3" />
  );
  const grid = <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />;
  const xAxis = (
    <XAxis dataKey="tick" {...axis} interval="preserveStartEnd" minTickGap={12} tickMargin={8} />
  );
  const yAxis = (
    <YAxis {...axis} width={64} allowDecimals={false} tickFormatter={compactNumber.format} />
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      {chartType === "bar" ? (
        <BarChart {...common}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={48}>
            {data.map((d, i) => (
              <Cell key={d.tick + i} fillOpacity={selected === null || selected === i ? 1 : 0.35} />
            ))}
          </Bar>
        </BarChart>
      ) : chartType === "line" ? (
        <LineChart {...common}>
          {grid}
          {band}
          {xAxis}
          {yAxis}
          {tooltip}
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            connectNulls
            dot={dot}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      ) : (
        <AreaChart {...common}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {grid}
          {band}
          {xAxis}
          {yAxis}
          {tooltip}
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            connectNulls
            dot={gaps ? dot : false}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}
