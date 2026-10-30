/**
 * Квиз: приём заявки лендинга и её запись в Google-таблицу города — их
 * POST /api/quiz/leads (app.py) и quiz_leads.py. Заявка сначала
 * сохраняется в базе (an_quiz_lead_add), потом уходит в таблицу задачей
 * «quiz_sheets» сразу после приёма (их sync_pending в create): внешнее
 * действие, по умолчанию выключена (старый портал пишет в те же таблицы).
 * Схема — db/migrations/2026-10-30_zzzzzzzzzzzz_analytics_quiz.sql.
 */
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";

import {
  QUIZ_HEADERS,
  QUIZ_MAX_BYTES,
  QUIZ_TEXT,
  quizClean,
  quizLeadFromPayload,
  quizSheetRow,
  type QuizPendingLead,
} from "../quiz/rules";
import { sheetsClient, type SheetsClient } from "./google-sheets.server";
import type { JobResult } from "./jobs.server";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * Откуда можно прислать заявку: их проверка Origin (только свой лендинг).
 * Свой — адрес портала (ADMIN_APP_URL, лендинг — /quiz/<город>), отдельный
 * домен лендинга — ANALYTICS_QUIZ_ORIGINS (через запятую). Без ADMIN_APP_URL
 * (стенд) — адрес самого запроса.
 */
function allowedOrigins(request: Request): Set<string> {
  const list = new Set<string>();
  const add = (value: string | undefined) => {
    try {
      if (value) list.add(new URL(value.trim()).origin);
    } catch {
      // Неверный адрес в переменной — пропускаем.
    }
  };
  add(process.env.ADMIN_APP_URL || request.url);
  for (const o of (process.env.ANALYTICS_QUIZ_ORIGINS ?? "").split(",")) add(o);
  return list;
}

// Защита публичного адреса (у них её нет): не больше 10 заявок с одного
// адреса за 10 минут. Адрес — последний в X-Forwarded-For (его дописал
// прокси сервера; первые подставляет кто угодно).
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 10;
const recent = new Map<string, number[]>();

function clientAddress(request: Request): string {
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",");
  return forwarded[forwarded.length - 1]?.trim() || request.headers.get("x-real-ip") || "local";
}

function tooMany(address: string, now = Date.now()): boolean {
  const hits = (recent.get(address) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    recent.set(address, hits);
    return true;
  }
  hits.push(now);
  recent.set(address, hits);
  if (recent.size > 5000) {
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) recent.delete(key);
    }
  }
  return false;
}

/**
 * Их POST /api/quiz/leads: чужой Origin — 403; не JSON, пусто или больше
 * 20 000 байт, нет согласия, имени или телефона — 400 с их общим текстом;
 * сохранено — 201 {"ok": true, "leadId": N}. Запись в таблицу — следом
 * (`afterSave`, если задача включена), ответ её не ждёт.
 */
export async function handleQuizLead(
  request: Request,
  afterSave: () => void = () => {},
): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (origin && !allowedOrigins(request).has(origin)) {
    return json({ ok: false, error: QUIZ_TEXT.forbidden }, 403);
  }
  if (tooMany(clientAddress(request))) {
    return json({ ok: false, error: QUIZ_TEXT.rejected }, 429);
  }
  let lead;
  try {
    const length = Number(request.headers.get("content-length") ?? "0");
    const type = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!(length > 0 && length <= QUIZ_MAX_BYTES) || !type.includes("application/json")) {
      throw new Error(QUIZ_TEXT.badRequest);
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).length > QUIZ_MAX_BYTES) {
      throw new Error(QUIZ_TEXT.badRequest);
    }
    lead = quizLeadFromPayload(JSON.parse(body));
  } catch (e) {
    console.log(`Quiz lead rejected: ${(e as Error).message}`);
    return json({ ok: false, error: QUIZ_TEXT.rejected }, 400);
  }
  const { data, error } = await getSupabaseAdmin().rpc("an_quiz_lead_add", {
    p_city: lead.city,
    p_name: lead.name,
    p_phone: lead.phone,
    p_recommendation: lead.recommendation,
    p_pain: lead.pain,
    p_duration: lead.duration,
    p_barrier: lead.barrier,
    p_utm: lead.utm,
    p_consent_at: lead.consentAt,
  });
  if (error) {
    console.error(`Quiz lead not saved: ${error.message}`);
    return json({ ok: false, error: QUIZ_TEXT.rejected }, error.code === "22023" ? 400 : 500);
  }
  console.log(`Quiz lead created: city=${lead.city}, lead_id=${String(data)}`);
  afterSave();
  return json({ ok: true, leadId: Number(data) }, 201);
}

async function mark(id: number, error: string | null) {
  // Не записанный итог вернул бы заявку в очередь — строка ушла бы дважды.
  for (let attempt = 0; ; attempt++) {
    const { error: e } = await getSupabaseAdmin().rpc("an_quiz_mark", {
      p_id: id,
      p_error: error,
    });
    if (!e) return;
    if (attempt >= 2) throw new Error(e.message);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Их sync_pending: неотправленные заявки по порядку (до 100). Таблица
 * города — один раз за запуск: нет листа — переименовать первый, строка
 * заголовков A1:P1; затем строка заявки в конец листа. Ошибка — их
 * sheet_error у заявки и конец запуска (следующие ждут, как у них).
 */
export async function deliverQuizLeads(): Promise<JobResult> {
  const { data, error } = await getSupabaseAdmin().rpc("an_quiz_pending", { p_limit: 100 });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as QuizPendingLead[];
  if (!rows.length) return { status: "success", message: "Новых заявок нет" };
  let sheets: SheetsClient | null = null;
  const ready = new Set<string>();
  let delivered = 0;
  for (const row of rows) {
    try {
      const id = row.spreadsheet_id;
      const sheet = row.sheet_name ?? "";
      if (!id || !sheet) throw new Error(QUIZ_TEXT.noSheet(row.city));
      sheets ??= await sheetsClient();
      if (!ready.has(row.city)) {
        const meta = await sheets.metadata(id);
        if (!meta.sheets.includes(sheet)) await sheets.renameFirstSheet(id, sheet);
        await sheets.replace(id, `${sheet}!A1:P1`, [QUIZ_HEADERS]);
        ready.add(row.city);
      }
      await sheets.append(id, sheet, [quizSheetRow(row)]);
      await mark(row.id, null);
      delivered += 1;
    } catch (e) {
      const message = quizClean((e as Error).message, 240);
      await mark(row.id, message).catch(() => {});
      return {
        status: delivered ? "partial" : "error",
        message: `Отправлено заявок: ${delivered}. Заявка №${row.id} (${row.city}): ${message}`,
        details: { delivered, failed_id: row.id },
      };
    }
  }
  return {
    status: "success",
    message: `Отправлено заявок: ${delivered}`,
    details: { delivered },
  };
}
