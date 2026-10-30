/**
 * Фоновые задачи «Аналитики» (ANALYTICS_PLAN.md, §7) — цикл этого же
 * процесса, раз в минуту. Одну задачу выполняет один процесс: аренда в базе
 * (an_job_claim / an_job_finish — сервер ходит в базу только через
 * PostgREST, блокировок сессии у него нет). Итог — an_job_state и журнал
 * an_job_runs (30 дней), их показывает «Фоновые задачи». Задачу с внешним
 * действием (AN_JOBS[key].external: Google-таблицы, Telegram, публикации VK)
 * сервер не запускает, пока её не включат: старый портал работает
 * параллельно и делает то же самое.
 *
 * ANALYTICS_JOBS=off (или PUSH_WORKER=off) — не выполнять задачи на этом
 * сервере: их можно вынести во второй контейнер того же образа.
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { jobEnabled } from "@/lib/analytics/jobs";
import { syncAllAmo } from "./amocrm.server";
import { syncAllAvito } from "./avito.server";
import { fbNightlyDue, fbNightlyRun } from "./fitbase.server";
import { deliverQuizLeads } from "./quiz.server";
import { syncAllVk } from "./vk-ads.server";
import { dispatchBudgetJob, evaluateBudgetAlerts } from "./vk-budget.server";
import { backfillLfMetrics, collectLf } from "./vk-lf.server";
import { syncAllSs } from "./vk-ss.server";

export type JobResult = {
  status: "success" | "partial" | "error";
  message: string;
  details?: Record<string, unknown>;
};

export type AnalyticsJob = {
  key: string;
  /** Как часто запускать. */
  everyMs: number;
  /** Только по событию (kickAnalyticsJob) и «Запустить»: по расписанию не запускается. */
  onDemand?: boolean;
  /** Пора ли запускать (проверка без аренды и журнала; по умолчанию — по everyMs). */
  isDue?: () => Promise<boolean>;
  /** На сколько занять задачу (секунды): дольше этого считается зависшей. */
  leaseSeconds: number;
  run: () => Promise<JobResult>;
};

const MINUTE = 60_000;

/**
 * Их sync_all: после сбора кабинетов — пересчёт предупреждений о бюджете и
 * их отправка партнёрам (отправка — своя задача «vk_budget_tg», внешняя:
 * только если её включили). Сбой предупреждений сбор не отменяет.
 */
async function syncVkWithBudget(): Promise<JobResult> {
  const result = await syncAllVk();
  try {
    const alerts = await evaluateBudgetAlerts();
    result.details = { ...result.details, budget_alerts: alerts };
    result.message += ` · предупреждений о бюджете: новых ${alerts.created}, снято ${alerts.resolved}`;
    const delivery = ANALYTICS_JOBS.find((j) => j.key === "vk_budget_tg");
    if (delivery && (await isJobEnabled(delivery.key))) await runJob(delivery);
  } catch (e) {
    result.details = { ...result.details, budget_alerts_error: (e as Error).message.slice(0, 200) };
    result.message += " · предупреждения о бюджете: ошибка";
    if (result.status === "success") result.status = "partial";
  }
  return result;
}

/** Задачи модулей добавляются сюда по мере переноса (подписи — AN_JOBS). */
export const ANALYTICS_JOBS: AnalyticsJob[] = [
  // Их lady-vk-ads.timer: раз в час; 200 кабинетов идут по очереди несколько
  // минут, аренда с запасом — второй запуск не начнётся, пока идёт первый.
  { key: "vk_ads", everyMs: 60 * MINUTE, leaseSeconds: 2 * 60 * 60, run: syncVkWithBudget },
  // Их dispatch_budget_alerts в конце sync_all: новые предупреждения о бюджете
  // — в Telegram-чаты партнёров (внешнее действие, выключена по умолчанию).
  // Запускает сбор VK Ads; своё расписание — запасное, раз в час.
  { key: "vk_budget_tg", everyMs: 60 * MINUTE, leaseSeconds: 30 * 60, run: dispatchBudgetJob },
  // Их lady-amocrm-marketing.timer: каждые 15 минут — изменённые сделки amoCRM
  // (только чтение; первый запуск подключения — полная сверка с 01.09.2026).
  { key: "amo", everyMs: 15 * MINUTE, leaseSeconds: 60 * 60, run: syncAllAmo },
  // Их lady-avito-ads.timer: раз в час — структура и статистика кампаний всех
  // кабинетов Авито за вчера по Москве (только чтение API).
  { key: "avito", everyMs: 60 * MINUTE, leaseSeconds: 60 * 60, run: syncAllAvito },
  // Их lady-community-messages.timer: раз в час — счётчики СС из Google-таблиц
  // (только чтение, без внешнего действия).
  { key: "vk_ss", everyMs: 60 * MINUTE, leaseSeconds: 30 * 60, run: syncAllSs },
  // Их lady-vk-ads-lead-forms.timer: каждые 5 минут — новые заявки ЛФ в
  // Google-таблицы кабинетов (внешнее действие, выключена по умолчанию).
  { key: "vk_lf", everyMs: 5 * MINUTE, leaseSeconds: 30 * 60, run: collectLf },
  // Их lady-vk-ads-lead-forms-backfill.timer: раз в час — заявки ЛФ текущего
  // месяца в счётчики реестра (только чтение VK).
  { key: "vk_lf_metrics", everyMs: 60 * MINUTE, leaseSeconds: 2 * 60 * 60, run: backfillLfMetrics },
  // Их quiz_leads.sync_pending: заявки квиза в Google-таблицы городов
  // (внешнее действие, выключена по умолчанию). Как у них — только сразу
  // после новой заявки (kickAnalyticsJob из приёма): неотправленные уходят
  // со следующей заявкой, повтора по расписанию нет (ANALYTICS_PLAN.md, §9).
  // Их FitBaseIntegration.sync_due: раз в минуту — после 01:00 МСК, если
  // сегодня ещё не запускалась, общая загрузка всех студий (только
  // изменения: их incremental_only). Только чтение FitBase.
  {
    key: "fitbase",
    everyMs: MINUTE,
    leaseSeconds: 10 * 60,
    isDue: fbNightlyDue,
    run: fbNightlyRun,
  },
  {
    key: "quiz_sheets",
    everyMs: 0,
    onDemand: true,
    leaseSeconds: 10 * 60,
    run: deliverQuizLeads,
  },
];

const g = globalThis as typeof globalThis & {
  __lsAnalyticsJobs?: { started: boolean; running: Set<string> };
};
const state = (g.__lsAnalyticsJobs ??= { started: false, running: new Set() });

export function startAnalyticsJobs() {
  if (
    state.started ||
    !hasSupabaseAdmin() ||
    process.env.ANALYTICS_JOBS === "off" ||
    process.env.PUSH_WORKER === "off"
  )
    return;
  state.started = true;
  setTimeout(() => void tick(), 30_000);
  setInterval(() => void tick(), MINUTE);
}

async function tick() {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from("an_job_state").select("job, enabled, last_started_at");
  if (error) {
    console.error("[analytics] задачи:", error.message);
    return;
  }
  const last = new Map(
    (data ?? []).map((r) => [
      r.job as string,
      { enabled: r.enabled as boolean, at: r.last_started_at as string | null },
    ]),
  );
  for (const job of ANALYTICS_JOBS) {
    if (job.onDemand) continue;
    const s = last.get(job.key);
    if (!jobEnabled(job.key, s)) continue;
    if (s?.at && Date.now() - new Date(s.at).getTime() < job.everyMs) continue;
    if (state.running.has(job.key)) continue;
    if (job.isDue) {
      try {
        if (!(await job.isDue())) continue;
      } catch (e) {
        console.error("[analytics] задача", job.key, (e as Error).message);
        continue;
      }
    }
    void runJob(job);
  }
}

/** Задачи, запущенные kickAnalyticsJob: true — пришло новое событие, пройти ещё раз. */
const kicks = new Map<string, boolean>();

/**
 * Выполнить задачу сейчас, если она включена и задачи выполняет этот сервер
 * (заявка квиза — в таблицу сразу после приёма). Событие во время запуска —
 * ещё один проход после него (заявка, пришедшая во время отправки
 * предыдущей, не ждёт следующей). Ошибки — в журнал задачи и лог.
 */
export async function kickAnalyticsJob(key: string): Promise<void> {
  if (
    !hasSupabaseAdmin() ||
    process.env.ANALYTICS_JOBS === "off" ||
    process.env.PUSH_WORKER === "off"
  )
    return;
  const job = ANALYTICS_JOBS.find((j) => j.key === key);
  if (!job) return;
  if (kicks.has(key)) {
    kicks.set(key, true);
    return;
  }
  kicks.set(key, false);
  try {
    do {
      kicks.set(key, false);
      if (!(await isJobEnabled(key))) break;
      await runJob(job);
    } while (kicks.get(key));
  } catch (e) {
    console.error("[analytics] задача", key, (e as Error).message);
  } finally {
    kicks.delete(key);
  }
}

/** Включена ли задача сейчас (строка состояния или правило по умолчанию). */
export async function isJobEnabled(key: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("an_job_state")
    .select("enabled")
    .eq("job", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return jobEnabled(key, (data as { enabled: boolean } | null) ?? undefined);
}

/**
 * Выполнить задачу сейчас, если её никто не выполняет («Запустить»). Строку
 * состояния без неё заводит an_job_claim включённой — поэтому выключенную по
 * умолчанию (внешнюю) задачу сюда не передавать: сначала isJobEnabled.
 */
export async function runJob(job: AnalyticsJob): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { data: claimed, error } = await admin.rpc("an_job_claim", {
    p_job: job.key,
    p_lease_seconds: job.leaseSeconds,
  });
  if (error || !claimed) return false;
  state.running.add(job.key);
  let result: JobResult;
  try {
    result = await job.run();
  } catch (e) {
    result = { status: "error", message: (e as Error).message };
  } finally {
    state.running.delete(job.key);
  }
  const { error: finishError } = await admin.rpc("an_job_finish", {
    p_job: job.key,
    p_status: result.status,
    p_message: result.message,
    p_details: result.details ?? {},
  });
  if (finishError) console.error("[analytics] итог задачи", job.key, finishError.message);
  if (result.status === "error") console.error("[analytics] задача", job.key, result.message);
  return true;
}
