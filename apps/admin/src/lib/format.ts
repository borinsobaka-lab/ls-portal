/**
 * Общие форматтеры админки. Раньше эти функции были скопированы в 5–6 файлов,
 * причём с расхождениями по точности денег — здесь обе точности сохранены
 * намеренно, чтобы вид разделов не изменился.
 */

const MONEY_ROUND = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "GEL",
  maximumFractionDigits: 0,
});

const MONEY_PRECISE = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "GEL",
  maximumFractionDigits: 2,
});

/** Деньги без копеек: продажи, дашборд, карточка клиента. */
export function formatMoney(n: number) {
  return MONEY_ROUND.format(n);
}

/** Деньги с копейками: касса, прочие продажи (там суммы мелкие). */
export function formatMoneyPrecise(n: number) {
  return MONEY_PRECISE.format(n);
}

/** Дата в ru-RU (dd.mm.yyyy). Невалидное значение отдаём как есть. */
export function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    // «YYYY-MM-DD» new Date() читает как полночь UTC — западнее Гринвича это
    // вчерашний день. Дату без времени собираем как локальную.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("ru-RU");
    return new Date(v).toLocaleDateString("ru-RU");
  } catch {
    return v;
  }
}

/** Дата и время в ru-RU (dd.mm.yyyy, hh:mm). */
export function formatDateTime(v: string | null | undefined) {
  if (!v) return "—";
  return new Date(v).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Число с разделителями разрядов. */
export function formatNumber(n: number) {
  return new Intl.NumberFormat("ru-RU").format(n);
}

/** «Фамилия Имя» с фолбэком на full_name — единый вид имени клиента. */
export function clientName(c: {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
}) {
  const composed = [c.last_name, c.first_name].filter(Boolean).join(" ").trim();
  return composed || c.full_name || "—";
}

/**
 * Сегодняшняя дата в локальном часовом поясе (YYYY-MM-DD).
 * Через `new Date().toISOString()` брать нельзя: он отдаёт UTC, и всё раннее
 * утро студии (Тбилиси, UTC+4) продажи падали бы вчерашним днём и ломали
 * сверку кассы.
 */
export function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

/** Значение для <input type="datetime-local"> в локальном поясе (YYYY-MM-DDTHH:mm). */
export function toDateTimeLocalValue(d: Date = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}

/** Инициалы для аватара: «Мария Тренерова» -> «МТ». */
export function initials(name: string, fallback = "") {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return letters || fallback;
}

/** Полный URL (а не путь в Storage). */
export function isHttpUrl(v: string | null | undefined): v is string {
  return !!v && /^https?:\/\//i.test(v);
}

export const GENDER_OPTIONS = [
  { value: "male", label: "Мужской" },
  { value: "female", label: "Женский" },
] as const;

export function genderLabel(v: string | null | undefined) {
  return GENDER_OPTIONS.find((g) => g.value === v)?.label ?? "—";
}

/**
 * Чистит строку поиска для PostgREST-фильтра `.or()`: там запятая разделяет
 * условия, а скобки группируют, поэтому «Иванов, ООО (Ромашка)» разваливает
 * запрос и возвращает 400 вместо результата.
 */
export function sanitizeSearch(value: string) {
  return value.trim().replace(/[,()]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Строка поиска по телефону: номера хранятся без пробелов (+995555123456),
 * поэтому «555 12-34» ищем как «5551234». Не номер — как есть.
 */
export function phoneSearchTerm(term: string) {
  const digits = term.replace(/[\s-]/g, "");
  return /^\+?\d+$/.test(digits) ? digits : term;
}

/**
 * Телефон из базы для таблиц, без libphonenumber-js (она тяжёлая — грузится
 * только с «Клиентами» и карточкой, там `formatPhoneDisplay` из
 * lib/contacts.ts): грузинский мобильный и российский номер — с пробелами,
 * как у `formatPhoneDisplay`; прочее — как записано.
 */
export function formatPhone(stored: string | null | undefined): string {
  const v = (stored ?? "").trim();
  let m = /^\+995(5\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (m) return `+995 ${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(v);
  if (m) return `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  return v;
}
