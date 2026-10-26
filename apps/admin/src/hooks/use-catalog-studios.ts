import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { unwrap } from "@/lib/query";
import {
  catalogStudioIds,
  networkStudioIds,
  sameNetwork,
  type CatalogStudio,
} from "@/lib/studio-catalog";

/**
 * Все клубы базы с форматом (studios читается публично). Нужен, чтобы
 * собрать общий каталог пакетных клубов и там, где сотрудник работает не во
 * всех из них: тренировка могла быть заведена в чужом клубе, продажа в
 * «Абонементах» — в клубе сети, где сотрудник не работает (название — для
 * фильтра «Клуб»). Ключ — под
 * ["studios"]: правка клубов инвалидирует и его.
 */
export const catalogStudiosQuery = queryOptions({
  queryKey: ["studios", "catalog"],
  queryFn: () =>
    unwrap<CatalogStudio[]>(
      supabase.from("studios").select("id, format, name").order("created_at"),
    ),
  staleTime: Infinity,
  meta: { errorMessage: "Не удалось загрузить клубы" },
});

/**
 * Клубы каталога клуба (lib/studio-catalog.ts; по умолчанию — активного):
 * у пакетного — все пакетные клубы, у подписочного — он сам. null — ещё
 * грузится или клуб не выбран: запросы каталога ждут (`enabled: !!ids`).
 */
export function useCatalogStudioIds(forStudioId?: string | null): string[] | null {
  const activeId = useActiveStudioId();
  const studioId = forStudioId === undefined ? activeId : forStudioId;
  const { data } = useQuery(catalogStudiosQuery);
  return useMemo(
    () => (studioId && data ? catalogStudioIds(data, studioId) : null),
    [studioId, data],
  );
}

/**
 * Клубы общей базы клиентов клуба (lib/studio-catalog.ts; по умолчанию —
 * активного): у пакетного — все пакетные клубы, у подписочного — он сам.
 * null — ещё грузится или клуб не выбран: запросы клиентов ждут
 * (`enabled: !!ids`).
 */
export function useNetworkStudioIds(forStudioId?: string | null): string[] | null {
  const activeId = useActiveStudioId();
  const studioId = forStudioId === undefined ? activeId : forStudioId;
  const { data } = useQuery(catalogStudiosQuery);
  return useMemo(
    () => (studioId && data ? networkStudioIds(data, studioId) : null),
    [studioId, data],
  );
}

/**
 * Клуб, где сейчас работают с клиентом клуба cardStudioId: активный, если у
 * них общая база клиентов (продажа — в активном клубе, решение владельца
 * 2026-10-17), иначе клуб карточки (клиент подписочного клуба из поиска по
 * другим клубам). Пока клубы грузятся — активный, если карточка не другая.
 */
export function useWorkStudioId(cardStudioId: string | null | undefined): string | null {
  const activeId = useActiveStudioId();
  const { data } = useQuery(catalogStudiosQuery);
  if (!cardStudioId) return activeId;
  if (!activeId) return cardStudioId;
  if (!data) return cardStudioId === activeId ? activeId : cardStudioId;
  return sameNetwork(data, activeId, cardStudioId) ? activeId : cardStudioId;
}

/** Формат любого клуба базы (studios читается публично), не только своих. */
export function useStudioFormat(studioId: string | null | undefined) {
  const { data } = useQuery(catalogStudiosQuery);
  return studioId ? (data?.find((s) => s.id === studioId)?.format ?? null) : null;
}
