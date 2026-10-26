/**
 * Остаток диагностик тела у своих абонементов (вкладка «Диагностика»
 * расписания пакетного приложения). Как списывает база
 * (schedule_bookings_charge_balance,
 * db/migrations/2026-10-15_zz_diagnostics_client_requests.sql): с
 * действующего абонемента, а с ждущего продления — только если действующего
 * или замороженного того же вида нет (текущий кончают тренировки, не
 * диагностики).
 */
export type DiagnosticsRow = {
  status: string;
  diagnostics_left?: number | null;
  balance_kind: "group" | "personal" | null;
};

export function diagnosticsBalance(rows: DiagnosticsRow[]) {
  const live = new Set(
    rows
      .filter((m) => m.status === "active" || m.status === "frozen")
      .map((m) => m.balance_kind ?? "group"),
  );
  return rows
    .filter(
      (m) =>
        m.status === "active" || (m.status === "pending" && !live.has(m.balance_kind ?? "group")),
    )
    .reduce((sum, m) => sum + Math.max(0, m.diagnostics_left ?? 0), 0);
}
