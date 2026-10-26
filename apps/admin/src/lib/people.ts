/**
 * Люди портала — для упоминаний «@» и карточки сотрудника (решение владельца
 * 2026-10-27): короткие данные (имя, аватарка, должность) — RPC
 * `people_cards` пачкой, карточка — `person_card`. Схема —
 * db/migrations/2026-10-27_zzzz_people_cards.sql.
 */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { MemberRole, UserType } from "@/lib/access/types";

export type PersonShort = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  position_name: string | null;
};

export type PersonCard = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  position_name: string | null;
  user_type: UserType | null;
  blocked: boolean;
  active: boolean;
  units: { name: string; role: MemberRole }[];
  clubs: { name: string; role: "owner" | "admin" | "trainer" }[];
  owned_clubs: string[];
};

export const CLUB_ROLE_LABEL: Record<PersonCard["clubs"][number]["role"], string> = {
  owner: "Владелец",
  admin: "Администратор",
  trainer: "Тренер",
};

const SHORT_KEY = "people_short";

// Короткие данные запрашиваются пачкой: упоминания и строки списка просят
// каждый своего человека, а в базу уходит один вызов на кадр.
let pending = new Map<string, ((p: PersonShort | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  const batch = pending;
  pending = new Map();
  timer = null;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const { data, error } = await supabase.rpc("people_cards", { p_ids: part });
    const rows = new Map(((error ? [] : data) as PersonShort[]).map((r) => [r.user_id, r]));
    for (const id of part) for (const done of batch.get(id) ?? []) done(rows.get(id) ?? null);
  }
}

function loadShort(userId: string): Promise<PersonShort | null> {
  return new Promise((resolve) => {
    const list = pending.get(userId) ?? [];
    list.push(resolve);
    pending.set(userId, list);
    timer ??= setTimeout(() => void flush(), 0);
  });
}

/** Имя, аватарка и должность человека (упоминание, строка списка). */
export function usePersonShort(userId: string | null | undefined) {
  return useQuery({
    queryKey: [SHORT_KEY, userId],
    queryFn: () => loadShort(userId!),
    enabled: !!userId,
    staleTime: 10 * 60_000,
  });
}

/** Уже известные короткие данные (из списка кандидатов) — без запроса. */
export function primePeople(client: QueryClient, rows: PersonShort[]) {
  for (const r of rows) client.setQueryData([SHORT_KEY, r.user_id], r);
}

export function usePrimePeople() {
  const client = useQueryClient();
  return (rows: PersonShort[]) => primePeople(client, rows);
}

/** Карточка сотрудника: должность, подразделения, клубы, контакты. */
export function usePersonCard(userId: string | null) {
  return useQuery({
    queryKey: ["person_card", userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("person_card", { p_user: userId });
      if (error) throw new Error(error.message);
      return (data ?? null) as PersonCard | null;
    },
    enabled: !!userId,
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить карточку сотрудника" },
  });
}
