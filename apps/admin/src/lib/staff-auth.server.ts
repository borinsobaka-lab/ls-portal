import type { SupabaseClient, User } from "@supabase/supabase-js";

import { createUserClient } from "@/integrations/supabase/client.server";
import { ACTIVE_STUDIO_HEADER } from "@/hooks/use-active-studio";
import { STAFF_ROLES, type StaffRole } from "@/lib/roles";

/** Токен из заголовка `Authorization: Bearer …`. */
export function bearerToken(header: string | null | undefined): string | null {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

/** Проверяет токен в GoTrue. Возвращает клиент от имени пользователя и его самого. */
export async function authenticate(
  token: string,
): Promise<{ supabase: SupabaseClient; user: User } | null> {
  const supabase = createUserClient(token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { supabase, user: data.user };
}

/** Студия сотрудника — profiles.studio_id (null, если профиля нет). */
export async function getProfileStudioId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("studio_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.studio_id as string | null | undefined) ?? null;
}

/** Роли сотрудника в конкретной студии. */
export async function getStudioStaffRoles(
  supabase: SupabaseClient,
  userId: string,
  studioId: string,
): Promise<StaffRole[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("studio_id", studioId)
    .in("role", STAFF_ROLES);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.role as StaffRole);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Студия, с которой работает сотрудник, и его роли в ней. Студия — из
 * заголовка ACTIVE_STUDIO_HEADER (выбор в шапке админки), без него — из
 * профиля. Заголовку не доверяем: роли проверяются именно в этой студии,
 * пустой roles — не сотрудник этой студии.
 */
export async function getStaffStudio(
  supabase: SupabaseClient,
  userId: string,
  requestedStudioId: string | null | undefined,
): Promise<{ studioId: string; roles: StaffRole[] } | null> {
  const requested = requestedStudioId?.trim();
  const studioId =
    requested && UUID_RE.test(requested) ? requested : await getProfileStudioId(supabase, userId);
  if (!studioId) return null;
  return { studioId, roles: await getStudioStaffRoles(supabase, userId, studioId) };
}

/** Активная студия из заголовка запроса. */
export function requestedStudioId(headers: Headers): string | null {
  return headers.get(ACTIVE_STUDIO_HEADER);
}

export type StaffContext = {
  supabase: SupabaseClient;
  userId: string;
  studioId: string;
  /** Роли сотрудника в этой студии (не пустые). */
  roles: StaffRole[];
};

export type StaffAuthResult =
  | { ok: true; staff: StaffContext }
  | { ok: false; status: 401 | 403; message: string };

/**
 * Проверка для API-роутов админки (AI-ассистент, диктовка): Bearer-токен И
 * роль сотрудника. Они ходят в платные внешние API и в данные студии, поэтому
 * клиентам приложения — тоже авторизованным пользователям этого же Supabase —
 * недоступны. 401 — нет сессии, 403 — сессия есть, но это не сотрудник.
 */
export async function authenticateStaff(request: Request): Promise<StaffAuthResult> {
  const token = bearerToken(request.headers.get("authorization"));
  const auth = token ? await authenticate(token) : null;
  if (!auth) {
    return {
      ok: false,
      status: 401,
      message: "Сессия истекла. Войдите заново и повторите запрос.",
    };
  }
  const staff = await getStaffStudio(
    auth.supabase,
    auth.user.id,
    requestedStudioId(request.headers),
  );
  if (!staff?.roles.length) {
    return { ok: false, status: 403, message: "Доступ только для сотрудников клуба." };
  }
  return {
    ok: true,
    staff: {
      supabase: auth.supabase,
      userId: auth.user.id,
      studioId: staff.studioId,
      roles: staff.roles,
    },
  };
}
