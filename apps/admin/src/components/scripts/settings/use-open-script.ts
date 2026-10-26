import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * Открыть скрипт (раздел + ?item=) или раздел-звонок целиком. Ведём по id:
 * если скрипт перенесли в другой раздел, ссылку строим по тому, где он сейчас.
 */
export function useOpenScript() {
  const navigate = useNavigate();
  return useCallback(
    (sectionId: string, itemId?: string) =>
      navigate({
        to: "/scripts/$sectionId",
        params: { sectionId },
        search: itemId ? { item: itemId } : {},
      }),
    [navigate],
  );
}
