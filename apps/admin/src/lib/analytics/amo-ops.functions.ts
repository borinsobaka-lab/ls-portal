import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { opsWindow } from "./amo-ops/rules";
import { mskToday } from "./core";
import { opsRun } from "./server/amo-ops.server";

/**
 * «Операционная аналитика amoCRM» — их server_wizard: подключение, прошедший
 * день по Москве, ограниченный сбор фоном (страница показывает ход и итог).
 * Только администратору аналитики (an_me от имени вызывающего).
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

/** Запуск, оборвавшийся с сервером, дольше их RuntimeMaxSec — ошибка. */
const STALE_MS = 10 * 60 * 1000;

export const startAmoOpsRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ connectionId: z.number().int().positive(), day: z.string().max(20) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const window = opsWindow(data.day, mskToday());
    if (!window) throw new Error("Choose a completed past day");
    const admin = getSupabaseAdmin();
    const ctx = await admin.rpc("an_amo_ops_context", { p_connection: data.connectionId });
    if (ctx.error) throw new Error(ctx.error.message);
    await admin
      .from("an_amo_ops_runs")
      .update({
        status: "error",
        message: "PILOT_FAILED: Interrupted",
        finished_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - STALE_MS).toISOString());
    const running = await admin
      .from("an_amo_ops_runs")
      .select("id")
      .eq("status", "running")
      .limit(1);
    if (running.error) throw new Error(running.error.message);
    if (running.data.length) {
      throw new Error("Pilot already running or stale lock needs operator inspection");
    }
    const run = await admin
      .from("an_amo_ops_runs")
      .insert({ connection_id: data.connectionId, day: data.day, started_by: context.userId })
      .select("id")
      .single();
    if (run.error) throw new Error(run.error.message);
    await admin.rpc("an_audit_add", {
      _user_id: context.userId,
      _event: "amocrm_operations_pilot_started",
      _details: `${data.connectionId} ${data.day}`,
    });
    const id = (run.data as { id: number }).id;
    void opsRun(id, data.connectionId, window.start, window.end).catch((e: Error) =>
      console.error("[analytics] amoCRM: операционный пилот", id, e.message),
    );
    return { id };
  });
