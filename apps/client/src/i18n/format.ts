import { type Locale, intlLocale } from "./locales";

/**
 * Даты, время и числа на языке клиента: t.date(d, {…}), t.time(d), t.number(n).
 *
 * Зачем не просто toLocaleDateString(t.intl): в Chromium (Chrome на Android,
 * десктопный Chrome) нет данных грузинского языка — ka-GE молча превращается в
 * английский («Mon, October 12»). Если браузер грузинский не знает, дату
 * собираем сами из грузинских названий дней и месяцев (порядок — как у
 * Intl для ka: «ორშ, 12 ოქტომბერი, 2026»), числа — с разделителями ru-RU
 * (у грузинского те же: пробел и запятая). iOS и сервер (Node) знают ka и
 * идут обычным путём.
 */

const KA_WEEKDAYS_LONG = [
  "კვირა",
  "ორშაბათი",
  "სამშაბათი",
  "ოთხშაბათი",
  "ხუთშაბათი",
  "პარასკევი",
  "შაბათი",
];
const KA_WEEKDAYS_SHORT = ["კვი", "ორშ", "სამ", "ოთხ", "ხუთ", "პარ", "შაბ"];
const KA_MONTHS_LONG = [
  "იანვარი",
  "თებერვალი",
  "მარტი",
  "აპრილი",
  "მაისი",
  "ივნისი",
  "ივლისი",
  "აგვისტო",
  "სექტემბერი",
  "ოქტომბერი",
  "ნოემბერი",
  "დეკემბერი",
];
const KA_MONTHS_SHORT = [
  "იან",
  "თებ",
  "მარ",
  "აპრ",
  "მაი",
  "ივნ",
  "ივლ",
  "აგვ",
  "სექ",
  "ოქტ",
  "ნოე",
  "დეკ",
];

let kaSupported: boolean | null = null;
function intlKnowsGeorgian() {
  if (kaSupported === null) {
    try {
      kaSupported = Intl.DateTimeFormat.supportedLocalesOf(["ka"]).length > 0;
    } catch {
      kaSupported = false;
    }
  }
  return kaSupported;
}

/** Для чисел без грузинского в Intl — ru-RU (те же разделители). */
function numberLocale(locale: Locale) {
  return locale === "ka" && !intlKnowsGeorgian() ? "ru-RU" : intlLocale(locale);
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Числа даты в нужном часовом поясе (если задан). */
function dateParts(date: Date, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAY_INDEX[get("weekday")] ?? date.getDay(),
    year: Number(get("year")),
    month: Number(get("month")) - 1,
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function georgianDate(date: Date, o: Intl.DateTimeFormatOptions): string {
  const p = dateParts(date, o.timeZone);
  const day = o.day === "2-digit" ? pad(p.day) : String(p.day);
  let text: string;
  if (o.month === "numeric" || o.month === "2-digit") {
    // ka: 12.10.2026
    const month = o.month === "2-digit" ? pad(p.month + 1) : String(p.month + 1);
    text = [o.day ? day : null, month, o.year ? String(p.year) : null].filter(Boolean).join(".");
  } else {
    const month = o.month ? (o.month === "long" ? KA_MONTHS_LONG : KA_MONTHS_SHORT)[p.month] : null;
    text = [o.day ? day : null, month].filter(Boolean).join(" ");
    if (o.year) text = text ? `${text}, ${p.year}` : String(p.year);
  }
  if (o.weekday) {
    const weekday = (o.weekday === "long" ? KA_WEEKDAYS_LONG : KA_WEEKDAYS_SHORT)[p.weekday];
    text = text ? `${weekday}, ${text}` : weekday;
  }
  if (o.hour || o.minute) {
    const time = `${p.hour}:${p.minute}`;
    text = text ? `${text}, ${time}` : time;
  }
  return text;
}

function toDate(value: Date | string | number) {
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(
  locale: Locale,
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = toDate(value);
  if (locale === "ka" && !intlKnowsGeorgian()) return georgianDate(date, options);
  return date.toLocaleDateString(intlLocale(locale), options);
}

/** Время «19:00» (24 часа во всех трёх языках). */
export function formatTime(
  locale: Locale,
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" },
): string {
  const date = toDate(value);
  if (locale === "ka" && !intlKnowsGeorgian()) {
    const p = dateParts(date, options.timeZone);
    return `${p.hour}:${p.minute}`;
  }
  return date.toLocaleTimeString(intlLocale(locale), options);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const tag = numberLocale(locale);
  const key = `${tag}|${JSON.stringify(options ?? {})}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, f);
  }
  return f.format(value);
}
