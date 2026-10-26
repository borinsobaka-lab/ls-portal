import { useQuery } from "@tanstack/react-query";

import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import { useActiveStudio } from "@/hooks/use-studios";
import { supabase } from "@/integrations/supabase/client";
import { canOpenClubSection } from "@/lib/admin-access";
import { CLUBS_HIDDEN } from "@/lib/launch";

/**
 * Заявки клиентов из приложения пакетных клубов (client_requests,
 * db/migrations/2026-10-15_zz_diagnostics_client_requests.sql): на
 * персональные занятия и на диагностику. «Обратная связь» → «Заявки».
 */

export type ClientRequestKind = "personal" | "diagnostic";

export const REQUEST_KIND_LABEL: Record<ClientRequestKind, string> = {
  personal: "Персональные занятия",
  diagnostic: "Диагностика",
};

/** Ключ счётчика — его же обновляет страница после «Отработано». */
export const OPEN_REQUESTS_KEY = "client_requests_open";

/**
 * Неотработанные заявки клубов (id через запятую) — бейдж на «Клубе» в
 * рейке и на «Заявках» в меню. Раз в минуту и при возвращении на вкладку:
 * новые заявки приходят из приложения, страницу никто не обновляет.
 */
export function useOpenRequestsCount(studioIds: string, enabled: boolean) {
  return useQuery({
    queryKey: [OPEN_REQUESTS_KEY, studioIds],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("client_requests")
        .select("id", { count: "exact", head: true })
        .in("studio_id", studioIds.split(","))
        .is("processed_at", null);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    enabled: enabled && !!studioIds,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  }).data;
}

/**
 * Счётчик для меню и рейки: только в пакетном клубе и только если раздел
 * «Заявки» открыт сотруднику в этом клубе; иначе 0. Считает заявки всех
 * пакетных клубов раздела — как страница «Заявок» (2026-10-19).
 */
export function useClubRequestsBadge() {
  const studioId = useActiveStudioId();
  const studio = useActiveStudio();
  const access = useAdminAccess();
  const ids = studioIdsKey(useSectionStudios("requests", "packages"));
  const enabled =
    !CLUBS_HIDDEN &&
    studio?.format === "packages" &&
    !!access &&
    canOpenClubSection(access, studioId, "requests");
  const count = useOpenRequestsCount(ids, enabled);
  return enabled ? (count ?? 0) : 0;
}
