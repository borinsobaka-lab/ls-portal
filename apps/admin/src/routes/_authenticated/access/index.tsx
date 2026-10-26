import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FileUp, UserPlus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { BulkActionsBar } from "@/components/access/bulk-actions";
import { ImportUsersDialog } from "@/components/access/import-users-dialog";
import { PageIntro, PersonLine, RoleChip, UserStatusChip } from "@/components/access/parts";
import { NewUserDialog } from "@/components/access/user-dialogs";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { AccessUsersPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  accessUsersQuery,
  networkStudiosQuery,
  orgUnitsQuery,
  studioOwnersQuery,
} from "@/lib/access/data";
import {
  lastSeenText,
  realEmail,
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
import { CLUBS_HIDDEN } from "@/lib/launch";

const ALL = "all";

const TIPS = {
  roles:
    "Действующие роли: свои и полученные через подразделение или должность (пунктиром). Личные права — в карточке.",
  studios: "Клубы, где у человека есть доступ к данным (по ролям).",
  status:
    "«Ещё не входил» — роли есть, но человек ни разу не входил. «Без ролей» — в портал не войдёт. «Доступ истёк» — прошла дата «Доступ до».",
  lastSeen: "Последний вход по коду из письма.",
  owned: "Клубы, где человек собственник («Оргструктура» → «Сеть клубов»), и их города.",
};

/** Текст-инструкция раздела (замечание тестирования 2026-10-27). */
const INTRO =
  "Все, у кого есть доступ к порталу: сотрудники УК, партнёры, сотрудники клубов. Вход — по коду на почту, без пароля; без роли человек не войдёт. Права удобнее давать через подразделение или должность — тогда новый человек получит их сам. Отметьте несколько строк — и проставьте им должность, тип, подразделение или роль разом.";

export const Route = createFileRoute("/_authenticated/access/")({
  head: () => ({ meta: [{ title: "Пользователи — Lady Stretch" }] }),
  pendingComponent: AccessUsersPageSkeleton,
  component: AccessUsersPage,
});

/**
 * «Пользователи» (Управление → Пользователи и роли, ACCESS.md): все люди
 * портала — сотрудники УК, партнёры, сотрудники клубов. Управляющему
 * клубами — люди его клубов и те, кого он завёл. Пока клубы скрыты
 * (lib/launch.ts), колонки и фильтра «Клубы» нет.
 */
function AccessUsersPage() {
  const navigate = useNavigate();
  const access = useAdminAccess();
  const names = useAccessNames();
  const { data: users, isLoading, error } = useQuery(accessUsersQuery);
  const { data: units } = useQuery(orgUnitsQuery);
  const { data: owners } = useQuery(studioOwnersQuery);
  const { data: studios } = useQuery(networkStudiosQuery);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [city, setCity] = useState(ALL);
  const [q, setQ] = useState("");
  const [studio, setStudio] = useState(ALL);
  const [role, setRole] = useState(ALL);
  const [unit, setUnit] = useState(ALL);
  const [status, setStatus] = useState<UserStatusKey | typeof ALL>(ALL);
  const [type, setType] = useState(ALL);
  const today = todayISO();
  const canAdd = hasRight(access, "users.manage");
  const canStructure = hasRight(access, "structure.manage");
  const canBulk = canAdd || canStructure;

  // Клубы собственника и их города — колонка, поиск и фильтр «Город».
  const owned = useMemo(() => {
    const club = new Map((studios ?? []).map((s) => [s.id, s]));
    const out = new Map<string, { name: string; city: string | null }[]>();
    for (const o of owners ?? []) {
      const s = club.get(o.studio_id);
      if (!s) continue;
      out.set(o.user_id, [...(out.get(o.user_id) ?? []), { name: s.name, city: s.city }]);
    }
    return out;
  }, [owners, studios]);
  const cities = useMemo(
    () =>
      [...new Set((studios ?? []).map((s) => s.city?.trim()).filter((c): c is string => !!c))].sort(
        (a, b) => a.localeCompare(b, "ru"),
      ),
    [studios],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/ё/g, "е");
    const inUnits = unit === ALL ? null : unitSubtree(units ?? [], unit);
    return (users ?? []).filter((u) => {
      const clubs = owned.get(u.user_id) ?? [];
      if (term) {
        // Поиск и по должности, подразделению, клубу и городу — не только по имени.
        const text = [
          u.full_name,
          realEmail(u.email),
          u.phone,
          u.position_id ? names.position.get(u.position_id) : null,
          u.user_type ? USER_TYPE_LABEL[u.user_type] : null,
          ...u.units.map((m) => names.unit.get(m.unit_id)),
          ...clubs.flatMap((c) => [c.name, c.city]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .replace(/ё/g, "е");
        if (!term.split(/\s+/).every((w) => text.includes(w))) return false;
      }
      if (city !== ALL && !clubs.some((c) => c.city?.trim() === city)) return false;
      if (studio !== ALL && !u.studio_ids.includes(studio)) return false;
      if (role !== ALL && !u.roles.some((r) => r.role_id === role)) return false;
      if (inUnits && !u.units.some((m) => inUnits.has(m.unit_id))) return false;
      if (status !== ALL && userStatus(u, today) !== status) return false;
      if (type !== ALL && (u.user_type ?? "none") !== type) return false;
      return true;
    });
  }, [users, units, owned, names, q, city, studio, role, unit, status, type, today]);

  const sort = useTableSort<PortalUserRow>({
    name: (u) => u.full_name ?? u.email,
    position: (u) => (u.position_id ? names.position.get(u.position_id) : null),
    owned: (u) => owned.get(u.user_id)?.[0]?.city ?? owned.get(u.user_id)?.[0]?.name ?? null,
    studios: (u) => u.studio_ids.length,
    status: (u) => STATUS_LABEL[userStatus(u, today)],
    seen: (u) => u.last_sign_in_at,
  });
  const pg = usePagination(sort.apply(filtered), undefined, sort.key, "access-users");
  const filtersActive =
    !!q ||
    city !== ALL ||
    studio !== ALL ||
    role !== ALL ||
    unit !== ALL ||
    status !== ALL ||
    type !== ALL;
  const reset = () => {
    setQ("");
    setCity(ALL);
    setStudio(ALL);
    setRole(ALL);
    setUnit(ALL);
    setStatus(ALL);
    setType(ALL);
  };

  // Отмечать можно тех, кем управляешь; «все» — отфильтрованные целиком.
  const selectable = filtered.filter((u) => u.can_manage || canStructure);
  const allSelected = selectable.length > 0 && selectable.every((u) => selected.has(u.user_id));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const bulkUsers = (users ?? [])
    .filter((u) => selected.has(u.user_id))
    .map((u) => ({ id: u.user_id, label: u.full_name || realEmail(u.email) || "Без имени" }));
  const cols = (CLUBS_HIDDEN ? 6 : 7) + (canBulk ? 1 : 0);

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
          <>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp />
              Импорт
            </Button>
            <Button onClick={() => setAdding(true)}>
              <UserPlus />
              Добавить
            </Button>
          </>
        ) : null
      }
    >
      <div className="space-y-3">
        <PageIntro id="users">{INTRO}</PageIntro>
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
              <ToolbarSearch
                value={q}
                onChange={setQ}
                placeholder="Имя, почта, должность, отдел, клуб или город"
              />
              {/* Клубы пока скрыты (lib/launch.ts) — фильтра и колонки «Клубы» нет. */}
              {!CLUBS_HIDDEN && (
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
              )}
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
              {cities.length > 0 && (
                <Select value={city} onValueChange={setCity}>
                  <SelectTrigger aria-label="Город" className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Все города</SelectItem>
                    {cities.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <ToolbarReset active={filtersActive} onReset={reset} />
            </TableToolbar>
            <BulkActionsBar
              users={bulkUsers}
              canManageUsers={canAdd}
              canEditStructure={canStructure}
              onClear={() => setSelected(new Set())}
            />
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canBulk && (
                      <TableHead className="w-10">
                        <Checkbox
                          aria-label="Отметить всех найденных"
                          checked={allSelected}
                          onCheckedChange={(on) =>
                            setSelected(on ? new Set(selectable.map((u) => u.user_id)) : new Set())
                          }
                        />
                      </TableHead>
                    )}
                    <TableHead {...sort.head("name")}>Пользователь</TableHead>
                    <TableHead {...sort.head("position")}>Должность и подразделение</TableHead>
                    <TableHead tip={TIPS.owned} {...sort.head("owned")}>
                      Клубы собственника
                    </TableHead>
                    <TableHead tip={TIPS.roles}>Роли</TableHead>
                    {!CLUBS_HIDDEN && (
                      <TableHead tip={TIPS.studios} {...sort.head("studios")}>
                        Клубы
                      </TableHead>
                    )}
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
                    <TableSkeletonRows columns={cols} rows={6} />
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={cols}
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
                        data-state={selected.has(u.user_id) ? "selected" : undefined}
                        onClick={() =>
                          void navigate({
                            to: "/access/users/$userId",
                            params: { userId: u.user_id },
                          })
                        }
                      >
                        {canBulk && (
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              aria-label={`Отметить: ${u.full_name ?? ""}`}
                              disabled={!u.can_manage && !canStructure}
                              checked={selected.has(u.user_id)}
                              onCheckedChange={(on) => toggle(u.user_id, on === true)}
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <Link
                            to="/access/users/$userId"
                            params={{ userId: u.user_id }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <PersonLine
                              name={u.full_name}
                              email={realEmail(u.email) ?? "без почты"}
                              avatar={u.avatar_url}
                            />
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
                        <TableCell className="text-sm">
                          {(owned.get(u.user_id) ?? []).length === 0 ? (
                            "—"
                          ) : (
                            <OwnedClubs clubs={owned.get(u.user_id) ?? []} />
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
                        {!CLUBS_HIDDEN && (
                          <TableCell className="text-sm">
                            {u.studio_ids.length === 0
                              ? "—"
                              : u.studio_ids.length <= 2
                                ? u.studio_ids.map((id) => names.studio.get(id)).join(", ")
                                : `${u.studio_ids.length} клубов`}
                          </TableCell>
                        )}
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
      <ImportUsersDialog open={importing} onOpenChange={setImporting} />
    </AdminShell>
  );
}

function OwnedClubs({ clubs }: { clubs: { name: string; city: string | null }[] }) {
  const shown = clubs.slice(0, 2);
  return (
    <div className="max-w-60">
      {shown.map((c) => (
        <div key={c.name} className="truncate">
          {c.name}
          {c.city && <span className="text-muted-foreground"> · {c.city}</span>}
        </div>
      ))}
      {clubs.length > 2 && (
        <div className="text-xs text-muted-foreground">и ещё {clubs.length - 2}</div>
      )}
    </div>
  );
}
