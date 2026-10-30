/**
 * Авито Реклама — сбор из API (их avito_ads.py: `_access_token`,
 * `_request_json`, `check_account`, `sync_structure`,
 * `sync_campaign_statistics`, `sync_history`, `sync_all_campaign_statistics`).
 * Только чтение API: токен по client_credentials, кампании / группы /
 * креативы (первая страница, 100 — как у них), дневная статистика кампаний.
 * Ключи — an_secrets (kind 'avito', ref = id кабинета). Пишет сервисным
 * ключом: итог проверки, структуру и статистику — RPC an_avito_*_store.
 *
 * Задача «avito» (jobs.server.ts) — раз в час, как их lady-avito-ads.timer
 * (`avito_ads_collector.py --all`: вчера по Москве, все кабинеты).
 * ANALYTICS_AVITO_ORIGIN — другой адрес API только для тестового стенда.
 */
import { mskToday } from "../core";
import {
  AVITO_API_PATH,
  AVITO_ENTITY_TYPES,
  AVITO_LIST_BODY,
  AVITO_MAX_DAYS,
  AVITO_TEXT,
  AVITO_TIMEOUT_MS,
  AVITO_TOKEN_PATH,
  addDaysIso,
  avitoEntityRow,
  avitoHistoryChunks,
  avitoHistoryStart,
  avitoList,
  avitoStatsFor,
  daysBetween,
  type AvitoEntityRow,
  type AvitoEntityType,
  type AvitoStatRow,
} from "../avito/rules";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";

const origin = () =>
  process.env.ANALYTICS_AVITO_ORIGIN?.replace(/\/+$/, "") || "https://api.avito.ru";

export const avitoKey = (id: number, name: "client_id" | "client_secret") => ({
  kind: "avito",
  ref: String(id),
  name,
});

/** Их RuntimeError: сеть и таймаут — проверка не выполнена. */
class AvitoNetworkError extends Error {}

/** Их _access_token: client_credentials. */
async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(origin() + AVITO_TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(AVITO_TIMEOUT_MS),
    });
  } catch {
    throw new AvitoNetworkError(AVITO_TEXT.network);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(AVITO_TEXT.tokenHttp(res.status));
  }
  const payload = (await res.json()) as Record<string, unknown> | null;
  const token = payload?.access_token ? String(payload.access_token) : "";
  if (!token) throw new Error(AVITO_TEXT.noToken);
  return token;
}

/** Их _request_json: [HTTP-код, JSON]; ошибка без JSON — {message: начало ответа}. */
async function requestJson(
  path: string,
  token: string,
  body?: unknown,
): Promise<[number, unknown]> {
  let res: Response;
  try {
    res = await fetch(origin() + AVITO_API_PATH + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(AVITO_TIMEOUT_MS),
    });
  } catch {
    throw new AvitoNetworkError(AVITO_TEXT.network);
  }
  const raw = await res.text();
  if (res.ok) return [res.status, raw ? (JSON.parse(raw) as unknown) : {}];
  const head = raw.slice(0, 1000);
  try {
    return [res.status, head ? (JSON.parse(head) as unknown) : {}];
  } catch {
    return [res.status, { message: head }];
  }
}

type Account = { id: number; name: string; avito_account_id: string; city: string; brand: string };

async function account(id: number): Promise<Account> {
  const row = (await must(
    db()
      .from("an_avito_accounts")
      .select("id, name, avito_account_id, city, brand")
      .eq("id", id)
      .maybeSingle(),
  )) as Account | null;
  if (!row) throw new Error(AVITO_TEXT.notFound);
  return row;
}

/** Токен кабинета: ключи из an_secrets (нет ключей — как «не найден»). */
async function accountToken(a: Account): Promise<string> {
  const clientId = await readSecret(avitoKey(a.id, "client_id"));
  const clientSecret = await readSecret(avitoKey(a.id, "client_secret"));
  if (!clientId || !clientSecret) throw new Error(AVITO_TEXT.notFound);
  return accessToken(clientId, clientSecret);
}

/**
 * Их check_account: токен, аккаунт и по первой странице кампаний, групп и
 * креативов; итог (код и число записей) пишется и при ошибке.
 */
export async function checkAvitoAccount(id: number): Promise<Record<string, number>> {
  const a = await account(id);
  let status = 0;
  const summary: Record<string, { total: number }> = {};
  try {
    const token = await accountToken(a);
    const [accountStatus] = await requestJson(`/account/${a.avito_account_id}`, token);
    status = accountStatus;
    if (status !== 200) throw new Error(AVITO_TEXT.accountHttp(status));
    for (const resource of AVITO_ENTITY_TYPES) {
      const [code, payload] = await requestJson(
        `/account/${a.avito_account_id}/${resource}`,
        token,
        AVITO_LIST_BODY,
      );
      if (code !== 200) throw new Error(AVITO_TEXT.listHttp(resource, code));
      summary[resource] = { total: avitoList(resource, payload).total };
    }
    status = 200;
    return Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.total]));
  } finally {
    await must(
      db().rpc("an_avito_check_store", { p_id: id, p_status: status, p_summary: summary }),
    );
  }
}

/** Их sync_structure: кампании, группы, креативы — одной записью (ошибка — ничего). */
export async function syncAvitoStructure(id: number): Promise<Record<string, number>> {
  const a = await account(id);
  const token = await accountToken(a);
  const totals: Record<string, number> = {};
  const items: AvitoEntityRow[] = [];
  for (const type of AVITO_ENTITY_TYPES) {
    const [code, payload] = await requestJson(
      `/account/${a.avito_account_id}/${type}`,
      token,
      AVITO_LIST_BODY,
    );
    if (code !== 200) throw new Error(AVITO_TEXT.listHttp(type, code));
    const list = avitoList(type as AvitoEntityType, payload);
    if (!Array.isArray(list.items)) throw new Error(AVITO_TEXT.listFormat(type));
    totals[type] = list.total;
    for (const item of list.items) {
      const row = avitoEntityRow(type, item);
      if (row) items.push(row);
    }
  }
  await must(db().rpc("an_avito_structure_store", { p_id: id, p_items: items }));
  return totals;
}

/** Их sync_campaign_statistics: структура, затем статистика каждой кампании за период. */
export async function syncAvitoStats(id: number, from: string, to: string): Promise<number> {
  if (to < from) throw new Error(AVITO_TEXT.reversed);
  if (daysBetween(from, to) > AVITO_MAX_DAYS) throw new Error(AVITO_TEXT.tooLong);
  await syncAvitoStructure(id);
  const a = await account(id);
  const campaigns = (await must(
    db()
      .from("an_avito_entities")
      .select("entity_id")
      .eq("account_id", id)
      .eq("entity_type", "campaigns"),
  )) as { entity_id: string }[];
  const token = await accountToken(a);
  const rows: AvitoStatRow[] = [];
  for (const c of campaigns) {
    const [code, payload] = await requestJson(
      `/account/${a.avito_account_id}/campaigns/${c.entity_id}/stats`,
      token,
      { dateFrom: from, dateTo: to },
    );
    if (code !== 200) throw new Error(AVITO_TEXT.statsHttp(c.entity_id, code));
    rows.push(...avitoStatsFor(c.entity_id, payload));
  }
  await must(db().rpc("an_avito_stats_store", { p_id: id, p_rows: rows }));
  return rows.length;
}

/** Их sync_history: от самого раннего старта кампаний по дату, блоками по 100 дней. */
export async function syncAvitoHistory(
  id: number,
  to: string,
): Promise<{ from: string; saved: number }> {
  await syncAvitoStructure(id);
  const starts = (await must(
    db()
      .from("an_avito_entities")
      .select("start_date")
      .eq("account_id", id)
      .eq("entity_type", "campaigns"),
  )) as { start_date: string | null }[];
  const from = avitoHistoryStart(
    starts.map((s) => s.start_date),
    new Date().toISOString().slice(0, 10),
  );
  if (to < from) throw new Error(AVITO_TEXT.historyReversed);
  let saved = 0;
  for (const [chunkFrom, chunkTo] of avitoHistoryChunks(from, to)) {
    saved += await syncAvitoStats(id, chunkFrom, chunkTo);
  }
  return { from, saved };
}

/** Их avito_ads_collector.py --all: вчера по Москве, все кабинеты по очереди. */
export async function syncAllAvito(): Promise<JobResult> {
  const day = addDaysIso(mskToday(), -1);
  const accounts = (await must(
    db().from("an_avito_accounts").select("id, city, brand").order("brand").order("city"),
  )) as { id: number; city: string; brand: string }[];
  let rows = 0;
  const errors: { account_id: number; city: string; error: string }[] = [];
  for (const a of accounts) {
    try {
      rows += await syncAvitoStats(a.id, day, day);
    } catch (e) {
      errors.push({ account_id: a.id, city: a.city, error: (e as Error).message.slice(0, 200) });
    }
  }
  return {
    status:
      accounts.length && errors.length === accounts.length
        ? "error"
        : errors.length
          ? "partial"
          : "success",
    message: `Кабинетов: ${accounts.length} · день ${day} · строк статистики: ${rows} · ошибок: ${errors.length}`,
    details: { day, errors },
  };
}
