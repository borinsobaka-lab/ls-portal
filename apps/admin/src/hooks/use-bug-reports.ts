import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

/**
 * Неразобранные «Сообщения об ошибках» (суперадминистратору) — счётчик на
 * «Управлении» в рейке и у пункта его меню. Ключ общий: оба места делят один
 * запрос; страница раздела сбрасывает его вместе со своим списком.
 */
export function useOpenBugReports(enabled: boolean): number {
  const { data = 0 } = useQuery({
    queryKey: ["portal_bug_reports", "open-count"],
    queryFn: async () =>
      (await unwrap<number | null>(supabase.rpc("portal_bug_reports_open_count"))) ?? 0,
    enabled,
    refetchInterval: 60_000,
  });
  return enabled ? data : 0;
}
