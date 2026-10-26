import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { isHiddenPermission, isHiddenRole } from "@/lib/launch";
import { accessErrorText } from "./logic";
import type {
  AccessLogRow,
  AccessMe,
  AccessRole,
  ExplainRow,
  NetworkStudio,
  OrgBrand,
  OrgMember,
  OrgPosition,
  OrgUnit,
  PermissionDef,
  PortalUserCard,
  PortalUserRow,
} from "./types";

/**
 * Данные раздела «Пользователи и роли»: чтение — таблицы под RLS и RPC
 * access_*, запись — только RPC (они сами проверяют права и пересчитывают
 * доступы). Схема — db/migrations/2026-10-25_zzzzzzzzzzzz_access_roles.sql.
 */
export const ACCESS_KEY = "access";

export async function accessRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(accessErrorText(error.message, error.details));
  return data as T;
}

/** Сбросить всё раздела — после любой записи (права пересчитываются каскадом). */
export function invalidateAccess(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: [ACCESS_KEY] }),
    // Свои права и меню могли поменяться (например, роль, выданная себе).
    qc.invalidateQueries({ queryKey: ["admin_permissions"] }),
    qc.invalidateQueries({ queryKey: ["studios"] }),
  ]);
}

/** Свои права — рейке, меню и кнопкам; заранее грузит проверка входа. */
export const accessMeQuery = queryOptions({
  queryKey: [ACCESS_KEY, "me"],
  queryFn: () => accessRpc<AccessMe>("access_me"),
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить права" },
});

export const accessCatalogQuery = queryOptions({
  queryKey: [ACCESS_KEY, "catalog"],
  queryFn: () =>
    unwrap<PermissionDef[]>(
      supabase
        .from("access_permissions")
        .select("key, block, label, hint, scope, levels, target, sort_order")
        .order("sort_order"),
    ),
  // Права скрытых разделов (lib/launch.ts) в ролях не показываются.
  select: (rows: PermissionDef[]) => rows.filter((p) => !isHiddenPermission(p.key)),
  staleTime: Infinity,
  meta: { errorMessage: "Не удалось загрузить каталог прав" },
});

export const accessRolesQuery = queryOptions({
  queryKey: [ACCESS_KEY, "roles"],
  queryFn: () => accessRpc<AccessRole[]>("access_roles_list"),
  // Стартовые роли клубов пока не показываются (lib/launch.ts).
  select: (rows: AccessRole[]) => rows.filter((r) => !isHiddenRole(r)),
  meta: { errorMessage: "Не удалось загрузить роли" },
});

export const accessUsersQuery = queryOptions({
  queryKey: [ACCESS_KEY, "users"],
  queryFn: () => accessRpc<PortalUserRow[]>("access_users"),
  meta: { errorMessage: "Не удалось загрузить пользователей" },
});

export function accessUserQuery(userId: string) {
  return queryOptions({
    queryKey: [ACCESS_KEY, "user", userId],
    queryFn: () => accessRpc<PortalUserCard>("access_user", { p_user: userId }),
    meta: { errorMessage: "Не удалось открыть пользователя" },
  });
}

export function accessExplainQuery(userId: string) {
  return queryOptions({
    queryKey: [ACCESS_KEY, "explain", userId],
    queryFn: () => accessRpc<ExplainRow[]>("access_explain", { p_user: userId }),
    meta: { errorMessage: "Не удалось загрузить источники прав" },
  });
}

export function accessLogQuery(userId: string | null, limit = 200) {
  return queryOptions({
    queryKey: [ACCESS_KEY, "log", userId, limit],
    queryFn: () => accessRpc<AccessLogRow[]>("access_log_list", { p_user: userId, p_limit: limit }),
    meta: { errorMessage: "Не удалось загрузить журнал" },
  });
}

export const orgUnitsQuery = queryOptions({
  queryKey: [ACCESS_KEY, "units"],
  queryFn: () =>
    unwrap<OrgUnit[]>(
      supabase
        .from("org_units")
        .select("id, parent_id, name, description, sort_order, path")
        .order("sort_order")
        .order("name"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить оргструктуру" },
});

export const orgMembersQuery = queryOptions({
  queryKey: [ACCESS_KEY, "members"],
  queryFn: () =>
    unwrap<OrgMember[]>(supabase.from("org_unit_members").select("unit_id, user_id, member_role")),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить состав подразделений" },
});

export const orgPositionsQuery = queryOptions({
  queryKey: [ACCESS_KEY, "positions"],
  queryFn: () =>
    unwrap<OrgPosition[]>(
      supabase
        .from("org_positions")
        .select("id, name, description, sort_order")
        .order("sort_order")
        .order("name"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить должности" },
});

export const orgBrandsQuery = queryOptions({
  queryKey: [ACCESS_KEY, "brands"],
  queryFn: () =>
    unwrap<OrgBrand[]>(
      supabase
        .from("org_brands")
        .select("id, name, short_name, color, sort_order")
        .order("sort_order")
        .order("name"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить бренды" },
});

/** Все клубы сети (studios читаются публично) — для областей назначений. */
export const networkStudiosQuery = queryOptions({
  queryKey: [ACCESS_KEY, "studios"],
  queryFn: () =>
    unwrap<NetworkStudio[]>(
      supabase.from("studios").select("id, name, format, brand_id, ownership, city").order("name"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить клубы" },
});

/** Базы знаний — для прав «База знаний» в роли (видны только доступные). */
export const accessKbBasesQuery = queryOptions({
  queryKey: [ACCESS_KEY, "kb-bases"],
  queryFn: () =>
    unwrap<{ id: string; title: string }[]>(
      supabase.from("kb_bases").select("id, title").order("sort_order").order("created_at"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить базы знаний" },
});

/** Названия и цвета ролей — для подписей (таблица видна всем людям портала). */
export const accessRoleNamesQuery = queryOptions({
  queryKey: [ACCESS_KEY, "role-names"],
  queryFn: () =>
    unwrap<
      {
        id: string;
        name: string;
        color: string | null;
        access_role_permissions: { perm_key: string }[];
      }[]
    >(
      supabase
        .from("access_roles")
        .select("id, name, color, access_role_permissions(perm_key)")
        .is("personal_user_id", null)
        .order("sort_order"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить роли" },
});
