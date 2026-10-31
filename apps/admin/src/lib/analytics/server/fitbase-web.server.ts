/**
 * FitBase — сборщик оснований записей со страниц веб-интерфейса (их
 * automatic-basis: web_source.Client, worker.run / apply_evidence,
 * configure_session). Сессия — cookies входа владельца (он входит сам, с
 * CAPTCHA; помощник на компьютере передаёт сессию порталу), хранится
 * шифртекстом в an_secrets (kind `fitbase_web`), обновлённые FitBase cookies
 * сохраняются после каждого запроса. Читаются только `/client-schedule/index`
 * и выбор клуба `/site/change-club` (POST без повторов). Проход — не дольше
 * 240 секунд и 120 запросов; очередь — an_fb_basis_*; основание — в
 * an_fb_trial_basis, затем пересчёт типов записей студии.
 *
 * Выбор клуба меняет активный клуб учётной записи FitBase и для других её
 * сессий (их сборщика на старом портале), поэтому задача `fitbase_basis` —
 * внешняя: выключена, пока её не включат на «Фоновых задачах».
 */
import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";

import {
  FbWebError,
  FbWebLogin,
  fbBasisJobOrder,
  fbBranchForm,
  fbEvidenceDecide,
  fbListUrl,
  fbPaginationAction,
  fbParsePage,
  fbWebOrigin,
  type FbApplyCounts,
  type FbBasisJob,
  type FbEvidence,
  type FbEvidenceLookup,
} from "../fitbase/web";
import { fbBasisClassifier, fbTrialOwner, type FbTrialRule } from "../fitbase/trials";
import { fbDay } from "../fitbase/rules";
import { fbTrialRecompute } from "./fitbase-trials.server";
import type { JobResult } from "./jobs.server";
import { readSecret, saveSecret } from "./secrets.server";

const db = () => getSupabaseAdmin();
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const SESSION = { kind: "fitbase_web", ref: "session", name: "session" };

// --- Cookies (их http.cookiejar) ---------------------------------------------------------------

export type FbCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  /** Секунды Unix; -1 — до конца сессии браузера. */
  expires: number;
  httpOnly: boolean;
};

const domainMatch = (host: string, domain: string) =>
  host === domain.replace(/^\./, "") || (domain.startsWith(".") && host.endsWith(domain));

export class FbCookieJar {
  cookies: FbCookie[] = [];

  constructor(host: string, initial: FbCookie[]) {
    for (const c of initial) {
      if (!c || typeof c.name !== "string" || typeof c.domain !== "string") continue;
      if (!domainMatch(host, c.domain)) continue;
      this.cookies.push({
        name: c.name,
        value: String(c.value ?? ""),
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure ?? true,
        expires: typeof c.expires === "number" && c.expires > 0 ? Math.floor(c.expires) : -1,
        httpOnly: Boolean(c.httpOnly),
      });
    }
  }

  header(url: URL): string {
    const now = nowSec();
    return this.cookies
      .filter(
        (c) =>
          domainMatch(url.hostname, c.domain) &&
          url.pathname.startsWith(c.path) &&
          (!c.secure || url.protocol === "https:") &&
          (c.expires < 0 || c.expires > now),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  absorb(url: URL, lines: string[]) {
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const cookie: FbCookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: url.hostname,
        path: "/",
        secure: false,
        expires: -1,
        httpOnly: false,
      };
      let maxAge: number | null = null;
      for (const raw of attrs) {
        const [k, ...v] = raw.split("=");
        const key = k.trim().toLowerCase();
        const value = v.join("=").trim();
        if (key === "domain" && value) {
          const d = value.startsWith(".") ? value : `.${value}`;
          if (!domainMatch(url.hostname, d)) continue;
          cookie.domain = d;
        } else if (key === "path" && value.startsWith("/")) cookie.path = value;
        else if (key === "secure") cookie.secure = true;
        else if (key === "httponly") cookie.httpOnly = true;
        else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
        else if (key === "expires") {
          const t = Date.parse(value);
          if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
        }
      }
      if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : nowSec() + maxAge;
      this.cookies = this.cookies.filter(
        (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
      );
      if (cookie.expires === -1 || cookie.expires > nowSec()) this.cookies.push(cookie);
    }
  }
}

// --- Клиент страниц (их web_source.Client) ---------------------------------------------------

/** Только стенд: адрес заглушки FitBase вместо https://<клуб>.fitbase.io. */
const webBase = () => (process.env.ANALYTICS_FITBASE_WEB_ORIGIN || "").replace(/\/+$/, "");

export class FbWebClient {
  readonly origin: string;
  readonly jar: FbCookieJar;
  private pause: (ms: number) => Promise<void>;
  /** Перед каждым запросом (их бюджет прохода). */
  beforeRequest: () => void = () => {};
  /** После каждого удачного запроса (их session_save). */
  afterRequest: () => Promise<void> = async () => {};

  constructor(origin: string, cookies: FbCookie[], pause: (ms: number) => Promise<void> = sleep) {
    if (!/^https:\/\/[a-z0-9-]+\.fitbase\.io$/.test(origin)) throw new FbWebError("invalid_origin");
    this.origin = origin;
    this.pause = pause;
    this.jar = new FbCookieJar(new URL(origin).hostname, cookies);
  }

  cookies(): FbCookie[] {
    return this.jar.cookies.map((c) => ({ ...c }));
  }

  private async fetchOnce(
    url: URL,
    method: "GET" | "POST",
    body: string | null,
  ): Promise<{ status: number; url: URL; html: string }> {
    let current = url;
    let m = method;
    let payload = body;
    for (let hop = 0; hop < 10; hop++) {
      const base = webBase();
      const target = base ? `${base}${current.pathname}${current.search}` : current.toString();
      const headers: Record<string, string> = {
        "User-Agent": "LadyAnalytics-FitBase/1.0",
        Accept: "text/html",
        Referer: `${this.origin}/client-schedule/index`,
      };
      const cookie = this.jar.header(current);
      if (cookie) headers.Cookie = cookie;
      if (base) headers["X-Fitbase-Host"] = current.hostname;
      if (payload !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
      const res = await fetch(target, {
        method: m,
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      this.jar.absorb(current, res.headers.getSetCookie());
      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        const next = new URL(location, current);
        if (
          `${next.protocol}//${next.host}` !== this.origin &&
          !(base && next.toString().startsWith(base))
        ) {
          throw new FbWebError("cross_origin_redirect_blocked");
        }
        // Заглушка стенда отвечает своими адресами — переводим их обратно.
        current =
          base && next.toString().startsWith(base)
            ? new URL(`${this.origin}${next.pathname}${next.search}`)
            : next;
        if (res.status <= 303 && m === "POST") {
          m = "GET";
          payload = null;
        } else if (m === "POST") {
          return { status: res.status, url: current, html: "" };
        }
        await res.body?.cancel();
        continue;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 6_000_000) {
            await reader.cancel();
            throw new FbWebError("response_too_large");
          }
          chunks.push(value);
        }
      }
      const html = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return { status: res.status, url: current, html };
    }
    throw new FbWebError("request_failed");
  }

  /** Их request(): только список записей и выбор клуба; GET при 429/5xx — до 2 повторов. */
  async request(url: string, fields: Record<string, string> | null = null): Promise<string> {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== this.origin)
      throw new FbWebError("cross_origin_request_blocked");
    if (u.pathname !== "/client-schedule/index" && u.pathname !== "/site/change-club")
      throw new FbWebError("unexpected_endpoint");
    if (fields !== null && u.pathname !== "/site/change-club")
      throw new FbWebError("write_request_blocked");
    this.beforeRequest();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pause(800);
      const res = await this.fetchOnce(
        u,
        fields ? "POST" : "GET",
        fields ? new URLSearchParams(fields).toString() : null,
      );
      if (res.status >= 200 && res.status < 300) {
        if (res.url.toString().includes("/site/login")) throw new FbWebLogin("login_required");
        if (res.html.includes('id="login-form"')) throw new FbWebLogin("login_required");
        // Как их session_save: обновлённые cookies — после удачного ответа.
        await this.afterRequest();
        return res.html;
      }
      if (res.status === 401 || res.status === 403) throw new FbWebLogin("login_required");
      // Выбор клуба (POST) не повторяется никогда.
      if (fields !== null || ![429, 500, 502, 503, 504].includes(res.status) || attempt === 2) {
        throw new FbWebError(`http_${res.status}`);
      }
      await this.pause(15_000 * (attempt + 1));
    }
    throw new FbWebError("request_failed");
  }

  /** Их switch(): штатный выбор клуба и проверка, что он выбран. */
  async switch(club: string): Promise<string> {
    let html = await this.request(`${this.origin}/client-schedule/index`);
    const { fields, allowed, selected } = fbBranchForm(html);
    if (!allowed.has(club)) throw new FbWebError("branch_access_missing");
    if (selected !== club) {
      if (!fields._csrf) throw new FbWebError("csrf_missing");
      await this.request(`${this.origin}/site/change-club`, { ...fields, "club-picker": club });
      html = await this.request(`${this.origin}/client-schedule/index`);
      if (fbBranchForm(html).selected !== club) throw new FbWebError("branch_switch_not_verified");
    }
    return html;
  }
}

// --- Сессия и состояние ------------------------------------------------------------------------

type Session = { origin: string; cookies: FbCookie[] };

async function loadSession(): Promise<Session | null> {
  const raw = await readSecret(SESSION);
  return raw ? (JSON.parse(raw) as Session) : null;
}

async function saveSession(origin: string, client: FbWebClient, userId: string | null = null) {
  await saveSecret(SESSION, JSON.stringify({ origin, cookies: client.cookies() }), userId);
}

async function setStatus(state: string, counts: Record<string, unknown> = {}) {
  const { error } = await db()
    .from("an_fb_basis_status")
    .upsert({ id: 1, state, checked_at: nowSec(), counts }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

type Conn = { id: number; name: string; domain: string; club_id: string };

async function webConnections(): Promise<Conn[]> {
  const { data, error } = await db()
    .from("an_fb_connections")
    .select("id, name, domain, club_id")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as Conn[];
}

/** Адрес FitBase сети (у всех студий один — сессия одна на учётную запись). */
export async function fbWebNetworkOrigin(): Promise<string> {
  const connections = await webConnections();
  if (!connections.length) throw new FbWebError("Сначала подключите студии FitBase.");
  const origins = new Set(connections.map((c) => fbWebOrigin(c.domain)));
  if (origins.size > 1)
    throw new FbWebError(`У студий разные адреса FitBase: ${[...origins].join(", ")}.`);
  return [...origins][0];
}

/**
 * Их configure_session: сессия из помощника входа (или вставленная вручную) —
 * только {origin, cookies}; страница записей открывается, у учётной записи
 * есть все клубы подключённых студий. Затем сохраняется шифртекстом.
 */
export async function fbWebAcceptSession(payload: unknown, userId: string | null): Promise<number> {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    JSON.stringify(Object.keys(payload).sort()) !== '["cookies","origin"]'
  ) {
    throw new FbWebError("Нужна сессия помощника входа: {origin, cookies}.");
  }
  const { origin, cookies } = payload as { origin: unknown; cookies: unknown };
  if (!Array.isArray(cookies) || cookies.length > 100 || typeof origin !== "string") {
    throw new FbWebError("Нужна сессия помощника входа: {origin, cookies}.");
  }
  const connections = await webConnections();
  if (!connections.length) throw new FbWebError("Сначала подключите студии FitBase.");
  for (const c of connections) {
    if (fbWebOrigin(c.domain) !== origin)
      throw new FbWebError(`Сессия не того FitBase: у студии «${c.name}» другой адрес.`);
  }
  const client = new FbWebClient(origin, cookies as FbCookie[]);
  let html: string;
  try {
    html = await client.request(`${origin}/client-schedule/index`);
  } catch (e) {
    if (e instanceof FbWebLogin) throw new FbWebError("FitBase не принял сессию: войдите заново.");
    throw e;
  }
  const { allowed } = fbBranchForm(html);
  const missing = connections.filter((c) => !allowed.has(String(c.club_id)));
  if (missing.length) {
    throw new FbWebError(
      `У учётной записи FitBase нет доступа к клубу студий: ${missing.map((c) => c.name).join(", ")}.`,
    );
  }
  await saveSession(origin, client, userId);
  await setStatus("authorized", { studios: connections.length });
  return connections.length;
}

export async function fbWebForgetSession() {
  const { error } = await db()
    .from("an_secrets")
    .delete()
    .eq("kind", SESSION.kind)
    .eq("ref", SESSION.ref)
    .eq("name", SESSION.name);
  if (error) throw new Error(error.message);
  await setStatus("not_authorized");
}

// --- Сопоставление (их apply_evidence) -------------------------------------------------------

type Classifier = (label: string) => number;

async function classifierFor(c: Conn): Promise<Classifier> {
  const owner = fbTrialOwner(c);
  const [{ data: rule }, { data: catalog }, { data: contracts }] = await Promise.all([
    db()
      .from("an_fb_trial_service_rules")
      .select("owner, mode, selected, revision")
      .eq("connection_id", c.id)
      .maybeSingle(),
    db()
      .from("an_fb_trial_service_catalog")
      .select("service_id, name")
      .eq("connection_id", c.id)
      .eq("owner", owner),
    db()
      .from("an_fb_trial_products")
      .select("label, is_trial")
      .eq("connection_id", c.id)
      .eq("kind", "contract"),
  ]);
  const active: FbTrialRule | null =
    rule && rule.owner === owner
      ? {
          mode: rule.mode as FbTrialRule["mode"],
          selected: (rule.selected as unknown[]).map(String),
          revision: rule.revision as number,
        }
      : null;
  return fbBasisClassifier(
    active,
    (catalog ?? []) as { service_id: string; name: string }[],
    (contracts ?? []) as { label: string; is_trial: number }[],
  );
}

/**
 * Их apply_evidence: основание принимается, только если запись есть в
 * загрузке API этой студии, день занятия совпадает, а название однозначно
 * сопоставлено с выбранными услугами; пустое не стирает прежнее, старое не
 * перезаписывает новое (решение — fbEvidenceDecide).
 */
export async function fbApplyEvidence(
  c: Conn,
  rows: FbEvidence[],
  resolve: (label: string) => number,
): Promise<FbApplyCounts> {
  const owner = fbTrialOwner(c);
  const { data, error } = await db().rpc("an_fb_basis_lookup", {
    p_id: c.id,
    p_ids: rows.map((r) => r.registration_id),
  });
  if (error) throw new Error(error.message);
  const { accepted, counts } = fbEvidenceDecide(
    owner,
    data as FbEvidenceLookup,
    rows,
    resolve,
    nowSec(),
  );
  if (accepted.length) {
    const { error: storeError } = await db()
      .from("an_fb_trial_basis")
      .upsert(
        accepted.map((a) => ({ connection_id: c.id, ...a })),
        { onConflict: "connection_id,registration_id" },
      );
    if (storeError) throw new Error(storeError.message);
  }
  return counts;
}

// --- Проход (их worker.run) ---------------------------------------------------------------------

async function patchJob(
  job: Pick<FbBasisJob, "connection_id" | "month">,
  fields: Partial<FbBasisJob>,
) {
  const { error } = await db()
    .from("an_fb_basis_jobs")
    .update(fields)
    .eq("connection_id", job.connection_id)
    .eq("month", job.month);
  if (error) throw new Error(error.message);
}

async function clearSeen(job: Pick<FbBasisJob, "connection_id" | "month">) {
  const { error } = await db()
    .from("an_fb_basis_seen")
    .delete()
    .eq("connection_id", job.connection_id)
    .eq("month", job.month);
  if (error) throw new Error(error.message);
}

let running = false;

/** Их run(max_seconds=240, max_requests=120): один проход очереди. */
export async function fbBasisRun(maxSeconds = 240, maxRequests = 120): Promise<JobResult> {
  if (running) return { status: "success", message: "Проход уже идёт." };
  running = true;
  try {
    return await runPass(maxSeconds, maxRequests);
  } catch (e) {
    // Как у них: без текста исключения (в нём могут быть данные запроса).
    await setStatus("worker_error", { error_type: (e as Error).name || "Error" }).catch(() => {});
    return { status: "error", message: "Ошибка сборщика оснований." };
  } finally {
    running = false;
  }
}

async function runPass(maxSeconds: number, maxRequests: number): Promise<JobResult> {
  const session = await loadSession();
  if (!session) {
    await setStatus("not_authorized");
    return { status: "success", message: "Сессия FitBase не подключена." };
  }
  const { origin } = session;
  const client = new FbWebClient(origin, session.cookies);
  const started = performance.now();
  let requests = 0;
  let saved = JSON.stringify(client.cookies());
  client.beforeRequest = () => {
    if (requests >= maxRequests || performance.now() - started > maxSeconds * 1000) {
      throw new FbWebError("pass_budget_reached");
    }
    requests += 1;
  };
  client.afterRequest = async () => {
    const now = JSON.stringify(client.cookies());
    if (now !== saved) {
      await saveSession(origin, client);
      saved = now;
    }
  };
  const connections = (await webConnections()).filter((c) => {
    try {
      return fbWebOrigin(c.domain) === origin;
    } catch {
      return false;
    }
  });
  if (!connections.length) throw new FbWebError("no_matching_connections");
  const summary: Record<string, number> = {
    requests: 0,
    pages: 0,
    recent_pages: 0,
    trial: 0,
    regular: 0,
    unknown_label: 0,
    not_in_api_cache: 0,
    empty: 0,
    time_mismatch: 0,
  };
  const today = fbDay(nowSec());
  const { data: planned, error: planError } = await db().rpc("an_fb_basis_plan", {
    p_conns: connections.map((c) => ({ id: c.id, owner: fbTrialOwner(c) })),
    p_today: today,
    p_now: nowSec(),
  });
  if (planError) throw new Error(planError.message);
  const todo = fbBasisJobOrder(planned as FbBasisJob[], today, nowSec());
  const classifiers = new Map<number, Classifier>();
  const changed = new Set<number>();
  const replayed = new Set<number>();
  let selected: string | null = null;
  let stopped = false;
  for (const job of todo) {
    if (stopped) break;
    if (job.month === "recent" && summary.recent_pages >= 40) continue;
    const c = connections.find((x) => x.id === job.connection_id)!;
    try {
      await patchJob(job, { last_attempt: nowSec() });
      if (selected !== String(c.club_id)) {
        await client.switch(String(c.club_id));
        selected = String(c.club_id);
      }
      if (!classifiers.has(c.id)) classifiers.set(c.id, await classifierFor(c));
      const resolve = classifiers.get(c.id)!;
      if (!replayed.has(c.id)) {
        const { data: pending } = await db()
          .from("an_fb_basis_evidence")
          .select("registration_id, label, reason_ref, lesson_time, captured_at")
          .eq("connection_id", c.id)
          .eq("owner", job.owner);
        if (pending?.length) {
          const counts = await fbApplyEvidence(c, pending as FbEvidence[], resolve);
          if (counts.trial || counts.regular) changed.add(c.id);
        }
        replayed.add(c.id);
      }
      if (job.finished_at) {
        await clearSeen(job);
        Object.assign(job, {
          page: 1,
          seen: 0,
          total: null,
          finished_at: 0,
          direction: 0,
          passes: 1,
          last_fingerprint: "",
          last_page: 0,
        });
        await patchJob(job, {
          page: 1,
          seen: 0,
          total: null,
          finished_at: 0,
          direction: 0,
          passes: 1,
          last_fingerprint: "",
          last_page: 0,
        });
      }
      let jobPages = 0;
      for (;;) {
        const recent = job.month === "recent";
        const anchor = recent ? job.anchor : fbDay(nowSec());
        const createdFrom = recent
          ? new Date(Date.parse(`${anchor}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10)
          : null;
        const url = fbListUrl(
          origin,
          job.lo,
          job.hi,
          job.page,
          createdFrom,
          recent ? anchor : null,
          Boolean(job.direction),
        );
        let html = await client.request(url);
        if (fbBranchForm(html).selected !== String(c.club_id)) {
          // Клуб учётной записи мог переключить другой сеанс.
          await client.switch(String(c.club_id));
          html = await client.request(url);
          if (fbBranchForm(html).selected !== String(c.club_id))
            throw new FbWebError("branch_changed_during_read");
        }
        const { rows, total, lastPage } = fbParsePage(html, url);
        if (rows.length) {
          const { error: seenError } = await db()
            .from("an_fb_basis_seen")
            .upsert(
              rows.map((r) => ({
                connection_id: c.id,
                month: job.month,
                registration_id: r.registration_id,
              })),
              { onConflict: "connection_id,month,registration_id", ignoreDuplicates: true },
            );
          if (seenError) throw new Error(seenError.message);
        }
        const now = nowSec();
        const evidence = rows.map((r) => ({ ...r, captured_at: now }));
        const labelled = evidence.filter((r) => r.label);
        if (labelled.length) {
          const { error: evError } = await db()
            .from("an_fb_basis_evidence")
            .upsert(
              labelled.map((r) => ({
                connection_id: c.id,
                owner: job.owner,
                registration_id: r.registration_id,
                label: r.label,
                reason_ref: r.reason_ref,
                lesson_time: r.lesson_time,
                captured_at: now,
              })),
              { onConflict: "connection_id,registration_id" },
            );
          if (evError) throw new Error(evError.message);
        }
        const counts = await fbApplyEvidence(c, evidence, resolve);
        if (counts.trial || counts.regular) changed.add(c.id);
        for (const [k, v] of Object.entries(counts)) summary[k] += v;
        summary.pages += 1;
        summary.recent_pages += recent ? 1 : 0;
        const { count } = await db()
          .from("an_fb_basis_seen")
          .select("registration_id", { count: "exact", head: true })
          .eq("connection_id", c.id)
          .eq("month", job.month);
        const seen = count ?? 0;
        const [action, fingerprint] = fbPaginationAction(
          job,
          rows.map((r) => r.registration_id),
          seen,
          total,
          lastPage,
          sha256,
        );
        const done = action === "complete";
        const nextPage = action === "reverse" ? 1 : job.page + 1;
        const direction = action === "reverse" ? 1 - job.direction : job.direction;
        const passes = job.passes + (action === "reverse" ? 1 : 0);
        const oldPage = job.page;
        const update = {
          page: nextPage,
          seen,
          total,
          finished_at: done ? now : 0,
          failed_at: 0,
          error: "",
          direction,
          passes,
          last_fingerprint: action === "reverse" ? "" : fingerprint,
          last_page: action === "reverse" ? 0 : oldPage,
        };
        await patchJob(job, update);
        Object.assign(job, update);
        jobPages += 1;
        if (done) break;
        // Проход делится между студиями, а не выбирает одну до конца.
        if (jobPages >= 10 || (recent && summary.recent_pages >= 40)) break;
      }
    } catch (e) {
      if (e instanceof FbWebLogin) {
        await finishChanged(changed);
        await setStatus("login_required", { requests, pages: summary.pages });
        return { status: "error", message: "Нужен повторный вход в FitBase." };
      }
      if (!(e instanceof FbWebError)) throw e;
      const code = e.message;
      if (code === "pass_budget_reached") break;
      const failed: Partial<FbBasisJob> = { failed_at: nowSec(), error: code.slice(0, 80) };
      if (code === "pagination_repeated" || code === "pagination_gap") {
        Object.assign(failed, {
          page: 1,
          direction: 0,
          passes: 1,
          last_fingerprint: "",
          last_page: 0,
        });
      }
      await patchJob(job, failed);
      if (code === "http_429" || code === "http_503") stopped = true;
    }
  }
  await finishChanged(changed);
  summary.requests = requests;
  const [{ count: pendingJobs }, { count: failedJobs }] = await Promise.all([
    db()
      .from("an_fb_basis_jobs")
      .select("month", { count: "exact", head: true })
      .eq("finished_at", 0),
    db().from("an_fb_basis_jobs").select("month", { count: "exact", head: true }).neq("error", ""),
  ]);
  summary.pending_jobs = pendingJobs ?? 0;
  summary.failed_jobs = failedJobs ?? 0;
  const state = summary.failed_jobs
    ? "attention_required"
    : summary.pending_jobs
      ? "running"
      : "up_to_date";
  await setStatus(state, summary);
  return {
    status: summary.failed_jobs ? "partial" : "success",
    message: `Страниц ${summary.pages}, пробных оснований ${summary.trial}, обычных ${summary.regular}`,
    details: summary,
  };
}

/** Новые основания меняют типы записей студии (их overrides читают trial_browser_basis). */
async function finishChanged(changed: Set<number>) {
  for (const id of changed) {
    await fbTrialRecompute(id).catch((e) =>
      console.error("[fitbase] типы пробных после оснований", id, (e as Error).message),
    );
  }
}

// --- Одноразовые коды помощника входа ---------------------------------------------------------

/** Код помощника: 15 минут, один раз; в базе — только SHA-256. */
export async function fbWebIssueToken(userId: string): Promise<string> {
  const token = createHash("sha256")
    .update(crypto.getRandomValues(new Uint8Array(32)))
    .digest("base64url");
  const { error } = await db()
    .from("an_fb_web_tokens")
    .insert({
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      created_by: userId,
    });
  if (error) throw new Error(error.message);
  return token;
}

/** Помощник прислал сессию: код действителен — принять её (код гасится в любом случае). */
export async function fbWebSessionFromHelper(token: string, payload: unknown): Promise<number> {
  const { data, error } = await db()
    .from("an_fb_web_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token_hash", sha256(token))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("created_by");
  if (error) throw new Error(error.message);
  if (!data?.length)
    throw new FbWebError("Код помощника устарел или уже использован. Получите новый на портале.");
  const userId = (data[0].created_by as string | null) ?? null;
  const studios = await fbWebAcceptSession(payload, userId);
  if (userId) {
    await db().rpc("an_audit_add", {
      _user_id: userId,
      _event: "fitbase_web_session",
      _details: `helper ${studios}`,
    });
  }
  return studios;
}
