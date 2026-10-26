import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useViewedStudioId } from "@/hooks/use-viewed-studio";
import { type Translator, currentT } from "@/i18n";

export type ClubSettings = {
  write_url: string | null;
  call_url: string | null;
  cancel_booking_minutes: number;
};

const DEFAULTS: ClubSettings = {
  write_url: null,
  call_url: null,
  cancel_booking_minutes: 180,
};

// «Контакты и правила» — у каждой студии свои (feedback_url с 2026-10-15 не
// читается: «Фидбэк» — своя форма, routes/feedback.tsx): studio_app_settings
// (db/migrations/2026-10-11_zzzzzzzzzz_app_content_by_studio.sql, правятся в
// админке). Строки нет (новая студия) — значения по умолчанию. Клиент без
// карточки (студия неизвестна) — прежний общий синглтон club_settings.
// Ошибку пробрасываем: раньше сбой запроса превращался в DEFAULTS и
// кэшировался до перезагрузки страницы (без быстрых действий и с чужим
// дедлайном отмены). Кэш — React Query по студии (настройки меняются редко,
// а читают их главная и расписание).
async function fetchSettings(studioId: string | null): Promise<ClubSettings> {
  const columns = "write_url, call_url, cancel_booking_minutes";
  const { data, error } = studioId
    ? await supabase
        .from("studio_app_settings")
        .select(columns)
        .eq("studio_id", studioId)
        .maybeSingle()
    : await supabase.from("club_settings").select(columns).eq("id", true).maybeSingle();
  if (error) throw error;
  return data ? { ...DEFAULTS, ...data } : DEFAULTS;
}

/**
 * which: "viewed" — смотримая студия (переключатель пакетного приложения:
 * кнопки главной), "home" — своя студия клиента (срок отмены его записей).
 */
export function useClubSettings(which: "viewed" | "home" = "viewed"): ClubSettings {
  const viewed = useViewedStudioId();
  const studioReady = viewed.studioReady;
  const studioId = which === "home" ? viewed.homeStudioId : viewed.studioId;
  const { data } = useQuery({
    queryKey: ["club-settings", studioId],
    queryFn: () => fetchSettings(studioId),
    enabled: studioReady,
    staleTime: 5 * 60_000,
  });
  // При ошибке — значения по умолчанию; следующее монтирование попробует снова.
  return data ?? DEFAULTS;
}

/** «3ч», «1ч 30мин», «45мин» — срок отмены записи. t — переводчик экрана (useT()). */
export function formatCancelDeadline(minutes: number, t: Translator = currentT()): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return t("{h}ч {m}мин", { h, m });
  if (h) return t("{h}ч", { h });
  return t("{m}мин", { m });
}
