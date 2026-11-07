import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Phone } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { CompanyPeoplePageSkeleton } from "@/components/page-skeletons";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonCardDialog } from "@/components/people/person-card";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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
import { MEMBER_ROLE_LABEL, USER_TYPE_LABEL, USER_TYPES } from "@/lib/access/logic";
import { PORTAL_NAME } from "@/lib/brand";
import {
  companyPeopleQuery,
  companyStructureQuery,
  isOnline,
  lastSeenLabel,
  matchPerson,
  unitChildren,
  unitWithDescendants,
} from "@/lib/company";
import { cn } from "@/lib/utils";

/**
 * «Компания» → «Сотрудники» (TASKS_CHATS_PLAN.md, веха 1; бриф 8.3, боль
 * № 42): все действующие люди портала — поиск по имени, почте, телефону,
 * должности, подразделению, клубу и городу; фильтры по должности (как в
 * Платруме), подразделению (с подразделениями ниже), типу, «в сети».
 * Строка — карточка сотрудника. Партнёры видят друг друга (решение
 * владельца 2026-11-07).
 */
export const Route = createFileRoute("/_authenticated/company/")({
  head: () => ({ meta: [{ title: `Сотрудники — ${PORTAL_NAME}` }] }),
  pendingComponent: CompanyPeoplePageSkeleton,
  component: CompanyPeoplePage,
});

const ALL = "all";
const NONE = "none";

function CompanyPeoplePage() {
  const { data: people = [], isPending } = useQuery(companyPeopleQuery);
  const { data: units = [] } = useQuery(companyStructureQuery);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState(ALL);
  const [unit, setUnit] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const positions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people)
      if (p.position_id && p.position_name) map.set(p.position_id, p.position_name);
    return [...map].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [people]);

  // Подразделения списком с отступом по глубине — для выбора.
  const unitOptions = useMemo(() => {
    const children = unitChildren(units);
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const u of children.get(parent) ?? []) {
        out.push({ id: u.id, name: u.name, depth });
        walk(u.id, depth + 1);
      }
    };
    walk(null, 0);
    return { list: out, children };
  }, [units]);

  const unitIds = useMemo(
    () => (unit === ALL ? null : unitWithDescendants(unitOptions.children, unit)),
    [unit, unitOptions],
  );

  const now = Date.now();
  const filtered = useMemo(
    () =>
      people.filter(
        (p) =>
          matchPerson(p, search) &&
          (position === ALL || (position === NONE ? !p.position_id : p.position_id === position)) &&
          (!unitIds || p.units.some((u) => unitIds.has(u.id))) &&
          (type === ALL || p.user_type === type) &&
          (!onlineOnly || isOnline(p.last_seen_at, now)),
      ),
    [people, search, position, unitIds, type, onlineOnly, now],
  );
  const onlineCount = people.filter((p) => isOnline(p.last_seen_at, now)).length;
  const pg = usePagination(
    filtered,
    undefined,
    [search, position, unit, type, onlineOnly].join("|"),
    "company-people",
  );
  const filtersActive = !!search || position !== ALL || unit !== ALL || type !== ALL || onlineOnly;

  return (
    <AdminShell title="Сотрудники">
      <div className="space-y-3">
        <TableToolbar>
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Имя, должность, отдел, город, телефон"
          />
          <Select value={position} onValueChange={setPosition}>
            <SelectTrigger className="w-48" aria-label="Должность">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все должности</SelectItem>
              <SelectItem value={NONE}>Без должности</SelectItem>
              {positions.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={unit} onValueChange={setUnit}>
            <SelectTrigger className="w-48" aria-label="Подразделение">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все подразделения</SelectItem>
              {unitOptions.list.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  <span style={{ paddingLeft: `${u.depth * 12}px` }}>{u.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-48" aria-label="Тип">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все типы</SelectItem>
              {USER_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {USER_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex h-10 items-center gap-2 px-1">
            <Switch id="online-only" checked={onlineOnly} onCheckedChange={setOnlineOnly} />
            <Label htmlFor="online-only" className="cursor-pointer whitespace-nowrap">
              В сети{onlineCount ? ` · ${onlineCount}` : ""}
            </Label>
          </div>
          <ToolbarReset
            active={filtersActive}
            onReset={() => {
              setSearch("");
              setPosition(ALL);
              setUnit(ALL);
              setType(ALL);
              setOnlineOnly(false);
            }}
          />
        </TableToolbar>

        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Сотрудник</TableHead>
                <TableHead>Подразделение</TableHead>
                <TableHead>Клубы и города</TableHead>
                <TableHead>Контакты</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableSkeletonRows rows={8} columns={5} />
              ) : pg.paged.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    {people.length === 0 ? "Пока никого нет." : "Никого не нашли."}
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((p) => {
                  const online = isOnline(p.last_seen_at, now);
                  return (
                    <TableRow
                      key={p.user_id}
                      className="cursor-pointer"
                      onClick={() => setOpenId(p.user_id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="relative shrink-0">
                            <StaffAvatar
                              value={p.avatar_url}
                              name={p.full_name}
                              className="size-9 text-xs"
                            />
                            {online && (
                              <span
                                aria-hidden
                                className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
                              />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.full_name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {p.position_name ?? (p.user_type ? USER_TYPE_LABEL[p.user_type] : "")}
                            </span>
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.units.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="block max-w-64 space-y-0.5 text-sm">
                            {p.units.slice(0, 2).map((u) => (
                              <span key={u.id} className="block truncate">
                                {u.name}
                                {u.role !== "member" && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · {MEMBER_ROLE_LABEL[u.role].toLowerCase()}
                                  </span>
                                )}
                              </span>
                            ))}
                            {p.units.length > 2 && (
                              <span className="text-xs text-muted-foreground">
                                и ещё {p.units.length - 2}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.clubs.length === 0 && p.cities.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="block max-w-64 text-sm">
                            {p.cities.length > 0 && (
                              <span className="block truncate">{p.cities.join(", ")}</span>
                            )}
                            {p.clubs.length > 0 && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {p.clubs.map((c) => c.name).join(", ")}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <span className="block space-y-0.5 text-sm">
                          {p.phone && (
                            <a
                              href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}
                              className="flex items-center gap-1.5 hover:underline"
                            >
                              <Phone className="size-3.5 text-muted-foreground" /> {p.phone}
                            </a>
                          )}
                          {p.email && (
                            <a
                              href={`mailto:${p.email}`}
                              className="flex max-w-56 items-center gap-1.5 truncate hover:underline"
                            >
                              <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">{p.email}</span>
                            </a>
                          )}
                          {!p.phone && !p.email && <span className="text-muted-foreground">—</span>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "text-sm whitespace-nowrap",
                            online ? "font-medium text-emerald-700" : "text-muted-foreground",
                          )}
                        >
                          {lastSeenLabel(p.last_seen_at)}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={isPending} />
        </div>
      </div>
      <PersonCardDialog userId={openId} onClose={() => setOpenId(null)} />
    </AdminShell>
  );
}
