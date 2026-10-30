/**
 * FitBase API v2 — их FitBaseIntegration.request / fetch (fitbase_runtime.py):
 * запрос страницы с ключом (Bearer + заголовки club / domain), их тексты
 * ошибок; постраничная выгрузка раздела с проверкой полноты (total_count,
 * размер страницы, повтор страницы) и повторами временных сбоев внутри
 * загрузки. Только чтение.
 *
 * Отличие: у них постраничная выгрузка внутри загрузки идёт проходами по
 * 45 секунд и кладёт страницы в кэш базы (после перезапуска портала — с той же
 * страницы). Здесь выгрузка идёт до конца одним проходом, а оборванная
 * перезапуском загрузка начинается заново.
 */
import { pyInt } from "../amo/rules";
import {
  FB_ENDPOINT_LABELS,
  FB_PAGED,
  FbError,
  fbCheckpointRow,
  isObj,
  type Json,
} from "../fitbase/rules";
import { pyStr } from "../vk/lf";

/** Адрес API (на стенде — заглушка). */
const apiOrigin = () =>
  (process.env.ANALYTICS_FITBASE_ORIGIN || "https://api.fitbase.io").replace(/\/+$/, "");

export type FbParams = Record<string, string | number>;

/** Контекст загрузки студии: ключ, прогресс и их служебные поля `c['_…']`. */
export type FbSession = {
  id: number;
  domain: string;
  key: string;
  /** Их _job_context.progressive: внутри фоновой загрузки. */
  progressive: boolean;
  /** Их _job_context.deadline (мс, performance.now). */
  deadline: number;
  lastFetch?: { endpoint: string; params: FbParams | null; total: number | null; received: number };
  paginationWarnings: string[];
  progress: (text: string) => Promise<void>;
};

const TRANSIENT = ["HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"];
export const fbTransient = (message: string) =>
  message.includes("временно недоступен") || TRANSIENT.some((t) => message.includes(t));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Их extract(): message / error / errors / field вглубь, до 5 элементов списка. */
function errorParts(value: unknown, parts: string[]) {
  if (isObj(value)) {
    for (const key of ["message", "error", "errors", "field"]) {
      if (key in value) errorParts(value[key], parts);
    }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) errorParts(item, parts);
  } else if (typeof value === "string") parts.push(value);
}

/** Их request(): одна страница раздела; ответ — словарь со списком items. */
export async function fbRequest(
  s: Pick<FbSession, "domain" | "key">,
  endpoint: string,
  page = 1,
  params: FbParams | null = null,
): Promise<Json> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) query.append(k, String(v));
  query.append("page", String(page));
  let token = s.key.trim();
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  let res: Response;
  let body: string;
  try {
    res = await fetch(`${apiOrigin()}/api/v2/${endpoint}?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        club: s.domain,
        domain: s.domain,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    body = await res.text();
  } catch {
    throw new FbError("FitBase временно недоступен или вернул некорректный ответ.");
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = "";
    try {
      const parts: string[] = [];
      errorParts(JSON.parse(body.slice(0, 8192)), parts);
      detail = parts.join("; ");
      if (token) detail = detail.split(token).join("[скрыто]");
      detail = Array.from(
        detail.replace(/Bearer\s+\S+/gi, "Bearer [скрыто]").replace(/[\r\n\t<>]/g, " "),
      )
        .slice(0, 180)
        .join("");
    } catch {
      // Тело не JSON — без подробностей, как у них.
    }
    if (res.status === 401 || res.status === 403) {
      throw new FbError(
        `FitBase · ${endpoint}: нет доступа. Проверьте API-токен и доступные филиалы.`,
      );
    }
    throw new FbError(
      `FitBase · ${endpoint}: HTTP ${res.status}` +
        (detail ? `. ${detail}` : ". Проверьте поддомен клуба и параметры API."),
    );
  }
  let data: unknown;
  try {
    if (body.length > 16_000_000) throw new Error("big");
    data = JSON.parse(body);
  } catch {
    throw new FbError("FitBase временно недоступен или вернул некорректный ответ.");
  }
  if (!isObj(data) || !Array.isArray(data.items)) {
    throw new FbError("FitBase вернул неожиданный формат ответа.");
  }
  return data;
}

/** Их подпись раздела в прогрессе. */
function fetchLabel(endpoint: string, params: FbParams | null): string {
  if (endpoint === "till-order-steps" && params) {
    return `${params.operation_type === "purchase" ? "Оплаты" : "Возвраты"} · ${params.date_from ?? ""} — ${params.date_to ?? ""}`;
  }
  if (endpoint === "schedule-registration" && params && params.event_id) {
    return `Повторная сверка занятия #${params.event_id}`;
  }
  return FB_ENDPOINT_LABELS[endpoint] ?? endpoint;
}

/**
 * Их fetch(): все страницы раздела. Конец — пустая страница, total_count
 * получен, неполная страница без total; пустая страница до total и повтор
 * страницы — их ошибки (у справочников без total повтор — предупреждение).
 * Внутри загрузки строки сразу сокращаются (их checkpoint_row).
 */
export async function fbFetch(
  s: FbSession,
  endpoint: string,
  params: FbParams | null = null,
): Promise<Json[]> {
  const items: Json[] = [];
  const seen = new Set<string>();
  const paged = FB_PAGED.has(endpoint);
  const resumable = s.progressive && paged;
  const deadline = resumable
    ? Number.POSITIVE_INFINITY
    : Math.min(performance.now() + (paged ? 600_000 : 120_000), s.deadline);
  const label = fetchLabel(endpoint, params);
  for (let page = 1; page < (resumable ? 10001 : 1501); page++) {
    if (performance.now() > deadline) {
      throw new FbError(
        "FitBase: превышено время загрузки. Предыдущие данные сохранены; повторите обновление.",
      );
    }
    await s.progress(`${label}: страница ${page}, загружено ${items.length}`);
    let data: Json | null = null;
    for (let attempt = 0; attempt < (resumable ? 3 : 1); attempt++) {
      try {
        data = await fbRequest(s, endpoint, page, params);
        break;
      } catch (e) {
        const message = (e as Error).message;
        if (!resumable || !fbTransient(message) || attempt === 2) throw e;
        await sleep(2000 * (attempt + 1));
      }
    }
    if (!data) throw new FbError("FitBase вернул неожиданный формат ответа.");
    let batch = data.items as unknown[];
    if (resumable) batch = batch.map((row) => (isObj(row) ? fbCheckpointRow(endpoint, row) : row));
    let added = 0;
    for (const row of batch) {
      if (!isObj(row) || row.id === null || row.id === undefined) {
        throw new FbError("В данных FitBase отсутствует ID.");
      }
      const uid = pyStr(row.id);
      if (seen.has(uid)) continue;
      seen.add(uid);
      items.push(row);
      added += 1;
    }
    const meta =
      isObj(data._meta) && Object.keys(data._meta).length
        ? data._meta
        : isObj(data.pagination) && Object.keys(data.pagination).length
          ? data.pagination
          : {};
    const total =
      "total_count" in data
        ? data.total_count
        : "totalCount" in meta
          ? meta.totalCount
          : "total_count" in meta
            ? meta.total_count
            : meta.total;
    const hasTotal = total !== null && total !== undefined;
    const verifiedTotal = /^\d+$/.test(pyStr(total ?? null)) ? Number(pyStr(total)) : null;
    let complete = batch.length === 0 || (hasTotal && items.length >= pyInt(total));
    if (batch.length === 0 && hasTotal && items.length < pyInt(total)) {
      throw new FbError(
        `FitBase · ${endpoint}: пустая страница до конца выгрузки (${items.length} из ${pyStr(total)}). Предыдущие данные сохранены.`,
      );
    }
    const size =
      "page_size" in data ? data.page_size : "perPage" in meta ? meta.perPage : meta.page_size;
    if (
      !complete &&
      size !== null &&
      size !== undefined &&
      pyInt(size) > 0 &&
      batch.length < pyInt(size)
    ) {
      if (!hasTotal) complete = true;
    }
    if (!complete && !added) {
      if (!paged && !hasTotal) {
        s.paginationWarnings.push(label);
        return items;
      }
      throw new FbError(
        `FitBase · ${endpoint}: повтор страницы ${page}; получено ${items.length}` +
          (hasTotal ? ` из ${pyStr(total)}` : "") +
          ". Предыдущие данные сохранены.",
      );
    }
    if (complete) {
      s.lastFetch = { endpoint, params, total: verifiedTotal, received: items.length };
      return items;
    }
  }
  throw new FbError("Слишком большой объём FitBase. Уточните доступ клуба.");
}
