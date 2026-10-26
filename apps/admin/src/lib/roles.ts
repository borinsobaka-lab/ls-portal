import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Роли сотрудников. Каждый новый пользователь получает роль `member`
 * (auth_trigger.sql), поэтому «просто авторизован» ≠ «сотрудник» — роль
 * проверяем явно.
 */
export const STAFF_ROLES = ["owner", "admin", "trainer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Пользователь админки: роль сотрудника хоть в одном клубе или человек
 * портала с действующими ролями (сотрудник УК может быть без клуба —
 * «Пользователи и роли», ACCESS.md). Работает с любым клиентом (браузерным
 * или серверным): is_portal_user выдана authenticated и service_role.
 *
 * Ошибка запроса — исключение, а не false: сбой сети или рестарт PostgREST
 * не должен выглядеть как «не сотрудник» и выкидывать из админки.
 */
export async function hasStaffRole(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_portal_user", { _user_id: userId });
  if (error) throw new Error(`Не удалось проверить роль: ${error.message}`);
  return data === true;
}
