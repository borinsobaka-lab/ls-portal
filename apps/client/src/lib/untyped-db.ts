import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/**
 * Клиент Supabase без сгенерированных типов — для таблиц и колонок, которых
 * нет в устаревшем types.ts (memberships, client_memberships, trainer_studios,
 * новые колонки; см. CLAUDE.md приложения, «Типы»). Строки приводить к своим
 * типам на месте. Уйдёт с полной регенерацией типов.
 */
export const untypedDb = supabase as unknown as SupabaseClient;
