import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/** Карточка клиента (clients) — поля, которые показывают главная и «Профиль». */
export type ClientCard = {
  id?: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  birthday?: string | null;
  gender?: string | null;
  photo_url?: string | null;
};

/**
 * Своя карточка клиента. Один ключ кэша у главной (имя и аватар в шапке) и
 * «Профиля»: открытый на одном экране, на другом он показывается сразу.
 */
export function clientCardQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["client-card", userId],
    queryFn: async (): Promise<ClientCard | null> => {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return (data as ClientCard | null) ?? null;
    },
    enabled: !!userId,
  });
}
