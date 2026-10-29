import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ANALYTICS_JOBS, runJob } from "./server/jobs.server";
import { replicaSecret } from "./server/replica.server";
import { replicaPublicKeyPem, secretsReady } from "./server/secrets.server";

/**
 * «Аналитика» → «Синхронизация» (ANALYTICS_PLAN.md, §3): настройки приёма
 * со старого портала и ручной запуск фоновых задач. Только администратору
 * аналитики (an_me от имени вызывающего).
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

export type ReplicaConfig = {
  /** Куда агент шлёт пачки. */
  endpoint: string;
  /** Задан ли ANALYTICS_REPLICA_SECRET (подпись пачек). */
  secretSet: boolean;
  /** Задан ли ANALYTICS_SECRETS_KEY (шифрование ключей интеграций). */
  secretsKeySet: boolean;
  /** Открытый ключ для установщика агента (PEM); null — не задан закрытый. */
  publicKeyPem: string | null;
};

export const getReplicaConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReplicaConfig> => {
    await requireAnAdmin(context.supabase);
    const base = (process.env.ADMIN_APP_URL ?? "").replace(/\/+$/, "");
    let publicKeyPem: string | null = null;
    try {
      publicKeyPem = replicaPublicKeyPem();
    } catch {
      publicKeyPem = null;
    }
    return {
      endpoint: `${base}/api/analytics/replica`,
      secretSet: replicaSecret() !== null,
      secretsKeySet: secretsReady(),
      publicKeyPem,
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
    const started = await runJob(job);
    if (!started) throw new Error("Задача уже выполняется — подождите её окончания");
    return { ok: true };
  });
