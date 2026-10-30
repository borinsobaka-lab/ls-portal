/**
 * FitBase — загрузка студий из API v2 (их FitBaseIntegration в
 * fitbase_runtime.py и fitbase_trials.repair_metadata): проверка подключения
 * и справочники, лиды, абонементы, сверка возвратов, занятия с проверкой
 * полноты записей и пробными, выручка по дням (Самара), уточнение пробных;
 * загрузка студии, общая очередь и ночной запуск в 01:00 МСК. Только чтение
 * FitBase.
 *
 * Их приватные выгрузки разделов (incremental_data, attendance_checks) —
 * файлы закрытого бакета an-fitbase (JSON → gzip → AES-256-GCM, ключ
 * ANALYTICS_SECRETS_KEY); факты раздела — пачками в an_fb_staging и одной
 * транзакцией an_fb_commit вместе с указателями на новые файлы. Схема —
 * db/migrations/2026-10-30_zzzzzzzzzzzzz_analytics_fitbase.sql.
 */
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";

import {
  FB_ATTENDANCE_CODES,
  FB_ATTENDANCE_STATUSES,
  FB_REVENUE_TZ,
  FbError,
  fbAddDays,
  fbAttendanceWindow,
  fbCheckpointRow,
  fbClassifiedProduct,
  fbCreatedAt,
  fbDay,
  fbDaysBetween,
  fbEmptyMark,
  fbIsoDate,
  fbMoneyCents,
  fbMskHour,
  fbNormalizeRegistration,
  fbPhone,
  fbRevenuePeriod,
  fbSuggested,
  fbTrialProduct,
  fbWallToEpoch,
  daysIn,
  isObj,
  obj,
  pyFalsy,
  type Json,
} from "../fitbase/rules";
import { casefold } from "../onec/rules";
import { pyStr } from "../vk/lf";
import { fbFetch, fbRequest, type FbParams, type FbSession } from "./fitbase-api.server";
import type { JobResult } from "./jobs.server";
import { decryptBytes, encryptBytes, readSecret } from "./secrets.server";

const BUCKET = "an-fitbase";
const db = () => getSupabaseAdmin();
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
/** str(x or '') Python. */
const strOr = (v: unknown) => (pyFalsy(v) ? "" : pyStr(v));

/** JSON с ключами по алфавиту (их json.dumps(..., sort_keys=True)). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Их ValueError — текст в состоянии; прочее — их общий текст. */
const isTheirs = (e: unknown) =>
  e instanceof FbError ||
  /^invalid literal for int\(\)|^Invalid isoformat string/.test((e as Error)?.message ?? "");
const safeError = (e: unknown) =>
  isTheirs(e) ? (e as Error).message : "Ошибка загрузки раздела. Повторите обновление.";

// --- Бакет --------------------------------------------------------------------------

async function putBlob(path: string, value: unknown) {
  const body = encryptBytes(gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
  const { error } = await db()
    .storage.from(BUCKET)
    .upload(path, body, { contentType: "application/octet-stream", upsert: true });
  if (error) throw new Error(`Хранилище FitBase: ${error.message}`);
}

async function getBlob<T>(path: string, fallback: T): Promise<T> {
  if (!path) return fallback;
  const { data, error } = await db().storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`Хранилище FitBase: ${error?.message ?? "файл не найден"}`);
  const raw = Buffer.from(await data.arrayBuffer());
  return JSON.parse(gunzipSync(decryptBytes(raw)).toString("utf8")) as T;
}

export async function removeFbBlobs(paths: string[]) {
  const list = paths.filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await db()
      .storage.from(BUCKET)
      .remove(list.slice(i, i + 100));
    if (error) console.error("[fitbase] удаление файлов:", error.message);
  }
}

const blobPath = (id: number, kind: string) => `${id}/${kind}/${Date.now()}-${randomUUID()}.bin`;

// --- Подключение -----------------------------------------------------------------------

export type FbConn = {
  id: number;
  name: string;
  brand: string;
  city: string;
  domain: string;
  club_id: string;
  metadata: Json;
  step_rules: Record<string, string>;
  source_rules: Record<string, string>;
  sync_state: string;
  job_started_at: number | null;
  full_sync: boolean;
  attendance_synced_at: number | null;
  attendance_from: string;
  attendance_to: string;
  attendance_rules: Record<string, string>;
  revenue_synced_at: number | null;
  revenue_from: string;
  revenue_to: string;
  checks_path: string;
  attendance_state: string;
};

async function getConn(id: number): Promise<FbConn> {
  const { data, error } = await db()
    .from("an_fb_connections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new FbError("Подключение FitBase не найдено.");
  return data as FbConn;
}

/** Загрузка «жива» (как an_fb_busy в базе): отметка не старше 15 минут. */
const connBusy = (c: FbConn) =>
  c.sync_state === "Выполняется" && c.job_started_at !== null && c.job_started_at >= nowSec() - 900;

async function patchConn(id: number, fields: Record<string, unknown>) {
  const { error } = await db().from("an_fb_connections").update(fields).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Все строки таблицы студии (PostgREST отдаёт не больше 1000 за раз). */
async function selectAll<T>(
  table: string,
  id: number,
  order: string,
  filter?: [column: string, value: string],
) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db()
      .from(table)
      .select("*")
      .eq("connection_id", id)
      .order(order)
      .range(from, from + 999);
    if (filter) q = q.eq(filter[0], filter[1]);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return rows;
  }
}

// --- Загрузка студии -----------------------------------------------------------------

type Run = FbSession & { incrementalOnly: boolean; lastWrite: number };

/** Их `c` раздела: служебные поля одной фазы. */
type Phase = {
  c: FbConn;
  run: Run;
  updates: Map<
    string,
    { endpoint: string; params: FbParams; values: Json[]; cursor: number; fullAt: number }
  >;
  full: boolean;
  checks: Map<string, CheckProof>;
};
type CheckProof = { signature: string; rows: Json[]; total: number | null };

function newPhase(run: Run, c: FbConn): Phase {
  run.lastFetch = undefined;
  run.paginationWarnings = [];
  return { c, run, updates: new Map(), full: false, checks: new Map() };
}

function makeRun(id: number, domain: string, key: string, incrementalOnly: boolean): Run {
  const run: Run = {
    id,
    domain,
    key,
    progressive: true,
    deadline: performance.now() + 3_300_000,
    paginationWarnings: [],
    incrementalOnly,
    lastWrite: 0,
    progress: async (text: string) => {
      // Их job_progress на каждой странице + отметка «загрузка жива»; чаще
      // раза в секунду не пишем.
      const t = Date.now();
      if (t - run.lastWrite < 1000) return;
      run.lastWrite = t;
      await patchConn(id, { job_progress: text, job_started_at: nowSec() }).catch(() => {});
    },
  };
  return run;
}

const INCREMENTAL_SECTIONS: Record<string, string> = {
  lead: "Лиды",
  "client-contract": "Абонементы",
  "client-service": "Названия услуг",
  "activated-services": "Связи записей с услугами",
  schedule: "Занятия",
  "schedule-registration": "Записи на занятия",
};

/**
 * Их incremental_fetch: изменённые с прошлой выгрузки строки (updated_at
 * минус 5 минут) поверх сохранённой выгрузки раздела; полная выгрузка —
 * впервые, раз в 7 дней (кроме ночной — их incremental_only) и при
 * сокращении периода. Сохраняется вместе с фактами раздела (commitPhase).
 */
async function incrementalFetch(
  ph: Phase,
  endpoint: string,
  params: FbParams = {},
): Promise<Json[]> {
  const { c, run } = ph;
  const original = { ...params };
  const logical: Json = { ...original };
  delete logical.date_to;
  if (["client-contract", "schedule-registration", "client-service"].includes(endpoint)) {
    logical._trial_products_version = endpoint === "schedule-registration" ? 3 : 1;
  }
  const scope = sha256(stableJson([c.domain, c.club_id, endpoint, logical]));
  const now = nowSec();
  const { data: oldRow, error } = await db().rpc("an_fb_incremental_open", {
    p_id: c.id,
    p_scope: scope,
    p_endpoint: endpoint,
    p_params: original,
  });
  if (error) throw new Error(error.message);
  const old = (oldRow ?? null) as {
    params: FbParams;
    object_path: string;
    cursor_at: number;
    full_at: number;
    pending_at: number | null;
  } | null;
  const anchor = old ? (old.pending_at ?? now) : now;
  const oldParams = old?.params ?? {};
  const full =
    !old ||
    !old.cursor_at ||
    (!run.incrementalOnly && now - old.full_at >= 7 * 86400) ||
    String(original.date_to ?? "") < String(oldParams.date_to ?? "");
  let query: FbParams;
  const merged = new Map<string, Json>();
  if (full) {
    query = original;
    ph.full = true;
  } else {
    query = { ...original };
    delete query.date_from;
    delete query.date_to;
    if (original.date_from === "1970-01-01") query.date_from = "1970-01-01";
    if (
      ["lead", "client-contract", "client-service"].includes(endpoint) &&
      !Object.keys(query).length
    ) {
      query["clubs_id[]"] = c.club_id;
    }
    query.updated_at = Math.max(1, old!.cursor_at - 300);
    for (const r of await getBlob<Json[]>(old!.object_path, [])) merged.set(pyStr(r.id), r);
  }
  const received = [...(await fbFetch(run, endpoint, Object.keys(query).length ? query : null))];
  if (
    !full &&
    original.date_to &&
    oldParams.date_to &&
    String(original.date_to) > String(oldParams.date_to)
  ) {
    const boundary = { ...original, date_from: fbAddDays(String(oldParams.date_to), 1) };
    received.push(...(await fbFetch(run, endpoint, boundary)));
  }
  for (const row of received) {
    const identity = pyStr(row.id);
    const deleted = !fbEmptyMark(row.deleted_at);
    if (deleted && endpoint !== "client-contract" && endpoint !== "client-service") {
      merged.delete(identity);
    } else {
      merged.set(identity, fbCheckpointRow(endpoint, row));
    }
  }
  if (
    (endpoint === "schedule" || endpoint === "till-order-steps") &&
    original.date_from &&
    original.date_to
  ) {
    const lo = String(original.date_from);
    const hi = String(original.date_to);
    const zone = original.item_type === "contract" ? "Europe/Moscow" : FB_REVENUE_TZ;
    for (const [key, value] of [...merged]) {
      let day: string;
      if (endpoint === "schedule") day = pyFalsy(value.date) ? "" : pyStr(value.date);
      else if (!fbEmptyMark(value.pay_date)) {
        day = fbDay(fbCreatedAt({ created_at: value.pay_date }), zone);
      } else continue;
      if (!(lo <= day && day <= hi)) merged.delete(key);
    }
  }
  const values = [...merged.values()];
  ph.updates.set(scope, {
    endpoint,
    params: original,
    values,
    cursor: anchor,
    fullAt: full ? now : old!.full_at,
  });
  const section =
    endpoint === "till-order-steps"
      ? original.operation_type === "refund"
        ? "Возвраты"
        : "Оплаты"
      : (INCREMENTAL_SECTIONS[endpoint] ?? endpoint);
  await patchConn(c.id, {
    job_progress: `${full ? "Первая загрузка / сверка истории: " : "Изменения: "}${section}, получено ${received.length}, сохранено ${values.length}`,
  });
  return values;
}

/** Пачки фактов раздела в an_fb_staging (по 5000 строк). */
async function stage(runId: string, kind: string, rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 5000) {
    const { error } = await db().rpc("an_fb_stage", {
      p_run: runId,
      p_kind: kind,
      p_rows: rows.slice(i, i + 5000),
    });
    if (error) throw new Error(error.message);
  }
}

/**
 * Их commit_incremental + замена фактов одной транзакцией: новые файлы
 * выгрузок (и подтверждённых занятий) — в бакет, затем an_fb_commit;
 * прежние файлы удаляются после неё.
 */
async function commitPhase(
  ph: Phase,
  runId: string,
  phase: string,
  state: Record<string, unknown>,
  checksMap?: Map<string, CheckProof>,
) {
  const uploaded: string[] = [];
  try {
    const incremental: Json[] = [];
    for (const [scope, u] of ph.updates) {
      const path = blobPath(ph.c.id, "inc");
      await putBlob(path, u.values);
      uploaded.push(path);
      incremental.push({
        scope,
        endpoint: u.endpoint,
        params: u.params,
        path,
        cursor_at: u.cursor,
        full_at: u.fullAt,
      });
    }
    const fullState = { ...state };
    if (checksMap && ph.checks.size) {
      for (const [eid, proof] of ph.checks) checksMap.set(eid, proof);
      const path = blobPath(ph.c.id, "checks");
      await putBlob(path, Object.fromEntries(checksMap));
      uploaded.push(path);
      fullState.checks_path = path;
    }
    const { data, error } = await db().rpc("an_fb_commit", {
      p_run: runId,
      p_id: ph.c.id,
      p_phase: phase,
      p_state: fullState,
      p_incremental: incremental,
    });
    if (error) throw new Error(error.message);
    await removeFbBlobs(((data as { removed_paths?: string[] })?.removed_paths ?? []) as string[]);
  } catch (e) {
    await removeFbBlobs(uploaded);
    throw e;
  }
}

/** Их verify(): клубы, воронки, этапы, источники; правила этапов — по названиям. */
async function verify(run: Run, id: number) {
  const c = await getConn(id);
  const ph = newPhase(run, c);
  const meta: Record<string, Json[]> = {};
  for (const [key, endpoint] of [
    ["clubs", "club-items"],
    ["funnels", "purchase-funnel"],
    ["steps", "purchase-funnel-step"],
    ["sources", "advertising-source"],
  ] as const) {
    meta[key] = await fbFetch(ph.run, endpoint);
  }
  const rules = { ...(c.step_rules ?? {}) };
  for (const step of meta.steps) {
    const sid = pyStr(step.id);
    if (!(sid in rules)) rules[sid] = fbSuggested("name" in step ? pyStr(step.name ?? null) : "");
  }
  const club = c.club_id || (meta.clubs.length === 1 ? pyStr(meta.clubs[0].id) : "");
  let progress = `Клубов: ${meta.clubs.length}, воронок: ${meta.funnels.length}, этапов: ${meta.steps.length}, источников: ${meta.sources.length}`;
  if (run.paginationWarnings.length) {
    progress += ` · FitBase вернул повтор без общего количества: ${run.paginationWarnings.join(", ")}. Проверьте полноту списков в настройках.`;
  }
  await patchConn(id, {
    metadata: meta,
    step_rules: rules,
    source_rules: c.source_rules ?? {},
    club_id: club,
    sync_state: "Выполняется",
    job_progress: progress,
  });
}

const clubOf = (row: Json) => pyStr(obj(row.club).id ?? null);

/** Их sync(): лиды клуба, ключ клиента — client_id, иначе телефон (SHA-256), иначе лид. */
async function syncLeads(run: Run, id: number) {
  const c = await getConn(id);
  if (!c.club_id) throw new FbError("Сначала выберите клуб в настройках.");
  const ph = newPhase(run, c);
  const data = await incrementalFetch(ph, "lead");
  const byPhone = new Map<string, string>();
  for (const lead of data) {
    const phone = fbPhone(lead);
    if (!pyFalsy(lead.client_id) && phone && clubOf(lead) === c.club_id) {
      byPhone.set(phone, pyStr(lead.client_id));
    }
  }
  const rows: unknown[][] = [];
  for (const lead of data) {
    if (clubOf(lead) !== c.club_id) continue;
    const created = fbCreatedAt(lead);
    const known = !pyFalsy(lead.client_id) ? pyStr(lead.client_id) : byPhone.get(fbPhone(lead));
    let identity: string;
    if (known) identity = `client:${known}`;
    else {
      const phone = fbPhone(lead);
      identity =
        phone.length === 11 ? `phone:${sha256(c.domain + phone)}` : `lead:${pyStr(lead.id)}`;
    }
    rows.push([
      pyStr(lead.id),
      identity,
      created,
      pyFalsy(obj(lead.funnel_step).id) ? "" : pyStr(obj(lead.funnel_step).id),
      pyFalsy(obj(lead.advertising_source).id) ? "" : pyStr(obj(lead.advertising_source).id),
    ]);
  }
  const runId = randomUUID();
  await stage(runId, "leads", rows);
  await commitPhase(ph, runId, "leads", {
    synced_at: nowSec(),
    sync_state: "Выполняется",
    job_progress: `Загружено сделок клуба: ${rows.length}`,
  });
}

/** Их sync_sales(): абонементы клуба — история (новый / повторный), продажи, названия. */
async function syncSales(run: Run, id: number) {
  const c = await getConn(id);
  if (!c.club_id) throw new FbError("Выберите клуб FitBase перед загрузкой продаж.");
  const ph = newPhase(run, c);
  const data = await incrementalFetch(ph, "client-contract");
  const rows: unknown[][] = [];
  const history: unknown[][] = [];
  const products: unknown[][] = [];
  for (const contract of data) {
    if (clubOf(contract) !== c.club_id) continue;
    const price = fbMoneyCents(
      contract.price !== null && contract.price !== undefined
        ? contract.price
        : contract.price_full,
    );
    const client = contract.client_id;
    if (pyFalsy(client)) {
      throw new FbError(
        "FitBase не передал ID клиента для абонемента. Новую/повторную продажу определить нельзя.",
      );
    }
    const created = fbCreatedAt(contract);
    history.push([pyStr(contract.id), pyStr(client), created, price]);
    products.push([pyStr(contract.id), ...fbTrialProduct(contract)]);
    if (price <= 0 || !fbEmptyMark(contract.deleted_at)) continue;
    const paid = fbMoneyCents(contract.amount_of_payment);
    rows.push([pyStr(contract.id), pyStr(client), created, price, paid]);
  }
  const runId = randomUUID();
  await stage(runId, "history", history);
  await stage(runId, "products", products);
  await stage(runId, "sales", rows);
  await commitPhase(ph, runId, "sales", {
    sales_synced_at: nowSec(),
    sales_state: "Продажи загружены",
    job_progress: `Абонементов: ${rows.length}`,
  });
}

/** Их sync_refund_audit(): оплаты и возвраты абонементов с 1970 года, сверка с продажами. */
async function syncRefundAudit(run: Run, id: number) {
  const c = await getConn(id);
  if (!c.club_id) throw new FbError("Сначала выберите клуб в настройках.");
  await patchConn(id, {
    refund_checked_at: null,
    refund_state: "Сверяем возвраты по абонементам…",
  });
  const contracts = new Map(
    (
      await selectAll<{ contract_id: string; client_id: string; paid_cents: number }>(
        "an_fb_sales",
        id,
        "contract_id",
      )
    ).map((r) => [r.contract_id, r]),
  );
  const ph = newPhase(run, c);
  const totals = new Map<string, [number, number]>();
  const purchases = new Set<string>();
  const payments = new Map<string, unknown[]>();
  for (const operation of ["purchase", "refund"] as const) {
    const params = {
      "club_ids[]": c.club_id,
      item_type: "contract",
      operation_type: operation,
      date_from: "1970-01-01",
      date_to: fbDay(nowSec(), FB_REVENUE_TZ),
    };
    for (const row of await incrementalFetch(ph, "till-order-steps", params)) {
      if (clubOf(row) !== c.club_id) continue;
      if (row.item_type !== "contract") continue;
      if (fbEmptyMark(row.pay_date) && (fbEmptyMark(row.amount) || row.amount === "0.00")) continue;
      const stamp = fbCreatedAt({ id: row.id, created_at: row.pay_date });
      const amount = fbMoneyCents(row.amount);
      if (!amount) continue;
      if (operation === "purchase" && amount < 0) {
        throw new FbError("FitBase вернул отрицательную оплату при сверке возвратов.");
      }
      let contract: unknown = !pyFalsy(row.item_id) ? row.item_id : obj(row.item).id;
      contract = pyFalsy(contract) || typeof contract === "boolean" ? "" : pyStr(contract);
      const signature = stableJson([pyStr(row.id), stamp, amount, contract]);
      if (operation === "refund" && purchases.has(signature)) {
        throw new FbError("FitBase вернул одинаковые оплаты и возвраты. Сверка не завершена.");
      }
      if (operation === "purchase") purchases.add(signature);
      const clientRaw = !pyFalsy(row.client_id)
        ? row.client_id
        : !pyFalsy(obj(row.client).id)
          ? obj(row.client).id
          : (contracts.get(contract as string)?.client_id ?? "");
      const record = [
        operation,
        pyStr(row.id),
        contract,
        pyFalsy(clientRaw) ? "" : pyStr(clientRaw),
        stamp,
        fbDay(stamp),
        Math.abs(amount),
      ];
      const key = `${operation}\u0000${pyStr(row.id)}`;
      if (payments.has(key)) {
        if (stableJson(payments.get(key)) !== stableJson(record)) {
          throw new FbError(
            "FitBase вернул разные суммы одной операции. Предыдущая выгрузка сохранена.",
          );
        }
        continue;
      }
      payments.set(key, record);
      const t = totals.get(contract as string) ?? [0, 0];
      t[operation === "purchase" ? 0 : 1] += Math.abs(amount);
      totals.set(contract as string, t);
    }
  }
  const audit: unknown[][] = [];
  let unknown = 0;
  let deducted = 0;
  let already = 0;
  for (const [cid, contract] of contracts) {
    const [gross, refund] = totals.get(cid) ?? [0, 0];
    const net = gross - refund;
    const paid = Number(contract.paid_cents);
    let status: string;
    let effective: number | null;
    if (!refund) {
      status = "no_refunds";
      effective = paid;
    } else if (paid === net) {
      status = "already_net";
      effective = paid;
      already += 1;
    } else if (paid === gross) {
      status = "deducted";
      effective = net;
      deducted += 1;
    } else {
      status = "unresolved";
      effective = null;
      unknown += 1;
    }
    audit.push([cid, paid, gross, refund, net, effective, status]);
  }
  const runId = randomUUID();
  await stage(runId, "audit", audit);
  await stage(runId, "payments", [...payments.values()] as unknown[][]);
  const t = nowSec();
  await commitPhase(ph, runId, "refund", {
    sales_payments_at: t,
    refund_checked_at: t,
    refund_state: `Возвраты сверены: уже учтены — ${already}, вычтены — ${deducted}, требуют проверки — ${unknown}`,
  });
}

/** Их datetime.fromisoformat(день + 'T' + время) в МСК → секунды. */
function eventTime(day: string, time: unknown): number {
  const text = `${day}T${pyStr(time ?? null)}`;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6})\d*)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text,
    );
  if (!m) throw new Error("bad time");
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  if (h > 23 || mi > 59 || s > 59) throw new Error("bad time");
  const micro = m[7] ? Number(m[7].padEnd(6, "0")) / 1e6 : 0;
  if (!m[8]) return fbWallToEpoch(y, mo, d, h, mi, s) + micro;
  if (m[8] === "Z") return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 + micro;
  const off = m[8].replace(":", "");
  const sign = off[0] === "-" ? -1 : 1;
  return (
    Date.UTC(y, mo - 1, d, h, mi, s) / 1000 +
    micro -
    sign * (Number(off.slice(1, 3)) * 3600 + Number(off.slice(3, 5) || 0) * 60)
  );
}

type Product = [string, number];
const STATUS_KEYS = Object.keys(FB_ATTENDANCE_STATUSES);

/**
 * Их sync_attendance(): занятия и записи за окно (год назад … сегодня, или
 * период отчёта с месяцем и годом раньше), сверка записей со счётчиками
 * занятия (повторная выгрузка занятия, подтверждения сохраняются), пробные
 * по названиям услуг и абонементов, коды статусов.
 */
async function syncAttendance(run: Run, id: number, startDate?: string, endDate?: string) {
  const c = await getConn(id);
  if (!c.club_id) throw new FbError("Сначала выберите клуб в настройках.");
  const ph = newPhase(run, c);
  const today = fbDay(nowSec());
  let lo: string;
  let hi: string;
  if (startDate !== undefined) {
    const w = fbAttendanceWindow(startDate, endDate ?? "");
    lo = [w.start, w.pmStart, w.pyStart].sort()[0];
    hi = w.end;
  } else if (c.attendance_from) {
    fbIsoDate(c.attendance_from);
    fbIsoDate(c.attendance_to);
    lo = c.attendance_from;
    hi = c.attendance_to > today ? c.attendance_to : today;
  } else {
    lo = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`;
    hi = today;
  }
  if (c.attendance_from && c.attendance_from < lo) lo = c.attendance_from;
  if (c.attendance_to && c.attendance_to > hi) hi = c.attendance_to;
  const events = await incrementalFetch(ph, "schedule", {
    date_from: lo,
    date_to: hi,
    "club_ids[]": c.club_id,
  });
  const registrations = await incrementalFetch(ph, "schedule-registration", {
    date_from: lo,
    date_to: hi,
    "clubs_id[]": c.club_id,
  });
  const eventRows = new Map<string, unknown[]>();
  const aggregate = new Map<string, Record<string, number>>();
  const histograms = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (clubOf(event) !== c.club_id) continue;
    if (event.event_type === "rent") continue;
    let day: string;
    let endedAt: number;
    try {
      if (!("date" in event)) throw new Error("no date");
      day = pyStr(event.date ?? null);
      fbIsoDate(day);
      if (!(lo <= day && day <= hi)) continue;
      if (!("time_end" in event) || !("time_start" in event)) throw new Error("no time");
      endedAt = eventTime(day, event.time_end);
      const startedAt = eventTime(day, event.time_start);
      if (endedAt < startedAt) endedAt += 86400;
    } catch {
      throw new FbError(
        "FitBase: не удалось прочитать дату/время занятия. Старая выгрузка сохранена.",
      );
    }
    const training = obj(event.training);
    const eid = pyStr(event.id);
    const cancelled = event.cancel;
    if (!(cancelled === true || cancelled === false || cancelled === 0 || cancelled === 1)) {
      throw new FbError("FitBase не передал признак отмены занятия. Старая выгрузка сохранена.");
    }
    eventRows.set(eid, [
      eid,
      day,
      Math.trunc(endedAt),
      pyFalsy(training.id) ? "" : pyStr(training.id),
      pyFalsy(training.name) ? "Без направления" : pyStr(training.name),
      Boolean(cancelled),
    ]);
    const counts = obj(event.registrations_count);
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts)) {
      if (k in FB_ATTENDANCE_STATUSES && typeof v === "number" && Number.isInteger(v) && v >= 0) {
        kept[k] = v;
      }
    }
    aggregate.set(eid, kept);
    histograms.set(eid, new Map());
  }

  let records: [string, string, string, string][] = [];
  const trialFacts = new Map<string, Product>();
  let serviceProducts: Map<string, [string, Product]> | null = null;
  let activations: Map<string, Json[]> | null = null;
  let trialMetadataFailed = false;
  const contractProducts = new Map(
    (
      await selectAll<{ item_id: string; label: string; is_trial: number }>(
        "an_fb_trial_products",
        id,
        "item_id",
        ["kind", "contract"],
      )
    ).map((r) => [r.item_id, [r.label, r.is_trial] as Product]),
  );

  const directFact = async (row: Json): Promise<Product> => {
    let fact = fbTrialProduct(row, true);
    const linked = obj(row.service);
    const sid = linked.id;
    const service = obj(obj(linked.service).available_service);
    if (!pyFalsy(sid) && fact[1] !== 1 && pyFalsy(service.name)) {
      if (serviceProducts === null) {
        serviceProducts = new Map();
        const services = await incrementalFetch(ph, "client-service", { "clubs_id[]": c.club_id });
        let catalog: Map<string, unknown> | null = null;
        for (const item of services) {
          const available = obj(obj(item.service).available_service);
          if (!pyFalsy(available.id) && pyFalsy(available.name)) {
            if (catalog === null) {
              catalog = new Map(
                (await fbFetch(run, "available-services", { "club_ids[]": c.club_id })).map((r) => [
                  pyStr(r.id),
                  r.name,
                ]),
              );
            }
            const label = catalog.get(pyStr(available.id));
            if (typeof label === "string" && label.trim()) available.name = label;
          }
          serviceProducts.set(pyStr(item.id), [
            pyFalsy(item.client_id) ? "" : pyStr(item.client_id),
            fbTrialProduct({ service: item }, true),
          ]);
        }
      }
      const [owner, product] = serviceProducts.get(pyStr(sid)) ?? ["", ["", -1] as Product];
      if (product[1] >= 0 && (!owner || pyFalsy(row.client_id) || owner === pyStr(row.client_id))) {
        fact = product;
      } else return ["", -1];
    }
    return fact[1] < 0 ? (contractProducts.get(pyStr(obj(row.contract).id ?? null)) ?? fact) : fact;
  };

  const proven = await evidenceCache(id);
  const trialFact = async (row: Json): Promise<Product> => {
    const prior = proven.get(pyStr(row.id));
    if (prior && prior[0] === metadataSignature(fbCheckpointRow("schedule-registration", row), c)) {
      return [prior[1], prior[2]];
    }
    let fact = fbClassifiedProduct(row);
    if (fact[1] < 0) fact = await directFact(row);
    if (fact[1] >= 0) return fact;
    if (activations === null) {
      activations = new Map();
      for (const item of await incrementalFetch(ph, "activated-services", {
        "club_ids[]": c.club_id,
      })) {
        const rid = item.registration_id;
        const club = obj(item.club).id;
        if (pyFalsy(rid) || typeof rid === "boolean") continue;
        if (club !== null && club !== undefined && pyStr(club) !== c.club_id) continue;
        const list = activations.get(pyStr(rid)) ?? [];
        list.push(item);
        activations.set(pyStr(rid), list);
      }
    }
    const facts: Product[] = [];
    for (const item of activations.get(pyStr(row.id)) ?? []) {
      const client = item.client_id;
      if (!pyFalsy(row.client_id) && !pyFalsy(client) && pyStr(client) !== pyStr(row.client_id)) {
        continue;
      }
      const product = await directFact({
        client_id: row.client_id ?? null,
        service: item.client_service ?? null,
        contract: item.client_contract ?? null,
      });
      if (product[1] >= 0) facts.push(product);
    }
    if (facts.length && new Set(facts.map((f) => f[1])).size === 1) {
      return [[...new Set(facts.map((f) => f[0]))].join(" / "), facts[0][1]];
    }
    return fact;
  };
  const safeTrialFact = async (row: Json): Promise<Product> => {
    try {
      return await trialFact(row);
    } catch (e) {
      if (!isTheirs(e)) throw e;
      // Их: необязательные названия продуктов не отменяют проверенную посещаемость.
      trialMetadataFailed = true;
      return ["", -1];
    }
  };

  for (const row of registrations) {
    const eid = pyFalsy(obj(row.event).id) ? "" : pyStr(obj(row.event).id);
    if (!eventRows.has(eid)) continue;
    const client = row.client_id;
    const status = row.status;
    if (typeof client === "boolean" || status === null || status === undefined) {
      throw new FbError("FitBase не передал корректный статус записи. Старая выгрузка сохранена.");
    }
    const code = pyStr(status);
    const h = histograms.get(eid)!;
    h.set(code, (h.get(code) ?? 0) + 1);
    records.push([pyStr(row.id), eid, pyFalsy(client) ? "" : pyStr(client), code]);
    trialFacts.set(pyStr(row.id), await safeTrialFact(row));
  }

  const countMatches = (observed: number, counts: Record<string, number>) => {
    const values = Object.values(counts);
    return (
      observed === values.reduce((a, b) => a + b, 0) ||
      (counts.registered >= Math.max(...values) && observed === counts.registered)
    );
  };
  const counterWarnings: string[] = [];
  let checksMap: Map<string, CheckProof> | null = null;
  for (const [eid, original] of [...aggregate]) {
    let counts = original;
    if (
      !(Object.keys(counts).length === STATUS_KEYS.length && STATUS_KEYS.every((k) => k in counts))
    ) {
      continue;
    }
    const observed = [...histograms.get(eid)!.values()].reduce((a, b) => a + b, 0);
    if (countMatches(observed, counts)) continue;
    const signature = sha256(
      stableJson([
        [id, ...eventRows.get(eid)!],
        counts,
        records
          .filter((r) => r[1] === eid)
          .map((r) => [id, ...r])
          .sort((a, b) => (stableJson(a) < stableJson(b) ? -1 : 1)),
      ]),
    );
    if (checksMap === null) {
      checksMap = new Map(
        Object.entries(await getBlob<Record<string, CheckProof>>(c.checks_path, {})),
      );
    }
    const proof = checksMap.get(eid);
    let targeted: Json[];
    if (proof && proof.signature === signature && !ph.full) {
      targeted = proof.rows;
      run.lastFetch = {
        endpoint: "schedule-registration",
        params: { event_id: eid },
        total: proof.total,
        received: targeted.length,
      };
    } else {
      targeted = await fbFetch(run, "schedule-registration", { event_id: eid });
    }
    const evidence = { ...(run.lastFetch ?? {}) } as NonNullable<Run["lastFetch"]>;
    const fresh: [string, string, string, string][] = [];
    const histogram = new Map<string, number>();
    const embedded: Record<string, number>[] = [];
    for (const row of targeted) {
      const linked = obj(row.event);
      if ((pyFalsy(linked.id) ? "" : pyStr(linked.id)) !== eid) {
        throw new FbError(
          `FitBase проигнорировал фильтр занятия #${eid}. Старая выгрузка сохранена.`,
        );
      }
      const client = row.client_id;
      const status = row.status;
      if (typeof client === "boolean" || status === null || status === undefined) {
        throw new FbError(
          "FitBase не передал корректный статус записи. Старая выгрузка сохранена.",
        );
      }
      const code = pyStr(status);
      histogram.set(code, (histogram.get(code) ?? 0) + 1);
      fresh.push([pyStr(row.id), eid, pyFalsy(client) ? "" : pyStr(client), code]);
      trialFacts.set(pyStr(row.id), await safeTrialFact(row));
      const counters = obj(linked.registrations_count);
      if (
        STATUS_KEYS.every(
          (k) =>
            typeof counters[k] === "number" &&
            Number.isInteger(counters[k]) &&
            (counters[k] as number) >= 0,
        )
      ) {
        embedded.push(Object.fromEntries(STATUS_KEYS.map((k) => [k, counters[k] as number])));
      }
    }
    if (
      embedded.length &&
      embedded.length === targeted.length &&
      embedded.every((v) => stableJson(v) === stableJson(embedded[0]))
    ) {
      counts = embedded[0];
    }
    const seenNow = [...histogram.values()].reduce((a, b) => a + b, 0);
    const sameParams =
      evidence.endpoint === "schedule-registration" &&
      stableJson(evidence.params) === stableJson({ event_id: eid });
    if (!countMatches(seenNow, counts)) {
      if (sameParams && evidence.total === seenNow && evidence.received === seenNow) {
        counterWarnings.push(eid);
        counts = {};
      } else {
        const detail = Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        throw new FbError(
          `FitBase: занятие #${eid}: записи не совпали со счётчиками. Получено ${seenNow}; total_count=${pyStr(evidence.total ?? null)}; ${detail}. Полнота не подтверждена. Старая выгрузка сохранена.`,
        );
      }
    }
    ph.checks.set(eid, {
      signature,
      rows: targeted.map((r) => fbCheckpointRow("schedule-registration", r)),
      total: sameParams ? evidence.total : null,
    });
    records = [...records.filter((r) => r[1] !== eid), ...fresh];
    histograms.set(eid, histogram);
    aggregate.set(eid, counts);
  }

  // Их подбор значений кодов статусов (коды по порядку — у них порядок множества).
  const rules: Record<string, string> = { ...(c.attendance_rules ?? {}) };
  const known = new Set(STATUS_KEYS);
  const aliases = new Map(
    Object.entries(FB_ATTENDANCE_STATUSES).map(([k, v]) => [casefold(v).replace(/ё/g, "е"), k]),
  );
  const codes = [...new Set(records.map((r) => r[3]))].sort();
  for (const code of codes) {
    if (known.has(rules[code])) continue;
    if (code in FB_ATTENDANCE_CODES) {
      rules[code] = FB_ATTENDANCE_CODES[code];
      continue;
    }
    const literal = casefold(code).replace(/ё/g, "е");
    if (known.has(literal)) {
      rules[code] = literal;
      continue;
    }
    if (aliases.has(literal)) {
      rules[code] = aliases.get(literal)!;
      continue;
    }
    const candidates = STATUS_KEYS.filter(
      (kind) =>
        histograms.size > 0 &&
        [...histograms].every(
          ([eid, h]) =>
            kind in (aggregate.get(eid) ?? {}) && (h.get(code) ?? 0) === aggregate.get(eid)![kind],
        ),
    );
    if (
      candidates.length === 1 &&
      !codes.filter((o) => o !== code).some((o) => rules[o] === candidates[0])
    ) {
      rules[code] = candidates[0];
    }
  }
  const unresolved = codes.some((code) => !known.has(rules[code]));
  let state = `Занятия загружены${unresolved ? " · сопоставьте статусы записей в настройках" : ""}`;
  if (counterWarnings.length) {
    state += ` · Сверка всей загруженной истории ${lo} — ${hi}: у ${counterWarnings.length} занятий сводные счётчики FitBase отличаются. Полный список записей проверен по API; это не число пропущенных занятий.`;
  }
  if (trialMetadataFailed) {
    state +=
      " · Воронка пробных: классификация услуг неполна. Посещаемость сохранена по проверенным записям; пробные требуют проверки.";
  }
  const runId = randomUUID();
  await stage(runId, "events", [...eventRows.values()]);
  await stage(runId, "records", records);
  await stage(
    runId,
    "products",
    records.map((r) => [r[0], ...(trialFacts.get(r[0]) ?? ["", -1])]),
  );
  await commitPhase(
    ph,
    runId,
    "attendance",
    {
      trial_snapshot: !trialMetadataFailed,
      attendance_synced_at: nowSec(),
      attendance_state: state,
      attendance_from: lo,
      attendance_to: hi,
      attendance_rules: rules,
    },
    checksMap ?? new Map(),
  );
}

/** Их metadata_signature: id, клиент, абонемент и услуга записи + студия. */
function metadataSignature(row: Json, c: { domain: string; club_id: string }): string {
  const r = fbNormalizeRegistration(row);
  const compact = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(compact)
      : isObj(v)
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== null && x !== undefined)
              .map(([k, x]) => [k, compact(x)]),
          )
        : v;
  const payload: Json = {};
  for (const k of ["id", "client_id", "contract", "service"]) payload[k] = r[k] ?? null;
  payload._owner = [c.domain, c.club_id];
  return sha256(stableJson(compact(payload)));
}

/** Их metadata_cache: подтверждённые классификации записей. */
async function evidenceCache(id: number) {
  const rows = await selectAll<{
    registration_id: string;
    signature: string;
    label: string;
    is_trial: number;
  }>("an_fb_trial_evidence", id, "registration_id");
  return new Map(rows.map((r) => [r.registration_id, [r.signature, r.label, r.is_trial] as const]));
}

/** Их metadata_scan: связи записей с услугами постранично (по 100, пауза 1 с). */
async function metadataScan(run: Run, c: FbConn, params: FbParams, deadline: number) {
  const items = new Map<string, Json>();
  let reported: number | null = null;
  let exhausted = false;
  for (let page = 1; page <= 150; page++) {
    if (performance.now() > deadline) break;
    const data = await fbRequest(run, "activated-services", page, {
      "club_ids[]": c.club_id,
      page_size: 100,
      ...params,
    });
    const rows = data.items as unknown[];
    const total = data.total_count;
    if (typeof total === "number" && Number.isInteger(total)) reported = total;
    if (!rows.length) {
      exhausted = true;
      break;
    }
    let added = 0;
    for (const row of rows) {
      if (!isObj(row) || row.id === null || row.id === undefined) {
        throw new FbError("FitBase не передал ID связи услуги.");
      }
      if (params.client_id && pyStr(row.client_id ?? "") !== pyStr(params.client_id)) {
        throw new FbError("FitBase проигнорировал фильтр клиента при уточнении пробных.");
      }
      const key = pyStr(row.id);
      if (!items.has(key)) added += 1;
      items.set(key, row);
    }
    if (!added) break;
    await sleep(1000);
  }
  return { rows: [...items.values()], received: items.size, reported, exhausted };
}

/**
 * Их repair_metadata: уточнить «пробное / обычное» у записей без названия
 * услуги — по сохранённым выгрузкам, связям записей с услугами (сначала весь
 * список, дальше — только клиенты новых записей), абонементам. Посещаемость
 * не меняется.
 */
async function repairMetadata(run: Run, id: number) {
  const c = await getConn(id);
  if (!c.attendance_synced_at) throw new FbError("Сначала загрузите посещаемость студии.");
  const ph = newPhase(run, c);
  const previous = await evidenceCache(id);
  const baseline = new Map<string, Json>();
  const { data: scopes, error } = await db()
    .from("an_fb_incremental")
    .select("object_path, cursor_at")
    .eq("connection_id", id)
    .eq("endpoint", "schedule-registration")
    .gt("cursor_at", 0)
    .order("cursor_at");
  if (error) throw new Error(error.message);
  for (const s of scopes ?? []) {
    for (const row of await getBlob<Json[]>(s.object_path as string, []))
      baseline.set(pyStr(row.id), row);
  }
  for (const proof of Object.values(await getBlob<Record<string, CheckProof>>(c.checks_path, {}))) {
    for (const row of proof.rows ?? []) {
      if (!baseline.has(pyStr(row.id))) baseline.set(pyStr(row.id), row);
    }
  }
  const records = await selectAll<{ registration_id: string; client_key: string }>(
    "an_fb_records",
    id,
    "registration_id",
  );
  const productRows = await selectAll<{
    kind: string;
    item_id: string;
    label: string;
    is_trial: number;
  }>("an_fb_trial_products", id, "item_id");
  const existing = new Map<string, Product>();
  const contracts = new Map<string, Product>();
  for (const r of productRows) {
    (r.kind === "registration" ? existing : contracts).set(r.item_id, [r.label, r.is_trial]);
  }
  const refreshed = await incrementalFetch(ph, "schedule-registration", {
    date_from: c.attendance_from,
    date_to: c.attendance_to,
    "clubs_id[]": c.club_id,
  });
  for (const row of refreshed) baseline.set(pyStr(row.id), fbNormalizeRegistration(row));
  const candidates = new Set<string>();
  for (const r of records) {
    const dto = baseline.get(r.registration_id) ?? {};
    const prior = previous.get(r.registration_id);
    const has = Object.keys(dto).length > 0;
    if (fbClassifiedProduct(dto)[1] >= 0) continue;
    if (has && prior && prior[0] === metadataSignature(dto, c)) continue;
    if ((contracts.get(strOr(obj(dto.contract).id)) ?? ["", -1])[1] >= 0) continue;
    if (has && !prior && (existing.get(r.registration_id) ?? ["", -1])[1] >= 0) continue;
    candidates.add(r.client_key);
  }
  const activations: Json[] = [];
  const evidence = { received: 0, reported: null as number | null, exhausted: true };
  const deadline = performance.now() + 240_000;
  const filters: FbParams[] =
    records.length && !previous.size
      ? [{}]
      : candidates.has("")
        ? [{}]
        : [...candidates]
            .sort()
            .slice(0, 100)
            .map((client) => ({ client_id: client }));
  for (const params of filters) {
    if (performance.now() > deadline) {
      evidence.exhausted = false;
      break;
    }
    let scan;
    try {
      scan = await metadataScan(run, c, params, deadline);
    } catch (e) {
      if (!isTheirs(e)) throw e;
      evidence.exhausted = false;
      break;
    }
    activations.push(...scan.rows);
    evidence.received += scan.received;
    evidence.exhausted = evidence.exhausted && scan.exhausted;
    if (filters.length === 1) evidence.reported = scan.reported;
  }
  const links = new Map<string, Json[]>();
  for (const row of activations) {
    const club = obj(row.club).id;
    if (club !== null && club !== undefined && pyStr(club) !== c.club_id) continue;
    if (!pyFalsy(row.registration_id) && typeof row.registration_id !== "boolean") {
      const list = links.get(pyStr(row.registration_id)) ?? [];
      list.push(row);
      links.set(pyStr(row.registration_id), list);
    }
  }
  const facts: [string, string, number][] = [];
  let unknown = 0;
  for (const r of records) {
    const dto = baseline.get(r.registration_id) ?? {};
    const has = Object.keys(dto).length > 0;
    let fact = fbClassifiedProduct(dto);
    const prior = previous.get(r.registration_id);
    if (has && prior && prior[0] === metadataSignature(dto, c)) fact = [prior[1], prior[2]];
    const found: Product[] = [];
    for (const row of links.get(r.registration_id) ?? []) {
      if (!pyFalsy(row.client_id) && r.client_key && pyStr(row.client_id) !== r.client_key)
        continue;
      const p = fbClassifiedProduct({
        service: row.client_service ?? null,
        contract: row.client_contract ?? null,
      });
      if (p[1] >= 0) found.push(p);
    }
    if (found.length) {
      fact =
        new Set(found.map((v) => v[1])).size === 1
          ? [[...new Set(found.map((v) => v[0]))].join(" / "), found[0][1]]
          : ["", -1];
    }
    const contract = pyFalsy(obj(dto.contract).id) ? "" : pyStr(obj(dto.contract).id);
    if (fact[1] < 0 && !found.length && contracts.has(contract)) fact = contracts.get(contract)!;
    if (fact[1] < 0 && !found.length && has && !prior && existing.has(r.registration_id)) {
      fact = existing.get(r.registration_id)!;
    }
    if (fact[1] < 0) unknown += 1;
    facts.push([r.registration_id, fact[0], fact[1]]);
  }
  const runId = randomUUID();
  await stage(runId, "products", facts);
  await stage(
    runId,
    "evidence",
    facts
      .filter((f) => f[2] >= 0 && baseline.has(f[0]))
      .map((f) => [f[0], metadataSignature(baseline.get(f[0])!, c), f[1], f[2]]),
  );
  await commitPhase(ph, runId, "trials", {
    trial_snapshot: !unknown,
    quality: { unknown, ...evidence },
  });
  if (unknown) {
    throw new FbError(
      `Классификация пробных неполна: неизвестных записей ${unknown}. Подтверждённые факты сохранены; посещаемость не менялась.`,
    );
  }
}

/** Их sync_revenue(): оплаты и возвраты по месяцам, день — по Самаре; вчера — последний день. */
async function syncRevenue(run: Run, id: number, startDate?: string, endDate?: string) {
  const c = await getConn(id);
  if (!c.club_id) throw new FbError("Сначала выберите клуб в настройках.");
  const ph = newPhase(run, c);
  const period = fbRevenuePeriod();
  const cutoff = period.cutoff;
  if (startDate) fbIsoDate(startDate);
  if (endDate) fbIsoDate(endDate);
  let lo = startDate || c.revenue_from || period.fromDate;
  const hi = endDate && endDate < cutoff ? endDate : cutoff;
  if (lo > hi || fbDaysBetween(lo, hi) > 2200) {
    throw new FbError("Выберите корректный период выручки не больше шести лет.");
  }
  if (c.revenue_from && c.revenue_from < lo) lo = c.revenue_from;
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  let chunkLo = lo;
  while (chunkLo <= hi) {
    const { y, m } = fbIsoDate(chunkLo);
    const monthEnd = `${chunkLo.slice(0, 8)}${String(daysIn(y, m)).padStart(2, "0")}`;
    const chunkHi = hi < monthEnd ? hi : monthEnd;
    for (const operation of ["purchase", "refund"] as const) {
      const params = {
        date_from: chunkLo,
        date_to: chunkHi,
        "club_ids[]": c.club_id,
        operation_type: operation,
      };
      for (const item of await incrementalFetch(ph, "till-order-steps", params)) {
        if (clubOf(item) !== c.club_id) continue;
        if (fbEmptyMark(item.pay_date) && (fbEmptyMark(item.amount) || item.amount === "0.00"))
          continue;
        let stamp: number;
        try {
          stamp = fbCreatedAt({ id: item.id, created_at: item.pay_date });
        } catch (e) {
          if (!isTheirs(e)) throw e;
          throw new FbError(
            "FitBase не передал корректную дату оплаты. Предыдущая выручка сохранена.",
          );
        }
        const day = fbDay(stamp, FB_REVENUE_TZ);
        if (!(chunkLo <= day && day <= chunkHi)) continue;
        let amount: number;
        try {
          amount = fbMoneyCents(item.amount);
        } catch (e) {
          if (!isTheirs(e)) throw e;
          throw new FbError(
            "Не удалось прочитать сумму платежа FitBase. Предыдущая выручка сохранена.",
          );
        }
        if (!amount) continue;
        if (operation === "purchase" && amount < 0) {
          throw new FbError(
            "FitBase вернул отрицательную оплату в выборке покупок. Предыдущая выручка сохранена.",
          );
        }
        const itemType = pyFalsy(item.item_type) ? "" : pyStr(item.item_type);
        const signature = stableJson([pyStr(item.id), stamp, amount, itemType]);
        if (operation === "refund" && seen.has(signature)) {
          throw new FbError(
            "FitBase вернул одинаковые операции в оплатах и возвратах. Предыдущая выручка сохранена.",
          );
        }
        if (operation === "purchase") seen.add(signature);
        const signed = operation === "refund" ? -Math.abs(amount) : amount;
        rows.push([operation, pyStr(item.id), stamp, day, signed, itemType]);
      }
    }
    chunkLo = fbAddDays(chunkHi, 1);
  }
  const runId = randomUUID();
  await stage(runId, "revenue", rows);
  await commitPhase(ph, runId, "revenue", {
    revenue_synced_at: nowSec(),
    revenue_state: "Выручка загружена",
    revenue_from: lo,
    revenue_to: hi,
  });
}

// --- Загрузка студии целиком (их start_job) ------------------------------------------------

export type FbAction = "verify" | "sync" | "sales" | "attendance" | "revenue" | "all" | "trials";

async function apiKey(id: number): Promise<string> {
  const key = await readSecret({ kind: "fitbase", ref: String(id), name: "api_key" });
  if (!key) throw new FbError("Ключ API FitBase не сохранён: введите его в подключении студии.");
  return key;
}

/**
 * Их start_job: студия — «Выполняется» (вторая загрузка — их ошибка), затем
 * разделы по действию в фоне. Возвращает обещание окончания загрузки.
 */
export async function fbStartJob(
  id: number,
  action: FbAction,
  opts: { start?: string; end?: string; incrementalOnly?: boolean } = {},
): Promise<{ done: Promise<void> }> {
  if (action === "attendance" && opts.start !== undefined)
    fbAttendanceWindow(opts.start, opts.end ?? "");
  const { data, error } = await db().rpc("an_fb_job_begin", { p_id: id, p_action: action });
  if (error) {
    if (error.code === "55006" || error.code === "P0002") throw new FbError(error.message);
    throw new Error(error.message);
  }
  const begun = data as FbConn;
  // Обёртка: иначе await этой функции ждал бы конца всей загрузки.
  return { done: runJob(begun, action, opts) };
}

async function runJob(
  begun: FbConn,
  action: FbAction,
  opts: { start?: string; end?: string; incrementalOnly?: boolean },
): Promise<void> {
  const id = begun.id;
  let run: Run;
  try {
    run = makeRun(id, begun.domain, await apiKey(id), Boolean(opts.incrementalOnly));
  } catch (e) {
    await patchConn(id, {
      sync_state: cut(
        isTheirs(e) ? (e as Error).message : "Ошибка загрузки. Проверьте настройки и повторите.",
        300,
      ),
      job_progress: "",
      job_started_at: null,
    }).catch(() => {});
    return;
  }
  try {
    if (action === "verify" || (action === "all" && !begun.club_id)) await verify(run, id);
    if (!(await getConn(id)).club_id) {
      await patchConn(id, { sync_state: "Выберите клуб в настройках", job_started_at: null });
      return;
    }
    if (action === "trials") {
      run.incrementalOnly = true;
      await patchConn(id, { job_progress: "Уточняем типы пробных занятий…" });
      await repairMetadata(run, id);
      await patchConn(id, {
        sync_state: "Обновление завершено",
        job_progress: "",
        job_started_at: null,
        sync_attempt_at: nowSec(),
      });
      return;
    }
    const failures: string[] = [];
    if (!["sales", "attendance", "revenue"].includes(action)) {
      try {
        await syncLeads(run, id);
      } catch (e) {
        failures.push(`Лиды: ${safeError(e)}`);
      }
    }
    if (!["attendance", "revenue"].includes(action)) {
      await patchConn(id, {
        sync_state: "Выполняется",
        job_progress: "Загружаем покупки абонементов…",
      });
      let salesOk = true;
      try {
        await syncSales(run, id);
      } catch (e) {
        salesOk = false;
        failures.push(`Абонементы: ${safeError(e)}`);
        await patchConn(id, { sales_state: cut(safeError(e), 300) });
      }
      if (salesOk) {
        try {
          await syncRefundAudit(run, id);
        } catch (e) {
          failures.push(`Возвраты: ${safeError(e)}`);
          await patchConn(id, { refund_state: cut(safeError(e), 300) });
        }
      }
    }
    let c = await getConn(id);
    if (
      action === "attendance" ||
      action === "all" ||
      ((action === "sync" || action === "verify") && (c.attendance_synced_at || c.full_sync))
    ) {
      try {
        await syncAttendance(run, id, opts.start, opts.end);
        try {
          await repairMetadata(run, id);
        } catch (e) {
          failures.push(`Воронка: ${safeError(e)}`);
        }
      } catch (e) {
        failures.push(`Занятия: ${safeError(e)}`);
        await patchConn(id, { attendance_state: cut(safeError(e), 300) });
      }
    }
    c = await getConn(id);
    if (
      action === "revenue" ||
      action === "all" ||
      ((action === "sync" || action === "verify") && (c.revenue_synced_at || c.full_sync))
    ) {
      try {
        await syncRevenue(run, id, opts.start, opts.end);
      } catch (e) {
        failures.push(`Выручка: ${safeError(e)}`);
        await patchConn(id, { revenue_state: cut(safeError(e), 300) });
      }
    }
    await patchConn(id, {
      sync_state: failures.length ? cut(failures.join("; "), 600) : "Обновление завершено",
      job_started_at: null,
      sync_attempt_at: nowSec(),
    });
  } catch (e) {
    const message = isTheirs(e)
      ? (e as Error).message
      : "Ошибка загрузки. Проверьте настройки и повторите.";
    if (!isTheirs(e)) console.error("[fitbase] загрузка студии", id, (e as Error).message);
    await patchConn(id, {
      sync_state: cut(message, 300),
      job_progress: "",
      job_started_at: null,
    }).catch(() => {});
  }
}

// --- Общая загрузка (их start_all) и ночной запуск ------------------------------------------

type BatchPayload = {
  ids: number[];
  total: number;
  completed: number;
  errors: number;
  message: string;
  results: { id: number; name: string; message: string }[];
};

async function saveBatch(payload: BatchPayload, active = true) {
  const { error } = await db()
    .from("an_fb_batch")
    .update({ active, payload, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) console.error("[fitbase] очередь:", error.message);
}

/** Их start_all: одна очередь, по одной студии; возвращает обещание окончания. */
export async function fbStartAll(
  opts: { incrementalOnly?: boolean; action?: "all" | "trials"; ids?: number[] } = {},
): Promise<{ done: Promise<void> }> {
  const action = opts.action ?? "all";
  const { data, error } = await db()
    .from("an_fb_connections")
    .select("id, name, city, brand")
    .order("brand")
    .order("city")
    .order("name");
  if (error) throw new Error(error.message);
  let connections = (data ?? []) as { id: number; name: string; city: string }[];
  if (opts.ids) {
    const allowed = new Set(connections.map((c) => c.id));
    if (!opts.ids.every((i) => allowed.has(i))) throw new FbError("Студия не найдена.");
    const wanted = new Set(opts.ids);
    connections = connections.filter((c) => wanted.has(c.id));
  }
  if (!connections.length) throw new FbError("Сначала добавьте студии FitBase.");
  const payload: BatchPayload = {
    ids: connections.map((c) => c.id),
    total: connections.length,
    completed: 0,
    errors: 0,
    message: "Общая загрузка поставлена в очередь.",
    results: [],
  };
  const { data: begun, error: beginError } = await db().rpc("an_fb_batch_begin", {
    p_payload: payload,
  });
  if (beginError) throw new Error(beginError.message);
  if (!begun) throw new FbError("Общая загрузка уже выполняется. Следите за прогрессом.");
  const done = (async () => {
    const heartbeat = setInterval(() => void saveBatch(payload), 60_000);
    try {
      for (const c of connections) {
        payload.message = `Обработано ${payload.completed} из ${payload.total}. Загружаем: ${c.city} · ${c.name}`;
        await saveBatch(payload);
        let result: string;
        try {
          const deadline = Date.now() + 3_600_000;
          let worker: Promise<void> | null = null;
          for (;;) {
            const current = await getConn(c.id);
            if (!connBusy(current)) {
              if (!current.club_id) throw new FbError("Выберите клуб в настройках студии.");
              try {
                worker = (await fbStartJob(c.id, action, { incrementalOnly: opts.incrementalOnly }))
                  .done;
              } catch (e) {
                if (!connBusy(await getConn(c.id))) throw e;
              }
              if (worker) break;
            }
            if (Date.now() >= deadline) {
              throw new FbError("Студия занята другой загрузкой более часа. Повторите позже.");
            }
            await sleep(2000);
          }
          await worker;
          const current = await getConn(c.id);
          if (current.sync_state !== "Обновление завершено") throw new FbError(current.sync_state);
          if (action !== "trials" && (current.attendance_state ?? "").includes("сопоставьте")) {
            throw new FbError(current.attendance_state);
          }
          result = `Загрузка завершена. ${current.attendance_state ?? ""}`;
        } catch (e) {
          payload.errors += 1;
          result = isTheirs(e)
            ? (e as Error).message
            : "Не удалось загрузить студию. Проверьте её статус.";
        }
        payload.results.push({ id: c.id, name: `${c.city} · ${c.name}`, message: result });
        payload.completed += 1;
        await saveBatch(payload);
      }
      payload.message = payload.errors
        ? `Обработано ${payload.completed} из ${payload.total}. Студий с ошибками: ${payload.errors}.`
        : `Все данные загружены: ${payload.total} студий.`;
    } catch {
      payload.message = "Общая загрузка остановлена из-за ошибки. Повторите запуск.";
    } finally {
      clearInterval(heartbeat);
      await saveBatch(payload, false);
    }
  })();
  return { done };
}

async function nightlyRow() {
  const { data, error } = await db()
    .from("an_fb_nightly")
    .select("last_run_day, error")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);
  return data as { last_run_day: string; error: string };
}

async function setNightlyError(text: string, current: string) {
  if (text === current) return;
  await db().from("an_fb_nightly").update({ error: text }).eq("id", 1);
}

/**
 * Их sync_due (раз в минуту): после 01:00 МСК, если сегодня ещё не
 * запускалась и есть студии с клубом. Пока идёт общая загрузка — их
 * сообщение «ожидает».
 */
export async function fbNightlyDue(): Promise<boolean> {
  const now = nowSec();
  const row = await nightlyRow();
  if (fbMskHour(now) < 1) {
    await setNightlyError("", row.error);
    return false;
  }
  const { count } = await db()
    .from("an_fb_connections")
    .select("id", { count: "exact", head: true })
    .neq("club_id", "");
  if (!count) return false;
  if (row.last_run_day >= fbDay(now)) {
    await setNightlyError("", row.error);
    return false;
  }
  const { data: batch } = await db()
    .from("an_fb_batch")
    .select("active, updated_at")
    .eq("id", 1)
    .single();
  if (batch?.active && Date.parse(batch.updated_at as string) >= Date.now() - 30 * 60_000) {
    await setNightlyError(
      "Ночная загрузка ожидает завершения текущей очереди. Повторная проверка через минуту.",
      row.error,
    );
    return false;
  }
  return true;
}

/** Задача «fitbase»: ночная загрузка всех студий — только изменения (их incremental_only). */
export async function fbNightlyRun(): Promise<JobResult> {
  const day = fbDay(nowSec());
  const row = await nightlyRow();
  try {
    void (await fbStartAll({ incrementalOnly: true })).done;
  } catch (e) {
    await setNightlyError(
      "Ночная загрузка не запущена. Повторная попытка через минуту.",
      row.error,
    );
    return { status: "error", message: (e as Error).message };
  }
  await db().from("an_fb_nightly").update({ last_run_day: day, error: "" }).eq("id", 1);
  return { status: "success", message: "Ночная загрузка всех студий запущена" };
}
