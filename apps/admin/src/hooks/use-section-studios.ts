import { useMemo } from "react";

import { useAdminAccess } from "@/hooks/use-admin-access";
import { useStudios, type Studio } from "@/hooks/use-studios";
import { sectionStudioIds, type ClubSectionKey } from "@/lib/admin-access";
import type { StudioFormat } from "@/lib/studio-formats";

/**
 * Клубы раздела, который показывает данные всех клубов сотрудника сразу, без
 * смены клуба в шапке (решение владельца 2026-10-19: «Обратная связь»,
 * «Заявки», «NPS-опросы», «Касса»): клубы, где ему открыт этот раздел
 * («Доступы»), в порядке переключателя; `format` — только клубы этого
 * формата. null — студии или права ещё грузятся.
 */
export function useSectionStudios(key: ClubSectionKey, format?: StudioFormat): Studio[] | null {
  const { data: studios } = useStudios();
  const access = useAdminAccess();
  // Строкой: useAdminAccess собирает объект прав заново на каждом рендере.
  const allowed = access ? sectionStudioIds(access, key).sort().join(",") : null;
  return useMemo(() => {
    if (!studios || allowed === null) return null;
    const ids = new Set(allowed.split(","));
    return studios.filter((s) => ids.has(s.id) && (!format || s.format === format));
  }, [studios, allowed, format]);
}

/** id клубов раздела строкой — для queryKey (стабильна между рендерами). */
export function studioIdsKey(studios: Studio[] | null): string {
  return (studios ?? []).map((s) => s.id).join(",");
}
