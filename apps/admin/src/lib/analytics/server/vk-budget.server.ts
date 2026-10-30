/**
 * VK Ads — «Контроль бюджетов» (их vk_ads.py: `evaluate_budget_alerts`,
 * `dispatch_budget_alerts`, `_telegram_api`, `telegram_chat_candidates`):
 * прогноз остатка кабинетов по средним тратам за 7 полных дней, уровни
 * предупреждений и отправка новых предупреждений в Telegram-чат партнёра
 * кабинета. Расчёт — `lib/analytics/vk/budget.ts` (их Decimal), запись —
 * RPC an_vk_budget_apply одной транзакцией.
 *
 * Telegram — как у них: через Cloudflare-шлюз (адрес и секрет сохранены —
 * POST {шлюз}/{метод} с Bearer-секретом; с сервера в России api.telegram.org
 * может быть недоступен), иначе напрямую с токеном бота. Токен и секрет —
 * an_secrets (kind 'telegram', ref 'bot'). ANALYTICS_TELEGRAM_ORIGIN —
 * другой адрес API только для тестового стенда.
 */
import { vkYesterdayUtc } from "../vk/api";
import {
  budgetAlertText,
  budgetVerdict,
  tgChatsFromUpdates,
  type BudgetSettings,
  type BudgetStage,
  type TgChat,
} from "../vk/budget";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";

export const TG_TOKEN = { kind: "telegram", ref: "bot", name: "token" };
export const TG_GATEWAY_SECRET = { kind: "telegram", ref: "bot", name: "gateway_secret" };

const TG_USER_AGENT = "LadyStretch-BudgetMonitor/1.0";
const tgOrigin = () =>
  process.env.ANALYTICS_TELEGRAM_ORIGIN?.replace(/\/+$/, "") || "https://api.telegram.org";

export type TgSettingsRow = {
  bot_username: string;
  test_chat_id: string;
  gateway_url: string;
};

export async function tgSettingsRow(): Promise<TgSettingsRow> {
  const row = (await must(
    db()
      .from("an_tg_settings")
      .select("bot_username, test_chat_id, gateway_url")
      .eq("id", true)
      .maybeSingle(),
  )) as TgSettingsRow | null;
  return row ?? { bot_username: "", test_chat_id: "", gateway_url: "" };
}

/** Их _telegram_api: шлюз, если сохранены адрес и секрет, иначе — напрямую. */
export async function tgApi(
  method: string,
  payload: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const settings = await tgSettingsRow();
  const secret = settings.gateway_url ? await readSecret(TG_GATEWAY_SECRET) : null;
  const viaGateway = Boolean(settings.gateway_url && secret);
  const token = viaGateway ? null : await readSecret(TG_TOKEN);
  if (!viaGateway && !token) throw new Error("Сначала сохраните токен Telegram-бота.");
  const url = viaGateway
    ? `${settings.gateway_url.replace(/\/+$/, "")}/${method}`
    : `${tgOrigin()}/bot${token}/${method}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": TG_USER_AGENT,
  };
  if (viaGateway) headers.Authorization = `Bearer ${secret}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(payload).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Не удалось подключиться к Telegram.");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as unknown;
      detail =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? String((parsed as Record<string, unknown>).description ?? "")
          : text.trim();
    } catch {
      detail = text.trim();
    }
    throw new Error(`Telegram не принял запрос: ${detail || `HTTP ${res.status}`}`);
  }
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Telegram не принял запрос: ответ не в формате JSON");
  }
  if (!result || typeof result !== "object" || !result.ok) {
    throw new Error(
      `Telegram не принял запрос: ${String(result?.description ?? "неизвестная ошибка")}`,
    );
  }
  return result;
}

/** Их telegram_chat_candidates: чаты, которые писали боту (getUpdates). */
export async function tgChatCandidates(): Promise<TgChat[]> {
  const r = await tgApi("getUpdates", { limit: "100", timeout: "0" });
  return tgChatsFromUpdates(r.result);
}

export async function tgSendMessage(chatId: string, text: string): Promise<void> {
  await tgApi("sendMessage", { chat_id: chatId, text });
}

// --- Предупреждения ------------------------------------------------------------------

const shiftDate = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type BudgetEvaluation = { created: number; resolved: number; skipped: number };

/**
 * Их evaluate_budget_alerts: период — 7 дней по `reference` (по умолчанию
 * вчера по UTC, как сбор VK Ads), у каждого активного кабинета — уровень по
 * последнему остатку; без остатка или с неполной неделей статистики —
 * пропуск.
 */
export async function evaluateBudgetAlerts(reference?: string): Promise<BudgetEvaluation> {
  const end = reference ?? vkYesterdayUtc();
  const start = shiftDate(end, -6);
  const settings = (await must(
    db()
      .from("an_vk_budget_settings")
      .select("is_enabled, warning_days, critical_days, target_days")
      .eq("id", true)
      .maybeSingle(),
  )) as (BudgetSettings & { is_enabled: boolean }) | null;
  if (!settings?.is_enabled) return { created: 0, resolved: 0, skipped: 0 };
  const inputs = (await must(db().rpc("an_vk_budget_inputs", { p_start: start, p_end: end }))) as {
    account_id: number;
    balance: string | null;
    spent: number;
    days: number;
  }[];
  let skipped = 0;
  const rows: Record<string, unknown>[] = [];
  for (const input of inputs ?? []) {
    const v = budgetVerdict(
      { balance: input.balance, spent: Number(input.spent), days: Number(input.days) },
      settings,
    );
    if (v.kind === "skip") skipped++;
    else if (v.kind === "alert") {
      rows.push({
        account_id: input.account_id,
        kind: v.kind,
        stage: v.stage,
        balance: v.balance.toString(),
        average: v.average.toString(),
        forecast: v.forecast.toString(),
        recommended: v.recommended.toString(),
      });
    } else rows.push({ account_id: input.account_id, kind: v.kind });
  }
  const applied = (await must(
    db().rpc("an_vk_budget_apply", { p_start: start, p_end: end, p_rows: rows }),
  )) as { created: number; resolved: number };
  return { created: applied.created, resolved: applied.resolved, skipped };
}

type PendingDelivery = {
  alert_id: number;
  stage: BudgetStage;
  balance: string;
  average_daily_spend: string;
  forecast_days: string;
  recommended_topup: string;
  name: string;
  city: string;
  partner_name: string;
  channel_id: number;
  chat_id: string;
};

/**
 * Их dispatch_budget_alerts: каждое новое активное предупреждение — один раз
 * в чат партнёра кабинета; ошибка отправки записывается и не повторяется.
 */
export async function dispatchBudgetAlerts(): Promise<{ sent: number; failed: number }> {
  const rows = (await must(db().rpc("an_vk_budget_pending"))) as PendingDelivery[];
  let sent = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    let status: "sent" | "error" = "sent";
    let details = "";
    try {
      await tgSendMessage(row.chat_id, budgetAlertText(row));
      sent++;
    } catch (e) {
      status = "error";
      details = (e as Error).message.slice(0, 300);
      failed++;
    }
    await must(
      db()
        .from("an_vk_budget_deliveries")
        .upsert(
          { alert_id: row.alert_id, channel_id: row.channel_id, status, details },
          { onConflict: "alert_id,channel_id", ignoreDuplicates: true },
        ),
    );
  }
  return { sent, failed };
}

/** Задача «vk_budget_tg» (внешняя): отправка партнёрам после сбора VK Ads. */
export async function dispatchBudgetJob(): Promise<JobResult> {
  const r = await dispatchBudgetAlerts();
  return {
    status: r.failed ? (r.sent ? "partial" : "error") : "success",
    message: `Отправлено в Telegram: ${r.sent} · ошибок: ${r.failed}`,
    details: r,
  };
}
