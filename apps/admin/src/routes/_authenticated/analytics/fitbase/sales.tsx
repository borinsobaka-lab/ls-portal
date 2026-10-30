import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { SERIES_COLORS } from "@/components/dashboard/colors";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbSalesBodySkeleton,
  AnalyticsFbSalesPageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { mskToday } from "@/lib/analytics/core";
import { fbSalesDataQuery } from "@/lib/analytics/fitbase/data";
import {
  FB_SHORT_MONTHS,
  fbDefaultPeriod,
  fbInteger,
  fbPercent,
  fbSalesAmountDelta,
  fbSalesAverage,
  fbSalesDelta,
  fbSalesMoney,
  fbSalesReport,
  fbTimestamp,
  type FbDelta,
  type FbSalesBucket,
  type FbSalesReport,
} from "@/lib/analytics/fitbase/reports";
import { FB_BRANDS } from "@/lib/analytics/fitbase/rules";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type SalesSearch = {
  from?: string;
  to?: string;
  brand?: string;
  city?: string;
  studio?: string;
  q?: string;
};

export const Route = createFileRoute("/_authenticated/analytics/fitbase/sales")({
  head: () => ({ meta: [{ title: "Продажи абонементов FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): SalesSearch => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 200) : undefined);
    return {
      from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
      to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
      brand: (FB_BRANDS as readonly string[]).includes(s.brand as string)
        ? (s.brand as string)
        : undefined,
      city: str(s.city),
      studio: typeof s.studio === "string" && /^\d+$/.test(s.studio) ? s.studio : undefined,
      q: str(s.q),
    };
  },
  pendingComponent: AnalyticsFbSalesPageSkeleton,
  component: AnalyticsFbSalesPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = "all";

/** Их «Правила отчёта» (fitbase_sales_page). */
const RULES = {
  sums: "Сумма оплат = поступления минус возвраты по дате платежа, включая выбранную конечную дату. Покупки для количества продаж отбираются по дате создания абонемента.",
  unclassified:
    "Часть операций пока не сопоставлена с историей: они показаны в «Не распределено». Оплаты новых + повторных + нераспределённые = сумма оплат. Средний чек новых/повторных рассчитан по сопоставленным операциям.",
  details: [
    "Суммы — операции оплаты абонементов минус возвраты по дате платежа, МСК, обе границы периода включены. Доплаты по старым абонементам включены. Стоимость договора и накопленное поле «Оплачено» не используются. Возврат вычитается один раз по ID операции. Количество продаж — покупки по дате создания абонемента; новая — первый платный абонемент клиента в клубе. Поэтому количество покупок и суммы платежей относятся к разным выборкам. Средний чек — чистые оплаты, делённые на число разных абонементов с положительной оплатой в периоде; несколько доплат по одному абонементу не увеличивают знаменатель.",
    "Правило общее для всех городов. Для сопоставления используются также удалённые абонементы и абонементы с нулевой стоимостью, по которым есть положительная оплата. Бесплатные абонементы без оплаты не меняют первую платную покупку. Известные новые/повторные оплаты показаны всегда; неизвестные связи вынесены в «Не распределено» и отмечены в детализации. При ошибке загрузки сохраняется последняя завершённая выгрузка операций; до первой загрузки сумм нет. Сравнения используют даты платежей. Автообновление ежедневно в 01:00 МСК. Отдельный отчёт выручки по городам по-прежнему заканчивается вчерашним днём.",
  ],
};

const NEW_COLOR = SERIES_COLORS[2];
const REPEAT_COLOR = SERIES_COLORS[0];
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * «Аналитика» → «FitBase» → «Продажи абонементов» — их fitbase_sales_page:
 * новые и повторные покупки, оплаты за вычетом возвратов, средние чеки,
 * сравнение с прошлым месяцем и годом, по городам и студиям. Право
 * «Продажи абонементов · FitBase» — вся сеть, только просмотр.
 */
function AnalyticsFbSalesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const def = fbDefaultPeriod(mskToday());
  const from = search.from ?? def.from;
  const to = search.to ?? def.to;
  const brand = search.brand ?? "";
  const city = search.city ?? "";
  const studio = search.studio ?? "";
  const q = search.q ?? "";
  const { data, error, isPending, isFetching } = useQuery(fbSalesDataQuery);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const [text, setText] = useState(q);
  const debounced = useDebouncedValue(text, 400);
  useEffect(() => {
    if (debounced.trim() !== q)
      void navigate({ search: (s) => ({ ...s, q: debounced.trim() || undefined }) });
  }, [debounced, q, navigate]);
  const result = useMemo(() => {
    if (!data) return null;
    if (studio && !data.connections.some((c) => String(c.id) === studio)) {
      return { error: "Недоступная студия." } as const;
    }
    try {
      return {
        report: fbSalesReport(data, { start: from, end: to, brand, city, studio, search: q }),
      };
    } catch (e) {
      return { error: (e as Error).message } as const;
    }
  }, [data, from, to, brand, city, studio, q]);
  const set = (patch: Partial<SalesSearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });
  const cities = data ? [...new Set(data.connections.map((c) => c.city))].sort(codeSort) : [];

  return (
    <AdminShell title={AN_TITLES.fbSales}>
      <div className="space-y-4">
        <TableToolbar>
          <ToolbarSearch value={text} onChange={setText} placeholder="Найти город" />
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период отчёта"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                set({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          <Select
            value={city || ALL}
            onValueChange={(v) => set({ city: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-44" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все города</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={studio || ALL}
            onValueChange={(v) => set({ studio: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Студия">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все студии</SelectItem>
              {(data?.connections ?? []).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={brand || ALL}
            onValueChange={(v) => set({ brand: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-44" aria-label="Направление">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все направления</SelectItem>
              {FB_BRANDS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !result ? (
          <AnalyticsFbSalesBodySkeleton />
        ) : "error" in result ? (
          <InfoNote variant="warning">{result.error}</InfoNote>
        ) : (
          <SalesBody r={result.report} dim={isFetching && !isPending} />
        )}
      </div>
    </AdminShell>
  );
}

function SalesBody({ r, dim }: { r: FbSalesReport; dim: boolean }) {
  const t = r.total;
  const ready = r.ready;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const cards = (
    [
      ["count", "Продажи абонементов"],
      ["new", "Новые продажи"],
      ["repeat", "Повторные продажи"],
      ["new_paid", "Оплаты новых"],
      ["repeat_paid", "Оплаты повторных продаж"],
      ["amount", "Сумма оплат"],
    ] as const
  ).map(([key, label]) => ({
    key,
    label,
    value: ready
      ? key === "count" || key === "new" || key === "repeat"
        ? fbInteger(t[key])
        : fbSalesMoney(t[key])
      : "—",
    delta: fbSalesDelta(t[key], r.previous[key], ready),
    spark: ready ? r.months.map((m) => m[key]) : [],
  }));
  const cityRows = [...r.cities].sort((a, b) => codeSort(a[0], b[0]));
  const studioRows = [...r.studios].sort(
    (a, b) => codeSort(a[0][0], b[0][0]) || a[0][1] - b[0][1] || codeSort(a[0][2], b[0][2]),
  );
  return (
    <div className={cn("space-y-4", dim && "opacity-60 transition-opacity")}>
      <p className="text-sm text-muted-foreground">
        Данные обновлены: {r.updated ? fbTimestamp(r.updated) : "Ещё не загружены"}
      </p>
      {r.pending > 0 && (
        <InfoNote variant="warning">
          Не загружены операции студий: {r.pending}. Нажмите «Обновить всё» в интеграции FitBase. До
          полной загрузки суммы показаны прочерком.
        </InfoNote>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <article
            key={c.key}
            className="flex min-w-0 flex-col gap-2 rounded-lg border bg-background p-4"
          >
            <p className="truncate text-xs font-medium text-muted-foreground">{c.label}</p>
            <p className="truncate text-2xl font-semibold tabular-nums">{c.value}</p>
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <DeltaText d={c.delta} />
                <p className="text-xs text-muted-foreground">к тому же периоду прошлого месяца</p>
              </div>
              <Spark values={c.spark} />
            </div>
          </article>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["new", "Средний чек новых"],
            ["repeat", "Средний чек повторных продаж"],
            ["all", "Средний чек общий"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="min-w-0 rounded-lg border bg-background p-4">
            <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-2xl font-semibold tabular-nums">
              {ready ? fbSalesAverage(t, key) : "—"}
            </p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-2 text-sm font-semibold">Продажи абонементов по месяцам</h2>
          <MonthChart r={r} kind="bars" />
        </section>
        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-2 text-sm font-semibold">Структура продаж</h2>
          <Structure t={t} ready={ready} />
        </section>
        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-2 text-sm font-semibold">Динамика суммы оплат</h2>
          <MonthChart r={r} kind="line" />
        </section>
      </div>
      <section className="rounded-lg border bg-background">
        <Table mobileCards={false}>
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2} className="min-w-56 align-bottom">
                Город / студия
              </TableHead>
              <TableHead colSpan={3} className="text-center">
                Продажи
              </TableHead>
              <TableHead colSpan={4} className="text-center">
                Оплаты
              </TableHead>
              <TableHead colSpan={3} className="text-center">
                Средний чек
              </TableHead>
              <TableHead colSpan={2} className="text-center">
                Динамика суммы оплат
              </TableHead>
            </TableRow>
            <TableRow>
              {[
                "Всего",
                "Новые",
                "Повторные",
                "Не распределено",
                "Новых",
                "Повторных продаж",
                "Сумма оплат",
                "Новый",
                "Повторная продажа",
                "Общий",
                "К прошлому месяцу",
                "К прошлому году",
              ].map((h) => (
                <TableHead key={h} className="text-right">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {cityRows.map(([city, values]) => {
              const [prior, year] = r.city_comparison.get(city)!;
              const isOpen = open.has(city);
              return (
                <Fragment key={city}>
                  <TableRow className="font-medium">
                    <TableCell>
                      <button
                        type="button"
                        className="mr-2 inline-flex size-6 items-center justify-center rounded-full border align-middle"
                        aria-expanded={isOpen}
                        aria-label={`Показать студии: ${city}`}
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (n.has(city)) n.delete(city);
                            else n.add(city);
                            return n;
                          })
                        }
                      >
                        {isOpen ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
                      </button>
                      {city}
                    </TableCell>
                    <SalesCells v={values} prior={prior} year={year} ready={ready} />
                  </TableRow>
                  {isOpen &&
                    studioRows
                      .filter(([key]) => key[0] === city)
                      .map(([key, v]) => {
                        const pair = r.studio_comparison.get(key[1]);
                        return (
                          <TableRow key={key[1]} className="text-muted-foreground">
                            <TableCell className="pl-12">{key[2]}</TableCell>
                            <SalesCells v={v} prior={pair?.[0]} year={pair?.[1]} ready={ready} />
                          </TableRow>
                        );
                      })}
                </Fragment>
              );
            })}
            {!cityRows.length && (
              <TableRow>
                <TableCell colSpan={13} className="py-6 text-center text-muted-foreground">
                  {ready
                    ? "За выбранный период продаж абонементов нет."
                    : "Покупки абонементов ещё не загружены. Обновите данные студии в интеграции FitBase."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <details className="rounded-lg border bg-background p-4 text-sm">
        <summary className="cursor-pointer font-medium select-none">
          Оплаты и возвраты за период
        </summary>
        <p className="mt-2 text-muted-foreground">
          Поступления: {fbSalesMoney(t.gross)} ₽. Возвраты: {fbSalesMoney(t.refund)} ₽. Итог:{" "}
          {fbSalesMoney(t.amount)} ₽. Даты — МСК.
        </p>
        <div className="mt-2 rounded-lg border">
          <Table mobileCards={false}>
            <TableHeader>
              <TableRow>
                {[
                  "Студия",
                  "Дата оплаты",
                  "ID операции",
                  "ID клиента",
                  "ID абонемента",
                  "Операция",
                  "Продажа",
                  "Сумма",
                ].map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.payment_rows.map((p) => (
                <TableRow key={`${p.connection_id}-${p.operation}-${p.step_id}`}>
                  <TableCell>{p.studio}</TableCell>
                  <TableCell className="whitespace-nowrap">{fbTimestamp(p.pay_at)}</TableCell>
                  <TableCell>{p.step_id}</TableCell>
                  <TableCell>{p.client_id || "—"}</TableCell>
                  <TableCell>{p.contract_id || "—"}</TableCell>
                  <TableCell>{p.operation === "purchase" ? "Оплата" : "Возврат"}</TableCell>
                  <TableCell>
                    {p.new === null ? "Не распределено" : p.new ? "Новая" : "Повторная"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fbSalesMoney(p.paid_cents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
      <details className="rounded-lg border bg-background p-4 text-sm">
        <summary className="cursor-pointer font-medium select-none">
          Правила отчёта и состояние загрузки
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>{RULES.sums}</p>
          {r.unclassified > 0 && <p>{RULES.unclassified}</p>}
          {RULES.details.map((d) => (
            <p key={d}>{d}</p>
          ))}
          <ul className="list-disc pl-5">
            {r.connections.map((c) => (
              <li key={c.id}>
                {c.name}: {c.sales_state}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

const TONE = { up: "text-emerald-700", down: "text-destructive", neutral: "text-muted-foreground" };

function DeltaText({ d }: { d: FbDelta }) {
  return <span className={cn("text-sm font-medium", TONE[d.tone])}>{d.text}</span>;
}

function SalesCells({
  v,
  prior,
  year,
  ready,
}: {
  v: FbSalesBucket;
  prior?: FbSalesBucket;
  year?: FbSalesBucket;
  ready: boolean;
}) {
  const num = "text-right whitespace-nowrap tabular-nums";
  return (
    <>
      {(["count", "new", "repeat"] as const).map((k) => (
        <TableCell key={k} className={num}>
          {fbInteger(v[k])}
        </TableCell>
      ))}
      {(["unassigned_paid", "new_paid", "repeat_paid", "amount"] as const).map((k) => (
        <TableCell key={k} className={num}>
          {fbSalesMoney(v[k])}
        </TableCell>
      ))}
      {(["new", "repeat", "all"] as const).map((k) => (
        <TableCell key={k} className={num}>
          {fbSalesAverage(v, k)}
        </TableCell>
      ))}
      <TableCell className={num}>
        {prior ? <DeltaText d={fbSalesAmountDelta(v.amount, prior.amount, ready)} /> : "—"}
      </TableCell>
      <TableCell className={num}>
        {year ? <DeltaText d={fbSalesAmountDelta(v.amount, year.amount, ready)} /> : "—"}
      </TableCell>
    </>
  );
}

/** Их spark: линия 9 месяцев, только при полных данных. */
function Spark({ values }: { values: (number | null)[] }) {
  const known = values.filter((v): v is number => v !== null);
  const peak = known.length ? Math.max(...known) : 0;
  if (!values.length || !peak || values.some((v) => v === null)) return null;
  const nums = values as number[];
  const low = Math.min(0, ...nums);
  const span = Math.max(0, peak) - low || 1;
  const points = nums
    .map((v, i) => `${i * 10},${(24 - ((v - low) / span) * 20).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 80 28" className="h-7 w-20 shrink-0" aria-hidden>
      <polyline points={points} fill="none" stroke="var(--brand)" strokeWidth={2} />
    </svg>
  );
}

/** Их chart(): столбцы числа продаж и линия суммы оплат за 9 месяцев. */
function MonthChart({ r, kind }: { r: FbSalesReport; kind: "bars" | "line" }) {
  if (!r.ready) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        После загрузки покупок здесь появится график
      </p>
    );
  }
  const values = r.months.map((m) => (kind === "bars" ? m.count : m.amount));
  if (values.some((v) => v === null)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Суммы требуют сверки возвратов
      </p>
    );
  }
  const nums = values as number[];
  const peak = Math.max(0, ...nums) || 1;
  const low = Math.min(0, ...nums);
  const span = Math.max(0, peak) - low || 1;
  const zero = 125 - ((0 - low) / span) * 105;
  const pts = r.months.map((m, i) => ({
    x: 50 + i * 58,
    y: 125 - ((nums[i] - low) / span) * 105,
    label: FB_SHORT_MONTHS[Number(m.month.slice(5)) - 1],
    title: `${m.month}: ${kind === "bars" ? fbInteger(nums[i]) : fbSalesMoney(nums[i])}`,
  }));
  return (
    <svg
      viewBox="0 0 570 165"
      className="w-full"
      role="img"
      aria-label={kind === "bars" ? "Количество продаж по месяцам" : "Сумма оплат по месяцам"}
    >
      {[20, 55, 90, 125].map((y) => (
        <path key={y} d={`M30 ${y}H540`} stroke="var(--border)" />
      ))}
      {kind === "line" && (
        <>
          <polygon
            points={`${pts[0].x},${zero} ${pts.map((p) => `${p.x},${p.y.toFixed(1)}`).join(" ")} ${pts[pts.length - 1].x},${zero}`}
            fill="var(--brand)"
            fillOpacity={0.12}
          />
          <polyline
            points={pts.map((p) => `${p.x},${p.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--brand)"
            strokeWidth={3}
          />
        </>
      )}
      {pts.map((p, i) => (
        <g key={i}>
          <text x={p.x} y={151} textAnchor="middle" className="fill-muted-foreground" fontSize={12}>
            {p.label}
          </text>
          {kind === "bars" ? (
            <rect
              x={p.x - 18}
              y={p.y}
              width={36}
              height={Math.max(0, 125 - p.y)}
              fill="var(--brand)"
              fillOpacity={i === 8 ? 1 : 0.35}
            >
              <title>{p.title}</title>
            </rect>
          ) : (
            <circle cx={p.x} cy={p.y} r={4} fill="var(--brand)" stroke="white" strokeWidth={2}>
              <title>{p.title}</title>
            </circle>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Их «Структура продаж»: кольцо новых и повторных. */
function Structure({ t, ready }: { t: FbSalesBucket; ready: boolean }) {
  const count = t.count;
  const pct = count ? (100 * t.new) / count : 0;
  return (
    <div className="flex items-center gap-4">
      <div
        className="relative grid size-32 shrink-0 place-items-center rounded-full"
        style={{
          background: `conic-gradient(${NEW_COLOR} 0 ${pct}%, ${REPEAT_COLOR} ${pct}% 100%)`,
        }}
      >
        <div className="grid size-22 place-items-center rounded-full bg-background text-center">
          <div>
            <p className="text-xl font-semibold tabular-nums">{ready ? fbInteger(count) : "—"}</p>
            <p className="text-xs text-muted-foreground">продаж</p>
          </div>
        </div>
      </div>
      <div className="min-w-0 space-y-2 text-sm">
        {(
          [
            ["new", "Новые продажи", NEW_COLOR],
            ["repeat", "Повторные продажи", REPEAT_COLOR],
          ] as const
        ).map(([key, label, color]) => (
          <p key={key} className="flex items-center gap-2">
            <i className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="min-w-0">{label}</span>
            <strong className="ml-auto tabular-nums">
              {count ? (
                <>
                  {ready ? fbInteger(t[key]) : "—"}{" "}
                  <span className="font-normal text-muted-foreground">
                    ({fbPercent(t[key] / count, 1)})
                  </span>
                </>
              ) : (
                "—"
              )}
            </strong>
          </p>
        ))}
      </div>
    </div>
  );
}
