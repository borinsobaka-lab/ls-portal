/**
 * «Аналитика» → «Администрирование»: подписи и расчёты ядра их портала
 * (app.py) — журнал действий, посещаемость, партнёры, ключи API для GPT.
 * Схема — db/migrations/2026-10-30_zz_analytics_core_admin.sql.
 */

/** Время старого портала — московское (их MOSCOW_TZ). */
export const MSK = "Europe/Moscow";

const MSK_PARTS = new Intl.DateTimeFormat("ru-RU", {
  timeZone: MSK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function mskParts(date: Date): Record<string, string> {
  return Object.fromEntries(MSK_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
}

/** Их format_timestamp: «дд.мм.гггг чч:мм» по Москве, пусто — «—». */
export function formatMsk(value: string | null | undefined): string {
  if (!value) return "—";
  const p = mskParts(new Date(value));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** Сегодня по Москве, «ГГГГ-ММ-ДД». */
export function mskToday(now = Date.now()): string {
  const p = mskParts(new Date(now));
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Период «Посещаемости» по умолчанию — их: 30 дней по сегодня (по Москве). */
export function defaultActivityPeriod(now = Date.now()): { from: string; to: string } {
  const to = mskToday(now);
  return { from: addDays(to, -29), to };
}

/** Их format_duration: «45 сек», «12 мин», «1 ч 5 мин 3 сек». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  if (s < 60) return `${s} сек`;
  const minutesTotal = Math.floor(s / 60);
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  const remainder = s % 60;
  const base = hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
  return remainder ? `${base} ${remainder} сек` : base;
}

/**
 * Подписи событий журнала — их action_names (users_page); события без
 * подписи у них показываются как есть, так и здесь. Подписаны и события,
 * которых у них нет (убрать из партнёров, ключи API из портала).
 */
export const AN_AUDIT_EVENTS: Record<string, string> = {
  login: "вход",
  logout: "выход",
  dashboard_view: "открыл(а) дашборд",
  password_reset: "смена пароля",
  user_created: "создание пользователя",
  access_changed: "изменение доступов",
  vk_inbox_access_changed: "изменение доступа к чатам VK",
  role_changed: "изменение роли",
  profile_changed: "изменение данных пользователя",
  partner_profile_changed: "изменение карточки партнёра",
  partner_removed: "партнёр убран",
  analytics_api_key_created: "создан ключ API для GPT",
  analytics_api_key_enabled: "ключ API для GPT включён",
  analytics_api_key_disabled: "ключ API для GPT отключён",
};

export function auditLabel(event: string): string {
  return AN_AUDIT_EVENTS[event] ?? event;
}

/** Строка «Посещаемости» (RPC an_activity_report). */
export type AnActivityRow = {
  user_id: string;
  full_name: string;
  position: string | null;
  email: string | null;
  active: boolean;
  visits: number;
  seconds: number;
  views: number;
  dashboards: string[];
  last_active: string | null;
};

/** Их плитки: визиты, активное время команды, не заходили. */
export function activityTotals(rows: AnActivityRow[]) {
  return {
    visits: rows.reduce((sum, r) => sum + r.visits, 0),
    seconds: rows.reduce((sum, r) => sum + r.seconds, 0),
    inactive: rows.filter((r) => r.visits === 0).length,
  };
}

/** Их пульс: раз в 15 секунд, если вкладка видна и человек что-то делал последние 3 минуты. */
export const PRESENCE_INTERVAL_MS = 15_000;
export const PRESENCE_IDLE_MS = 180_000;

/**
 * Какая страница шлёт пульс. Их страницы портала (page()) — «Главная»;
 * отчёты 1С (их /1c) пульса не шлют и просмотров не пишут
 * (ANALYTICS_PLAN.md, §9) — null.
 */
export function presenceDashboard(pathname: string): string | null {
  if (!(pathname === "/analytics" || pathname.startsWith("/analytics/"))) return null;
  if (pathname.startsWith("/analytics/onec/")) return null;
  return "Главная";
}

/**
 * Отчёты, которые партнёру выдают из маркетинга и отзывов (их «Доступ к
 * отчётам»): у нас выдаются ролями в «Пользователях и ролях».
 */
export const AN_PARTNER_REPORTS = [
  { key: "mkt.ls", title: "Маркетинг Lady Stretch" },
  { key: "mkt.lj", title: "Маркетинг Lady Jump" },
  { key: "reviews", title: "Отзывы и оценки", hint: "Только назначенные партнёру города" },
] as const;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Их create_analytics_api_key: «ls_live_» + token_urlsafe(40). */
export function newApiKey(
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
) {
  return `ls_live_${base64Url(random(new Uint8Array(40)))}`;
}

/** SHA-256 ключа шестнадцатеричной строкой — как их key_hash. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
