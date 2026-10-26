import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

import { ACTIVE_STUDIO_HEADER } from "@/hooks/use-active-studio";
import { authenticate, bearerToken, getStaffStudio } from "@/lib/staff-auth.server";

/**
 * Middleware серверных функций. Токен прикладывает attachSupabaseAuth
 * (auth-attacher.ts) на стороне браузера.
 */

/** Любой авторизованный пользователь: context.supabase — клиент от его имени. */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const token = bearerToken(getRequestHeader("authorization"));
    const auth = token ? await authenticate(token) : null;
    // Error, а не Response: брошенный Response клиент получал как «данные»
    // (useQuery видел объект без полей и страница падала), Error же приходит
    // в onError/error с этим текстом.
    if (!auth) throw new Error("Сессия истекла. Войдите заново.");
    return next({ context: { supabase: auth.supabase, userId: auth.user.id } });
  },
);

/**
 * Сотрудник активной студии (выбор в шапке; без него — profiles.studio_id):
 * добавляет studioId и isOwner.
 */
export const requireStaff = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const staff = await getStaffStudio(
      context.supabase,
      context.userId,
      getRequestHeader(ACTIVE_STUDIO_HEADER),
    );
    if (!staff) throw new Error("Клуб не найден для пользователя");
    if (!staff.roles.length) throw new Error("Доступ только для сотрудников этого клуба");
    return next({ context: { studioId: staff.studioId, isOwner: staff.roles.includes("owner") } });
  });

/**
 * Владелец хотя бы одной студии — управляет «Доступами». Добавляет
 * ownedStudioIds: выдавать и снимать доступ он может только в своих студиях.
 * Активная студия здесь не важна: «Доступы» — раздел над студиями.
 */
export const requireAccessManager = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("studio_id")
      .eq("user_id", context.userId)
      .eq("role", "owner");
    if (error) throw new Error(error.message);
    const ownedStudioIds = [...new Set((data ?? []).map((r) => r.studio_id as string))];
    if (ownedStudioIds.length === 0) {
      throw new Error("Управлять доступами может только владелец клуба");
    }
    return next({ context: { ownedStudioIds } });
  });
