/**
 * Дни рождения и отсутствия — запросы (RPC `people_*`). Ключи
 * ["people_absences"], ["people_birthdays"], ["people_birthday", id].
 */
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import {
  addDaysISO,
  localISO,
  type Absence,
  type AbsenceKind,
  type BirthdayInfo,
  type UpcomingBirthday,
} from "./people-calendar";

const rpc = async <T>(fn: string, args?: Record<string, unknown>) =>
  (await unwrap<T>(supabase.rpc(fn, args))) as T;

/** Отсутствия с позавчера на 90 дней вперёд — одним запросом на весь портал. */
export const absencesQuery = queryOptions({
  queryKey: ["people_absences"],
  queryFn: async () => {
    const today = localISO();
    return (
      (await rpc<Absence[] | null>("people_absences_list", {
        p_from: addDaysISO(today, -2),
        p_to: addDaysISO(today, 90),
      })) ?? []
    );
  },
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить отсутствия" },
});

export function useAbsences() {
  const { data = [] } = useQuery(absencesQuery);
  return data;
}

export const birthdaysQuery = (days = 30) =>
  queryOptions({
    queryKey: ["people_birthdays", days],
    queryFn: async () =>
      (await rpc<UpcomingBirthday[] | null>("people_birthdays_upcoming", { p_days: days })) ?? [],
    staleTime: 10 * 60_000,
    meta: { errorMessage: "Не удалось загрузить дни рождения" },
  });

export const birthdayQuery = (userId: string) =>
  queryOptions({
    queryKey: ["people_birthday", userId],
    queryFn: () => rpc<BirthdayInfo>("people_birthday_get", { p_user: userId }),
    staleTime: 10 * 60_000,
  });

export function useTodayISO() {
  return useMemo(() => localISO(), []);
}

export async function saveBirthday(
  qc: QueryClient,
  userId: string,
  date: string | null,
  showYear: boolean,
) {
  await rpc("people_birthday_save", { p_user: userId, p_date: date, p_show_year: showYear });
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["people_birthday", userId] }),
    qc.invalidateQueries({ queryKey: ["people_birthdays"] }),
  ]);
}

export async function saveAbsence(
  qc: QueryClient,
  a: {
    id?: string | null;
    user_id: string;
    kind: AbsenceKind;
    starts_on: string;
    ends_on: string;
    note?: string;
  },
) {
  await rpc("people_absence_save", {
    p_id: a.id ?? null,
    p_user: a.user_id,
    p_kind: a.kind,
    p_from: a.starts_on,
    p_to: a.ends_on,
    p_note: a.note ?? null,
  });
  await qc.invalidateQueries({ queryKey: ["people_absences"] });
}

export async function deleteAbsence(qc: QueryClient, id: string) {
  await rpc("people_absence_delete", { p_id: id });
  await qc.invalidateQueries({ queryKey: ["people_absences"] });
}

export function peopleErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("people_forbidden"))
    return "Это может сам сотрудник, его руководитель или тот, кто управляет пользователями";
  if (msg.includes("people_birthday_invalid")) return "Проверьте дату рождения";
  if (msg.includes("people_absence_invalid"))
    return "Проверьте даты: «по» не раньше «с», не больше года";
  return msg;
}
