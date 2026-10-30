import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { quizSpreadsheetId } from "./quiz/rules";
import { sheetsClient } from "./server/google-sheets.server";

/**
 * Квиз: проверка Google-таблицы города — только чтение (название и листы),
 * ключом сервисного аккаунта «Источников СС». Только администратору
 * аналитики.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

export const checkQuizSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ spreadsheetId: z.string().min(1).max(400) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const meta = await (await sheetsClient()).metadata(quizSpreadsheetId(data.spreadsheetId));
    return { title: meta.title, sheets: meta.sheets };
  });
