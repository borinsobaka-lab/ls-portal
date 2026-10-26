/**
 * Хватит ли клиенту абонемента на занятие — окно занятия в «Расписании»
 * пакетного клуба (решение владельца 2026-10-13). Записаться можно и сверх
 * остатка (2 тренировки на балансе — хоть на 4 занятия), а «Посетил» без
 * остатка база не даст (schedule_bookings_charge_balance) — сначала продажа.
 * Расчёт повторяет списание в базе: групповые — visits_left абонемента пакета
 * тренировок, персональные — personal_left любого абонемента (в пакет
 * тренировок их дарят), диагностики — diagnostics_left любого абонемента;
 * срок — на дату занятия по Тбилиси.
 */

/** С какого баланса спишется занятие: групповые, персональные или диагностики. */
export type BalanceKind = "visits" | "personal" | "diagnostic";

/** Баланс по типу занятия (schedule_entries.kind). */
export function entryBalance(kind: string): BalanceKind {
  return kind === "personal" ? "personal" : kind === "diagnostic" ? "diagnostic" : "visits";
}

export type BalanceRow = {
  /**
   * active — текущий; pending — продление ждёт (спишется после текущего);
   * frozen — заморожен (в остаток не идёт).
   */
  status: string;
  ends_at: string | null;
  visits_left: number | null;
  personal_left: number | null;
  /** Остаток диагностик тела (2026-10-15); нет поля — 0. */
  diagnostics_left?: number | null;
  balance_kind: "group" | "personal" | null;
};

/** Дата по Тбилиси (YYYY-MM-DD) — с ней база сверяет срок абонемента. */
export function tbilisiDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Tbilisi" });
}

/**
 * Тренировок нужного вида на балансе к дате занятия; без счётчика — безлимит.
 * Замороженный (frozen) в остаток не идёт, но, как и действующий, держит
 * ждущие диагностики: их база не спишет, пока жив абонемент того же вида, а
 * его кончают тренировки, а не диагностики.
 */
export function balanceFor(rows: BalanceRow[], balance: BalanceKind, date: string) {
  const live = new Set(
    rows
      .filter((r) => r.status === "active" || r.status === "frozen")
      .map((r) => r.balance_kind ?? "group"),
  );
  let total = 0;
  for (const r of rows) {
    if (r.status !== "active" && r.status !== "pending") continue;
    if (r.ends_at && r.ends_at < date) continue;
    if (balance === "personal") total += Math.max(0, r.personal_left ?? 0);
    else if (balance === "diagnostic") {
      if (r.status === "pending" && live.has(r.balance_kind ?? "group")) continue;
      total += Math.max(0, r.diagnostics_left ?? 0);
    } else if (r.balance_kind !== "personal") {
      if (r.visits_left == null) return Infinity;
      total += Math.max(0, r.visits_left);
    }
  }
  return total;
}

/**
 * balance — тренировок на балансе сейчас (с ждущим продлением), ahead —
 * сколько записей клиента на такие же занятия раньше этого ещё не отмечены.
 */
export type Coverage = { balance: number; ahead: number };

export type BookingMark = { status: string; no_show_excused: boolean | null };

/** Посещение по записи уже списано: «Посетил» или «Не посетил» без уважительной причины. */
export function isCharged(b: BookingMark) {
  return b.status === "attended" || (b.status === "no_show" && b.no_show_excused === false);
}

/**
 * noBalance — «Посетил» сейчас не отметить (остатка нет совсем); uncovered —
 * на это занятие остатка не хватит: он уйдёт на более ранние записи. По уже
 * списанной записи предупреждать не о чем.
 */
export function attendanceBlock(b: BookingMark, cov: Coverage | undefined) {
  if (!cov || isCharged(b)) return { noBalance: false, uncovered: false };
  return { noBalance: cov.balance <= 0, uncovered: cov.balance <= cov.ahead };
}
