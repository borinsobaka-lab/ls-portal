import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { supabase } from "@/integrations/supabase/client";

export type StaffProfile = {
  id: string;
  email: string | null;
  fullName: string | null;
  /** Аватарка — путь в бакете avatars (ставит владелец в «Доступах»). */
  avatarUrl: string | null;
  /** Как подписывать действия сотрудника: ФИО, иначе почта. */
  displayName: string;
};

export const staffProfileQuery = queryOptions({
  queryKey: ["staff-profile"],
  queryFn: async (): Promise<StaffProfile | null> => {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name, email, avatar_url")
      .eq("id", user.id)
      .maybeSingle();
    const fullName = (prof?.full_name as string | null | undefined) || null;
    const email = (prof?.email as string | null | undefined) || user.email || null;
    const avatarUrl = (prof?.avatar_url as string | null | undefined) || null;
    return { id: user.id, email, fullName, avatarUrl, displayName: fullName || email || "" };
  },
  staleTime: Infinity,
});

/**
 * Текущий сотрудник (кто продаёт, кто закрыл отзыв и т. п.). Профиль
 * загружается один раз и кэшируется на всю сессию вкладки.
 *
 * Для записи в БД берите `await ensure()`, а не `data`: если нажать
 * «Сохранить» до окончания загрузки, `data` ещё пуст и подпись записалась бы
 * как null.
 */
export function useStaffProfile() {
  const queryClient = useQueryClient();
  const { data } = useQuery(staffProfileQuery);
  const ensure = useCallback(() => queryClient.ensureQueryData(staffProfileQuery), [queryClient]);
  return { data, ensure };
}
