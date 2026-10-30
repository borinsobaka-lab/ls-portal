import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ANALYTICS_JOBS, isJobEnabled, runJob } from "./server/jobs.server";
import { secretsReady } from "./server/secrets.server";

/**
 * «Аналитика» → «Фоновые задачи» (ANALYTICS_PLAN.md, §7): настройки сервера
 * и ручной запуск задач. Только администратору аналитики (an_me от имени
 * вызывающего).
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

export type AnalyticsConfig = {
  /** Задан ли ANALYTICS_SECRETS_KEY (шифрование ключей интеграций). */
  secretsKeySet: boolean;
  /** Выполняет ли этот сервер фоновые задачи (ANALYTICS_JOBS / PUSH_WORKER). */
  jobsOn: boolean;
};

export const getAnalyticsConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AnalyticsConfig> => {
    await requireAnAdmin(context.supabase);
    return {
      secretsKeySet: secretsReady(),
      jobsOn: process.env.ANALYTICS_JOBS !== "off" && process.env.PUSH_WORKER !== "off",
    };
  });

export const runAnalyticsJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ key: z.string().min(1).max(80) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const job = ANALYTICS_JOBS.find((j) => j.key === data.key);
    if (!job) throw new Error("Задача не найдена");
    if (!(await isJobEnabled(job.key))) throw new Error("Задача выключена — сначала включите её");
    const started = await runJob(job);
    if (!started) throw new Error("Задача уже выполняется — подождите её окончания");
    return { ok: true };
  });
