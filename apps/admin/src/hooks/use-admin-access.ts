import { queryOptions, useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useStudios } from "@/hooks/use-studios";
import { unwrap } from "@/lib/query";
import type { AdminAccess, AdminSectionKey, ClubSectionKey } from "@/lib/admin-access";
import { kbLevelOf, type KbLevel } from "@/lib/kb/access";
import { kbBasesQuery, kbOwnGrantsQuery } from "@/lib/kb/data";
import { acadAccessQuery } from "@/lib/academy/data";
import { anMeQuery } from "@/lib/analytics/data";
import { accessMeQuery } from "@/lib/access/data";
import { ACCESS_RIGHTS, type AccessRight } from "@/lib/access/logic";

type OwnPermissions = {
  rail: AdminSectionKey[] | null;
  studios: Record<string, ClubSectionKey[]>;
};

/** Свои строки прав; заранее загружает и проверка входа (`_authenticated/route.tsx`). */
export const adminPermissionsQuery = queryOptions({
  queryKey: ["admin_permissions"],
  queryFn: async (): Promise<OwnPermissions> => {
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) return { rail: null, studios: {} };
    const [rail, perStudio] = await Promise.all([
      unwrap<{ sections: AdminSectionKey[] }[]>(
        supabase.from("admin_permissions").select("sections").eq("user_id", userId),
      ),
      unwrap<{ studio_id: string; sections: ClubSectionKey[] }[]>(
        supabase
          .from("admin_studio_permissions")
          .select("studio_id, sections")
          .eq("user_id", userId),
      ),
    ]);
    return {
      rail: rail[0]?.sections ?? null,
      studios: Object.fromEntries(perStudio.map((r) => [r.studio_id, r.sections])),
    };
  },
  // Права меняет владелец в «Доступах»; свои права он менять не может.
  staleTime: Infinity,
  meta: { errorMessage: "Не удалось загрузить права доступа" },
});

/**
 * Права текущего сотрудника («Доступы»): какие разделы рейки и клуба ему
 * открыты. null — ещё загружаются. Свои строки прав RLS отдаёт всегда.
 *
 * Это только интерфейс: если таблиц прав ещё нет или запрос не удался,
 * считаем, что открыто всё (данные всё равно защищает RLS), а тост об ошибке
 * покажет общий QueryCache.
 */
export function useAdminAccess(): AdminAccess | null {
  const { data: studios, isLoading: studiosLoading } = useStudios();
  const { data: own, isLoading } = useQuery(adminPermissionsQuery);
  const { data: kbBases, isLoading: kbLoading } = useQuery(kbBasesQuery);
  const { data: kbGrants, isLoading: kbGrantsLoading } = useQuery(kbOwnGrantsQuery);
  const { data: academy, isLoading: academyLoading } = useQuery(acadAccessQuery);
  const { data: me, isLoading: meLoading } = useQuery(accessMeQuery);
  const { data: analytics, isLoading: analyticsLoading } = useQuery(anMeQuery);

  if (
    studiosLoading ||
    isLoading ||
    kbLoading ||
    kbGrantsLoading ||
    academyLoading ||
    meLoading ||
    analyticsLoading
  )
    return null;
  const list = studios ?? [];
  // Вне новой модели (прежние правила): владелец клуба — администратор сети.
  const legacyOwner = !me?.managed && list.some((s) => s.roles.includes("owner"));
  const rights: AccessRight[] = legacyOwner
    ? [...ACCESS_RIGHTS]
    : ((me?.rights ?? []).filter((r): r is AccessRight =>
        (ACCESS_RIGHTS as readonly string[]).includes(r),
      ) as AccessRight[]);
  const kbAdmin = rights.includes("kb.admin");
  const kb: Record<string, KbLevel> = {};
  for (const base of kbBases ?? []) {
    const level = kbLevelOf(kbAdmin, kbGrants ?? [], base.id);
    if (level) kb[base.id] = level;
  }
  return {
    rights,
    kbAdmin,
    manageAll: legacyOwner || !!me?.manage_all,
    manageStudioIds: me?.manage_studio_ids ?? [],
    kb,
    academy,
    analytics,
    rail: legacyOwner ? null : (own?.rail ?? null),
    studios: Object.fromEntries(
      list.map((s) => [
        s.id,
        { owner: s.roles.includes("owner"), sections: own?.studios[s.id] ?? null },
      ]),
    ),
  };
}
