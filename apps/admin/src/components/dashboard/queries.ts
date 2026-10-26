import { useQuery } from "@tanstack/react-query";

import type { DashboardView } from "@/components/dashboard/dashboard-shell";
import { loadSalesHistory } from "@/lib/dashboard-data";

/**
 * История продаж выбранных клубов за всё время — одна на «Общие показатели», «Продажи»
 * и «Клиенты» (общий queryKey): смена периода и переход между подразделами
 * считаются по ней в браузере, без новых запросов.
 */
export function useSalesHistory(view: DashboardView) {
  return useQuery({
    queryKey: ["dashboard", view.scope, "sales-history"],
    queryFn: () => loadSalesHistory(view.clubIds),
    meta: { errorMessage: `${view.name}: не удалось загрузить продажи для дашборда` },
  });
}
