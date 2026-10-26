import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { networkStudiosQuery, orgBrandsQuery } from "@/lib/access/data";

export type PickItem = { id: string; label: string; sub?: string | null };

/** Клубы сети для выбора: название, бренд и город. */
export function useClubPickItems(): PickItem[] {
  const { data: studios } = useQuery(networkStudiosQuery);
  const { data: brands } = useQuery(orgBrandsQuery);
  return useMemo(() => {
    const brand = new Map((brands ?? []).map((b) => [b.id, b.short_name || b.name]));
    return (studios ?? []).map((s) => ({
      id: s.id,
      label: s.name,
      sub: [s.brand_id ? brand.get(s.brand_id) : null, s.city].filter(Boolean).join(", ") || null,
    }));
  }, [studios, brands]);
}
