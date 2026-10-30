/**
 * VK Ads — сбор лид-форм (их lead_forms_collector.py и
 * vk_ads.discover_pilot_lead_forms): у кабинета с таблицей — только новые
 * заявки (после старта сбора), зашифрованно в базе, затем строками A–W в его
 * Google-таблицу; счётчик заявок ЛФ дня — для реестра таргета. Отдельно —
 * пересчёт счётчиков текущего месяца по всем кабинетам (только чтение VK),
 * создание таблиц кабинетов в папке Google Drive, проверки их «VK Ads Panel».
 * Содержимое заявок не пишется ни в журнал, ни в итоги задач.
 *
 * Задачи (jobs.server.ts): «vk_lf» — раз в 5 минут (их
 * lady-vk-ads-lead-forms.timer; запись в Google-таблицы — внешнее действие,
 * выключена, пока её не включат), «vk_lf_metrics» — раз в час (их
 * lady-vk-ads-lead-forms-backfill.timer).
 */
import { createHash } from "node:crypto";

import { mskToday } from "../core";
import { VK_LEAD_FORMS_PATH, vkIsObject, vkItems } from "../vk/api";
import {
  LF_DEFAULT_SHEET,
  LF_HEADERS,
  LF_PAGE_SIZE,
  lfDateFields,
  lfEpoch,
  lfJson,
  lfLeadsPath,
  lfRow,
  lfSheetTitle,
  lfStatDate,
  pyStr,
  type LfRecord,
} from "../vk/lf";
import { driveCreateSpreadsheet, driveRefreshToken } from "./google-drive.server";
import { sheetsClient, type SheetsClient } from "./google-sheets.server";
import type { JobResult } from "./jobs.server";
import { decryptSecret, encryptSecret, readSecret } from "./secrets.server";
import { db, must, saveLeadForms, saveRaw, vkRequest } from "./vk-ads.server";

type Account = {
  id: number;
  name: string;
  vk_account_id: string;
  city: string;
  partner_name: string;
  created_at?: string;
};
type Source = {
  account_id: number;
  spreadsheet_id: string;
  sheet_name: string;
  starts_at: string;
  account: Account;
  token: string;
};

const ACCOUNT_COLUMNS = "id, name, vk_account_id, city, partner_name";
const tokenOf = (id: number) => readSecret({ kind: "vk_ads", ref: String(id), name: "token" });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Их ORDER BY a.city, a.name. */
const byCityName = (a: Account, b: Account) => cmp(a.city, b.city) || cmp(a.name, b.name);

/** Кабинеты по id (одним запросом). */
async function accountsById(ids: number[]): Promise<Map<number, Account & { is_active: boolean }>> {
  if (!ids.length) return new Map();
  const rows = (await must(
    db().from("an_vk_accounts").select(`${ACCOUNT_COLUMNS}, is_active`).in("id", ids),
  )) as (Account & { is_active: boolean })[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Их discover_pilot_lead_forms: список лид-форм кабинета (без заявок). */
export async function discoverLeadForms(account: Account, token: string) {
  const run = (await must(
    db()
      .from("an_vk_sync_runs")
      .insert({ account_id: account.id, resource: "lead_forms_pilot", status: "running" })
      .select("id")
      .single(),
  )) as { id: number };
  try {
    const [status, payload] = await vkRequest(token, VK_LEAD_FORMS_PATH);
    const rawId = await saveRaw(account.id, run.id, "lead_forms", status, payload);
    if (status !== 200 || !vkIsObject(payload)) {
      throw new Error(`Список лид-форм VK Ads не получен: HTTP ${status}`);
    }
    const items = vkItems(payload, ["items", "data"]);
    const forms = Array.isArray(items) ? items : [];
    const [saved, links] = await saveLeadForms(account.id, forms);
    await must(
      db()
        .from("an_vk_sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "success",
          http_status: status,
          details: `forms_returned=${forms.length}, forms_saved=${saved}, links_saved=${links}, raw_response_id=${rawId ?? "None"}`,
        })
        .eq("id", run.id),
    );
    return { forms_returned: forms.length, forms_saved: saved, links_saved: links };
  } catch (e) {
    await db()
      .from("an_vk_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error",
        details: (e as Error).message.slice(0, 500),
      })
      .eq("id", run.id);
    throw e;
  }
}

async function formsOf(accountId: number): Promise<{ vk_form_id: string; name: string }[]> {
  return (await must(
    db().from("an_vk_lead_forms").select("vk_form_id, name").eq("account_id", accountId),
  )) as { vk_form_id: string; name: string }[];
}

/** Страница заявок формы: [список, ошибка?] — их _request без повторов. */
async function leadsPage(
  token: string,
  formId: string,
  offset: number,
  limit = LF_PAGE_SIZE,
): Promise<Record<string, unknown>[] | null> {
  const [status, payload] = await vkRequest(token, lfLeadsPath(formId, limit, offset));
  if (status !== 200 || !vkIsObject(payload)) return null;
  const items = vkItems(payload, ["items", "data"]);
  if (!Array.isArray(items)) return null;
  return items as Record<string, unknown>[];
}

/** Их _store_new_lead (пачкой): новые заявки и счётчик дня. */
async function storeLeads(
  accountId: number,
  leads: Record<string, unknown>[],
  updateMetrics: boolean,
): Promise<number> {
  const entries = [];
  for (const lead of leads) {
    const leadId = pyStr("id" in lead ? lead.id : "").trim();
    const formId = pyStr("form_id" in lead ? lead.form_id : "").trim();
    if (!leadId || !formId) continue;
    const raw = lfJson(lead);
    entries.push({
      lead_id: leadId,
      form_id: formId,
      created_at_vk: pyStr("created_at" in lead ? lead.created_at : ""),
      ad_plan_id: pyStr("ad_plan_id" in lead ? lead.ad_plan_id : ""),
      ad_group_id: pyStr("ad_group_id" in lead ? lead.ad_group_id : ""),
      banner_id: pyStr("banner_id" in lead ? lead.banner_id : ""),
      encrypted_payload: encryptSecret(raw),
      payload_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      stat_date: lfStatDate(lead.created_at),
    });
  }
  if (!entries.length) return 0;
  return (await must(
    db().rpc("an_vk_lf_store", {
      p_account: accountId,
      p_leads: entries,
      p_update_metrics: updateMetrics,
    }),
  )) as number;
}

type Submission = {
  id: number;
  vk_form_id: string;
  vk_lead_id: string;
  created_at_vk: string;
  ad_plan_id: string;
  ad_group_id: string;
  banner_id: string;
  encrypted_payload: string;
  received_at: string;
};

/** Их _pending_rows: ждущие записи (и с ошибкой) — строки A–W. */
async function pendingRows(account: Account, limit = 100) {
  const records = (await must(
    db()
      .from("an_vk_lf_submissions")
      .select(
        "id, vk_form_id, vk_lead_id, created_at_vk, ad_plan_id, ad_group_id, banner_id, encrypted_payload, received_at",
      )
      .eq("account_id", account.id)
      .in("sheet_status", ["pending", "error"])
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit),
  )) as Submission[];
  const names = new Map((await formsOf(account.id)).map((f) => [f.vk_form_id, f.name]));
  const rows = records.map((r) => {
    const lead = JSON.parse(decryptSecret(r.encrypted_payload)) as Record<string, unknown>;
    const rec: LfRecord = {
      vk_lead_id: r.vk_lead_id,
      vk_account_id: account.vk_account_id,
      ad_plan_id: r.ad_plan_id,
      ad_group_id: r.ad_group_id,
      banner_id: r.banner_id,
      vk_form_id: r.vk_form_id,
      form_name: names.get(r.vk_form_id) ?? null,
      account_name: account.name,
      city: account.city,
      partner_name: account.partner_name,
      created_at_vk: r.created_at_vk,
      received_at: Math.floor(new Date(r.received_at).getTime() / 1000),
    };
    return lfRow(rec, lead);
  });
  return { records, rows };
}

/** Их collection_sources: включённые таблицы активных кабинетов с ключом. */
async function lfSources(): Promise<Source[]> {
  const rows = (await must(
    db()
      .from("an_vk_lf_sources")
      .select("account_id, spreadsheet_id, sheet_name, starts_at")
      .eq("is_enabled", true),
  )) as Omit<Source, "token" | "account">[];
  const accounts = await accountsById(rows.map((r) => r.account_id));
  const out: Source[] = [];
  for (const r of rows) {
    const account = accounts.get(r.account_id);
    if (!account?.is_active) continue;
    const token = await tokenOf(r.account_id);
    if (token) out.push({ ...r, account, token });
  }
  return out.sort((a, b) => byCityName(a.account, b.account));
}

export type LfAccountResult = {
  account: string;
  forms_checked: number;
  leads_seen: number;
  new_saved: number;
  sheet_sent: number;
  failed_forms: number;
  status: "success" | "partial" | "error";
  error?: string;
};

/** Их _collect_one: новые заявки кабинета → база → его Google-таблица. */
async function collectOne(
  src: Source,
  sheets: () => Promise<SheetsClient>,
): Promise<LfAccountResult> {
  const account = src.account;
  await discoverLeadForms(account, src.token);
  const forms = await formsOf(account.id);
  const cutoff = Math.floor(new Date(src.starts_at).getTime() / 1000);
  let fetched = 0;
  let saved = 0;
  let failed = 0;
  for (const form of forms) {
    let offset = 0;
    for (;;) {
      const items = await leadsPage(src.token, form.vk_form_id, offset);
      if (!items) {
        failed++;
        break;
      }
      const fresh: Record<string, unknown>[] = [];
      for (const lead of items) {
        if (!vkIsObject(lead)) continue;
        fetched++;
        // VK отдаёт сначала новые; старт сбора отсекает историю.
        if (lfEpoch(lead.created_at) < cutoff) continue;
        fresh.push(lead);
      }
      saved += await storeLeads(account.id, fresh, true);
      if (items.length < LF_PAGE_SIZE || fresh.length === 0) break;
      offset += LF_PAGE_SIZE;
    }
  }
  const { records, rows } = await pendingRows(account);
  let sent = 0;
  if (rows.length) {
    const ids = records.map((r) => r.id);
    try {
      await (await sheets()).append(src.spreadsheet_id, src.sheet_name, rows);
      await must(
        db()
          .from("an_vk_lf_submissions")
          .update({
            sheet_status: "sent",
            sheet_error: "",
            sheet_sent_at: new Date().toISOString(),
          })
          .in("id", ids),
      );
      sent = ids.length;
    } catch (e) {
      await db()
        .from("an_vk_lf_submissions")
        .update({ sheet_status: "error", sheet_error: (e as Error).message.slice(0, 300) })
        .eq("account_id", account.id)
        .in("sheet_status", ["pending", "error"]);
    }
  }
  return {
    account: account.name,
    forms_checked: forms.length,
    leads_seen: fetched,
    new_saved: saved,
    sheet_sent: sent,
    failed_forms: failed,
    status: failed ? "partial" : "success",
  };
}

/** Клиент таблиц — один на запуск и только если есть что записать. */
function lazySheets() {
  let client: Promise<SheetsClient> | null = null;
  return () => (client ??= sheetsClient());
}

/** Их collect: все включённые таблицы; ошибка кабинета не останавливает остальные. */
export async function collectLf(): Promise<JobResult> {
  const sources = await lfSources();
  if (!sources.length) return { status: "error", message: "Сбор новых лидов ещё не запущен." };
  const sheets = lazySheets();
  const results: LfAccountResult[] = [];
  for (const src of sources) {
    try {
      results.push(await collectOne(src, sheets));
    } catch (e) {
      results.push({
        account: src.account.name,
        forms_checked: 0,
        leads_seen: 0,
        new_saved: 0,
        sheet_sent: 0,
        failed_forms: 1,
        status: "error",
        error: (e as Error).message.slice(0, 200),
      });
    }
  }
  const sum = (k: keyof LfAccountResult) => results.reduce((n, r) => n + Number(r[k]), 0);
  const failed = sum("failed_forms");
  return {
    status: failed ? "partial" : "success",
    message:
      `Кабинетов: ${results.length} · форм: ${sum("forms_checked")} · новых заявок: ${sum("new_saved")}` +
      ` · записано в таблицы: ${sum("sheet_sent")} · ошибок форм: ${failed}`,
    details: { results },
  };
}

/** Их collect_account: обычный сбор одного кабинета (кнопка панели). */
export async function collectLfAccount(accountId: number): Promise<LfAccountResult> {
  const src = (await lfSources()).find((s) => s.account_id === accountId);
  if (!src) throw new Error("Для этого кабинета не найдена включённая таблица лид-форм.");
  return collectOne(src, lazySheets());
}

async function activeAccounts(): Promise<(Account & { token: string })[]> {
  const rows = (await must(
    db().from("an_vk_accounts").select(ACCOUNT_COLUMNS).eq("is_active", true).order("id"),
  )) as Account[];
  const out: (Account & { token: string })[] = [];
  for (const a of rows) {
    const token = await tokenOf(a.id);
    if (token) out.push({ ...a, token });
  }
  return out;
}

/**
 * Их backfill_current_month_metrics: заявки ЛФ текущего месяца (МСК) по всем
 * кабинетам — в счётчики реестра, без записи в таблицы. Кабинет с ошибкой VK
 * пропускается (остаётся прошлый полный итог); счётчик дня не уменьшается.
 */
export async function backfillLfMetrics(): Promise<JobResult> {
  const today = mskToday();
  const start = `${today.slice(0, 8)}01`;
  const accounts = await activeAccounts();
  let forms = 0;
  let applications = 0;
  let failed = 0;
  let accountsFailed = 0;
  for (const account of accounts) {
    try {
      await discoverLeadForms(account, account.token);
      const seen = new Set<string>();
      const known = new Map<string, string>();
      let accountFailed = false;
      for (const form of await formsOf(account.id)) {
        forms++;
        let offset = 0;
        for (;;) {
          const items = await leadsPage(account.token, form.vk_form_id, offset);
          if (!items) {
            failed++;
            accountFailed = true;
            break;
          }
          let current = false;
          for (const lead of items) {
            if (!vkIsObject(lead)) continue;
            const id = pyStr("id" in lead ? lead.id : "").trim();
            if (!id || seen.has(id)) continue;
            const day = lfStatDate(lead.created_at);
            if (!day) continue;
            seen.add(id);
            if (day >= start && day <= today) {
              known.set(id, day);
              current = true;
            }
          }
          if (items.length < LF_PAGE_SIZE || !current) break;
          offset += LF_PAGE_SIZE;
        }
      }
      if (accountFailed) {
        accountsFailed++;
        continue;
      }
      // Сохранённые сборщиком заявки периода — тоже в счёт (их merge_preserved_lf_metrics).
      const stored = (await must(
        db()
          .from("an_vk_lf_submissions")
          .select("vk_lead_id, created_at_vk")
          .eq("account_id", account.id),
      )) as { vk_lead_id: string; created_at_vk: string }[];
      for (const s of stored) {
        const day = lfStatDate(s.created_at_vk);
        if (day && day >= start && day <= today) known.set(s.vk_lead_id, day);
      }
      const total = (await must(
        db().rpc("an_vk_lf_merge_metrics", {
          p_account: account.id,
          p_start: start,
          p_end: today,
          p_leads: [...known].map(([lead_id, stat_date]) => ({ lead_id, stat_date })),
        }),
      )) as number;
      applications += Number(total);
    } catch {
      failed++;
      accountsFailed++;
    }
  }
  return {
    status: failed ? "partial" : "success",
    message:
      `Период ${start}—${today} · кабинетов: ${accounts.length} · форм: ${forms}` +
      ` · заявок ЛФ: ${applications} · кабинетов с ошибкой: ${accountsFailed}`,
  };
}

/** Их activate_account: таблица кабинета — лист, старт сбора «сейчас», шапка A–W. */
export async function activateLfAccount(
  accountId: number,
  spreadsheetId: string,
  sheetName = LF_DEFAULT_SHEET,
  sheets?: SheetsClient,
) {
  const client = sheets ?? (await sheetsClient());
  const name = sheetName.trim() || LF_DEFAULT_SHEET;
  const meta = await client.metadata(spreadsheetId);
  if (!meta.sheets.includes(name)) await client.renameFirstSheet(spreadsheetId, name);
  const account = await must(
    db()
      .from("an_vk_accounts")
      .select("id, name")
      .eq("id", accountId)
      .eq("is_active", true)
      .maybeSingle(),
  );
  if (!account) throw new Error("Активный кабинет VK Ads не найден.");
  const now = new Date().toISOString();
  await must(
    db().from("an_vk_lf_sources").upsert(
      {
        account_id: accountId,
        spreadsheet_id: spreadsheetId,
        sheet_name: name,
        starts_at: now,
        is_enabled: true,
        updated_at: now,
      },
      { onConflict: "account_id" },
    ),
  );
  await client.replace(spreadsheetId, `${name}!A1:W1`, [LF_HEADERS]);
}

/**
 * Их lead-forms/create: таблица на каждый активный кабинет без таблицы в
 * папке Drive (её владелец — подключённый Google-аккаунт; папка открыта
 * сервисному аккаунту редактором). Существующие таблицы не заменяются.
 */
export async function createLfSheets(folderId: string): Promise<string[]> {
  const refresh = await driveRefreshToken();
  const withSource = new Set(
    (
      (await must(db().from("an_vk_lf_sources").select("account_id"))) as { account_id: number }[]
    ).map((r) => r.account_id),
  );
  const accounts = (
    (await must(
      db().from("an_vk_accounts").select(ACCOUNT_COLUMNS).eq("is_active", true),
    )) as Account[]
  ).filter((a) => !withSource.has(a.id));
  const sheets = await sheetsClient();
  const created: string[] = [];
  for (const a of accounts) {
    const id = await driveCreateSpreadsheet(refresh, folderId, lfSheetTitle(a.city, a.name));
    await activateLfAccount(a.id, id, LF_DEFAULT_SHEET, sheets);
    created.push(a.name);
  }
  await must(
    db()
      .from("an_google_settings")
      .upsert(
        { id: true, drive_folder_id: folderId, drive_updated_at: new Date().toISOString() },
        { onConflict: "id" },
      ),
  );
  return created;
}

/** Их «Проверить Google Таблицу»: доступ к таблице каждого кабинета, без записи. */
export async function verifyLfSheets() {
  const sources = (await must(
    db().from("an_vk_lf_sources").select("account_id, spreadsheet_id, sheet_name"),
  )) as { account_id: number; spreadsheet_id: string; sheet_name: string }[];
  const accounts = await accountsById(sources.map((r) => r.account_id));
  const rows = sources.flatMap((r) => {
    const account = accounts.get(r.account_id);
    return account ? [{ ...r, account }] : [];
  });
  const sheets = await sheetsClient();
  const out: { account: string; city: string; ok: boolean; text: string }[] = [];
  for (const r of rows.sort((a, b) => byCityName(a.account, b.account))) {
    try {
      const meta = await sheets.metadata(r.spreadsheet_id);
      const ok = meta.sheets.includes(r.sheet_name);
      out.push({
        account: r.account.name,
        city: r.account.city,
        ok,
        text: ok
          ? `«${meta.title}», лист «${r.sheet_name}»`
          : `«${meta.title}»: листа «${r.sheet_name}» нет (листы: ${meta.sheets.join(", ")})`,
      });
    } catch (e) {
      out.push({
        account: r.account.name,
        city: r.account.city,
        ok: false,
        text: (e as Error).message,
      });
    }
  }
  return out;
}

/** Их audit_date_fields: какие поля даты VK отдаёт по ЛФ города — без данных людей. */
export async function auditLfDates(city: string) {
  const norm = (v: string) =>
    v
      .replace(/\u00a0/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .join("");
  const all = await activeAccounts();
  let accounts = all.filter((a) => norm(a.city) === norm(city));
  const matched = accounts.length > 0;
  if (!matched) accounts = all.slice(0, 3);
  const samples: string[] = [];
  const fields = new Set<string>();
  let checked = 0;
  for (const a of accounts) {
    await discoverLeadForms(a, a.token);
    const forms = (await formsOf(a.id)).slice(0, 3);
    for (const f of forms) {
      const items = await leadsPage(a.token, f.vk_form_id, 0, 5);
      if (!items) continue;
      for (const lead of items) {
        if (!vkIsObject(lead)) continue;
        checked++;
        for (const k of lfDateFields(lead)) fields.add(k);
        const raw = lead.created_at;
        if (raw !== null && raw !== undefined && raw !== "" && samples.length < 12)
          samples.push(pyStr(raw));
      }
    }
  }
  return {
    requested_city: city,
    city_matched: matched,
    accounts: accounts.length,
    lead_samples: checked,
    date_fields: [...fields].sort(),
    created_at_samples: samples,
  };
}
