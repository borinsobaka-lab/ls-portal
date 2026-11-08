/**
 * Люди для чатов — справочник «Компании» (RPC company_people: имя, аватарка,
 * должность, «в сети»), один запрос на весь портал. Ушедших с портала в
 * справочнике нет — их имя «Бывший сотрудник».
 */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { companyPeopleQuery, type CompanyPerson } from "@/lib/company";

export function usePeople() {
  const { data = [], isPending } = useQuery(companyPeopleQuery);
  const byId = useMemo(() => new Map(data.map((p) => [p.user_id, p])), [data]);
  const name = useCallback(
    (id: string | null | undefined) =>
      (id && byId.get(id)?.full_name) || (id ? "Бывший сотрудник" : "Портал"),
    [byId],
  );
  const person = useCallback(
    (id: string | null | undefined): CompanyPerson | undefined => (id ? byId.get(id) : undefined),
    [byId],
  );
  return { people: data, byId, name, person, loading: isPending };
}

/** Короткое имя для превью группы: «Анна», а не «Иванова Анна». */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : full;
}
