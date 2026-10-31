/**
 * «Операционная аналитика amoCRM» — сбор их пилота (api_client.py Client,
 * collector.py collect / save_window): одно подключение, прошедший день по
 * Москве, только GET; не больше 120 запросов за 300 секунд, 1 запрос в
 * секунду, повтор 429 и 5xx, без переходов, ответ до 2 МБ; проверка, что
 * фильтр дат сработал, пагинация без повторов. Сначала загрузка, потом
 * запись снимка — неполное окно не сохраняется. Токен — an_secrets
 * kind 'amocrm'. ANALYTICS_AMOCRM_ORIGIN — другой адрес API только для стенда.
 */
import {
  OPS_EVENT_TYPES,
  opsTruthy,
  sanitizeEvent,
  sanitizeLead,
  sanitizeTask,
  type OpsConfig,
  type OpsSnapshot,
} from "../amo-ops/rules";
import { amoToken } from "./amocrm.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";

/** Их ApiFailure. */
export class OpsFailure extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Их validate_host: https://<аккаунт>.amocrm.ru или .kommo.com. */
export function opsValidateHost(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OpsFailure("Invalid CRM account URL");
  }
  if (
    u.protocol !== "https:" ||
    !u.hostname ||
    !(u.hostname.endsWith(".amocrm.ru") || u.hostname.endsWith(".kommo.com")) ||
    u.username ||
    u.password ||
    !(u.port === "" || u.port === "443") ||
    !(u.pathname === "" || u.pathname === "/") ||
    u.search ||
    u.hash
  )
    throw new OpsFailure("Invalid CRM account URL");
  return url.replace(/\/+$/, "");
}

type Query = Record<string, string | number | readonly string[]>;
const encode = (q: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
    else p.append(k, String(v));
  return p.toString();
};

/** Их Client: ограниченный GET-клиент. */
export class OpsClient {
  requests = 0;
  private started = Date.now();
  private last = 0;
  constructor(
    private baseUrl: string,
    private token: string,
    private maxRequests = 120,
    private maxSeconds = 300,
  ) {}

  async get(path: string, query?: Query): Promise<Record<string, unknown> | null> {
    if (!path.startsWith("/api/v4/") || path.includes("?") || path.includes(".."))
      throw new OpsFailure("API path is not allowed");
    const stand = process.env.ANALYTICS_AMOCRM_ORIGIN?.replace(/\/+$/, "");
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, 1000 - (Date.now() - this.last));
      if (
        this.requests >= this.maxRequests ||
        (Date.now() - this.started + wait) / 1000 + 25 > this.maxSeconds
      )
        throw new OpsFailure("Request/time budget reached; window remains incomplete");
      await sleep(wait);
      this.requests += 1;
      this.last = Date.now();
      const url = (stand ?? this.baseUrl) + path + (query ? "?" + encode(query) : "");
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: "Bearer " + this.token,
            Accept: "application/json",
            "User-Agent": "LadyStretch-OperationsPilot/1.0",
            ...(stand ? { "X-Amo-Base": this.baseUrl } : {}),
          },
          redirect: "manual",
          signal: AbortSignal.timeout(25_000),
        });
      } catch {
        throw new OpsFailure("CRM connection/JSON error; response body omitted");
      }
      if (res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
          const retry = Number.parseInt(res.headers.get("retry-after") ?? "0", 10);
          const delay = Math.min(
            30,
            Math.max(2 ** (attempt + 1), Number.isFinite(retry) ? retry : 0),
          );
          await sleep(delay * 1000);
          continue;
        }
        throw new OpsFailure(`CRM HTTP ${res.status}; no credential or response body logged`);
      }
      if (res.status === 204) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const raw = new Uint8Array(await res.arrayBuffer());
      if (raw.length > 2 * 1024 * 1024) throw new OpsFailure("Response size limit exceeded");
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new OpsFailure("CRM connection/JSON error; response body omitted");
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        throw new OpsFailure("Unexpected response shape");
      return payload as Record<string, unknown>;
    }
    throw new OpsFailure("Retry budget exhausted");
  }

  async pages(path: string, collection: string, query: Query = {}, limit = 100, maxPages = 25) {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.get(path, { ...query, limit, page });
      if (payload === null) return result;
      const embedded = payload._embedded as Record<string, unknown> | undefined;
      const batch = embedded?.[collection];
      if (!Array.isArray(batch))
        throw new OpsFailure("Collection absent; do not interpret as zero");
      for (const item of batch) {
        if (
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          !opsTruthy((item as Record<string, unknown>).id)
        )
          throw new OpsFailure("Invalid collection item");
        const identity = String((item as Record<string, unknown>).id);
        if (seen.has(identity))
          throw new OpsFailure("Repeated page/object; pagination must be checked");
        seen.add(identity);
        result.push(item as Record<string, unknown>);
      }
      const links = payload._links as Record<string, unknown> | undefined;
      if (!opsTruthy(links?.next)) return result;
    }
    throw new OpsFailure("Page limit reached; window remains incomplete");
  }
}

/** Их collect: сделки по созданию, события по времени, задачи по изменению и задачи событий. */
export async function opsCollect(
  client: OpsClient,
  account: string,
  config: OpsConfig,
  start: number,
  end: number,
) {
  const n = (v: unknown) => Number(v);
  const rawLeads = await client.pages("/api/v4/leads", "leads", {
    "filter[created_at][from]": start,
    "filter[created_at][to]": end,
    with: "contacts",
  });
  if (rawLeads.some((x) => !(start <= n(x.created_at) && n(x.created_at) <= end)))
    throw new OpsFailure("Lead date filter failed calibration");
  const rawEvents = await client.pages("/api/v4/events", "events", {
    "filter[created_at][from]": start,
    "filter[created_at][to]": end,
    "filter[type][]": OPS_EVENT_TYPES,
  });
  if (
    rawEvents.some(
      (x) =>
        !(start <= n(x.created_at) && n(x.created_at) <= end) ||
        !(OPS_EVENT_TYPES as readonly string[]).includes(String(x.type)),
    )
  )
    throw new OpsFailure("Event filter failed calibration");
  const rawTasks = await client.pages("/api/v4/tasks", "tasks", {
    "filter[updated_at][from]": start,
    "filter[updated_at][to]": end,
  });
  if (rawTasks.some((x) => !(start <= n(x.updated_at) && n(x.updated_at) <= end)))
    throw new OpsFailure("Task date filter failed calibration");
  const present = new Set(rawTasks.map((t) => String(t.id)));
  const missing = [
    ...new Set(rawEvents.filter((e) => e.entity_type === "task").map((e) => String(e.entity_id))),
  ]
    .filter((id) => !present.has(id))
    .sort();
  for (const taskId of missing) {
    if (!/^\d+$/.test(taskId)) throw new OpsFailure("Unexpected task identifier");
    const task = await client.get("/api/v4/tasks/" + taskId);
    rawTasks.push(task ?? {});
  }
  return {
    leads: rawLeads.map((x) => sanitizeLead(x, account, config)),
    tasks: rawTasks.map((x) => sanitizeTask(x, account)),
    events: rawEvents.map((x) => sanitizeEvent(x, account)),
  };
}

const g = globalThis as typeof globalThis & { __lsAmoOpsRunning?: boolean };

/** Их server_wizard + collector main: сбор окна, снимок, итог запуска. */
export async function opsRun(
  runId: number,
  connectionId: number,
  start: number,
  end: number,
): Promise<void> {
  const finish = (fields: Record<string, unknown>) =>
    must(
      db()
        .from("an_amo_ops_runs")
        .update({ ...fields, finished_at: new Date().toISOString() })
        .eq("id", runId),
    );
  if (g.__lsAmoOpsRunning) {
    await finish({
      status: "error",
      message: "Pilot already running or stale lock needs operator inspection",
    });
    return;
  }
  g.__lsAmoOpsRunning = true;
  let client: OpsClient | null = null;
  try {
    const ctx = (await must(db().rpc("an_amo_ops_context", { p_connection: connectionId }))) as {
      id: string;
      base_url: string;
      config: OpsConfig;
    };
    const token = await readSecret(amoToken(connectionId));
    if (!token) throw new OpsFailure("Credential cannot be decrypted with existing keys");
    client = new OpsClient(opsValidateHost(ctx.base_url), token);
    const { leads, tasks, events } = await opsCollect(client, ctx.id, ctx.config, start, end);
    const snapshot: OpsSnapshot = {
      leads,
      tasks,
      events,
      config: ctx.config,
      humans: [],
      bots: [],
      coverage: "API window downloaded; UI calibration not performed",
      request_count: client.requests,
      limitations: [
        "Created deals only; task set is updated/linked tasks, not all due tasks",
        "Historical task/lead snapshots may reflect later changes",
        "Message conversation IDs and call outcomes not yet collected",
      ],
    };
    await must(
      db().from("an_amo_ops_windows").upsert(
        {
          connection_id: connectionId,
          window_start: start,
          window_end: end,
          captured_at: new Date().toISOString(),
          snapshot,
        },
        { onConflict: "connection_id,window_start,window_end" },
      ),
    );
    await finish({
      status: "success",
      message: "PILOT_SAVED",
      requests: client.requests,
      leads: leads.length,
      tasks: tasks.length,
      events: events.length,
    });
  } catch (e) {
    const text = e instanceof OpsFailure ? e.message : (e as Error)?.name || "Error";
    await finish({
      status: "error",
      message: "PILOT_FAILED: " + text,
      requests: client?.requests ?? 0,
    }).catch(() => undefined);
  } finally {
    g.__lsAmoOpsRunning = false;
  }
}
