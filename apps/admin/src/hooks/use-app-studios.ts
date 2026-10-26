import { useQuery } from "@tanstack/react-query";

import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useStudios } from "@/hooks/use-studios";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

/**
 * Клубы у записей «Мобильного приложения» (новости, услуги, пуши —
 * `studio_ids`, db/migrations/2026-10-11_zzzzzzzzzz_app_content_by_studio.sql).
 * Сотрудник выбирает только свои клубы (где у него есть роль); чужие клубы
 * записи видны, но не меняются — их оставляет и проверяет база. Поле формы и
 * ячейка таблицы — components/app-studios-field.tsx.
 */

/** Мои клубы (id) — для фильтра списка `.overlaps("studio_ids", ids)`. */
export function useMyStudioIds(): string[] | undefined {
  const { data } = useStudios();
  return data?.map((s) => s.id);
}

/** Клубы новой записи по умолчанию: клуб из шапки, иначе первый свой. */
export function useDefaultStudioIds(): string[] {
  const activeId = useActiveStudioId();
  const { data = [] } = useStudios();
  const active = data.find((s) => s.id === activeId) ?? data[0];
  return active ? [active.id] : [];
}

/** Делит клубы записи на свои (можно менять) и чужие (остаются как есть). */
export function splitStudioIds(ids: string[], mine: string[] | undefined) {
  const own = new Set(mine ?? []);
  return {
    mine: ids.filter((id) => own.has(id)),
    locked: ids.filter((id) => !own.has(id)),
  };
}

/**
 * Названия всех клубов: у записи могут быть и чужие клубы (studios читается
 * публично — как в клиентском приложении).
 */
export function useStudioNames() {
  return useQuery({
    queryKey: ["studio-names"],
    queryFn: async () => {
      const rows = await unwrap<{ id: string; name: string }[]>(
        supabase.from("studios").select("id, name"),
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    },
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить клубы" },
  });
}
