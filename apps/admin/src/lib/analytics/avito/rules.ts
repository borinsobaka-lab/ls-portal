/**
 * Авито — правила их avito_ads.py без ввода-вывода: адреса API, разбор
 * ответов (сущности, ссылка с UTM, дата старта кампании, строки и числа
 * статистики), их тексты проверки и загрузки, планы. Их parse_qs / unquote,
 * float() / int() и date.fromtimestamp (сервер в UTC) — как в Python.
 */
import { pyFloat, strip } from "../onec/rules";

export const AVITO_BRANDS = ["Lady Stretch", "Lady Jump"] as const;
export const AVITO_TOKEN_PATH = "/token";
export const AVITO_API_PATH = "/ads/v1";
export const AVITO_ENTITY_TYPES = ["campaigns", "groups", "creatives"] as const;
export type AvitoEntityType = (typeof AVITO_ENTITY_TYPES)[number];
/** Их «Один запрос Авито может охватывать не более 100 дней». */
export const AVITO_MAX_DAYS = 100;
/** Их тело запроса списков: только первая страница (100) — как у них. */
export const AVITO_LIST_BODY = { filter: {}, limit: 100, page: 1 };
export const AVITO_TIMEOUT_MS = 25_000;

export const AVITO_TEXT = {
  network: "Не удалось подключиться к API Авито. Повторите проверку позже.",
  noToken: "Авито не вернула access token.",
  tokenHttp: (code: number) =>
    `Авито не выдала access token (HTTP ${code}). Проверьте client_id и client_secret.`,
  accountHttp: (code: number) => `Авито не подтвердило аккаунт (HTTP ${code}).`,
  listHttp: (resource: string, code: number) => `Авито не вернула ${resource} (HTTP ${code}).`,
  listFormat: (resource: string) => `Авито вернула неожиданный формат ${resource}.`,
  statsHttp: (campaign: string, code: number) =>
    `Авито не вернула статистику кампании ${campaign} (HTTP ${code}).`,
  notFound: "Кабинет Авито не найден.",
  reversed: "Дата окончания не может быть раньше даты начала.",
  tooLong: "Один запрос Авито может охватывать не более 100 дней.",
  historyReversed: "Дата окончания истории не может быть раньше даты старта кампании.",
};

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Истинность значения в Python. */
const truthy = (v: Json) =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (isObject(v) && Object.keys(v).length === 0)
  );
/** str() Python для значений JSON. */
const pyStr = (v: Json): string =>
  v === true ? "True" : v === false ? "False" : v === null ? "None" : String(v);

/** Их _clean для ключей: открытый текст обрезан; '' — пусто, 'long' — длиннее 200. */
export function avitoKeyValue(
  value: string,
): { kind: "empty" | "long" } | { kind: "ok"; value: string } {
  const v = strip(value);
  if (!v) return { kind: "empty" };
  if (Array.from(v).length > 200) return { kind: "long" };
  return { kind: "ok", value: v };
}

// --- Разбор ответа API --------------------------------------------------------------

/** Их _first_text: первое непустое из полей. */
export function avitoFirstText(item: Record<string, Json>, ...names: string[]): string {
  for (const name of names) {
    const value = item[name];
    if (value !== null && value !== undefined && value !== "") return pyStr(value);
  }
  return "";
}

/** unquote Python: %XX — байты UTF-8 (ошибки — U+FFFD), прочее — как есть. */
function pyUnquote(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder("utf-8").decode(bytes);
  });
}

/** Запрос URL как у urlparse: без \t\r\n, до «#», после первого «?». */
function urlQuery(url: string): string {
  let s = url.replace(/[\t\r\n]/g, "");
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf("?");
  return q >= 0 ? s.slice(q + 1) : "";
}

/** parse_qs Python (пустые значения отбрасываются). */
export function pyParseQs(query: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const value = part.slice(eq + 1);
    if (!value.length) continue;
    const name = pyUnquote(part.slice(0, eq).replace(/\+/g, " "));
    const list = out.get(name) ?? [];
    list.push(pyUnquote(value.replace(/\+/g, " ")));
    out.set(name, list);
  }
  return out;
}

/** Их _landing_url: первая ссылка http(s) с utm_source (вглубь словарей, не списков). */
export function avitoLandingUrl(item: Record<string, Json>): string {
  for (const value of Object.values(item)) {
    if (
      typeof value === "string" &&
      (value.startsWith("https://") || value.startsWith("http://"))
    ) {
      if ((pyParseQs(urlQuery(value)).get("utm_source") ?? []).length) return value;
    }
    if (isObject(value)) {
      const nested = avitoLandingUrl(value);
      if (nested) return nested;
    }
  }
  return "";
}

/** UTM ссылки: их (utm.get(…) or [""])[0]. */
export function avitoUtm(landing: string) {
  const qs = landing ? pyParseQs(urlQuery(landing)) : new Map<string, string[]>();
  const first = (k: string) => (qs.get(k) ?? [""])[0];
  return {
    utm_source: first("utm_source"),
    utm_medium: first("utm_medium"),
    utm_campaign: first("utm_campaign"),
    utm_content: first("utm_content"),
  };
}

const isoDateOk = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return +m[1] >= 1 && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** Их _campaign_start: первая дата из полей старта / создания. */
export function avitoCampaignStart(item: Record<string, Json>): string | null {
  for (const key of [
    "startDate",
    "start_date",
    "dateStart",
    "date_start",
    "createdAt",
    "created_at",
  ]) {
    const value = truthy(item[key]) ? pyStr(item[key]).slice(0, 10) : "";
    if (isoDateOk(value)) return value;
  }
  return null;
}

export type AvitoEntityRow = {
  entity_type: AvitoEntityType;
  entity_id: string;
  parent_campaign_id: string;
  parent_group_id: string;
  name: string;
  landing_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  start_date: string | null;
};

/** Строка сущности их sync_structure (без id — пропускается). */
export function avitoEntityRow(type: AvitoEntityType, item: Json): AvitoEntityRow | null {
  if (!isObject(item) || !truthy(item.id)) return null;
  const landing = avitoLandingUrl(item);
  return {
    entity_type: type,
    entity_id: pyStr(item.id),
    parent_campaign_id: avitoFirstText(
      item,
      "campaignId",
      "campaignID",
      "campaign_id",
      "CampaignId",
    ),
    parent_group_id: avitoFirstText(item, "groupId", "groupID", "group_id", "GroupId"),
    name: avitoFirstText(item, "name", "title"),
    landing_url: landing,
    ...avitoUtm(landing),
    start_date: type === "campaigns" ? avitoCampaignStart(item) : null,
  };
}

/** int(x) Python для «total» (число — вниз к нулю, строка цифр). */
const pyIntValue = (v: Json): number => {
  if (v === true) return 1;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  throw new Error(`invalid literal for int() with base 10: '${pyStr(v)}'`);
};

/** Список ответа и их total: int(payload.get("total") or len(items)). */
export function avitoList(
  resource: AvitoEntityType,
  payload: Json,
): { items: Json; total: number } {
  const items = isObject(payload) ? (payload[resource] ?? []) : [];
  const length = Array.isArray(items)
    ? items.length
    : isObject(items)
      ? Object.keys(items).length
      : typeof items === "string"
        ? Array.from(items).length
        : 0;
  const total = isObject(payload) && truthy(payload.total) ? pyIntValue(payload.total) : length;
  return { items, total };
}

const STAT_KEYS = ["timestamp", "date", "shows", "impressions", "clicks", "spend"];

/** Их _stat_rows: первый список словарей со статистикой (вглубь словарей). */
export function avitoStatRows(payload: Json): Record<string, Json>[] {
  if (!isObject(payload)) return [];
  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.length && value.every(isObject)) {
      if (value.some((item) => STAT_KEYS.some((k) => k in (item as Record<string, Json>)))) {
        return value as Record<string, Json>[];
      }
    }
  }
  for (const value of Object.values(payload)) {
    const rows = avitoStatRows(value);
    if (rows.length) return rows;
  }
  return [];
}

/** date.fromtimestamp(int(x)) на сервере в UTC; вне 1–9999 года — "". */
function fromTimestamp(value: number): string {
  if (!Number.isFinite(value)) return "";
  const d = new Date(Math.trunc(value) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  if (year < 1 || year > 9999) return "";
  return d.toISOString().slice(0, 10);
}

/** Их _stat_date: дата строки статистики или "". */
export function avitoStatDate(item: Record<string, Json>): string {
  const value = [item.date, item.day, item.timestamp].find(truthy) ?? "";
  if (typeof value === "number" || value === true) return fromTimestamp(Number(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return fromTimestamp(Number(value));
  const s = pyStr(value).slice(0, 10);
  return isoDateOk(s) ? s : "";
}

/** float(x) Python для значения JSON; не число — null (у них — следующий ключ). */
function pyFloatValue(v: Json): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (/^[+-]?nan$/i.test(strip(v))) return Number.NaN;
    const n = pyFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Их _number: float(item.get(key) or 0) по первому ключу, который
 * разбирается (отсутствующий ключ — 0.0, дальше не смотрит — как у них).
 */
export function avitoNumber(item: Record<string, Json>, ...keys: string[]): number {
  for (const key of keys) {
    const n = pyFloatValue(truthy(item[key]) ? item[key] : 0);
    if (n !== null) return n;
  }
  return 0;
}

/** int(float) Python. */
function pyIntFloat(n: number): number {
  if (Number.isNaN(n)) throw new Error("cannot convert float NaN to integer");
  if (!Number.isFinite(n)) throw new Error("cannot convert float infinity to integer");
  return Math.trunc(n);
}

export type AvitoStatRow = {
  campaign_id: string;
  stat_date: string;
  shows: number;
  clicks: number;
  spent: number;
};

/** Строки статистики кампании их sync_campaign_statistics (без даты — пропуск). */
export function avitoStatsFor(campaignId: string, payload: Json): AvitoStatRow[] {
  const out: AvitoStatRow[] = [];
  for (const item of avitoStatRows(payload)) {
    const statDate = avitoStatDate(item);
    if (!statDate) continue;
    out.push({
      campaign_id: campaignId,
      stat_date: statDate,
      shows: pyIntFloat(avitoNumber(item, "shows", "impressions", "views")),
      clicks: pyIntFloat(avitoNumber(item, "clicks")),
      spent: avitoNumber(item, "spend", "spent", "cost", "costs"),
    });
  }
  return out;
}

// --- Даты -------------------------------------------------------------------------

export const addDaysIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Их history_start_date: самый ранний старт кампаний; без дат — последние
 * 100 дней от сегодня (их date.today() — сервер в UTC).
 */
export function avitoHistoryStart(starts: (string | null)[], todayUtc: string): string {
  const known = starts.filter((s): s is string => !!s).sort();
  return known[0] ?? addDaysIso(todayUtc, -99);
}

/** Их блоки истории по 100 дней. */
export function avitoHistoryChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDaysIso(cursor, 99) < to ? addDaysIso(cursor, 99) : to;
    out.push([cursor, end]);
    cursor = addDaysIso(end, 1);
  }
  return out;
}

// --- Подписи страницы кабинетов -----------------------------------------------------------

export type AvitoCheckSummary = Record<string, { total?: number }> | null;

/** Их статус API кабинета. */
export function avitoCheckStatus(status: number | null, checkedAt: string | null): string {
  if (status === 200) return "проверен";
  if (checkedAt) return "не удалось проверить";
  return "не проверен";
}

/** Их «Структура»: campaigns: N · groups: M · creatives: K. */
export function avitoSummaryText(summary: AvitoCheckSummary | undefined): string {
  if (!summary) return "—";
  // Порядок их проверки (jsonb хранит ключи по длине).
  const rank = (k: string) => {
    const i = (AVITO_ENTITY_TYPES as readonly string[]).indexOf(k);
    return i < 0 ? AVITO_ENTITY_TYPES.length : i;
  };
  const parts = Object.entries(summary)
    .sort(([a], [b]) => rank(a) - rank(b))
    .filter(([, data]) => isObject(data))
    .map(([title, data]) => `${title}: ${Math.trunc(Number(data.total ?? 0))}`);
  return parts.join(" · ") || "данные не получены";
}

/** Итог проверки и структуры: «campaigns: N, groups: M, creatives: K». */
export const avitoTotalsText = (totals: Record<string, number>) =>
  Object.entries(totals)
    .map(([name, n]) => `${name}: ${n}`)
    .join(", ");

// --- Планы ------------------------------------------------------------------------

/** int(str) Python для плана заявок. */
export function avitoPlanInt(value: string): number {
  const s = strip(value);
  if (/^[+-]?\d(_?\d)*$/.test(s)) return Number.parseInt(s.replace(/_/g, ""), 10);
  throw new Error(`invalid literal for int() with base 10: '${value}'`);
}

/** float(value.replace(",", ".").replace(" ", "")) Python для CPL. */
export function avitoPlanFloat(value: string): number {
  const s = value.replace(/,/g, ".").replace(/ /g, "");
  if (/^[+-]?nan$/i.test(strip(s))) return Number.NaN;
  const n = pyFloat(s);
  if (Number.isNaN(n)) throw new Error(`could not convert string to float: '${s}'`);
  return n;
}

export type AvitoPlan = {
  month: string;
  brand: string;
  city: string;
  applications_plan: number;
  target_cpl: number;
};
export type AvitoPeriodPlan = {
  applications_plan: number;
  budget_plan: number;
  target_cpl: number;
};

const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Их plan_metrics_for_period: месячный план пропорционально дням периода. */
export function avitoPlansForPeriod(
  from: string,
  to: string,
  plans: AvitoPlan[],
): Map<string, AvitoPeriodPlan> {
  const out = new Map<string, AvitoPeriodPlan>();
  for (const plan of plans) {
    const [y, m] = plan.month.split("-").map(Number);
    const days = monthDays(y, m);
    const monthStart = `${plan.month}-01`;
    const monthEnd = `${plan.month}-${String(days).padStart(2, "0")}`;
    const start = from > monthStart ? from : monthStart;
    const end = to < monthEnd ? to : monthEnd;
    if (start > end) continue;
    const portion = daysBetween(start, end) + 1;
    const key = JSON.stringify([plan.brand, plan.city]);
    const entry = out.get(key) ?? { applications_plan: 0, budget_plan: 0, target_cpl: 0 };
    const applications = (plan.applications_plan * portion) / days;
    entry.applications_plan += applications;
    entry.budget_plan += applications * plan.target_cpl;
    out.set(key, entry);
  }
  for (const entry of out.values()) {
    entry.target_cpl = entry.applications_plan ? entry.budget_plan / entry.applications_plan : 0;
  }
  return out;
}
