import { differenceInCalendarDays, parseISO } from "date-fns";

import type { SaleOrigin, SaleRecord } from "@/lib/dashboard-analytics";
import { formatNumber } from "@/lib/format";
import { plural } from "@/lib/payroll";

/**
 * Подробный отчёт плитки дашборда — список справа от графика в окне плитки:
 * кто стоит за цифрой (клиенты, продажи, абонементы, занятия), чтобы с ними
 * поработать: позвать на продление, напомнить о платеже, предложить пакет.
 * Строки — те же точки, что у графика (SeriesPoint.row), поэтому список
 * всегда совпадает с цифрой; без React и Supabase (тест — dashboard-details.test.ts).
 */

/** Цвет плашки строки: хорошо (купил), плохо (просрочен), внимание (скоро), нейтрально. */
export type DetailTone = "good" | "bad" | "warn" | "muted";

export type DetailRow = {
  /** Уникален в списке плитки. */
  key: string;
  /** Локальная дата yyyy-MM-dd — по ней строка попадает в период или столбец графика. */
  date: string;
  /** Дата в строке вместо `date` («—» у абонемента, срок которого не начался). */
  dateText?: string;
  /** Карточка клиента: имя, телефон и ссылка на карточку — по ней. */
  clientId?: string | null;
  /** Учётная запись приложения — если карточки в строке нет (журнал посещений). */
  userId?: string | null;
  /**
   * Имя без карточки (снимок в журнале) или подпись строки, где клиента нет
   * вовсе (занятие расписания).
   */
  name?: string;
  /** Что: абонемент, позиция продажи, тренировка. */
  title?: string;
  /** Подробности: остаток, продавец, промокод, комментарий. */
  note?: string;
  /** Число справа: сумма, посещения, доля — в формате списка (DetailsSpec.format). */
  value?: number;
  badge?: { text: string; tone: DetailTone };
  /** Требует действия (не купил, просрочил, критик) — такие строки первыми. */
  attention?: boolean;
};

/**
 * Порядок списка: date — от ранних (окончания, сроки платежей — сначала
 * ближайшие), dateDesc — свежие сверху, value — по числу справа, valueAsc —
 * от меньшего (заполняемость: пустые занятия первыми).
 */
export type DetailSort = "date" | "dateDesc" | "value" | "valueAsc";

export type DetailsSpec = {
  /** Заголовок списка: «У кого заканчиваются», «Кто должен». */
  title: string;
  /** Что в строке — для счётчика: ["клиент", "клиента", "клиентов"]. */
  unit: [string, string, string];
  /** Подпись даты в строке: «Окончание», «Срок оплаты»; без неё — просто дата. */
  dateLabel?: string;
  /** Дата строкам не нужна (члены клуба по посещениям и LTV). */
  noDate?: boolean;
  /** Вид числа справа (как у плиток, lib/dashboard-stats.ts). */
  format?: "money" | "number" | "percent" | "days" | "score";
  /** Слово после штук справа: «3 посещения». */
  valueUnit?: [string, string, string];
  /** Подпись итога по числу справа («Сумма»); без неё итога нет. */
  totalLabel?: string;
  sort: DetailSort;
  /**
   * Строки одного клиента — одной строкой: число справа складывается, дата —
   * последняя (посещения: сколько раз пришёл).
   */
  group?: boolean;
  /** Текст пустого списка. */
  empty: string;
};

/** Ключ человека в строке: карточка, учётная запись, иначе имя из журнала. */
export function personKey(row: DetailRow) {
  if (row.clientId) return `c:${row.clientId}`;
  if (row.userId) return `u:${row.userId}`;
  return `n:${row.name ?? row.key}`;
}

/** Строки одного клиента — одной: число справа — сумма, дата — последняя, внимание — у любой. */
export function groupRows(rows: DetailRow[]): DetailRow[] {
  const groups = new Map<string, DetailRow>();
  for (const row of rows) {
    const key = personKey(row);
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, { ...row, key, value: row.value ?? 1 });
      continue;
    }
    groups.set(key, {
      ...prev,
      date: row.date > prev.date ? row.date : prev.date,
      clientId: prev.clientId ?? row.clientId,
      userId: prev.userId ?? row.userId,
      value: (prev.value ?? 0) + (row.value ?? 1),
      attention: prev.attention || row.attention,
    });
  }
  return [...groups.values()];
}

function compare(sort: DetailSort) {
  return (a: DetailRow, b: DetailRow) => {
    if (!!a.attention !== !!b.attention) return a.attention ? -1 : 1;
    let d = 0;
    if (sort === "value") d = (b.value ?? 0) - (a.value ?? 0);
    else if (sort === "valueAsc") d = (a.value ?? 0) - (b.value ?? 0);
    else if (sort === "date") d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    // Равные — свежие сверху, затем по ключу: порядок не прыгает между рендерами.
    return b.date.localeCompare(a.date) || a.key.localeCompare(b.key);
  };
}

/**
 * Строки списка за период (from–to включительно; без него — все, у
 * «сейчас»-плиток): отбор по дате, группировка и порядок.
 */
export function detailRows(
  rows: DetailRow[],
  spec: Pick<DetailsSpec, "sort" | "group">,
  range?: { from: string; to: string },
): DetailRow[] {
  const picked = range ? rows.filter((r) => r.date >= range.from && r.date <= range.to) : rows;
  return (spec.group ? groupRows(picked) : [...picked]).sort(compare(spec.sort));
}

/** «42 клиента». */
export function countText(n: number, unit: DetailsSpec["unit"]) {
  return `${formatNumber(n)} ${plural(n, unit)}`;
}

/**
 * Плашка срока от сегодня: прошёл — `past(дней)` красным («Просрочен 5 дн.»),
 * сегодня и в ближайшие `soon` дней — жёлтым, дальше — серым «Через 12 дн.».
 */
export function dueBadge(
  date: string,
  today: string,
  past: (days: number) => string,
  soon = 7,
): { text: string; tone: DetailTone; overdue: boolean } {
  const days = differenceInCalendarDays(parseISO(date), parseISO(today));
  if (days < 0) return { text: past(-days), tone: "bad", overdue: true };
  if (days === 0) return { text: "Сегодня", tone: "warn", overdue: false };
  return { text: `Через ${days} дн.`, tone: days <= soon ? "warn" : "muted", overdue: false };
}

// ---------------------------------------------------------------------------
// Строки из истории продаж («Продажи», «Маркетинг»)

/** Тип продажи в строке отчёта — плашкой. */
export const ORIGIN_BADGE: Record<SaleOrigin, NonNullable<DetailRow["badge"]>> = {
  new: { text: "Новый", tone: "good" },
  renewal: { text: "Продление", tone: "muted" },
  return: { text: "Вернулся", tone: "warn" },
  single: { text: "Разовое", tone: "muted" },
};

/** Продажа абонемента строкой отчёта: клиент, абонемент, продавец, сумма. */
export function saleDetail(s: SaleRecord, extra: Partial<DetailRow> = {}): DetailRow {
  return {
    key: `sale:${s.id}`,
    date: s.soldAt,
    clientId: s.clientId,
    title: s.membershipName,
    note: s.sellerName ? `Продал: ${s.sellerName}` : undefined,
    value: s.totalAmount,
    ...extra,
  };
}

/**
 * Купил ли клиент абонемент (не пробное, не разовое, не отменённый и не
 * удалённый) в день `since` или позже — после пробного или разового
 * посещения: не купил — повод позвонить.
 */
export function boughtSince(sales: SaleRecord[], clientId: string, since: string) {
  return sales.some(
    (s) =>
      s.clientId === clientId &&
      !s.trial &&
      !s.single &&
      !s.noMembership &&
      !s.cancelled &&
      s.soldAt >= since,
  );
}

/** Плашка «купил после пробного / разового». */
export function conversionBadge(bought: boolean): NonNullable<DetailRow["badge"]> {
  return bought ? { text: "Купил абонемент", tone: "good" } : { text: "Не купил", tone: "bad" };
}
