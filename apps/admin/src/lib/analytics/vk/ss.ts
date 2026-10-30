/**
 * VK Ads: источники «сообщений сообщества» (СС) — правила их vk_ads.py
 * (`_spreadsheet_id_from_url`, `_sheet_date`, `_source_daily_counts`) и
 * city_aliases.py. Без запросов: их читают сервер сбора СС и страницы.
 */

/** Их city_aliases.canonical_city — одна замена: Казань Lady Jump. */
export function vkCanonicalCity(brand: string, city: string): string {
  const cleaned = city.replace(/\u00a0/g, " ").trim();
  if (
    brand.trim() === "Lady Jump" &&
    ["Казань", "Казань Вишневского", "Казань · Вишневского"].includes(cleaned)
  ) {
    return "Казань · Вишневского";
  }
  return city;
}

const ID_CHARS = /^[A-Za-z0-9_-]+$/;

/** Их _spreadsheet_id_from_url: часть пути после «d». */
export function ssSpreadsheetId(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/[?#].*$/, "");
  }
  const parts = path.split("/");
  const at = parts.indexOf("d");
  if (at < 0 || at + 1 >= parts.length) {
    throw new Error("Не удалось извлечь ID Google Таблицы из ссылки.");
  }
  const id = parts[at + 1];
  if (!id || !ID_CHARS.test(id)) throw new Error("Некорректный ID Google Таблицы.");
  return id;
}

/** ID таблицы для запросов к Google — их проверка в google_sheets.py. */
export function ssCheckId(id: string): string {
  const v = id.trim();
  if (!v || !ID_CHARS.test(v)) throw new Error("Некорректный ID Google Таблицы.");
  return v;
}

const MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
  янв: 1,
  фев: 2,
  мар: 3,
  апр: 4,
  май: 5,
  июн: 6,
  июл: 7,
  авг: 8,
  сен: 9,
  окт: 10,
  ноя: 11,
  дек: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** date(y, m, d).isoformat() или null, если такой даты нет. */
function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/**
 * Их _sheet_date: ГГГГ-ММ-ДД где угодно в строке, ДД.ММ.ГГГГ (или через
 * «/»), «5 октября 2026», иначе серийный номер даты Google (4–6 цифр).
 * Найденный, но несуществующий день — None (дальше не ищут).
 */
export function ssSheetDate(raw: string): string | null {
  const value = raw
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase();
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(value);
  if (numeric) return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const named = /(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})/.exec(value);
  if (named && named[2] in MONTHS) {
    return isoDate(Number(named[3]), MONTHS[named[2]], Number(named[1]));
  }
  const serial = /^\s*(\d{4,6})(?:[.,]\d+)?\s*$/.exec(value);
  if (serial) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(serial[1]) * 86_400_000);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}

/**
 * Их _source_daily_counts: строки после заголовка, дата — в колонке
 * dateIndex (лиды — C, заявки — D); строка без такой колонки или без
 * распознанной даты не считается. Город в строке не проверяется (источник —
 * один город).
 */
export function ssDailyCounts(rows: string[][], dateIndex: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows.slice(1)) {
    if (row.length <= dateIndex) continue;
    const day = ssSheetDate(row[dateIndex]);
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

/** Листы и колонки дат стандартных таблиц СС (их sync_community_message_source). */
export const SS_LEADS_RANGE = "Сбор лидов!A:Z";
export const SS_APPLICATIONS_RANGE = "Номера!A:Z";
export const SS_LEADS_DATE_INDEX = 2;
export const SS_APPLICATIONS_DATE_INDEX = 3;

export type SsDay = { date: string; leads: number; applications: number };

/** Счётчики по дням для записи; пусто в обоих — их ошибка с числом строк. */
export function ssDays(leadsRows: string[][], applicationRows: string[][]): SsDay[] {
  const leads = ssDailyCounts(leadsRows, SS_LEADS_DATE_INDEX);
  const apps = ssDailyCounts(applicationRows, SS_APPLICATIONS_DATE_INDEX);
  if (leads.size === 0 && apps.size === 0) {
    throw new Error(
      "В источниках СС не найдены строки с распознанной датой. " +
        `Получено строк: лиды — ${Math.max(0, leadsRows.length - 1)}, ` +
        `заявки — ${Math.max(0, applicationRows.length - 1)}.`,
    );
  }
  return [...new Set([...leads.keys(), ...apps.keys()])].sort().map((date) => ({
    date,
    leads: leads.get(date) ?? 0,
    applications: apps.get(date) ?? 0,
  }));
}

/** urllib.parse.quote(range, safe="!:'") — как их запрос значений. */
export function pyQuoteRange(range: string): string {
  return encodeURIComponent(range)
    .replace(/%3A/gi, ":")
    .replace(/[*()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
