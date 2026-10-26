import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useClientStudioId } from "@/hooks/use-client-studio";
import type { StudioFormat } from "@/lib/app-format";
import type { ContentTranslations } from "@/i18n";

export type Studio = {
  id: string;
  name: string;
  format: StudioFormat;
  /** Основной цвет студии (#rrggbb). В приложении пока не применяется. */
  brand_color: string;
  /** Путь в бакете studio-logos или полный URL. */
  logo_url: string | null;
  /** Адрес одной строкой (db/migrations/…_studio_address.sql) — только в useFormatStudios. */
  address?: string | null;
  /**
   * Картинка клуба в выборе студии (studios.photo_url — путь в бакете
   * studio-logos или полный URL; db/migrations/2026-10-14_zz_app_sign_in_closed_studio_photo.sql)
   * — только в useFormatStudios.
   */
  photo_url?: string | null;
  /** Переводы названия и адреса (src/i18n/content.ts). */
  translations?: ContentTranslations | null;
};

const STUDIO_COLUMNS = "id, name, format, brand_color, logo_url, translations";

// Таблица studios читается публично (db/migrations/2026-10-09_studio_formats.sql), в том числе до
// входа. Пока миграция не выполнена, колонки format нет и запросы падают —
// тогда хук отдаёт null, и приложение ведёт себя как до разделения
// форматов (без проверки формата).

/** Студия текущего клиента (по карточке clients.studio_id). */
export function useClientStudio(): Studio | null {
  const { studioId } = useClientStudioId();
  const { data } = useQuery({
    queryKey: ["studio", studioId],
    queryFn: async (): Promise<Studio | null> => {
      const { data, error } = await supabase
        .from("studios")
        .select(STUDIO_COLUMNS)
        .eq("id", studioId!)
        .maybeSingle();
      if (error) throw error;
      return (data as Studio | null) ?? null;
    },
    enabled: !!studioId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data ?? null;
}
