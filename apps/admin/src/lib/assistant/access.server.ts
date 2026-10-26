import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminAccess, AdminSectionKey, ClubSectionKey } from "@/lib/admin-access";
import type { StaffRole } from "@/lib/roles";
import { ACCESS_RIGHTS, type AccessRight } from "@/lib/access/logic";
import type { AccessMe } from "@/lib/access/types";

/**
 * Права сотрудника для Kate — как их читает меню (`useAdminAccess`), но на
 * сервере и только для открытого клуба. Свои строки прав RLS отдаёт всегда.
 * Ошибка чтения — исключение: открыть всё при сбое было бы утечкой.
 */
export async function loadAdminAccess(
  supabase: SupabaseClient,
  userId: string,
  studioId: string,
  roles: StaffRole[],
): Promise<AdminAccess> {
  const [rail, club, me] = await Promise.all([
    supabase.from("admin_permissions").select("sections").eq("user_id", userId),
    supabase
      .from("admin_studio_permissions")
      .select("sections")
      .eq("user_id", userId)
      .eq("studio_id", studioId),
    supabase.rpc("access_me"),
  ]);
  const error = rail.error ?? club.error ?? me.error;
  if (error) throw new Error(error.message);
  const railRow = (rail.data ?? [])[0] as { sections: AdminSectionKey[] } | undefined;
  const clubRow = (club.data ?? [])[0] as { sections: ClubSectionKey[] } | undefined;
  const own = (me.data ?? {}) as Partial<AccessMe>;
  const rights = (own.rights ?? []).filter((r): r is AccessRight =>
    (ACCESS_RIGHTS as readonly string[]).includes(r),
  );
  return {
    rights,
    kbAdmin: rights.includes("kb.admin"),
    manageAll: !!own.manage_all,
    manageStudioIds: own.manage_studio_ids ?? [],
    rail: railRow?.sections ?? null,
    studios: {
      [studioId]: { owner: roles.includes("owner"), sections: clubRow?.sections ?? null },
    },
  };
}
