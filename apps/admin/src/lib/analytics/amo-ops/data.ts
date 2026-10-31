import { supabase } from "@/integrations/supabase/client";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { unwrap } from "@/lib/query";
import type { OpsSnapshot } from "./rules";

/** Ключи запросов «Операционной аналитики»: ["analytics", "amo-ops", …]. */
export const AMO_OPS_KEY = [ANALYTICS_KEY, "amo-ops"] as const;

export type OpsRunRow = {
  id: number;
  connection_id: number;
  connection: string;
  day: string;
  status: "running" | "success" | "error";
  message: string;
  requests: number;
  leads: number;
  tasks: number;
  events: number;
  started_at: string;
  finished_at: string | null;
};
export type OpsWindowRow = {
  connection_id: number;
  connection: string;
  start: number;
  end: number;
  captured_at: string;
};
export type OpsOverview = {
  connections: { id: number; name: string; has_settings: boolean }[];
  runs: OpsRunRow[];
  windows: OpsWindowRow[];
};

/** Подключения, запуски и собранные окна; пока идёт сбор — раз в 3 секунды. */
export const amoOpsOverviewQuery = {
  queryKey: [...AMO_OPS_KEY, "overview"],
  queryFn: () => unwrap<OpsOverview>(supabase.rpc("an_amo_ops_overview")),
  meta: { errorMessage: "Не удалось загрузить операционную аналитику" },
  refetchInterval: (q: { state: { data?: OpsOverview } }) =>
    q.state.data?.runs.some((r) => r.status === "running") ? 3000 : false,
};

export type OpsWindowData = {
  account: string;
  start: number;
  end: number;
  captured_at: number;
  snapshot: OpsSnapshot;
};

export const amoOpsWindowQuery = (connection: number, start: number) => ({
  queryKey: [...AMO_OPS_KEY, "window", connection, start],
  queryFn: () =>
    unwrap<OpsWindowData>(
      supabase.rpc("an_amo_ops_window", { p_connection: connection, p_start: start }),
    ),
  meta: { errorMessage: "Не удалось загрузить окно сбора" },
});
