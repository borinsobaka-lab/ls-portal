import { createClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Браузерный клиент: сессия сотрудника в localStorage, RLS действует.
 * Нетипизированный — сгенерированных типов базы пока нет (см. CLAUDE.md).
 */
export const supabase = createClient(
  SUPABASE_URL || "http://localhost",
  SUPABASE_ANON_KEY || "public-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
