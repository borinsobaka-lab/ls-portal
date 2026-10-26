import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAdminAccess } from "@/hooks/use-admin-access";
import { kbBasesQuery } from "@/lib/kb/data";

/** Последняя открытая база — в неё ведёт «База знаний» в рейке (/kb). */
export const KB_LAST_BASE_KEY = "kb_last_base";

export function readLastKbBase(): string | null {
  try {
    return window.localStorage.getItem(KB_LAST_BASE_KEY);
  } catch {
    return null;
  }
}

/** Базы, открытые сотруднику: владельцу — все, остальным — выданные в «Доступах». */
export function useMyKbBases() {
  const access = useAdminAccess();
  const query = useQuery(kbBasesQuery);
  const bases = useMemo(
    () => (query.data ?? []).filter((b) => access?.kbAdmin || !!access?.kb?.[b.id]),
    [query.data, access],
  );
  return { bases, loading: !access || query.isLoading };
}
