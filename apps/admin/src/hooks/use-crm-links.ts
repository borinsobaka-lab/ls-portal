import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useNetworkStudioIds } from "@/hooks/use-catalog-studios";
import { unwrap } from "@/lib/query";

/**
 * Ссылки amoCRM для строк таблицы — одним запросом на страницу, а не по
 * запросу на строку. Возвращает функцию для `crmLink` у ClientNameLink:
 * пока ссылки грузятся — null (иконки нет, но и отдельных запросов строк нет).
 * Карточки — из базы клиентов клуба: у пакетного — всех пакетных клубов
 * (2026-10-17), клиент в таблице мог быть заведён в другом клубе сети.
 */
export function useCrmLinks(
  studioId: string | null,
  by: "id" | "user_id",
  ids: (string | null | undefined)[],
) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  const networkIds = useNetworkStudioIds(studioId);
  const { data } = useQuery({
    queryKey: ["clients", studioId, "crm-links", by, networkIds?.join(","), unique],
    queryFn: async () => {
      const rows = await unwrap<{ id: string; user_id: string | null; crm_link: string | null }[]>(
        supabase
          .from("clients")
          .select("id, user_id, crm_link")
          .in("studio_id", networkIds!)
          .in(by, unique),
      );
      return new Map(rows.map((r) => [r[by] ?? "", r.crm_link]));
    },
    enabled: !!studioId && !!networkIds && unique.length > 0,
  });
  return (id: string | null | undefined) => (id && data?.get(id)) || null;
}
