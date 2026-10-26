import {
  canOpenClubSection,
  canOpenRail,
  type AdminAccess,
  type ClubSectionKey,
  type RailAccessKey,
} from "@/lib/admin-access";

/**
 * Какие инструменты Kate открыты сотруднику — по тем же разделам, что меню
 * админки («Доступы»). Разделы клуба защищает только интерфейс (данные —
 * RLS по клубу), поэтому без этой проверки Kate рассказала бы о кассе
 * администратору, которому «Касса» закрыта.
 *
 * Инструмент открыт, если открыт хоть один из его разделов. Без разделов —
 * открыт всем (имена сотрудников, сводка-счётчики).
 */
type Need = { club?: ClubSectionKey[]; rail?: RailAccessKey[] };

const CLIENT_DATA: ClubSectionKey[] = ["clients", "client-memberships", "sales"];
const MEMBERSHIP_DATA: ClubSectionKey[] = ["client-memberships", "sales", "clients"];
const SALES_DATA: ClubSectionKey[] = ["sales", "client-memberships"];

export const TOOL_SECTIONS: Record<string, Need> = {
  list_clients: { club: CLIENT_DATA },
  get_client_details: { club: CLIENT_DATA },
  list_app_clients: { club: CLIENT_DATA },
  list_inactive_members: { club: CLIENT_DATA },
  list_birthdays: { club: CLIENT_DATA },
  list_trainers: {},
  list_workouts: { club: ["workouts", "schedule"] },
  list_schedule: { club: ["schedule"] },
  list_schedule_bookings: { club: ["schedule"] },
  list_memberships: { club: ["memberships", "client-memberships", "sales"] },
  list_client_memberships: { club: MEMBERSHIP_DATA },
  list_expiring_client_memberships: { club: MEMBERSHIP_DATA },
  list_package_sales: { club: MEMBERSHIP_DATA },
  list_installments_due: { club: SALES_DATA },
  list_sales: { club: SALES_DATA },
  sales_summary: { club: SALES_DATA },
  list_trials_without_purchase: { club: SALES_DATA },
  list_cash_operations: { club: ["cash"] },
  list_promo_codes: { club: ["promocodes"] },
  list_news: { rail: ["app"] },
  list_services: { rail: ["app"] },
  list_push_notifications: { rail: ["app"] },
  get_club_settings: { rail: ["app"] },
  list_feedback: { club: ["feedback"] },
  list_nps: { club: ["nps"] },
  list_client_requests: { club: ["requests"] },
  list_bookings_log: { club: ["bookings-log", "schedule"] },
  counts_overview: {},
};

export function canUseTool(access: AdminAccess, studioId: string, name: string): boolean {
  const need = TOOL_SECTIONS[name];
  // Инструмент без записи здесь — закрыт: новый инструмент должен явно
  // назвать свои разделы.
  if (!need) return false;
  if (!need.club && !need.rail) return true;
  return (
    (need.club ?? []).some((key) => canOpenClubSection(access, studioId, key)) ||
    (need.rail ?? []).some((key) => canOpenRail(access, key))
  );
}

/** Оставляет только открытые сотруднику инструменты. */
export function filterTools<T extends Record<string, unknown>>(
  tools: T,
  access: AdminAccess,
  studioId: string,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => canUseTool(access, studioId, name)),
  ) as Partial<T>;
}
