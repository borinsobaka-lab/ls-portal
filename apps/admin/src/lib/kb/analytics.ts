/**
 * Аналитика чтения базы знаний (db/migrations/2026-10-25_zzzz_kb_reading_analytics.sql):
 * типы ответов RPC, подписи состояний и форматирование — без React.
 */

/** Состояние «сотрудник × статья». */
export type KbReadState = "current" | "outdated" | "unread";

export const KB_READ_STATE: Record<
  KbReadState,
  { label: string; short: string; tone: "positive" | "warning" | "neutral"; color: string }
> = {
  current: { label: "Прочитал", short: "Прочитали", tone: "positive", color: "#17B3A3" },
  outdated: {
    label: "Читал прежнюю версию",
    short: "Прежнюю версию",
    tone: "warning",
    color: "#FFBE3D",
  },
  unread: { label: "Не открывал", short: "Не открывали", tone: "neutral", color: "#D9DDE3" },
};

/** Период аналитики, дней (сегодня включительно, дни — по Тбилиси). */
export const KB_PERIODS = [
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
] as const;
export type KbPeriod = (typeof KB_PERIODS)[number]["value"];

export type KbActivity = {
  views: number;
  readers: number;
  seconds: number;
  searches: number;
  zero_searches: number;
};

export type KbOverview = {
  from: string;
  to: string;
  days: number;
  /** Сотрудники, кому выдана база (без владельцев). */
  people: number;
  /** Опубликованные статьи, видимые читателям. */
  articles: number;
  /** Пары «статья × кто должен прочитать». */
  pairs: number;
  read_current: number;
  read_outdated: number;
  completed: number;
  /** Статьи, которые никто из аудитории не открывал. */
  never_read: number;
  current: KbActivity;
  previous: KbActivity;
  daily: { day: string; views: number; readers: number; seconds: number }[];
  top_articles: { id: string; title: string; views: number; readers: number; seconds: number }[];
  attention: {
    id: string;
    title: string;
    published_at: string | null;
    audience: number;
    read_current: number;
    read_outdated: number;
  }[];
  sections: {
    id: string;
    title: string;
    icon: string | null;
    articles: number;
    pairs: number;
    read_current: number;
    read_outdated: number;
  }[];
  top_queries: { query: string; count: number; users: number; results: number; clicks: number }[];
  zero_queries: { query: string; count: number; users: number; last_at: string }[];
};

/** Вкладка «Поиск» (RPC kb_analytics_search): те же поля, что в обзоре. */
export type KbSearchStats = Pick<
  KbOverview,
  "from" | "to" | "days" | "top_queries" | "zero_queries"
> & {
  current: Pick<KbActivity, "searches" | "zero_searches">;
  previous: Pick<KbActivity, "searches" | "zero_searches">;
};

export type KbPersonRow = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  level: "view" | "edit";
  required: number;
  read_current: number;
  read_outdated: number;
  completed: number;
  seconds_total: number;
  seconds_period: number;
  views_period: number;
  active_days: number;
  first_read_at: string | null;
  last_read_at: string | null;
  last_node_id: string | null;
  last_node_title: string | null;
  last_sign_in_at: string | null;
};

export type KbPersonArticle = {
  id: string;
  title: string;
  parent_id: string | null;
  published_at: string | null;
  required: boolean;
  state: KbReadState;
  first_read_at: string | null;
  last_read_at: string | null;
  read_count: number;
  seconds: number;
  max_scroll: number;
  completed_at: string | null;
};

export type KbPersonDetail = {
  articles: KbPersonArticle[];
  daily: { day: string; views: number; seconds: number }[];
  searches: {
    query: string;
    results: number;
    clicked_node_id: string | null;
    created_at: string;
  }[];
};

export type KbReportRow = {
  id: string;
  parent_id: string | null;
  title: string;
  status: "draft" | "published" | "archived";
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  published_at: string | null;
  published_by_name: string | null;
  has_draft: boolean;
  access_count: number;
  readers_count: number;
  outdated_count: number;
  completed_count: number;
  avg_seconds: number;
  views_30d: number;
  last_read_at: string | null;
};

export type KbReader = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  state: KbReadState;
  first_read_at: string | null;
  last_read_at: string | null;
  read_count: number;
  seconds: number;
  max_scroll: number;
  completed_at: string | null;
};

/** Доля 0…1; пустой знаменатель — 0. */
export function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** «67%»; без знаменателя — «—». */
export function percentText(part: number, total: number): string {
  return total > 0 ? `${Math.round(share(part, total) * 100)}%` : "—";
}

/** Время чтения: «45 с», «12 мин», «2 ч 5 мин», «2 ч». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "0 мин";
  if (s < 60) return `${s} с`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 24 * 60 * 60 * 1000;

/** Когда: «сегодня», «вчера», «5 дн. назад», дальше 30 дней — дата. */
export function formatAgo(iso: string | null, now = new Date()): string {
  if (!iso) return "никогда";
  const at = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return `${days} дн. назад`;
  return at.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/** Подпись дня графика: «25 окт» и полная «пятница, 25 октября». */
export function dayLabels(day: string): { tick: string; label: string } {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return {
    tick: date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", ""),
    label: date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }),
  };
}

/** Прогресс сотрудника: доля прочитанных актуальных статей из положенных. */
export function personProgress(p: Pick<KbPersonRow, "required" | "read_current">): number {
  return share(p.read_current, p.required);
}

/** Число со словом в нужной форме: plural(4, ["статья", "статьи", "статей"]) → «4 статьи». */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const form =
    a > 10 && a < 20 ? forms[2] : b === 1 ? forms[0] : b >= 2 && b <= 4 ? forms[1] : forms[2];
  return `${n} ${form}`;
}

/**
 * «Обновлено …» в шапке статьи: «сегодня», «вчера», «11 дней назад»,
 * дальше 30 дней — дата «12 окт. 2026».
 */
export function formatUpdatedAgo(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return `${plural(days, ["день", "дня", "дней"])} назад`;
  return at.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}
