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

export type JobResult = {
  status: "success" | "partial" | "error";
  message: string;
  details?: Record<string, unknown>;
};

export type AnalyticsJob = {
  key: string;
  /** Как часто запускать. */
  everyMs: number;
  /** На сколько занять задачу (секунды): дольше этого считается зависшей. */
  leaseSeconds: number;
  run: () => Promise<JobResult>;
};

const MINUTE = 60_000;

/** Задачи модулей добавляются сюда по мере переноса (подписи — AN_JOBS). */
export const ANALYTICS_JOBS: AnalyticsJob[] = [];

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
    const s = last.get(job.key);
    if (!jobEnabled(job.key, s)) continue;
    if (s?.at && Date.now() - new Date(s.at).getTime() < job.everyMs) continue;
    if (state.running.has(job.key)) continue;
    void runJob(job);
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
