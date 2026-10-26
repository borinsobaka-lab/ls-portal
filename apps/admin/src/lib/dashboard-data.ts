import { addDays, differenceInCalendarDays, format } from "date-fns";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { todayISO } from "@/lib/format";
import type { SeriesKind, SeriesPoint } from "@/lib/dashboard-series";
import {
  inPeriod,
  notRenewedBeforeEnd,
  sumBy,
  type OtherSaleRecord,
  type RefundRecord,
  type SaleRecord,
} from "@/lib/dashboard-analytics";
import type { ClassEntry } from "@/lib/dashboard-classes";
import { dueBadge, type DetailRow, type DetailsSpec } from "@/lib/dashboard-details";
import type { NpsAnswer } from "@/lib/dashboard-marketing";

/**
 * Загрузка данных дашборда из Supabase: показатели «Общих показателей»,
 * история продаж («Продажи», «Клиенты», «Маркетинг», графики), посещения,
 * клиенты, занятия расписания («Занятия»), анкеты и NPS («Маркетинг»).
 * Расчёты над строками — lib/dashboard-analytics.ts и lib/dashboard-series.ts.
 */

export function toISO(d: Date) {
  return format(d, "yyyy-MM-dd");
}

// Границы локальных суток как моменты времени для timestamptz-колонок.
// Строку без смещения ("YYYY-MM-DDT00:00:00") сервер читает в своём поясе
// (UTC), и окно периода съезжало на 4 часа относительно суток студии.
export function dayStartISO(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}

export function nextDayStartISO(date: string) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Локальная дата yyyy-MM-dd момента timestamptz. */
export function localDate(ts: string) {
  return toISO(new Date(ts));
}

export type Period = { from: string; to: string };

/** Предыдущий период той же длины, вплотную перед выбранным. */
export function previousPeriod(period: Period): Period {
  const from = new Date(`${period.from}T00:00:00`);
  const to = new Date(`${period.to}T00:00:00`);
  const days = differenceInCalendarDays(to, from) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from: toISO(prevFrom), to: toISO(prevTo) };
}

/** Показатели «Общих показателей» за период — для выбранного и предыдущего периода. */
export type PeriodMetrics = {
  revenue: number;
  signups: number;
  expiring: number;
  visits: number;
  avgMembership: number;
  avgServices: number;
  avgTotal: number;
  debtPeriod: number;
};

/** Показатели «на сейчас» — от выбранного периода не зависят. */
export type SnapshotMetrics = {
  activeClients: number;
  debtTotal: number;
};

export type OverviewMetrics = PeriodMetrics & SnapshotMetrics;

/** Метрика, которую не удалось посчитать, — undefined: в карточке «—», а не 0. */
type Loaded<T> = { metrics: Partial<T>; errors: string[] };

type SupabaseResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

type Row = Record<string, unknown>;

// Таблица ещё не создана миграцией (other_sales, refunds — AGENT_TASKS,
// Задача 6): данных нет — это 0, а не ошибка.
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/**
 * Запросы метрик независимы: упавший даёт undefined только своим метрикам
 * (текст ошибки — в общий тост), соседние карточки считаются как обычно.
 * `load` — запрос с count (строки не нужны), `loadRows` — все строки
 * источника постранично: суммы считаются по строкам, а PostgREST отдаёт не
 * больше 1000 строк на ответ.
 */
function makeLoader(errors: string[]) {
  async function load(query: PromiseLike<SupabaseResult>) {
    const { data, error, count } = await query;
    if (error) {
      if (error.code && MISSING_TABLE.has(error.code)) return { rows: [], count: 0 };
      errors.push(error.message);
      return undefined;
    }
    return { rows: (data ?? []) as Row[], count: count ?? 0 };
  }
  async function guard<T>(promise: Promise<T>) {
    try {
      return await promise;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }
  const loadRows = (source: SeriesSource) => guard(loadAllRows(source).then((rows) => ({ rows })));
  return { load, loadRows, guard };
}

/** Встроенная связь PostgREST: объект или массив из одного. */
const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

function sum(rows: Row[], column: string) {
  return rows.reduce<number>((s, r) => s + Number(r[column] ?? 0), 0);
}

/** Статусы абонементов в «Заканчивается абонементов» — карточка и график. */
const EXPIRING_STATUSES = ["active", "frozen", "expired"];

export async function loadPeriodMetrics(
  studioIds: string[],
  from: string,
  to: string,
): Promise<Loaded<PeriodMetrics>> {
  const errors: string[] = [];
  const { load, loadRows, guard } = makeLoader(errors);
  const [saleRows, signups, expiring, visits, debtRows, otherSaleRows, refundRows, written] =
    await Promise.all([
      loadRows(sales(studioIds, from, to)),
      load(
        supabase
          .from("clients")
          .select("id", { count: "exact", head: true })
          .in("studio_id", studioIds)
          .gte("registration_date", from)
          .lte("registration_date", to),
      ),
      guard(expiringMemberships(studioIds, from, to)),
      load(
        supabase
          .from("bookings_log")
          .select("id", { count: "exact", head: true })
          .in("studio_id", studioIds)
          .eq("status", "attended")
          .gte("starts_at", dayStartISO(from))
          .lt("starts_at", nextDayStartISO(to)),
      ),
      // Задолженность за период — неоплаченные взносы со сроком в диапазоне
      loadRows(unpaidInstallments(studioIds, from, to)),
      // Продажи услуг и товаров — отдельная таблица, но выручка общая.
      loadRows(otherSales(studioIds, from, to)),
      // Возвраты уменьшают выручку за период.
      loadRows(refunds(studioIds, from, to)),
      // И платежи рассрочки, снятые возвратом (пакетные клубы).
      guard(writtenOffInstallments(studioIds)),
    ]);

  const metrics: Partial<PeriodMetrics> = {
    signups: signups?.count,
    expiring: expiring?.length,
    visits: visits?.count,
    debtPeriod: debtRows && sum(debtRows.rows, "amount"),
  };
  if (saleRows) {
    const revenue = sum(saleRows.rows, "total_amount");
    metrics.avgMembership = saleRows.rows.length ? revenue / saleRows.rows.length : 0;
  }
  if (otherSaleRows) {
    const revenue = sum(otherSaleRows.rows, "total_amount");
    metrics.avgServices = otherSaleRows.rows.length ? revenue / otherSaleRows.rows.length : 0;
  }
  if (saleRows && otherSaleRows) {
    const revenue = sum(saleRows.rows, "total_amount") + sum(otherSaleRows.rows, "total_amount");
    const deals = saleRows.rows.length + otherSaleRows.rows.length;
    metrics.avgTotal = deals ? revenue / deals : 0;
    // Выручка — абонементы плюс услуги и товары, минус возвраты и снятые
    // возвратом платежи рассрочки (их нет в сумме возврата: денег не вносили).
    if (refundRows && written) {
      const writtenOff = sumBy(
        written.filter((w) => inPeriod(w.date, from, to)),
        (w) => w.amount,
      );
      metrics.revenue = revenue - sum(refundRows.rows, "amount") - writtenOff;
    }
  }
  return { metrics, errors };
}

export async function loadSnapshotMetrics(studioIds: string[]): Promise<Loaded<SnapshotMetrics>> {
  const errors: string[] = [];
  const { loadRows } = makeLoader(errors);
  const [active, debtRows] = await Promise.all([
    loadRows({
      date: "ends_at",
      page: (lo, hi) =>
        select("client_memberships", "client_id, ends_at", lo)
          .in("studio_id", studioIds)
          .eq("status", "active")
          .order("id")
          .range(lo, hi),
    }),
    // Общая задолженность — все неоплаченные взносы по студии
    loadRows(unpaidInstallments(studioIds)),
  ]);

  const today = toISO(new Date());
  const current = active?.rows.filter((m) => !m.ends_at || String(m.ends_at) >= today);
  return {
    metrics: {
      activeClients: current && new Set(current.map((m) => m.client_id)).size,
      debtTotal: debtRows && sum(debtRows.rows, "amount"),
    },
    errors,
  };
}

/** Тост о метриках, которые не удалось посчитать (сами они — «—»). */
export function reportErrors(what: string, errors: string[]) {
  if (errors.length) toast.error(`${what}: ${[...new Set(errors)].join("; ")}`);
}

/**
 * Строки одной таблицы: откуда взять дату и сумму. Строк бывает больше
 * лимита PostgREST на ответ (1000), поэтому `page` — запрос одной страницы,
 * а `loadAllRows` догружает остальные.
 */
type SeriesSource = {
  page: (lo: number, hi: number) => PromiseLike<SupabaseResult>;
  date: string;
  /** timestamptz — дату берём по локальным суткам; иначе колонка date. */
  timestamp?: boolean;
  /** Без суммы точка — просто «одна штука». */
  amount?: string;
  /** Возвраты вычитаются из выручки. */
  sign?: number;
  /** Считается в число продаж (знаменатель среднего чека)? */
  deal?: boolean;
  /** Строка подробного отчёта (кто и что) — для списка в окне плитки. */
  row?: (r: Row, date: string) => DetailRow;
};

/** График показателя в окне карточки: как получить точки за отрезок дат. */
export type SeriesDef = {
  kind: SeriesKind;
  /** Что именно на графике — подзаголовок окна. */
  description: string;
  /**
   * Показатель смотрит вперёд (окончания абонементов, сроки взносов) — график
   * заканчивается концом выбранного периода. Остальные — не позже сегодня:
   * будущие корзины выручки и посещений всегда пустые.
   */
  future?: boolean;
  /**
   * У среднего — чем считается знаменатель (подпись в окне и текст пустой
   * корзины); по умолчанию продажи: «Продаж за 12 месяцев», «нет продаж».
   */
  base?: { label: string; empty: string };
  /**
   * Подробный отчёт справа от графика — строки точек (SeriesPoint.row):
   * клиенты, продажи, абонементы. Без него окно — только график.
   */
  details?: DetailsSpec;
  load: (studioIds: string[], from: string, to: string) => Promise<SeriesPoint[]>;
};

const PAGE_SIZE = 1000;

function select(table: string, columns: string, lo: number) {
  return supabase.from(table).select(`id, ${columns}`, lo === 0 ? { count: "exact" } : undefined);
}

/** Подпись клиента и абонемента продажи — строки подробного отчёта. */
const SALE_COLUMNS = {
  sales: "client_id, memberships(name)",
  other_sales: "client_id, item_name",
};

/** Продажа строкой отчёта: клиент, абонемент или позиция, сумма. */
function saleRow(table: "sales" | "other_sales") {
  return (r: Row, date: string): DetailRow => ({
    key: `${table}:${r.id}`,
    date,
    clientId: (r.client_id as string | null) ?? null,
    title:
      table === "sales"
        ? (one(r.memberships as { name: string | null } | null)?.name ?? "Абонемент")
        : String(r.item_name ?? "Прочая продажа"),
    value: Number(r.total_amount ?? 0),
  });
}

function salesSource(table: "sales" | "other_sales") {
  return (studioIds: string[], from: string, to: string): SeriesSource => ({
    date: "sold_at",
    amount: "total_amount",
    row: saleRow(table),
    page: (lo, hi) =>
      select(table, `sold_at, total_amount, ${SALE_COLUMNS[table]}`, lo)
        .in("studio_id", studioIds)
        .gte("sold_at", from)
        .lte("sold_at", to)
        .order("sold_at")
        .order("id")
        .range(lo, hi),
  });
}

const sales = salesSource("sales");
const otherSales = salesSource("other_sales");

/**
 * Неоплаченные взносы студии: со сроком в from–to или (без границ) все.
 * Снятые возвратом (пакетные клубы, refunded) уже никто не должен.
 */
function unpaidInstallments(studioIds: string[], from?: string, to?: string): SeriesSource {
  const now = todayISO();
  return {
    date: "due_date",
    amount: "amount",
    row: (r, date) => {
      const sale = one(
        r.sales as { client_id: string | null; memberships: { name: string } | null } | null,
      );
      const due = dueBadge(date, now, (d) => `Просрочен ${d} дн.`);
      return {
        key: `inst:${r.id}`,
        date,
        clientId: sale?.client_id ?? null,
        title: one(sale?.memberships)?.name ?? "Абонемент",
        note: "Платёж рассрочки",
        value: Number(r.amount ?? 0),
        badge: { text: due.text, tone: due.tone },
        attention: due.overdue,
      };
    },
    page: (lo, hi) => {
      let q = select(
        "sale_installments",
        "due_date, amount, sales!inner(studio_id, client_id, memberships(name))",
        lo,
      )
        .eq("paid", false)
        .eq("refunded", false)
        .in("sales.studio_id", studioIds);
      if (from) q = q.gte("due_date", from);
      if (to) q = q.lte("due_date", to);
      return q.order("due_date").order("id").range(lo, hi);
    },
  };
}

function refunds(studioIds: string[], from: string, to: string): SeriesSource {
  return {
    date: "refunded_at",
    timestamp: true,
    amount: "amount",
    sign: -1,
    deal: false,
    row: (r, date) => {
      const sale = one(
        r.sales as { client_id: string | null; memberships: { name: string } | null } | null,
      );
      const other = one(
        r.other_sales as { client_id: string | null; item_name: string | null } | null,
      );
      return {
        key: `refund:${r.id}`,
        date,
        clientId: sale?.client_id ?? other?.client_id ?? null,
        title: one(sale?.memberships)?.name ?? other?.item_name ?? "Продажа",
        value: -Number(r.amount ?? 0),
        badge: { text: "Возврат", tone: "bad" },
      };
    },
    page: (lo, hi) =>
      select(
        "refunds",
        "refunded_at, amount, sales(client_id, memberships(name)), other_sales(client_id, item_name)",
        lo,
      )
        .in("studio_id", studioIds)
        .gte("refunded_at", dayStartISO(from))
        .lt("refunded_at", nextDayStartISO(to))
        .order("refunded_at")
        .order("id")
        .range(lo, hi),
  };
}

/**
 * Платежи рассрочки, снятые возвратом (пакетные клубы, триггер
 * refunds_packages_apply): продажа считалась в выручку полной стоимостью, а
 * эти деньги так и не поступят. Дата — день первого возврата по продаже
 * (его и ставит триггер); у платежа своей даты снятия нет, поэтому строк —
 * все, период отбирается здесь (таких платежей единицы).
 */
async function writtenOffInstallments(studioIds: string[]) {
  const rows = await loadAllRows({
    page: (lo, hi) =>
      select(
        "sale_installments",
        "amount, sales!inner(studio_id, client_id, memberships(name), refunds(refunded_at))",
        lo,
      )
        .eq("refunded", true)
        .in("sales.studio_id", studioIds)
        .order("id")
        .range(lo, hi),
  });
  return rows.flatMap((r) => {
    const sale = one(
      r.sales as {
        client_id: string | null;
        memberships: { name: string } | null;
        refunds: { refunded_at: string }[] | null;
      } | null,
    );
    const first = (sale?.refunds ?? []).map((x) => x.refunded_at).sort()[0];
    if (!first) return [];
    const date = localDate(first);
    const amount = Number(r.amount ?? 0);
    const row: DetailRow = {
      key: `written:${r.id}`,
      date,
      clientId: sale?.client_id ?? null,
      title: one(sale?.memberships)?.name ?? "Абонемент",
      note: "Невнесённый платёж рассрочки",
      value: -amount,
      badge: { text: "Снят возвратом", tone: "muted" },
    };
    return [{ date, amount, row }];
  });
}

/**
 * «Заканчивается абонементов» — даты окончания абонементов в from–to, кроме
 * тех, что клиент уже продлил до окончания: купил следующий абонемент того же
 * вида (balance_kind) не позже дня окончания. В подписочном клубе такая
 * покупка заменяет прежний (replaced — его и так нет в выборке), в пакетном
 * продление ждёт своей очереди (pending), а прежний остаётся действующим.
 */
async function expiringMemberships(studioIds: string[], from: string, to: string) {
  const ending = await loadAllRows({
    page: (lo, hi) =>
      select(
        "client_memberships",
        "client_id, balance_kind, ends_at, created_at, visits_left, personal_left, " +
          "membership:memberships(name)",
        lo,
      )
        .in("studio_id", studioIds)
        .in("status", EXPIRING_STATUSES)
        .gte("ends_at", from)
        .lte("ends_at", to)
        .order("id")
        .range(lo, hi),
  });
  if (ending.length === 0) return [];
  // Самый ранний момент оформления (строки timestamptz сравниваем как время:
  // у дробной части секунд разная длина).
  const since = ending
    .map((m) => String(m.created_at))
    .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  // Продление — у тех же клиентов, в любом клубе: база клиентов пакетных
  // клубов общая (2026-10-17), абонемент из Ваке могли продлить в Сабуртало.
  const clientIds = [...new Set(ending.map((m) => String(m.client_id)))];
  const later = (
    await Promise.all(
      chunks(clientIds).map((ids) =>
        loadAllRows({
          page: (lo, hi) =>
            select("client_memberships", "client_id, balance_kind, created_at", lo)
              .in("client_id", ids)
              .not("status", "in", "(cancelled,refunded)")
              .gt("created_at", since)
              .order("id")
              .range(lo, hi),
        }),
      ),
    )
  ).flat();
  const key = (m: Row) => `${m.client_id}:${m.balance_kind ?? "group"}`;
  const now = todayISO();
  return notRenewedBeforeEnd(
    ending.map((m) => ({
      key: key(m),
      createdAt: Date.parse(String(m.created_at)),
      endsAt: String(m.ends_at),
      row: m,
    })),
    later.map((m) => ({
      key: key(m),
      createdAt: Date.parse(String(m.created_at)),
      date: localDate(String(m.created_at)),
    })),
  ).map((m): DetailRow => {
    const r = m.row;
    const left = r.balance_kind === "personal" ? r.personal_left : r.visits_left;
    const due = dueBadge(m.endsAt, now, (d) => `Закончился ${d} дн. назад`);
    return {
      key: `cm:${r.id}`,
      date: m.endsAt,
      clientId: String(r.client_id),
      title: one(r.membership as { name: string } | null)?.name ?? "Абонемент",
      note: left == null ? undefined : `Осталось тренировок: ${left}`,
      badge: { text: due.text, tone: due.tone },
    };
  });
}

/** Имя клиента из журнала посещений: «Фамилия Имя», иначе полное. */
function logName(r: Row) {
  return (
    [r.client_last_name, r.client_first_name].filter(Boolean).join(" ").trim() ||
    String(r.client_full_name ?? "—")
  );
}

const VISIT_COLUMNS =
  "starts_at, client_id, user_id, client_first_name, client_last_name, client_full_name";

function attendedVisits(studioIds: string[], from: string, to: string, columns = "starts_at") {
  return {
    date: "starts_at",
    timestamp: true,
    row: (r: Row, date: string): DetailRow => ({
      key: `visit:${r.id}`,
      date,
      clientId: (r.client_id as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null,
      name: logName(r),
      value: 1,
    }),
    page: (lo: number, hi: number) =>
      select("bookings_log", columns, lo)
        .in("studio_id", studioIds)
        .eq("status", "attended")
        .gte("starts_at", dayStartISO(from))
        .lt("starts_at", nextDayStartISO(to))
        .order("starts_at")
        .order("id")
        .range(lo, hi),
  } satisfies SeriesSource;
}

/** Все строки источника: первая страница с count, остальные — параллельно. */
async function loadAllRows(source: Pick<SeriesSource, "page">) {
  const unwrapPage = ({ data, error }: SupabaseResult) => {
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  };
  const first = await source.page(0, PAGE_SIZE - 1);
  if (first.error?.code && MISSING_TABLE.has(first.error.code)) return [];
  const rows = unwrapPage(first);
  const total = first.count ?? rows.length;
  // Сервер может отдавать меньше PAGE_SIZE (свой max-rows) — шаг по факту.
  const step = rows.length;
  if (!step || step >= total) return rows;
  const pages: PromiseLike<SupabaseResult>[] = [];
  for (let lo = step; lo < total; lo += step) pages.push(source.page(lo, lo + step - 1));
  return rows.concat(...(await Promise.all(pages)).map(unwrapPage));
}

/** Точки графика из таблиц: дата, сумма (со знаком) и вклад в число продаж. */
function sourcesSeries(
  sources: (studioIds: string[], from: string, to: string) => SeriesSource[],
): SeriesDef["load"] {
  return async (studioIds, from, to) => {
    const chunks = await Promise.all(
      sources(studioIds, from, to).map(async (source): Promise<SeriesPoint[]> => {
        const rows = await loadAllRows(source);
        return rows.map((r) => {
          const date = source.timestamp
            ? localDate(String(r[source.date]))
            : String(r[source.date]).slice(0, 10);
          return {
            date,
            amount: source.amount ? Number(r[source.amount] ?? 0) * (source.sign ?? 1) : 0,
            n: source.deal === false ? 0 : 1,
            row: source.row?.(r, date),
          };
        });
      }),
    );
    return chunks.flat();
  };
}

/**
 * Покупал ли клиент абонемент — плашка в списке новых клиентов: тех, кто не
 * купил, зовём первыми. Пробное (пакетные клубы) — отдельно: до покупки шаг.
 * Продажи — в любом клубе: база клиентов пакетных клубов общая.
 */
async function purchaseBadges(clientIds: string[]) {
  const rows = (
    await Promise.all(
      chunks(clientIds).map((ids) =>
        loadAllRows({
          page: (lo, hi) =>
            select("sales", "client_id, memberships(kind), client_memberships(status)", lo)
              .in("client_id", ids)
              .order("id")
              .range(lo, hi),
        }),
      ),
    )
  ).flat();
  const state = new Map<string, "bought" | "trial">();
  for (const r of rows) {
    const kind = one(r.memberships as { kind: string | null } | null)?.kind;
    const term = one(r.client_memberships as { status: string }[] | null);
    if (!term || term.status === "cancelled" || term.status === "refunded") continue;
    const id = String(r.client_id);
    if (kind === "trial") {
      if (!state.has(id)) state.set(id, "trial");
    } else if (kind !== "single") state.set(id, "bought");
  }
  return state;
}

/** Строка нового клиента: купил ли абонемент (не купил — первым в списке). */
export const PURCHASE_BADGE = {
  bought: { text: "Купил абонемент", tone: "good" },
  trial: { text: "Только пробное", tone: "warn" },
  none: { text: "Без покупки", tone: "bad" },
} as const satisfies Record<string, DetailRow["badge"]>;

/** Подробные отчёты плиток «Общих показателей» (и тех же плиток в других подразделах). */
const MONEY_ROWS = {
  unit: ["операция", "операции", "операций"],
  format: "money",
  totalLabel: "Итого",
  empty: "Продаж нет",
} as const satisfies Partial<DetailsSpec>;

/** Кто должен: неоплаченные платежи рассрочки, просроченные — первыми. */
export const DEBT_DETAILS: DetailsSpec = {
  title: "Кто должен — напомнить о платеже",
  unit: ["платёж", "платежа", "платежей"],
  format: "money",
  totalLabel: "Долг",
  dateLabel: "Срок",
  sort: "date",
  empty: "Неоплаченных платежей нет",
};

/** Графики есть у показателей за период; у «сейчас»-показателей истории нет. */
export const OVERVIEW_SERIES: Partial<Record<keyof OverviewMetrics, SeriesDef>> = {
  revenue: {
    kind: "sum",
    description: "абонементы, услуги и товары за вычетом возвратов",
    details: { title: "Продажи и возвраты", sort: "dateDesc", ...MONEY_ROWS },
    load: async (studioIds, from, to) => {
      const [points, written] = await Promise.all([
        sourcesSeries((s, f, t) => [sales(s, f, t), otherSales(s, f, t), refunds(s, f, t)])(
          studioIds,
          from,
          to,
        ),
        writtenOffInstallments(studioIds),
      ]);
      return points.concat(
        written
          .filter((w) => inPeriod(w.date, from, to))
          .map((w) => ({ date: w.date, amount: -w.amount, n: 0, row: w.row })),
      );
    },
  },
  signups: {
    kind: "count",
    description: "клиенты по дате регистрации",
    details: {
      title: "Новые клиенты",
      unit: ["клиент", "клиента", "клиентов"],
      dateLabel: "Добавлен",
      sort: "dateDesc",
      empty: "Новых клиентов нет",
    },
    load: async (studioIds, from, to) => {
      const points = await sourcesSeries((studioIds, from, to) => [
        {
          date: "registration_date",
          row: (r, date) => ({ key: `client:${r.id}`, date, clientId: String(r.id) }),
          page: (lo, hi) =>
            select("clients", "registration_date", lo)
              .in("studio_id", studioIds)
              .gte("registration_date", from)
              .lte("registration_date", to)
              .order("registration_date")
              .order("id")
              .range(lo, hi),
        },
      ])(studioIds, from, to);
      const bought = await purchaseBadges(points.flatMap((p) => (p.row ? [p.row.clientId!] : [])));
      return points.map((p) => {
        if (!p.row) return p;
        const state = bought.get(p.row.clientId!) ?? "none";
        return {
          ...p,
          row: { ...p.row, badge: PURCHASE_BADGE[state], attention: state !== "bought" },
        };
      });
    },
  },
  expiring: {
    kind: "count",
    // Прошедшие абонементы уже не active (expire_memberships), поэтому здесь
    // и истёкшие; заменённые новой покупкой, продлённые до окончания,
    // отменённые и возвращённые не считаем.
    description: "абонементы по дате окончания, кроме отменённых и продлённых досрочно",
    future: true,
    details: {
      title: "У кого заканчиваются — позвать на продление",
      unit: ["абонемент", "абонемента", "абонементов"],
      dateLabel: "Окончание",
      sort: "date",
      empty: "Непродлённых абонементов нет",
    },
    load: async (studioIds, from, to) =>
      (await expiringMemberships(studioIds, from, to)).map((row) => ({
        date: row.date,
        amount: 0,
        n: 1,
        row,
      })),
  },
  visits: {
    kind: "count",
    description: "отмеченные посещения занятий",
    details: {
      title: "Кто приходил",
      unit: ["клиент", "клиента", "клиентов"],
      valueUnit: ["посещение", "посещения", "посещений"],
      dateLabel: "Последнее",
      sort: "value",
      group: true,
      empty: "Посещений нет",
    },
    load: sourcesSeries((studioIds, from, to) => [
      attendedVisits(studioIds, from, to, VISIT_COLUMNS),
    ]),
  },
  avgMembership: {
    kind: "avg",
    description: "выручка за абонементы / число продаж",
    details: { title: "Продажи абонементов", sort: "value", ...MONEY_ROWS },
    load: sourcesSeries((s, f, t) => [sales(s, f, t)]),
  },
  avgServices: {
    kind: "avg",
    description: "выручка за услуги и товары / число продаж",
    details: { title: "Продажи услуг и товаров", sort: "value", ...MONEY_ROWS },
    load: sourcesSeries((s, f, t) => [otherSales(s, f, t)]),
  },
  avgTotal: {
    kind: "avg",
    description: "вся выручка / число продаж",
    details: { title: "Все продажи", sort: "value", ...MONEY_ROWS },
    load: sourcesSeries((s, f, t) => [sales(s, f, t), otherSales(s, f, t)]),
  },
  debtPeriod: {
    kind: "sum",
    description: "неоплаченные взносы по сроку оплаты",
    future: true,
    details: DEBT_DETAILS,
    load: sourcesSeries((studioIds, from, to) => [unpaidInstallments(studioIds, from, to)]),
  },
};

/**
 * Подробные отчёты «сейчас»-плиток: графика у них нет — только список, от
 * периода он не зависит.
 */
export const OVERVIEW_LISTS: Partial<
  Record<
    keyof OverviewMetrics,
    { details: DetailsSpec; load: (studioIds: string[]) => Promise<DetailRow[]> }
  >
> = {
  debtTotal: {
    details: DEBT_DETAILS,
    load: async (studioIds) => {
      const source = unpaidInstallments(studioIds);
      return (await loadAllRows(source)).map((r) => source.row!(r, String(r.due_date)));
    },
  },
  activeClients: {
    details: {
      title: "Действующие абонементы",
      unit: ["абонемент", "абонемента", "абонементов"],
      dateLabel: "До",
      sort: "date",
      empty: "Действующих абонементов нет",
    },
    load: async (studioIds) => {
      const rows = await loadAllRows({
        page: (lo, hi) =>
          select(
            "client_memberships",
            "client_id, ends_at, balance_kind, visits_left, personal_left, membership:memberships(name)",
            lo,
          )
            .in("studio_id", studioIds)
            .eq("status", "active")
            .order("id")
            .range(lo, hi),
      });
      const now = todayISO();
      return rows
        .filter((m) => !m.ends_at || String(m.ends_at) >= now)
        .map((m) => {
          const left = m.balance_kind === "personal" ? m.personal_left : m.visits_left;
          // Без срока (ждёт первого посещения) — в конце списка.
          const date = (m.ends_at as string | null) ?? "9999-12-31";
          const dateText = m.ends_at ? undefined : "—";
          const due = m.ends_at ? dueBadge(date, now, () => "") : null;
          return {
            key: `cm:${m.id}`,
            date,
            dateText,
            clientId: String(m.client_id),
            title: one(m.membership as { name: string } | null)?.name ?? "Абонемент",
            note: left == null ? undefined : `Осталось тренировок: ${left}`,
            badge: due
              ? { text: due.text, tone: due.tone }
              : { text: "Срок не начался", tone: "muted" as const },
          };
        });
    },
  },
};

// ---------------------------------------------------------------------------
// История продаж — «Продажи», «Клиенты» (LTV), продления и возвраты

export type SalesHistory = {
  sales: SaleRecord[];
  otherSales: OtherSaleRecord[];
  refunds: RefundRecord[];
};

/**
 * Все продажи студии за всё время: продления и возвраты смотрят на прошлые
 * покупки клиента, LTV от периода не зависит. Расчёты по периоду дальше идут
 * по этим строкам в браузере — смена периода не ходит в базу.
 */
export async function loadSalesHistory(studioIds: string[]): Promise<SalesHistory> {
  const [saleRows, otherRows, refundRows] = await Promise.all([
    loadAllRows({
      page: (lo, hi) =>
        select(
          "sales",
          "client_id, sold_at, created_at, total_amount, payment_method, seller_id, admin_name, " +
            "source, promo_code, discount_amount, " +
            "memberships(name, kind), client_memberships(ends_at, status), " +
            "sale_installments(amount, paid, paid_at, due_date, payment_method)",
          lo,
        )
          .in("studio_id", studioIds)
          .order("sold_at")
          .order("id")
          .range(lo, hi),
    }),
    loadAllRows({
      page: (lo, hi) =>
        select("other_sales", "client_id, sold_at, total_amount, payment_method, item_name", lo)
          .in("studio_id", studioIds)
          .order("sold_at")
          .order("id")
          .range(lo, hi),
    }),
    loadAllRows({
      page: (lo, hi) =>
        select("refunds", "refunded_at, amount, sale_id, other_sale_id", lo)
          .in("studio_id", studioIds)
          .order("refunded_at")
          .order("id")
          .range(lo, hi),
    }),
  ]);

  return {
    sales: saleRows.map((r) => {
      const membership = one(r.memberships as { name: string; kind: string } | null);
      const term = one(r.client_memberships as { ends_at: string | null; status: string }[]);
      const installments = (r.sale_installments ?? []) as {
        amount: number;
        paid: boolean;
        paid_at: string | null;
        due_date: string;
        payment_method: string | null;
      }[];
      const sellerName = (r.admin_name as string | null) || null;
      return {
        id: String(r.id),
        clientId: String(r.client_id),
        soldAt: String(r.sold_at),
        createdAt: String(r.created_at ?? ""),
        totalAmount: Number(r.total_amount ?? 0),
        membershipName: membership?.name ?? "Без названия",
        trial: membership?.kind === "trial",
        single: membership?.kind === "single",
        personal: membership?.kind === "personal",
        method: (r.payment_method as string | null) ?? null,
        source: String(r.source ?? "admin"),
        promoCode: (r.promo_code as string | null) || null,
        discount: Number(r.discount_amount ?? 0),
        sellerKey: (r.seller_id as string | null) ?? sellerName,
        sellerName,
        endsAt: term?.ends_at ?? null,
        cancelled: term?.status === "cancelled" || term?.status === "refunded",
        noMembership: !term,
        installments: installments.map((i) => ({
          amount: Number(i.amount ?? 0),
          paid: !!i.paid,
          date: i.paid_at ?? i.due_date,
          method: i.payment_method,
        })),
      };
    }),
    otherSales: otherRows.map((r) => ({
      id: String(r.id),
      clientId: (r.client_id as string | null) ?? null,
      soldAt: String(r.sold_at),
      totalAmount: Number(r.total_amount ?? 0),
      itemName: String(r.item_name ?? "Без названия"),
      method: (r.payment_method as string | null) ?? null,
    })),
    refunds: refundRows.map((r) => ({
      date: localDate(String(r.refunded_at)),
      amount: Number(r.amount ?? 0),
      saleId: (r.sale_id as string | null) ?? null,
      otherSaleId: (r.other_sale_id as string | null) ?? null,
    })),
  };
}

/** Посещения за период по дням (отмеченные занятия). */
export async function loadVisitDates(studioIds: string[], from: string, to: string) {
  const rows = await loadAllRows(attendedVisits(studioIds, from, to));
  return rows.map((r) => localDate(String(r.starts_at)));
}

// ---------------------------------------------------------------------------
// «Клиенты»

export type ClientRow = {
  id: string;
  userId: string | null;
  name: string;
  birthday: string | null;
  registrationDate: string | null;
  /**
   * Карточку завели в выбранных клубах. false — член клуба по абонементу,
   * проданному здесь, а карточка из другого клуба общей базы (пакетные
   * клубы, 2026-10-17): он не «новый клиент» этих клубов.
   */
  ownClub: boolean;
};

export type VisitRow = { clientId: string | null; userId: string | null; name: string };

export type ClientsData = {
  clients: ClientRow[];
  /** Члены клуба (ЧК): есть действующий абонемент, в том числе замороженный (пробный не в счёт). */
  memberIds: Set<string>;
};

/** Пробный абонемент (memberships.kind = trial) — клиента ЧК не делает. */
function isTrialRow(m: Record<string, unknown>) {
  const ref = m.membership as { kind?: string | null } | { kind?: string | null }[] | null;
  return (Array.isArray(ref) ? ref[0] : ref)?.kind === "trial";
}

const CLIENT_DATA_COLUMNS =
  "user_id, first_name, last_name, full_name, birthday, registration_date";

export async function loadClientsData(studioIds: string[]): Promise<ClientsData> {
  const [clientRows, termRows] = await Promise.all([
    loadAllRows({
      page: (lo, hi) =>
        select("clients", CLIENT_DATA_COLUMNS, lo)
          .in("studio_id", studioIds)
          .order("id")
          .range(lo, hi),
    }),
    loadAllRows({
      page: (lo, hi) =>
        select("client_memberships", "client_id, status, ends_at, membership:memberships(kind)", lo)
          .in("studio_id", studioIds)
          .in("status", ["active", "frozen"])
          .order("id")
          .range(lo, hi),
    }),
  ]);
  // Та же логика, что у статуса ЧК (lib/client-status.ts, clients_with_status).
  const today = toISO(new Date());
  const memberIds = new Set(
    termRows
      .filter((m) => !isTrialRow(m))
      .filter((m) => m.status === "frozen" || !m.ends_at || String(m.ends_at) >= today)
      .map((m) => String(m.client_id)),
  );
  // Член клуба — по абонементу, проданному в выбранных клубах; у общей базы
  // клиентов пакетных клубов (2026-10-17) его карточку могли завести в другом
  // клубе — догружаем её, иначе он выпал бы из «Членов клуба» везде, кроме
  // «все клубы».
  const own = new Set(clientRows.map((r) => String(r.id)));
  const missing = [...memberIds].filter((id) => !own.has(id));
  const extraRows = (
    await Promise.all(
      chunks(missing).map((ids) =>
        loadAllRows({
          page: (lo, hi) =>
            select("clients", CLIENT_DATA_COLUMNS, lo).in("id", ids).order("id").range(lo, hi),
        }),
      ),
    )
  ).flat();
  const toClient = (r: Row, ownClub: boolean): ClientRow => ({
    id: String(r.id),
    userId: (r.user_id as string | null) ?? null,
    name:
      [r.last_name, r.first_name].filter(Boolean).join(" ").trim() || String(r.full_name ?? "—"),
    birthday: (r.birthday as string | null) ?? null,
    registrationDate: (r.registration_date as string | null) ?? null,
    ownClub,
  });
  return {
    clients: [
      ...clientRows.map((r) => toClient(r, true)),
      ...extraRows.map((r) => toClient(r, false)),
    ],
    memberIds,
  };
}

/** Отмеченные посещения за период: кто ходил (карточка, учётная запись, имя из журнала). */
export async function loadVisits(
  studioIds: string[],
  from: string,
  to: string,
): Promise<VisitRow[]> {
  const rows = await loadAllRows(attendedVisits(studioIds, from, to, VISIT_COLUMNS));
  return rows.map((r) => ({
    clientId: (r.client_id as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    name: logName(r),
  }));
}

// ---------------------------------------------------------------------------
// «Занятия»

type EntryRow = {
  id: string;
  studio_id: string;
  kind: string | null;
  starts_at: string;
  capacity: number | null;
  cancelled_at: string | null;
  workout_id: string | null;
  workout: { name: string | null; color: string | null; capacity: number | null } | null;
  schedule_entry_trainers:
    | {
        trainer: {
          id: string;
          full_name: string | null;
          rating_avg: number | null;
          rating_count: number | null;
        } | null;
      }[]
    | null;
  bookings: { status: string; client_id?: string | null; user_id?: string | null }[];
};

/**
 * Групповые и персональные занятия клубов, начавшиеся в from–to, с тренерами
 * и записями (прочая активность дашборду не нужна). Записи — живые
 * schedule_bookings: статус каждой записи занятия.
 * `light` — только статусы записей (графики плиток за 12 месяцев).
 */
export async function loadClassEntries(
  studioIds: string[],
  from: string,
  to: string,
  light = false,
): Promise<ClassEntry[]> {
  const bookings = light ? "status" : "status, client_id, user_id";
  const rows = (await loadAllRows({
    page: (lo, hi) =>
      select(
        "schedule_entries",
        "studio_id, kind, starts_at, capacity, cancelled_at, workout_id, " +
          "workout:workouts(name, color, capacity), " +
          "schedule_entry_trainers(trainer:trainers(id, full_name, rating_avg, rating_count)), " +
          `bookings:schedule_bookings(${bookings})`,
        lo,
      )
        .in("studio_id", studioIds)
        .in("kind", ["group", "personal"])
        .gte("starts_at", dayStartISO(from))
        .lt("starts_at", nextDayStartISO(to))
        .order("starts_at")
        .order("id")
        .range(lo, hi),
  })) as unknown as EntryRow[];
  return rows.map((r) => {
    const start = new Date(r.starts_at);
    const workout = one(r.workout);
    return {
      id: r.id,
      studioId: r.studio_id,
      kind: r.kind === "personal" ? "personal" : "group",
      startsAt: start.getTime(),
      date: toISO(start),
      weekday: (start.getDay() + 6) % 7,
      time: format(start, "HH:mm"),
      cancelled: !!r.cancelled_at,
      workoutId: r.workout_id,
      workoutName: workout?.name || "Без тренировки",
      workoutColor: workout?.color ?? null,
      // Как в «Расписании»: своя вместимость занятия, иначе тренировки; 0 — без лимита.
      capacity: (r.capacity ?? workout?.capacity) || null,
      trainers: (r.schedule_entry_trainers ?? []).flatMap((x) => {
        const t = one(x.trainer);
        if (!t) return [];
        const rated = t.rating_avg != null && !!t.rating_count;
        return [
          {
            id: t.id,
            name: t.full_name || "Без имени",
            rating: rated ? Number(t.rating_avg) : null,
            ratingCount: t.rating_count ?? 0,
          },
        ];
      }),
      bookings: (r.bookings ?? []).map((b) => ({
        status: b.status,
        client: b.client_id ?? b.user_id ?? null,
        clientId: b.client_id ?? null,
        userId: b.user_id ?? null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// «Маркетинг»

/** Список id кусками: длинный `in.(…)` не влезает в адрес запроса. */
function chunks<T>(items: T[], size = 100) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Ответы анкеты приложения (member_profiles) по учётным записям: откуда
 * узнали о клубе и главная цель.
 */
export async function loadProfileAnswers(userIds: string[]) {
  const pages = await Promise.all(
    chunks(userIds).map((ids) =>
      loadAllRows({
        page: (lo, hi) =>
          supabase
            .from("member_profiles")
            .select("user_id, referral_source, primary_goal", lo === 0 ? { count: "exact" } : {})
            .in("user_id", ids)
            .order("user_id")
            .range(lo, hi),
      }),
    ),
  );
  return new Map(
    pages.flat().map((r) => [
      String(r.user_id),
      {
        referralSource: (r.referral_source as string | null) ?? null,
        goal: (r.primary_goal as string | null) ?? null,
      },
    ]),
  );
}

/**
 * Карточки клиентов из `clientIds`, у которых есть отмеченное посещение — в
 * любом клубе сети (база клиентов пакетных клубов общая, журнал всех клубов
 * сети по карточке открыт — 2026-10-17).
 */
export async function loadVisitedClientIds(clientIds: string[]) {
  const pages = await Promise.all(
    chunks(clientIds).map((ids) =>
      loadAllRows({
        page: (lo, hi) =>
          select("bookings_log", "client_id", lo)
            .in("client_id", ids)
            .eq("status", "attended")
            .order("id")
            .range(lo, hi),
      }),
    ),
  );
  return new Set(pages.flat().map((r) => String(r.client_id)));
}

/** Оценки NPS клубов с from по to (дата ответа — локальная): кто ответил и комментарий. */
export async function loadNpsScores(
  studioIds: string[],
  from: string,
  to: string,
): Promise<NpsAnswer[]> {
  const rows = await loadAllRows({
    page: (lo, hi) =>
      select("nps_responses", "score, created_at, client_id, user_id, client_name, comment", lo)
        .in("studio_id", studioIds)
        .gte("created_at", dayStartISO(from))
        .lt("created_at", nextDayStartISO(to))
        .order("created_at")
        .order("id")
        .range(lo, hi),
  });
  return rows.map((r) => ({
    id: String(r.id),
    date: localDate(String(r.created_at)),
    score: Number(r.score),
    clientId: (r.client_id as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    name: (r.client_name as string | null) || null,
    comment: (r.comment as string | null) || null,
  }));
}
