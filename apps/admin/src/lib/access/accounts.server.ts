/**
 * Учётные записи людей портала (GoTrue) — общее у «Пользователей и ролей»
 * (createPortalUser) и переноса людей со старого портала аналитики. Только
 * сервис-ключом и только после проверки прав вызывающего: права, роли и
 * данные человека пишут RPC от его имени.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { NO_EMAIL_DOMAIN } from "@/lib/access/logic";

/** Сообщения GoTrue приходят по-английски — частые переводим для тоста. */
export function authErrorText(message: string) {
  if (/already (been )?registered|already exists|email_exists/i.test(message)) {
    return "Пользователь с такой почтой уже зарегистрирован";
  }
  return message;
}

/** Учётная запись с этой почтой (профиль), без регистра. */
export async function findProfileIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | null> {
  const pattern = email.replace(/[\\%_]/g, "\\$&");
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", pattern)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0]?.id as string | undefined) ?? null;
}

export async function isPortalUser(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("portal_users")
    .select("user_id")
    .eq("user_id", userId)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * Клуб профиля (profiles.studio_id обязателен): переданный, иначе клуб того,
 * кто добавляет, иначе самый первый клуб. Права это не даёт — их дают роли.
 */
export async function homeStudioFor(
  admin: SupabaseClient,
  preferred: string | null,
  actorId: string,
): Promise<string> {
  let id = preferred;
  if (!id) {
    const { data: own } = await admin
      .from("profiles")
      .select("studio_id")
      .eq("id", actorId)
      .maybeSingle();
    id = (own?.studio_id as string | undefined) ?? null;
  }
  if (!id) {
    const { data: oldest } = await admin
      .from("studios")
      .select("id")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    id = (oldest?.id as string | undefined) ?? null;
  }
  if (!id) throw new Error("Сначала заведите хотя бы один клуб");
  return id;
}

/**
 * Новая учётная запись сотрудника: вход по коду из письма, пароля нет. Без
 * почты — служебный адрес в домене .invalid (lib/access/logic.ts): GoTrue
 * без почты или телефона учётную запись не заводит.
 */
export async function createStaffAccount(
  admin: SupabaseClient,
  p: { email: string | null; first_name: string; last_name: string; studioId: string },
): Promise<string> {
  const fullName = `${p.last_name} ${p.first_name}`.trim();
  const authEmail = p.email ?? `nomail-${crypto.randomUUID()}@${NO_EMAIL_DOMAIN}`;
  const { data: res, error } = await admin.auth.admin.createUser({
    email: authEmail,
    email_confirm: true,
    // studio_id читает handle_new_user; staff_account — не заводить
    // карточку клиента (db/migrations/…_staff_accounts.sql).
    user_metadata: {
      first_name: p.first_name,
      last_name: p.last_name,
      full_name: fullName,
      studio_id: p.studioId,
      staff_account: true,
    },
  });
  if (error || !res.user) {
    throw new Error(authErrorText(error?.message ?? "Не удалось создать пользователя"));
  }
  const userId = res.user.id;
  const { error: profErr } = await admin
    .from("profiles")
    .upsert({ id: userId, studio_id: p.studioId, full_name: fullName, email: p.email });
  // profiles.email у человека без почты — пусто (handle_new_user мог вписать служебный).
  if (profErr) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(profErr.message);
  }
  return userId;
}
