import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  accessKbBasesQuery,
  accessRoleNamesQuery,
  accessUsersQuery,
  networkStudiosQuery,
  orgBrandsQuery,
  orgPositionsQuery,
  orgUnitsQuery,
} from "@/lib/access/data";
import { isHiddenPermission } from "@/lib/launch";
import type { Names } from "@/lib/access/logic";

/** Имена клубов, брендов, подразделений, должностей и людей — для подписей. */
export function useAccessNames(withUsers = true): Names & {
  /** studio — у роли есть права «в клубе» (клубы назначения важны). */
  role: Map<string, { name: string; color: string | null; studio: boolean }>;
  kbBase: Map<string, string>;
} {
  const { data: studios } = useQuery(networkStudiosQuery);
  const { data: brands } = useQuery(orgBrandsQuery);
  const { data: units } = useQuery(orgUnitsQuery);
  const { data: positions } = useQuery(orgPositionsQuery);
  const { data: roles } = useQuery(accessRoleNamesQuery);
  const { data: bases } = useQuery(accessKbBasesQuery);
  const { data: users } = useQuery({ ...accessUsersQuery, enabled: withUsers });
  return useMemo(
    () => ({
      studio: new Map((studios ?? []).map((s) => [s.id, s.name])),
      brand: new Map((brands ?? []).map((b) => [b.id, b.name])),
      unit: new Map((units ?? []).map((u) => [u.id, u.name])),
      position: new Map((positions ?? []).map((p) => [p.id, p.name])),
      user: new Map((users ?? []).map((u) => [u.user_id, u.full_name || u.email || "—"])),
      role: new Map(
        (roles ?? []).map((r) => [
          r.id,
          {
            name: r.name,
            color: r.color,
            // Права «в клубе» без скрытых разделов (lib/launch.ts).
            studio: r.access_role_permissions.some(
              (p) =>
                !isHiddenPermission(p.perm_key) &&
                (p.perm_key === "studio.tier" ||
                  p.perm_key.startsWith("club.") ||
                  p.perm_key === "users.manage" ||
                  p.perm_key === "analytics.clubs"),
            ),
          },
        ]),
      ),
      kbBase: new Map((bases ?? []).map((b) => [b.id, b.title])),
    }),
    [studios, brands, units, positions, users, roles, bases],
  );
}
