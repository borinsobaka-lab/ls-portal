/**
 * Статус клуба (вычисляется из client_memberships):
 *  - chk  — Член клуба: есть активный абонемент (status='active' и не истёк).
 *  - bchk — Бывший член клуба: когда-то был абонемент, сейчас нет активного.
 *  - pchk — Потенциальный член клуба: никогда не покупал абонементы.
 * Пробные абонементы (memberships.kind = 'trial', пакетные клубы) не
 * считаются вовсе (решение владельца 2026-10-14): клиент только с пробным —
 * ПЧК, ЧК — после продажи любого другого абонемента.
 */
import { todayISO } from "@/lib/format";

export type ClubStatus = "chk" | "pchk" | "bchk";

export const CLUB_STATUS_LABEL: Record<ClubStatus, string> = {
  chk: "ЧК",
  pchk: "ПЧК",
  bchk: "БЧК",
};

export const CLUB_STATUS_FULL: Record<ClubStatus, string> = {
  chk: "Член клуба",
  pchk: "Потенциальный член клуба",
  bchk: "Бывший член клуба",
};

/** Кто попадает в статус — для подсказки у колонки «Статус» (та же логика, что ниже и во вью clients_with_status). */
export const CLUB_STATUS_RULE: Record<ClubStatus, string> = {
  chk: "есть действующий абонемент — в том числе замороженный. Пробный не считается.",
  bchk: "абонементы покупал, но сейчас ни одного действующего: закончились или отменены. Пробный не считается.",
  pchk: "ни разу не покупал абонемент, кроме пробного, — например, только пришёл на пробное или заведён вручную.",
};

export type MembershipLite = {
  client_id: string;
  status: string | null;
  ends_at: string | null;
  /** memberships.kind: trial — пробный, в статусе не считается. */
  kind?: string | null;
};

export function computeClubStatus(memberships: MembershipLite[] | null | undefined): ClubStatus {
  const list = (memberships ?? []).filter((m) => m.kind !== "trial");
  if (list.length === 0) return "pchk";
  const today = todayISO();
  // Замороженный абонемент — тоже действующий (на паузе), клиент остаётся ЧК.
  const hasActive = list.some(
    (m) => m.status === "frozen" || (m.status === "active" && (!m.ends_at || m.ends_at >= today)),
  );
  if (hasActive) return "chk";
  return "bchk";
}
