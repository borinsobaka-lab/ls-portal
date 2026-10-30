/**
 * «Отзывы» — подписи и расчёты для страниц, как у них в app.py (`reviews_page`,
 * `staff_feedback_page`, `staff_feedback_links_page`, `format_review_date`):
 * период по умолчанию — текущий месяц по Москве, числа — с их округлением
 * (round() Python: ровно посередине — к чётному), инициалы, поиск сотрудника
 * и латиницей.
 */
import { pyRound } from "../onec-reports/payload";
import { mskToday } from "../core";

/** Их период по умолчанию: с 1-го числа по сегодня (Москва). */
export function rvDefaultPeriod(now = Date.now()): { from: string; to: string } {
  const to = mskToday(now);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** Их «Показать»: конец раньше начала — меняются местами. */
export function rvPeriod(from: string, to: string): { from: string; to: string } {
  return from <= to ? { from, to } : { from: to, to: from };
}

// Их MONTH_NAMES — именительный падеж («1 сентябрь 2026»), как у них.
const MONTH_NAMES = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

/** Их format_review_date: ГГГГ-ММ-ДД → «1 сентябрь 2026», иначе как есть. */
export function formatReviewDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return value;
  return `${+m[3]} ${MONTH_NAMES[+m[2] - 1]} ${+m[1]}`;
}

/** f"{x:.{digits}f}" Python. */
export function pyFixed(x: number, digits: number): string {
  const r = pyRound(x, digits);
  // Python сохраняет знак у нуля: f"{-0.04:.1f}" — «-0.0».
  return (r === 0 && (x < 0 || Object.is(x, -0)) ? "-" : "") + r.toFixed(digits);
}

/** Их звёзды у средней: '★' * max(1, round(average)). */
export function ratingStars(average: number): string {
  return "★".repeat(Math.max(1, pyRound(average, 0)));
}

/** f"{rating:g}" Python для оценки 0…5. */
export function ratingText(rating: number): string {
  return String(Number(rating.toPrecision(6)));
}

/** Их инициалы: первые буквы двух первых слов, заглавными. */
export function rvInitials(name: string, fallback: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || fallback
  );
}

/** Их полоски распределения: 5…1 звёзд, доля от самой частой оценки. */
export function ratingBars(ratings: { rating: number; count: number }[]) {
  const count = (v: number) => ratings.find((r) => r.rating === v)?.count ?? 0;
  const max = Math.max(...[5, 4, 3, 2, 1].map(count), 1);
  return [5, 4, 3, 2, 1].map((value) => ({
    value,
    count: count(value),
    percent: (count(value) * 100) / max,
  }));
}

const LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function latin(s: string): string {
  return s.toLowerCase().replace(/[а-яё]/g, (c) => LATIN[c] ?? c);
}

/** Их поиск в «Ссылках»: по имени и должности, в том числе латиницей. */
export function staffMatches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = text.toLowerCase();
  return t.includes(q) || latin(t).includes(latin(q));
}

/** Постоянная ссылка формы отзыва о сотруднике. */
export function feedbackUrl(origin: string, token: string): string {
  return `${origin}/analytics-feedback/${token}`;
}
