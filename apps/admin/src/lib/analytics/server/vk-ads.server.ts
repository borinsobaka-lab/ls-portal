/**
 * VK Ads — сбор из API (их vk_ads.py: `sync_account`, `sync_all`): у каждого
 * активного кабинета — остаток (снимок раз в час), все кампании (страницы по
 * 200), лид-формы и их кампании (расход ЛФ — по прямой связи), дневная
 * статистика кампаний пачками по 100 с повторами при 429 / 5xx. Только
 * чтение API; ключи — an_secrets. Пишет сервисным ключом в an_vk_*.
 *
 * Задача «vk_ads» (jobs.server.ts) — раз в час, как их lady-vk-ads.timer;
 * «Ключ и загрузка» на странице кабинетов — тот же сбор за выбранный период.
 */
import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  VK_LEAD_FORMS_PATH,
  VK_PLANS_MAX_OFFSET,
  VK_PLANS_PAGE,
  VK_PLANS_PAGE_PAUSE_MS,
  VK_STATS_BATCH,
  VK_STATS_MAX_ATTEMPTS,
  VK_STATS_PAUSE_MS,
  VK_USER_AGENT,
  vkChunks,
  vkDecimal,
  vkDiagnostic,
  vkFormPlanIds,
  vkIsObject,
  vkItems,
  vkPlansPath,
  vkRetryDelayMs,
  vkStatRows,
  vkStatsPath,
  vkStr,
  vkTransient,
  vkUrl,
  vkYesterdayUtc,
} from "../vk/api";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Другой адрес API — только для проверки на тестовом стенде (VK_ADS_API_ORIGIN). */
const origin = () => process.env.VK_ADS_API_ORIGIN?.replace(/\/+$/, "") || undefined;
export const db = () => getSupabaseAdmin();

export async function must<T>(
  q: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}

/** Их _request: [HTTP-код, JSON]; сеть и таймаут — [0, {error}]. */
export async function vkRequest(token: string, path: string): Promise<[number, unknown]> {
  let res: Response;
  try {
    res = await fetch(vkUrl(path, origin()), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": VK_USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const name = (e as Error).name === "TimeoutError" ? "TimeoutError" : "URLError";
    return [0, { error: name }];
  }
  const body = await res.text();
  if (res.ok) {
    // У них json.loads ответа 200 без JSON — исключение и ошибка сбора.
    return [res.status, JSON.parse(body) as unknown];
  }
  try {
    return [res.status, JSON.parse(body) as unknown];
  } catch {
    return [res.status, { error: "non_json_response" }];
  }
}

async function vkRequestWithRetry(token: string, path: string): Promise<[number, unknown, number]> {
  let status = 0;
  let payload: unknown = { error: "request_not_started" };
  for (let attempt = 1; attempt <= VK_STATS_MAX_ATTEMPTS; attempt++) {
    [status, payload] = await vkRequest(token, path);
    if (!vkTransient(status)) return [status, payload, attempt];
    if (attempt < VK_STATS_MAX_ATTEMPTS) await sleep(vkRetryDelayMs(attempt));
  }
  return [status, payload, VK_STATS_MAX_ATTEMPTS];
}

/** Их _raw: ответ с ошибкой — в диагностику; успешные не хранятся. */
export async function saveRaw(
  accountId: number,
  runId: number,
  resource: string,
  status: number,
  payload: unknown,
): Promise<number | null> {
  if (status >= 200 && status < 300) return null;
  const text = vkDiagnostic(payload);
  const row = await must(
    db()
      .from("an_vk_raw_responses")
      .insert({
        account_id: accountId,
        sync_run_id: runId,
        resource,
        http_status: status,
        payload_sha256: createHash("sha256").update(text).digest("hex"),
        payload_json: text,
      })
      .select("id")
      .single(),
  );
  return (row as { id: number }).id;
}

/** Их _save_lead_forms: формы и их кампании (ответы заявок не хранятся). */
export async function saveLeadForms(
  accountId: number,
  forms: unknown[],
): Promise<[number, number]> {
  const now = new Date().toISOString();
  await must(db().from("an_vk_lead_form_links").delete().eq("account_id", accountId));
  const formRows: Record<string, unknown>[] = [];
  const linkRows: Record<string, unknown>[] = [];
  for (const form of forms) {
    if (!vkIsObject(form)) continue;
    const formId = vkStr(form.id ?? "").trim();
    if (!formId) continue;
    const name = vkStr(form.name || form.title || "").slice(0, 500);
    const status = vkStr(form.status || form.state || "").slice(0, 100);
    formRows.push({
      account_id: accountId,
      vk_form_id: formId,
      name,
      status,
      payload: form,
      updated_at: now,
    });
    for (const planId of vkFormPlanIds(form)) {
      linkRows.push({ account_id: accountId, vk_form_id: formId, vk_plan_id: planId });
    }
  }
  // Одна форма дважды в ответе — последняя версия (их ON CONFLICT … DO UPDATE).
  const uniqueForms = [...new Map(formRows.map((r) => [r.vk_form_id, r])).values()];
  const uniqueLinks = [
    ...new Map(linkRows.map((r) => [`${r.vk_form_id}\u0000${r.vk_plan_id}`, r])).values(),
  ];
  for (const part of vkChunks(uniqueForms, 200)) {
    await must(db().from("an_vk_lead_forms").upsert(part, { onConflict: "account_id,vk_form_id" }));
  }
  for (const part of vkChunks(uniqueLinks, 1000)) {
    await must(db().from("an_vk_lead_form_links").insert(part));
  }
  return [formRows.length, linkRows.length];
}

export type VkSyncResult = {
  campaigns: number;
  rows: number;
  status: "success" | "partial";
  failed_batches: number;
  lead_form_links: string;
};

/**
 * Их sync_account: остаток, кампании, лид-формы, статистика за период
 * (по умолчанию — вчера по UTC, как у них на сервере). Ошибка — исключение,
 * кабинету — отметка «ошибка HTTP …» (401) или 0.
 */
export async function syncVkAccount(
  accountId: number,
  from?: string,
  to?: string,
): Promise<VkSyncResult> {
  const statFrom = from ?? vkYesterdayUtc();
  const statTo = to ?? statFrom;
  if (statTo < statFrom)
    throw new Error("Дата окончания периода не может быть раньше даты начала.");
  const account = await must(
    db()
      .from("an_vk_accounts")
      .select("id")
      .eq("id", accountId)
      .eq("is_active", true)
      .maybeSingle(),
  );
  const token = account
    ? await readSecret({ kind: "vk_ads", ref: String(accountId), name: "token" })
    : null;
  if (!account || !token) throw new Error("Активный кабинет с ключом не найден.");
  const startedAt = new Date().toISOString();
  const run = (await must(
    db()
      .from("an_vk_sync_runs")
      .insert({
        account_id: accountId,
        resource: "daily_sync",
        started_at: startedAt,
        status: "running",
      })
      .select("id")
      .single(),
  )) as { id: number };
  try {
    const [balanceStatus, balance] = await vkRequest(token, "/user/account.json");
    const balanceRaw = await saveRaw(accountId, run.id, "user/account", balanceStatus, balance);
    if (balanceStatus !== 200 || !vkIsObject(balance)) {
      throw new Error(`Баланс VK Ads не получен: HTTP ${balanceStatus}`);
    }
    await must(
      db()
        .from("an_vk_balances")
        .insert({
          account_id: accountId,
          measured_at: startedAt,
          balance: vkDecimal(balance.balance ?? null),
          r_balance: vkDecimal(balance.r_balance ?? ""),
          currency_balance_hold: vkDecimal(balance.currency_balance_hold ?? ""),
          currency: vkStr(balance.currency ?? ""),
          raw_response_id: balanceRaw,
        }),
    );

    // Кампаний больше 200 — следующие страницы: их расход есть в статистике.
    const plans: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let finished = false;
    for (let offset = 0; offset < VK_PLANS_MAX_OFFSET; offset += VK_PLANS_PAGE) {
      const [planStatus, page] = await vkRequest(token, vkPlansPath(offset));
      await saveRaw(accountId, run.id, `ad_plans:offset=${offset}`, planStatus, page);
      if (planStatus !== 200 || !vkIsObject(page)) {
        throw new Error(`Кампании VK Ads не получены: HTTP ${planStatus}`);
      }
      const items = vkItems(page);
      if (!Array.isArray(items)) throw new Error("VK Ads вернул кампании в неожиданном формате.");
      let pageNew = 0;
      for (const plan of items) {
        if (!vkIsObject(plan)) continue;
        const id = vkStr(plan.id ?? "");
        if (id && !seen.has(id)) {
          seen.add(id);
          plans.push(plan);
          pageNew++;
        }
      }
      if (items.length < VK_PLANS_PAGE) {
        finished = true;
        break;
      }
      if (pageNew === 0) {
        throw new Error(
          "VK Ads повторил страницу кампаний; сбор остановлен, чтобы не потерять расходы.",
        );
      }
      await sleep(VK_PLANS_PAGE_PAUSE_MS);
    }
    if (!finished) {
      throw new Error("Слишком много страниц кампаний VK Ads; сбор остановлен безопасно.");
    }
    const planIds: string[] = [];
    const planRows: Record<string, unknown>[] = [];
    for (const plan of plans) {
      const id = vkStr(plan.id ?? "");
      if (!id) continue;
      planIds.push(id);
      planRows.push({
        account_id: accountId,
        vk_plan_id: id,
        name: vkStr(plan.name ?? ""),
        payload: plan,
        fetched_at: startedAt,
      });
    }
    for (const part of vkChunks(planRows, 500)) {
      await must(db().from("an_vk_ad_plans").upsert(part, { onConflict: "account_id,vk_plan_id" }));
    }

    // Связи ЛФ — вместе с кампаниями; отказ этого метода сбор не останавливает
    // (последние верные связи остаются).
    let leadNote = "not_available";
    try {
      const [formsStatus, formsPayload] = await vkRequest(token, VK_LEAD_FORMS_PATH);
      const formsRaw = await saveRaw(accountId, run.id, "lead_forms", formsStatus, formsPayload);
      const forms = vkIsObject(formsPayload) ? vkItems(formsPayload, ["items", "data"]) : [];
      if (formsStatus === 200 && Array.isArray(forms)) {
        const [saved, links] = await saveLeadForms(accountId, forms);
        leadNote = `forms=${saved},links=${links},raw=${formsRaw === null ? "None" : formsRaw}`;
      } else {
        leadNote = `HTTP${formsStatus}`;
      }
    } catch (e) {
      leadNote = `error=${(e as Error).message.slice(0, 100)}`;
    }

    let rowsSaved = 0;
    const failed: string[] = [];
    const batches = vkChunks(planIds, VK_STATS_BATCH);
    for (let n = 0; n < batches.length; n++) {
      const [statsStatus, stats, attempts] = await vkRequestWithRetry(
        token,
        vkStatsPath(statFrom, statTo, batches[n]),
      );
      const statsRaw = await saveRaw(
        accountId,
        run.id,
        "daily_campaign_statistics",
        statsStatus,
        stats,
      );
      if (statsStatus !== 200 || !vkIsObject(stats)) {
        failed.push(`${n + 1}:HTTP${statsStatus}:attempts=${attempts}`);
      } else {
        const now = new Date().toISOString();
        const rows = vkStatRows(stats, statFrom).map((r) => ({
          ...r,
          account_id: accountId,
          raw_response_id: statsRaw,
          updated_at: now,
        }));
        const unique = [
          ...new Map(rows.map((r) => [`${r.vk_plan_id}\u0000${r.stat_date}`, r])).values(),
        ];
        for (const part of vkChunks(unique, 1000)) {
          await must(
            db()
              .from("an_vk_daily_stats")
              .upsert(part, { onConflict: "account_id,vk_plan_id,stat_date" }),
          );
        }
        rowsSaved += rows.length;
      }
      if (n < batches.length - 1) await sleep(VK_STATS_PAUSE_MS);
    }
    await must(
      db()
        .from("an_vk_accounts")
        .update({ last_verified_at: startedAt, last_verification_status: 200 })
        .eq("id", accountId),
    );
    const status = failed.length ? "partial" : "success";
    const details =
      `period=${statFrom}:${statTo}, campaigns=${planIds.length}, batches=${batches.length}, ` +
      `rows=${rowsSaved}, lead_form_links=${leadNote}, failed_batches=${failed.join("|") || "none"}`;
    await must(
      db()
        .from("an_vk_sync_runs")
        .update({ finished_at: new Date().toISOString(), status, http_status: 200, details })
        .eq("id", run.id),
    );
    return {
      campaigns: planIds.length,
      rows: rowsSaved,
      status,
      failed_batches: failed.length,
      lead_form_links: leadNote,
    };
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    const now = new Date().toISOString();
    await db()
      .from("an_vk_accounts")
      .update({
        last_verified_at: now,
        last_verification_status: message.includes("HTTP 401") ? 401 : 0,
      })
      .eq("id", accountId);
    await db()
      .from("an_vk_sync_runs")
      .update({ finished_at: now, status: "error", details: message })
      .eq("id", run.id);
    throw e;
  }
}

/**
 * Их sync_all: все активные кабинеты по очереди (бренд, город, название),
 * ошибка одного не останавливает остальные.
 */
export async function syncAllVk(): Promise<JobResult> {
  const accounts = (await must(
    db().from("an_vk_accounts").select("id, name, brand, city, is_active").eq("is_active", true),
  )) as { id: number; name: string; brand: string; city: string }[];
  const byte = (s: string) => Buffer.from(s, "utf8");
  accounts.sort(
    (a, b) =>
      Buffer.compare(byte(a.brand), byte(b.brand)) ||
      Buffer.compare(byte(a.city), byte(b.city)) ||
      Buffer.compare(byte(a.name), byte(b.name)) ||
      a.id - b.id,
  );
  let success = 0;
  let partial = 0;
  const errors: { account_id: number; name: string; error: string }[] = [];
  for (const a of accounts) {
    try {
      const r = await syncVkAccount(a.id);
      if (r.status === "partial") partial++;
      else success++;
    } catch (e) {
      errors.push({ account_id: a.id, name: a.name, error: (e as Error).message.slice(0, 200) });
    }
  }
  const status: JobResult["status"] =
    accounts.length && errors.length === accounts.length
      ? "error"
      : errors.length || partial
        ? "partial"
        : "success";
  return {
    status,
    message: `Кабинетов: ${accounts.length} · загружено: ${success} · частично: ${partial} · ошибок: ${errors.length}`,
    details: { errors: errors.slice(0, 50) },
  };
}
