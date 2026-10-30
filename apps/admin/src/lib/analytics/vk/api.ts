/**
 * VK Ads — правила их vk_ads.py без ввода-вывода (их функции `_request`,
 * `_request_with_retry`, `_decimal`, `_form_plan_ids`, `_chunks`, `_raw`),
 * общие для сервера сбора (lib/analytics/server/vk-ads.server.ts) и тестов.
 */

export const VK_USER_AGENT = "LadyStretch-VKAds/1.0";

/** Их STATISTICS_BATCH_SIZE, паузы и попытки, размер страницы кампаний. */
export const VK_STATS_BATCH = 100;
export const VK_STATS_PAUSE_MS = 500;
export const VK_STATS_MAX_ATTEMPTS = 6;
export const VK_PLANS_PAGE = 200;
export const VK_PLANS_PAGE_PAUSE_MS = 200;
/** Их range(0, 20000, AD_PLANS_PAGE_SIZE): больше страниц — сбор останавливается. */
export const VK_PLANS_MAX_OFFSET = 20000;

export const VK_ORIGIN = "https://ads.vk.com";

/** Адрес запроса: пути `/api/…` — от корня, остальные — от `/api/v2`. */
export function vkUrl(path: string, origin = VK_ORIGIN): string {
  return (path.startsWith("/api/") ? origin : `${origin}/api/v2`) + path;
}

/** Их _request_with_retry: повторять только временные ошибки (сеть, 429, 5xx). */
export function vkTransient(status: number): boolean {
  return [0, 429, 500, 502, 503, 504].includes(status);
}

/** Пауза перед следующей попыткой: min(2^(попытка−1), 20) секунд. */
export function vkRetryDelayMs(attempt: number): number {
  return Math.min(2 ** (attempt - 1), 20) * 1000;
}

const DECIMAL = /^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/;

/**
 * Их _decimal: str(Decimal(str(value))), не число — "0". Нечисловые
 * NaN/Infinity у них сохранялись строкой, а в суммах SQLite считал их нулём
 * — здесь сразу "0". Результат — строка для колонки numeric.
 */
export function vkDecimal(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value !== "string") return "0";
  const s = value.trim();
  return DECIMAL.test(s) ? s.replace(/_/g, "") : "0";
}

/** Их int(value or 0): пусто — 0, дробное — целая часть. */
export function vkInt(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value))
    return Number.parseInt(value, 10);
  return 0;
}

/** str(value) Python для идентификаторов из JSON (числа, строки). */
export function vkStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Их _form_plan_ids: все значения ключа `ad_plan_ids` на любой глубине формы. */
export function vkFormPlanIds(form: unknown): Set<string> {
  const result = new Set<string>();
  const walk = (value: unknown, key: string) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, key);
    } else if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    } else if (key === "ad_plan_ids") {
      const id = vkStr(value).trim();
      if (id) result.add(id);
    }
  };
  walk(form, "");
  return result;
}

export function vkChunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Их urlencode запроса дневной статистики кампаний. */
export function vkStatsPath(from: string, to: string, ids: string[]): string {
  const q = new URLSearchParams({
    date_from: from,
    date_to: to,
    ids: ids.join(","),
    metrics: "base",
  });
  return `/statistics/ad_plans/day.json?${q.toString()}`;
}

export function vkPlansPath(offset: number): string {
  return `/ad_plans.json?limit=${VK_PLANS_PAGE}&offset=${offset}`;
}

export const VK_LEAD_FORMS_PATH = "/api/v1/lead_ads/lead_forms.json";

/** Их _raw: компактный JSON ответа с ошибкой, до 64 КБ. */
export function vkDiagnostic(payload: unknown): string {
  return JSON.stringify(payload ?? null).slice(0, 65536);
}

/** Истинность значения в Python (пустые список, словарь, строка, 0 — ложь). */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * Их `payload.get("items") or payload.get("data") or []` для ответа-словаря:
 * первое непустое значение (не обязательно список — это проверяет вызывающий).
 */
export function vkItems(payload: Record<string, unknown>, keys: string[] = ["items"]): unknown {
  for (const k of keys) if (pyTruthy(payload[k])) return payload[k];
  return [];
}

/** Ответ-словарь (их isinstance(payload, dict)). */
export function vkIsObject(payload: unknown): payload is Record<string, unknown> {
  return !!payload && typeof payload === "object" && !Array.isArray(payload);
}

/** Строка статистики кампании за день (их daily_campaign_statistics). */
export type VkStatRow = {
  vk_plan_id: string;
  stat_date: string;
  shows: number;
  clicks: number;
  goals: number;
  spent: string;
  not_ad_spent: string;
  cpm: string;
  cpc: string;
  cpa: string;
  ctr: string;
  cr: string;
};

/**
 * Их разбор ответа statistics/ad_plans/day: `items[].rows[]`, у строки —
 * `date` (нет — дата начала периода) и метрики `base`.
 */
export function vkStatRows(payload: unknown, defaultDate: string): VkStatRow[] {
  const items =
    payload && typeof payload === "object" ? (payload as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  const out: VkStatRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const planId = vkStr((item as { id?: unknown }).id);
    if (!planId) continue;
    const rows = (item as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = (row ?? {}) as { base?: Record<string, unknown>; date?: unknown };
      const base = (r.base && typeof r.base === "object" ? r.base : {}) as Record<string, unknown>;
      out.push({
        vk_plan_id: planId,
        stat_date: r.date === undefined || r.date === null ? defaultDate : vkStr(r.date),
        shows: vkInt(base.shows ?? 0),
        clicks: vkInt(base.clicks ?? 0),
        goals: vkInt(base.goals ?? 0),
        spent: vkDecimal(base.spent ?? 0),
        not_ad_spent: vkDecimal(base.not_ad_spent ?? 0),
        cpm: vkDecimal(base.cpm ?? ""),
        cpc: vkDecimal(base.cpc ?? ""),
        cpa: vkDecimal(base.cpa ?? ""),
        ctr: vkDecimal(base.ctr ?? ""),
        cr: vkDecimal(base.cr ?? ""),
      });
    }
  }
  return out;
}

/** Их «вчера» сборщика: date.today() − 1 на сервере в UTC. */
export function vkYesterdayUtc(now = Date.now()): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10);
}
