/**
 * amoCRM — подключение и сбор сделок (их amocrm.py: `_api_get`,
 * `verify_connection`, `fetch_metadata`, `sync_connection`, `sync_all`).
 * Только чтение amoCRM: справочники и маркетинговые поля сделок (без
 * контактов клиентов). Токен — an_secrets (kind 'amocrm', ref = id
 * подключения). Пишет сервисным ключом в an_amo_*; запись сделок, этапы и
 * версии для срезов — RPC an_amo_store_leads.
 *
 * Задача «amo» (jobs.server.ts) — раз в 15 минут, как их
 * lady-amocrm-marketing.timer: изменённые сделки с перекрытием 15 минут.
 * ANALYTICS_AMOCRM_ORIGIN — другой адрес API только для тестового стенда
 * (настоящий адрес подключения уходит заголовком X-Amo-Base).
 */
import {
  AMO_MAX_PAGES,
  AMO_OVERLAP,
  AMO_PAGE,
  AMO_START,
  AMO_USER_AGENT,
  amoLeadRow,
  amoLeadsPath,
  amoMetadata,
  amoPipelineKey,
  amoSyncDetails,
  amoUtmFieldIds,
  type AmoField,
  type AmoLeadRow,
  type AmoResponsible,
  type AmoSettings,
  type AmoSyncContext,
} from "../amo/rules";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";

export const amoToken = (id: number) => ({ kind: "amocrm", ref: String(id), name: "token" });

const origin = () => process.env.ANALYTICS_AMOCRM_ORIGIN?.replace(/\/+$/, "") || undefined;

/** Их _api_get: [HTTP-код, JSON]; 204 — пусто; сеть и таймаут — ошибка. */
export async function amoGet(
  baseUrl: string,
  token: string,
  path: string,
): Promise<[number, Record<string, unknown>]> {
  const stand = origin();
  let res: Response;
  try {
    res = await fetch((stand ?? baseUrl) + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": AMO_USER_AGENT,
        ...(stand ? { "X-Amo-Base": baseUrl } : {}),
      },
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error(
      "AmoCRM не ответила за 25 секунд. Подождите 2–3 минуты и повторите обновление.",
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return [res.status, { error: "http_error" }];
  }
  if (res.status === 204) return [204, {}];
  const raw = await res.text();
  try {
    const payload = JSON.parse(raw) as unknown;
    return [res.status, (payload ?? {}) as Record<string, unknown>];
  } catch {
    throw new Error(`AmoCRM вернула некорректный JSON (HTTP ${res.status}).`);
  }
}

type Connection = { id: number; base_url: string; is_active: boolean };

async function connectionWithToken(id: number): Promise<Connection & { token: string }> {
  const row = (await must(
    db().from("an_amo_connections").select("id, base_url, is_active").eq("id", id).maybeSingle(),
  )) as Connection | null;
  const token = row ? await readSecret(amoToken(id)) : null;
  if (!row || !token) throw new Error("Подключение AmoCRM не найдено.");
  return { ...row, token };
}

/** Их verify_connection: /api/v4/account; итог проверки — у подключения. */
export async function verifyAmo(id: number): Promise<string> {
  const c = await connectionWithToken(id);
  const [status, payload] = await amoGet(c.base_url, c.token, "/api/v4/account");
  const name =
    typeof payload.name === "string" ? payload.name : payload.name ? String(payload.name) : "";
  await must(
    db()
      .from("an_amo_connections")
      .update({
        last_verified_at: new Date().toISOString(),
        last_verification_status: status,
        last_verification_details:
          status === 200 ? name.slice(0, 200) : "Токен или доступ AmoCRM не подтверждён.",
      })
      .eq("id", id),
  );
  if (status !== 200) {
    throw new Error(`AmoCRM вернула HTTP ${status}. Проверьте токен и выданные права.`);
  }
  return name || "Подключение подтверждено";
}

/** Их fetch_metadata: воронки, поля сделки и пользователи (без данных клиентов). */
export async function fetchAmoMetadata(id: number): Promise<[number, number, number]> {
  const c = await connectionWithToken(id);
  const [ps, pp] = await amoGet(c.base_url, c.token, "/api/v4/leads/pipelines?limit=250");
  const [fs, fp] = await amoGet(c.base_url, c.token, "/api/v4/leads/custom_fields?limit=250");
  const [us, up] = await amoGet(c.base_url, c.token, "/api/v4/users?limit=250");
  const failed = [ps, fs, us].find((s) => s !== 200);
  if (failed !== undefined) {
    throw new Error(`AmoCRM вернула HTTP ${failed} при загрузке настроек.`);
  }
  const meta = amoMetadata(pp, fp, up);
  await must(
    db().from("an_amo_metadata").upsert(
      {
        connection_id: id,
        pipelines: meta.pipelines,
        lead_fields: meta.fields,
        users: meta.users,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "connection_id" },
    ),
  );
  return [meta.pipelines.length, meta.fields.length, meta.users.length];
}

/** Их _lead_pages: страницы по 250 до неполной (204 — пусто). */
async function leadPages(
  c: Connection & { token: string },
  filter: "updated" | "created",
  from: number,
): Promise<Record<string, unknown>[]> {
  const leads: Record<string, unknown>[] = [];
  for (let page = 1; page <= AMO_MAX_PAGES; page++) {
    const [status, payload] = await amoGet(c.base_url, c.token, amoLeadsPath(filter, from, page));
    if (status === 204) return leads;
    if (status !== 200) throw new Error(`AmoCRM вернула HTTP ${status} при загрузке сделок.`);
    const emb = payload._embedded as Record<string, unknown> | undefined;
    const batch = emb && typeof emb === "object" ? (emb.leads ?? []) : [];
    if (!Array.isArray(batch)) throw new Error("AmoCRM вернула неожиданный формат сделок.");
    for (const lead of batch) {
      if (lead && typeof lead === "object" && !Array.isArray(lead)) {
        leads.push(lead as Record<string, unknown>);
      }
    }
    if (batch.length < AMO_PAGE) return leads;
  }
  throw new Error("Слишком много страниц сделок за один запуск. Повторите синхронизацию позже.");
}

/** Их _configured_connection + справочники для разбора сделок. */
async function syncContext(id: number) {
  const c = await connectionWithToken(id).catch(() => null);
  if (!c || !c.is_active) throw new Error("Активное подключение AmoCRM не найдено.");
  const settings = (await must(
    db()
      .from("an_amo_settings")
      .select(
        "new_lead_pipeline_id, auto_source_field_id, manual_source_field_id, booked_field_id, attended_field_id, paid_field_id, close_basis_field_id",
      )
      .eq("connection_id", id)
      .maybeSingle(),
  )) as AmoSettings | null;
  if (!settings) {
    throw new Error("Сначала сохраните правила маркетинговой аналитики для этого подключения.");
  }
  return { c, settings };
}

async function contextMaps(id: number, settings: AmoSettings): Promise<AmoSyncContext> {
  const [meta, responsibles, pipelines, basis] = await Promise.all([
    must(db().from("an_amo_metadata").select("lead_fields").eq("connection_id", id).maybeSingle()),
    must(
      db()
        .from("an_amo_responsibles")
        .select("amo_user_id, amo_user_name, brand, city, partner_name")
        .eq("connection_id", id),
    ),
    must(db().from("an_amo_pipeline_brands").select("pipeline_id, brand").eq("connection_id", id)),
    must(
      db()
        .from("an_amo_basis")
        .select("field_value_id")
        .eq("connection_id", id)
        .eq("is_unqualified", true),
    ),
  ]);
  const fields = ((meta as { lead_fields: AmoField[] } | null)?.lead_fields ?? []) as AmoField[];
  return {
    settings,
    utm: amoUtmFieldIds(Array.isArray(fields) ? fields : []),
    responsibles: new Map(
      (responsibles as (AmoResponsible & { amo_user_id: string })[]).map((r) => [r.amo_user_id, r]),
    ),
    pipelineBrands: new Map(
      (pipelines as { pipeline_id: string; brand: string }[]).map((p) => [p.pipeline_id, p.brand]),
    ),
    unqualified: new Set((basis as { field_value_id: string }[]).map((b) => b.field_value_id)),
  };
}

export type AmoSyncMode = "manual" | "full" | "scheduled";
export type AmoSyncResult = { received: number; saved: number; details: string };

/** Начать сверку: проверки и отметка «идёт» (ошибки — сразу вызывающему). */
export async function beginAmoSync(id: number, mode: AmoSyncMode) {
  await must(db().rpc("an_amo_freeze_snapshots"));
  const { c, settings } = await syncContext(id);
  const run = (await must(
    db().rpc("an_amo_sync_begin", { p_connection: id, p_mode: mode }),
  )) as number;
  return { c, settings, run };
}

/** Их sync_connection после отметки «идёт»: сделки, запись, итог. */
export async function runAmoSync(
  id: number,
  mode: AmoSyncMode,
  started: Awaited<ReturnType<typeof beginAmoSync>>,
): Promise<AmoSyncResult> {
  const { c, settings, run } = started;
  let received = 0;
  let saved = 0;
  try {
    const state = (await must(
      db()
        .from("an_amo_sync_state")
        .select("last_success_at")
        .eq("connection_id", id)
        .maybeSingle(),
    )) as { last_success_at: string | null } | null;
    const since = state?.last_success_at ? Math.floor(Date.parse(state.last_success_at) / 1000) : 0;
    const incremental = !!since && mode !== "full";
    const leads = incremental
      ? await leadPages(c, "updated", Math.max(AMO_START, since - AMO_OVERLAP))
      : await leadPages(c, "created", AMO_START);
    received = leads.length;
    const ctx = await contextMaps(id, settings);
    const pipelines = new Map<string, number>();
    let before = 0;
    let invalid = 0;
    const rows: AmoLeadRow[] = [];
    for (const lead of leads) {
      const key = amoPipelineKey(lead);
      pipelines.set(key, (pipelines.get(key) ?? 0) + 1);
      const out = amoLeadRow(lead, ctx);
      if (out.kind === "invalid") invalid++;
      else if (out.kind === "before") before++;
      else rows.push(out.row);
    }
    let other = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const r = (await must(
        db().rpc("an_amo_store_leads", {
          p_connection: id,
          p_pipeline: settings.new_lead_pipeline_id,
          p_rows: rows.slice(i, i + 500),
        }),
      )) as { saved: number; skipped_other: number };
      saved += r.saved;
      other += r.skipped_other;
    }
    const details = amoSyncDetails({
      kind: incremental ? "incremental" : "full",
      expected: settings.new_lead_pipeline_id,
      pipelines,
      other,
      before,
      invalid,
    });
    await finish(id, run, "success", received, saved, details);
    return { received, saved, details };
  } catch (e) {
    await finish(id, run, "error", received, saved, (e as Error).message).catch(() => undefined);
    throw e;
  }
}

async function finish(
  id: number,
  run: number,
  status: "success" | "error",
  received: number,
  saved: number,
  details: string,
) {
  await must(
    db().rpc("an_amo_sync_finish", {
      p_connection: id,
      p_run: run,
      p_status: status,
      p_received: received,
      p_saved: saved,
      p_details: details,
    }),
  );
}

export async function syncAmo(id: number, mode: AmoSyncMode): Promise<AmoSyncResult> {
  return runAmoSync(id, mode, await beginAmoSync(id, mode));
}

/** Их sync_all: все подключения с правилами по очереди; ошибка одного — не всем. */
export async function syncAllAmo(): Promise<JobResult> {
  const ids = (
    (await must(db().from("an_amo_settings").select("connection_id").order("connection_id"))) as {
      connection_id: number;
    }[]
  ).map((r) => r.connection_id);
  let ok = 0;
  let received = 0;
  let saved = 0;
  const errors: { connection_id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      const r = await syncAmo(id, "scheduled");
      ok++;
      received += r.received;
      saved += r.saved;
    } catch (e) {
      errors.push({ connection_id: id, error: (e as Error).message.slice(0, 200) });
    }
  }
  return {
    status:
      ids.length && errors.length === ids.length ? "error" : errors.length ? "partial" : "success",
    message: `Подключений: ${ids.length} · обновлено: ${ok} · сделок получено: ${received}, сохранено: ${saved} · ошибок: ${errors.length}`,
    details: { errors },
  };
}
