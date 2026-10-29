/**
 * «Аналитика» — запросы (React Query + RPC an_*). Ключи — ["analytics", …];
 * после записи — invalidateAnalytics.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { parseAnMe, type AnMeRow } from "./access";

export const ANALYTICS_KEY = "analytics";

/** Права в «Аналитике» — грузит guard заранее, читают меню и страницы. */
export const anMeQuery = queryOptions({
  queryKey: [ANALYTICS_KEY, "me"],
  queryFn: async () => parseAnMe(await unwrap<AnMeRow | null>(supabase.rpc("an_me"))),
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить права в «Аналитике»" },
});

export function invalidateAnalytics(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: [ANALYTICS_KEY] });
}
