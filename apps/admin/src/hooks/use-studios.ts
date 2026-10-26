import { queryOptions, useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { unwrap } from "@/lib/query";
import { STAFF_ROLES, type StaffRole } from "@/lib/roles";
import type { ContentTranslations } from "@/lib/content-i18n";
import type { StudioFormat } from "@/lib/studio-formats";

export type Studio = {
  id: string;
  name: string;
  format: StudioFormat;
  brand_color: string;
  /** Путь в бакете studio-logos или полный URL. */
  logo_url: string | null;
  /** Адрес одной строкой — для клиентского приложения. */
  address: string | null;
  /**
   * Картинка клуба в клиентском приложении (выбор студии): путь в бакете
   * studio-logos или полный URL.
   */
  photo_url: string | null;
  /** Переводы для приложения: {en|ka: {name, address}} (lib/content-i18n.ts). */
  translations: ContentTranslations;
  created_at: string;
  /** Роли текущего сотрудника в этой студии. */
  roles: StaffRole[];
};

/**
 * Студии, где текущий пользователь — сотрудник (owner/admin/trainer).
 * Таблица studios читается публично, поэтому список ограничиваем своими
 * ролями явно — иначе в переключателе оказались бы все студии базы.
 *
 * Опции запроса отдельно от хука: их заранее загружает проверка входа
 * (`_authenticated/route.tsx`), чтобы меню не ждало своей очереди.
 */
export const studiosQuery = queryOptions({
  queryKey: ["studios"],
  queryFn: async (): Promise<Studio[]> => {
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) return [];
    const roles = await unwrap<{ studio_id: string; role: StaffRole }[]>(
      supabase
        .from("user_roles")
        .select("studio_id, role")
        .eq("user_id", userId)
        .in("role", STAFF_ROLES),
    );
    const ids = [...new Set(roles.map((r) => r.studio_id))];
    if (ids.length === 0) return [];
    const studios = await unwrap<Omit<Studio, "roles">[]>(
      supabase
        .from("studios")
        .select(
          "id, name, format, brand_color, logo_url, address, photo_url, translations, created_at",
        )
        .in("id", ids)
        .order("created_at"),
    );
    return studios.map((s) => ({
      ...s,
      roles: roles.filter((r) => r.studio_id === s.id).map((r) => r.role),
    }));
  },
  // Студии меняются редко; после правки в «Студиях» кэш инвалидируется.
  staleTime: Infinity,
  meta: { errorMessage: "Не удалось загрузить клубы" },
});

export function useStudios() {
  return useQuery(studiosQuery);
}

/** Студия, выбранная в шапке (null — ещё не загружены или не выбрана). */
export function useActiveStudio(): Studio | null {
  const id = useActiveStudioId();
  const { data } = useStudios();
  return data?.find((s) => s.id === id) ?? null;
}
