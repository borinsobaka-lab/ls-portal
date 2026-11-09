import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import {
  CompanyStructurePageSkeleton,
  CompanyStructureTreeSkeleton,
} from "@/components/page-skeletons";
import { PersonChip } from "@/components/people/person-card";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { MEMBER_ROLE_LABEL } from "@/lib/access/logic";
import { hasRight } from "@/lib/admin-access";
import { PORTAL_NAME } from "@/lib/brand";
import {
  companyPeopleQuery,
  companyStructureQuery,
  isOnline,
  unitChildren,
  type CompanyPerson,
  type CompanyUnit,
} from "@/lib/company";
import { cn } from "@/lib/utils";

/**
 * «Компания» → «Структура» (бриф 8.1): подразделения деревом, у каждого —
 * руководители, заместители и сотрудники; кто за что отвечает. Только
 * просмотр: правят в «Управлении» → «Пользователи и роли» → «Оргструктура».
 * Поиск — по названию подразделения и по людям (подразделения, где человек
 * есть, раскрываются).
 */
export const Route = createFileRoute("/_authenticated/company/structure")({
  head: () => ({ meta: [{ title: `Структура компании — ${PORTAL_NAME}` }] }),
  pendingComponent: CompanyStructurePageSkeleton,
  component: CompanyStructurePage,
});

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

function CompanyStructurePage() {
  const { data: units = [], isPending } = useQuery(companyStructureQuery);
  const { data: people = [] } = useQuery(companyPeopleQuery);
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const access = useAdminAccess();
  const canManage = hasRight(access, "structure.manage");

  const byId = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);
  const children = useMemo(() => unitChildren(units), [units]);

  // Совпавшие подразделения и все их предки — видны; без поиска — все.
  const visible = useMemo(() => {
    const q = norm(search.trim());
    if (!q) return null;
    const parent = new Map(units.map((u) => [u.id, u.parent_id]));
    const out = new Set<string>();
    for (const u of units) {
      const hit =
        norm(u.name).includes(q) ||
        u.members.some((m) => norm(byId.get(m.user_id)?.full_name ?? "").includes(q));
      if (!hit) continue;
      let cur: string | null = u.id;
      while (cur && !out.has(cur)) {
        out.add(cur);
        cur = parent.get(cur) ?? null;
      }
    }
    return out;
  }, [search, units, byId]);

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const roots = children.get(null) ?? [];

  return (
    <AdminShell title="Структура компании">
      <div className="space-y-3">
        <TableToolbar>
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Подразделение или сотрудник"
          />
          {closed.size > 0 ? (
            <Button variant="outline" onClick={() => setClosed(new Set())}>
              <ChevronDown /> Раскрыть все
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={units.length === 0}
              onClick={() =>
                setClosed(new Set(units.filter((u) => children.has(u.id)).map((u) => u.id)))
              }
            >
              <ChevronUp /> Свернуть все
            </Button>
          )}
        </TableToolbar>

        {isPending ? (
          <CompanyStructureTreeSkeleton />
        ) : roots.length === 0 ? (
          <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
            Оргструктуру ещё не завели.
            {canManage
              ? " Её ведут в «Управлении» → «Пользователи и роли» → «Оргструктура»."
              : " Когда её заполнят, здесь появятся отделы и кто за что отвечает."}
          </div>
        ) : (
          <div className="space-y-2">
            {roots
              .filter((u) => !visible || visible.has(u.id))
              .map((u) => (
                <UnitNode
                  key={u.id}
                  unit={u}
                  depth={0}
                  tree={children}
                  byId={byId}
                  visible={visible}
                  closed={visible ? new Set() : closed}
                  toggle={toggle}
                />
              ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function UnitNode({
  unit,
  depth,
  tree,
  byId,
  visible,
  closed,
  toggle,
}: {
  unit: CompanyUnit;
  depth: number;
  tree: Map<string | null, CompanyUnit[]>;
  byId: Map<string, CompanyPerson>;
  visible: Set<string> | null;
  closed: Set<string>;
  toggle: (id: string) => void;
}) {
  const kids = (tree.get(unit.id) ?? []).filter((k) => !visible || visible.has(k.id));
  const open = !closed.has(unit.id);
  const leaders = unit.members.filter((m) => m.role !== "member");
  const staff = unit.members.filter((m) => m.role === "member");
  const total = countDeep(unit, tree);

  return (
    <div className={cn(depth > 0 && "border-l pl-3 sm:pl-5")}>
      <div className="rounded-lg border bg-background p-3 sm:p-4">
        <div className="flex items-start gap-2">
          {kids.length > 0 ? (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-1 size-7 shrink-0"
              aria-label={open ? "Свернуть" : "Раскрыть"}
              aria-expanded={open}
              onClick={() => toggle(unit.id)}
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </Button>
          ) : (
            <span className="size-7 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h2 className="text-base font-semibold">{unit.name}</h2>
              <span className="text-xs text-muted-foreground">
                {unit.members.length} чел.
                {total > unit.members.length ? ` · с подразделениями ${total}` : ""}
              </span>
            </div>
            {unit.description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{unit.description}</p>
            )}
            {leaders.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {leaders.map((m) => (
                  <Member key={m.user_id} id={m.user_id} role={m.role} byId={byId} />
                ))}
              </div>
            )}
            {staff.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {staff.map((m) => (
                  <Member key={m.user_id} id={m.user_id} byId={byId} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {open && kids.length > 0 && (
        <div className="mt-2 space-y-2">
          {kids.map((k) => (
            <UnitNode
              key={k.id}
              unit={k}
              depth={depth + 1}
              tree={tree}
              byId={byId}
              visible={visible}
              closed={closed}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Люди подразделения и всех ниже — без повторов. */
function countDeep(unit: CompanyUnit, children: Map<string | null, CompanyUnit[]>) {
  const people = new Set(unit.members.map((m) => m.user_id));
  const stack = [unit.id];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const u of children.get(id) ?? []) {
      for (const m of u.members) people.add(m.user_id);
      stack.push(u.id);
    }
  }
  return people.size;
}

function Member({
  id,
  role,
  byId,
}: {
  id: string;
  role?: "head" | "deputy" | "member";
  byId: Map<string, CompanyPerson>;
}) {
  const p = byId.get(id);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <PersonChip userId={id} name={p?.full_name} avatar={p?.avatar_url ?? null} />
      {role && role !== "member" && (
        <StatusChip tone="strong" size="sm">
          {MEMBER_ROLE_LABEL[role]}
        </StatusChip>
      )}
      {p && isOnline(p.last_seen_at) && (
        <span aria-label="в сети" className="size-2 rounded-full bg-emerald-500" />
      )}
    </span>
  );
}
