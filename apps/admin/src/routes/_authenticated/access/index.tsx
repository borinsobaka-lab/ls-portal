import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { UserPlus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { PersonLine, RoleChip, UserStatusChip } from "@/components/access/parts";
import { NewUserDialog } from "@/components/access/user-dialogs";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { AccessUsersPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useTableSort } from "@/hooks/use-table-sort";
import { hasRight } from "@/lib/admin-access";
import { accessUsersQuery, orgUnitsQuery } from "@/lib/access/data";
import {
  lastSeenText,
  STATUS_LABEL,
  unitSubtree,
  unitTree,
  USER_TYPE_LABEL,
  USER_TYPES,
  userStatus,
  type UserStatusKey,
} from "@/lib/access/logic";
import type { PortalUserRow } from "@/lib/access/types";
import { todayISO } from "@/lib/format";
import { useAccessNames } from "@/hooks/use-access-names";

const ALL = "all";

const TIPS = {
  roles:
    "Действующие роли: свои и полученные через подразделение или должность (пунктиром). Личные права — в карточке.",
  studios: "Клубы, где у человека есть доступ к данным (по ролям).",
  status:
    "«Ещё не входил» — роли есть, но человек ни разу не входил. «Без ролей» — в портал не войдёт. «Доступ истёк» — прошла дата «Доступ до».",
  lastSeen: "Последний вход по коду из письма.",
};

export const Route = createFileRoute("/_authenticated/access/")({
  head: () => ({ meta: [{ title: "Пользователи — Base40 Admin" }] }),
  pendingComponent: AccessUsersPageSkeleton,
  component: AccessUsersPage,
});

/**
 * «Пользователи» (Управление → Пользователи и роли, ACCESS.md): все люди
 * портала — сотрудники УК, партнёры, сотрудники клубов. Управляющему
 * клубами — люди его клубов и те, кого он завёл.
 */
function AccessUsersPage() {
  const navigate = useNavigate();
  const access = useAdminAccess();
  const names = useAccessNames();
  const { data: users, isLoading, error } = useQuery(accessUsersQuery);
  const { data: units } = useQuery(orgUnitsQuery);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [studio, setStudio] = useState(ALL);
  const [role, setRole] = useState(ALL);
  const [unit, setUnit] = useState(ALL);
  const [status, setStatus] = useState<UserStatusKey | typeof ALL>(ALL);
  const [type, setType] = useState(ALL);
  const today = todayISO();
  const canAdd = hasRight(access, "users.manage");

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const inUnits = unit === ALL ? null : unitSubtree(units ?? [], unit);
    return (users ?? []).filter((u) => {
      if (
        term &&
        !`${u.full_name ?? ""} ${u.email ?? ""} ${u.phone ?? ""}`.toLowerCase().includes(term)
      )
        return false;
      if (studio !== ALL && !u.studio_ids.includes(studio)) return false;
      if (role !== ALL && !u.roles.some((r) => r.role_id === role)) return false;
      if (inUnits && !u.units.some((m) => inUnits.has(m.unit_id))) return false;
      if (status !== ALL && userStatus(u, today) !== status) return false;
      if (type !== ALL && (u.user_type ?? "none") !== type) return false;
      return true;
    });
  }, [users, units, q, studio, role, unit, status, type, today]);

  const sort = useTableSort<PortalUserRow>({
    name: (u) => u.full_name ?? u.email,
    position: (u) => (u.position_id ? names.position.get(u.position_id) : null),
    studios: (u) => u.studio_ids.length,
    status: (u) => STATUS_LABEL[userStatus(u, today)],
    seen: (u) => u.last_sign_in_at,
  });
  const pg = usePagination(sort.apply(filtered), undefined, sort.key);
  const filtersActive =
    !!q || studio !== ALL || role !== ALL || unit !== ALL || status !== ALL || type !== ALL;
  const reset = () => {
    setQ("");
    setStudio(ALL);
    setRole(ALL);
    setUnit(ALL);
    setStatus(ALL);
    setType(ALL);
  };

  const counts = useMemo(() => {
    const c: Partial<Record<UserStatusKey, number>> = {};
    for (const u of users ?? []) {
      const s = userStatus(u, today);
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [users, today]);

  return (
    <AdminShell
      title="Пользователи"
      actions={
        canAdd ? (
          <Button onClick={() => setAdding(true)}>
            <UserPlus />
            Добавить
          </Button>
        ) : null
      }
    >
      <div className="space-y-3">
        {error && !users ? (
          <InfoNote variant="warning">{error.message}</InfoNote>
        ) : (
          <>
            {users && (
              <p className="text-sm text-muted-foreground">
                Всего: {users.length}
                {(["active", "invited", "no_roles", "expired", "blocked"] as const)
                  .filter((s) => counts[s])
                  .map((s) => ` · ${STATUS_LABEL[s].toLowerCase()}: ${counts[s]}`)
                  .join("")}
              </p>
            )}
            <TableToolbar>
              <ToolbarSearch value={q} onChange={setQ} placeholder="Имя, почта или телефон" />
              <Select value={studio} onValueChange={setStudio}>
                <SelectTrigger aria-label="Клуб" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все клубы</SelectItem>
                  {[...names.studio].map(([id, name]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger aria-label="Роль" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все роли</SelectItem>
                  {[...names.role].map(([id, r]) => (
                    <SelectItem key={id} value={id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger aria-label="Подразделение" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все подразделения</SelectItem>
                  {unitTree(units ?? []).map(({ unit: u, depth }) => (
                    <SelectItem key={u.id} value={u.id}>
                      {"  ".repeat(depth)}
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={(v) => setStatus(v as UserStatusKey | "all")}>
                <SelectTrigger aria-label="Статус" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все статусы</SelectItem>
                  {(Object.keys(STATUS_LABEL) as UserStatusKey[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger aria-label="Тип" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все типы</SelectItem>
                  {USER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {USER_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">Тип не указан</SelectItem>
                </SelectContent>
              </Select>
              <ToolbarReset active={filtersActive} onReset={reset} />
            </TableToolbar>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead {...sort.head("name")}>Пользователь</TableHead>
                    <TableHead {...sort.head("position")}>Должность</TableHead>
                    <TableHead tip={TIPS.roles}>Роли</TableHead>
                    <TableHead tip={TIPS.studios} {...sort.head("studios")}>
                      Клубы
                    </TableHead>
                    <TableHead tip={TIPS.status} {...sort.head("status")}>
                      Статус
                    </TableHead>
                    <TableHead tip={TIPS.lastSeen} {...sort.head("seen")}>
                      Последний вход
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableSkeletonRows columns={6} rows={6} />
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        {filtersActive ? "Никого не нашлось" : "Пользователей пока нет"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    pg.paged.map((u) => (
                      <TableRow
                        key={u.user_id}
                        className="cursor-pointer"
                        onClick={() =>
                          void navigate({
                            to: "/access/users/$userId",
                            params: { userId: u.user_id },
                          })
                        }
                      >
                        <TableCell>
                          <Link
                            to="/access/users/$userId"
                            params={{ userId: u.user_id }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <PersonLine name={u.full_name} email={u.email} avatar={u.avatar_url} />
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>{u.position_id ? names.position.get(u.position_id) : "—"}</div>
                          {u.units.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {u.units.map((m) => names.unit.get(m.unit_id)).join(", ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-80 flex-wrap gap-1">
                            {u.roles
                              .filter((r) => !r.personal)
                              .map((r) => {
                                const info = names.role.get(r.role_id);
                                return (
                                  <RoleChip
                                    key={r.assignment_id}
                                    name={info?.name ?? "Роль"}
                                    color={info?.color}
                                    muted={r.subject_type !== "user"}
                                  />
                                );
                              })}
                            {u.roles.some((r) => r.personal) && (
                              <span className="text-xs text-muted-foreground">+ личные права</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {u.studio_ids.length === 0
                            ? "—"
                            : u.studio_ids.length <= 2
                              ? u.studio_ids.map((id) => names.studio.get(id)).join(", ")
                              : `${u.studio_ids.length} клубов`}
                        </TableCell>
                        <TableCell>
                          <UserStatusChip status={userStatus(u, today)} />
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                          {lastSeenText(u.last_sign_in_at)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              {users && <DataPagination {...pg} />}
            </div>
          </>
        )}
      </div>
      <NewUserDialog open={adding} onOpenChange={setAdding} />
    </AdminShell>
  );
}
