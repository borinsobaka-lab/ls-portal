import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatNumber } from "@/lib/format";
import type { Slice } from "./chart-panel";
import { EMPTY_RING_COLOR } from "./colors";

/**
 * Графики разделов дашборда (recharts). Файл грузится отдельным чанком
 * (lazy в ./chart-panel.tsx): дашборд — первая страница после входа.
 */

const compactNumber = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const axis = {
  tick: { fontSize: 11, fill: "var(--muted-foreground)" },
  tickLine: false,
  axisLine: false,
};

const grid = <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />;

function TooltipBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium first-letter:uppercase">{title}</div>
      {children}
    </div>
  );
}

export type DailyPoint = { tick: string; label: string; value: number };

/** Столбики по дням периода (выручка, посещения). */
export function DailyPlot({
  data,
  color,
  format,
}: {
  data: DailyPoint[];
  color: string;
  format: (n: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {grid}
        <XAxis
          dataKey="tick"
          {...axis}
          interval="preserveStartEnd"
          minTickGap={12}
          tickMargin={8}
        />
        <YAxis {...axis} width={56} allowDecimals={false} tickFormatter={compactNumber.format} />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as DailyPoint | undefined) : null;
            if (!row) return null;
            return (
              <TooltipBox title={row.label}>
                <div className="mt-1 text-sm font-semibold tabular-nums">{format(row.value)}</div>
              </TooltipBox>
            );
          }}
        />
        <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export type RatePoint = {
  tick: string;
  label: string;
  renewal: number | null;
  renewed: number;
  renewalBase: number;
  returnRate: number | null;
  returned: number;
  returnBase: number;
};

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);

/** Процент продлений и возвращений по месяцам — две линии на одной шкале 0–100%. */
export function RatesPlot({
  data,
  colors,
}: {
  data: RatePoint[];
  colors: { renewal: string; returnRate: string };
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="tick" {...axis} tickMargin={8} />
        <YAxis {...axis} width={44} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as RatePoint | undefined) : null;
            if (!row) return null;
            return (
              <TooltipBox title={row.label}>
                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: colors.renewal }}
                  />
                  Продления: <b className="tabular-nums">{pct(row.renewal)}</b>
                  <span className="text-muted-foreground">
                    ({formatNumber(row.renewed)} из {formatNumber(row.renewalBase)})
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: colors.returnRate }}
                  />
                  Возвращения: <b className="tabular-nums">{pct(row.returnRate)}</b>
                  <span className="text-muted-foreground">
                    ({formatNumber(row.returned)} из {formatNumber(row.returnBase)})
                  </span>
                </div>
              </TooltipBox>
            );
          }}
        />
        {(["renewal", "returnRate"] as const).map((key) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={colors[key]}
            strokeWidth={2}
            dot={{ r: 4, fill: colors[key], stroke: "var(--background)", strokeWidth: 2 }}
            activeDot={{ r: 5 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const RING = { innerRadius: "58%", outerRadius: "95%" } as const;

/**
 * Кольцевая диаграмма долей; подписи и значения — в легенде под ней
 * (PieLegend). Без долей — пустое серое кольцо с подписью внутри.
 */
export function PiePlot({ slices, format }: { slices: Slice[]; format: (n: number) => string }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  if (slices.length === 0) {
    return (
      <div className="relative h-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={[{ value: 1 }]}
              dataKey="value"
              {...RING}
              fill={EMPTY_RING_COLOR}
              stroke="none"
              isAnimationActive={false}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="max-w-20 text-center text-xs leading-tight text-muted-foreground">
            Нет данных за период
          </span>
        </div>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip
          content={({ active, payload }) => {
            const s = active ? (payload?.[0]?.payload as Slice | undefined) : null;
            if (!s) return null;
            return (
              <TooltipBox title={s.label}>
                <div className="mt-1 text-sm font-semibold tabular-nums">
                  {format(s.value)}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {Math.round((s.value / total) * 100)}%
                  </span>
                </div>
              </TooltipBox>
            );
          }}
        />
        <Pie
          data={slices}
          dataKey="value"
          nameKey="label"
          {...RING}
          paddingAngle={slices.length > 1 ? 1.5 : 0}
          stroke="var(--background)"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {slices.map((s) => (
            <Cell key={s.key} fill={s.color} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

/** Столбики по категориям (возрастные группы). */
export function CategoryPlot({
  data,
  color,
  format,
}: {
  data: { label: string; value: number }[];
  color: string;
  format: (n: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="label" {...axis} interval={0} tickMargin={8} />
        <YAxis {...axis} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as { label: string; value: number }) : null;
            if (!row) return null;
            return (
              <TooltipBox title={row.label}>
                <div className="mt-1 text-sm font-semibold tabular-nums">{format(row.value)}</div>
              </TooltipBox>
            );
          }}
        />
        <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={56} />
      </BarChart>
    </ResponsiveContainer>
  );
}
