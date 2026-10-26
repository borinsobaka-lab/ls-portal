import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FolderPlus, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AssignDialog, type AssignSubject } from "@/components/access/assign-dialog";
import { AccessSection, PersonLine, RoleChip } from "@/components/access/parts";
import { useConfirm } from "@/components/confirm-dialog";
import { AccessStructurePageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { ColorInput } from "@/components/ui/color-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import { hasRight } from "@/lib/admin-access";
import {
  ACCESS_KEY,
  accessRpc,
  accessUsersQuery,
  invalidateAccess,
  networkStudiosQuery,
  orgBrandsQuery,
  orgMembersQuery,
  orgPositionsQuery,
  orgUnitsQuery,
} from "@/lib/access/data";
import { MEMBER_ROLE_LABEL, scopeText, unitSubtree, unitTree } from "@/lib/access/logic";
import type {
  Assignment,
  MemberRole,
  NetworkStudio,
  OrgBrand,
  OrgPosition,
  OrgUnit,
} from "@/lib/access/types";
import { STUDIO_FORMAT_LABEL } from "@/lib/studio-formats";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useAccessNames } from "@/hooks/use-access-names";

type Tab = "units" | "positions" | "network";
const TABS: { value: Tab; label: string }[] = [
  { value: "units", label: "Подразделения" },
  { value: "positions", label: "Должности" },
  { value: "network", label: "Сеть клубов" },
];

export const Route = createFileRoute("/_authenticated/access/structure")({
  head: () => ({ meta: [{ title: "Оргструктура — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: Tab; unit?: string } => ({
    ...(search.tab === "positions" || search.tab === "network" ? { tab: search.tab } : {}),
    ...(typeof search.unit === "string" ? { unit: search.unit } : {}),
  }),
  pendingComponent: AccessStructurePageSkeleton,
  component: StructurePage,
});

/** Роли, выданные подразделениям и должностям (читают управляющие). */
function useGroupAssignments() {
  return useQuery({
    queryKey: [ACCESS_KEY, "group-assignments"],
    queryFn: () =>
      unwrap<Assignment[]>(
        supabase
          .from("access_assignments")
          .select("*")
          .neq("subject_type", "user")
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить роли подразделений" },
  });
}

/**
 * «Оргструктура» (ACCESS.md): подразделения УК деревом (руководители,
 * заместители, сотрудники; человек может быть в нескольких), должности и
 * сеть клубов — бренды и клубы (свой / франшиза, город). Роль, выданная
 * подразделению или должности, действует на всех, кто в них, — и на будущих.
 */
function StructurePage() {
  const { tab = "units" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const access = useAdminAccess();
  const canEdit = hasRight(access, "structure.manage");
  return (
    <AdminShell title="Оргструктура">
      <div className="space-y-4">
        <Tabs
          value={tab}
          onValueChange={(v) =>
            void navigate({ search: { tab: v === "units" ? undefined : (v as Tab) } })
          }
          activationMode="manual"
        >
          <TabsList aria-label="Разделы оргструктуры" className="max-w-full overflow-x-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {!canEdit && (
          <InfoNote>
            Менять структуру может тот, у кого есть право «Оргструктура и сеть». Вам — просмотр.
          </InfoNote>
        )}
        {tab === "units" && <UnitsTab canEdit={canEdit} />}
        {tab === "positions" && <PositionsTab canEdit={canEdit} />}
        {tab === "network" && <NetworkTab canEdit={canEdit} />}
      </div>
    </AdminShell>
  );
}

// --- Подразделения -----------------------------------------------------------

function UnitsTab({ canEdit }: { canEdit: boolean }) {
  const { unit: selectedId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: units } = useQuery(orgUnitsQuery);
  const { data: members } = useQuery(orgMembersQuery);
  const names = useAccessNames();
  const [editing, setEditing] = useState<{ unit: OrgUnit | null; parentId: string | null } | null>(
    null,
  );
  const tree = unitTree(units ?? []);
  const selected = (units ?? []).find((u) => u.id === selectedId) ?? null;
  const select = (id: string) => void navigate({ search: (s) => ({ ...s, unit: id }) });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <section className="space-y-2 rounded-lg border bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Подразделения</h2>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing({ unit: null, parentId: null })}
            >
              <Plus /> Подразделение
            </Button>
          )}
        </div>
        {tree.length === 0 ? (
          <InfoNote variant="empty">
            Подразделений пока нет. Например: «Офис собственника», «Отдел развития», «Отдел
            контента».
          </InfoNote>
        ) : (
          <ul className="space-y-0.5">
            {tree.map(({ unit, depth }) => {
              const own = (members ?? []).filter((m) => m.unit_id === unit.id);
              const heads = own.filter((m) => m.member_role === "head");
              return (
                <li key={unit.id}>
                  <button
                    type="button"
                    onClick={() => select(unit.id)}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
                      unit.id === selectedId && "bg-muted font-medium",
                    )}
                    style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
                  >
                    <span className="min-w-0 flex-1 truncate">{unit.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {heads.length > 0 &&
                        `${heads.map((h) => names.user.get(h.user_id)?.split(" ")[0]).join(", ")} · `}
                      {own.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {selected ? (
        <UnitPanel
          key={selected.id}
          unit={selected}
          units={units ?? []}
          canEdit={canEdit}
          onEdit={() => setEditing({ unit: selected, parentId: selected.parent_id })}
          onAddChild={() => setEditing({ unit: null, parentId: selected.id })}
          onDeleted={() => void navigate({ search: (s) => ({ ...s, unit: undefined }) })}
        />
      ) : (
        <InfoNote variant="empty" className="self-start">
          Выберите подразделение слева — состав, руководители и роли подразделения.
        </InfoNote>
      )}
      <UnitDialog
        state={editing}
        units={units ?? []}
        onClose={() => setEditing(null)}
        onSaved={(id) => select(id)}
      />
    </div>
  );
}

function UnitPanel({
  unit,
  units,
  canEdit,
  onEdit,
  onAddChild,
  onDeleted,
}: {
  unit: OrgUnit;
  units: OrgUnit[];
  canEdit: boolean;
  onEdit: () => void;
  onAddChild: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const names = useAccessNames();
  const { confirm, confirmDialog } = useConfirm();
  const { data: members } = useQuery(orgMembersQuery);
  const { data: users } = useQuery(accessUsersQuery);
  const { data: assignments } = useGroupAssignments();
  const [adding, setAdding] = useState({ user: "", role: "member" as MemberRole });
  const [assign, setAssign] = useState<{ open: boolean; existing: Assignment | null }>({
    open: false,
    existing: null,
  });
  const own = (members ?? []).filter((m) => m.unit_id === unit.id);
  const order: Record<MemberRole, number> = { head: 0, deputy: 1, member: 2 };
  own.sort(
    (a, b) =>
      order[a.member_role] - order[b.member_role] ||
      (names.user.get(a.user_id) ?? "").localeCompare(names.user.get(b.user_id) ?? "", "ru"),
  );
  const subtree = unitSubtree(units, unit.id);
  const below = (members ?? []).filter((m) => subtree.has(m.unit_id) && m.unit_id !== unit.id);
  const roles = (assignments ?? []).filter((a) => a.unit_id === unit.id);
  const parentRoles = (assignments ?? []).filter(
    (a) => a.unit_id && a.with_subunits && a.unit_id !== unit.id && unit.path.includes(a.unit_id),
  );
  const userOf = new Map((users ?? []).map((u) => [u.user_id, u]));
  const canAssign = !!access?.manageAll || hasRight(access, "portal.admin");

  const setMember = async (userId: string, role: MemberRole | null) => {
    try {
      await accessRpc("org_member_set", { p_unit: unit.id, p_user: userId, p_role: role });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  const removeUnit = async () => {
    const ok = await confirm({
      title: `Удалить «${unit.name}»?`,
      description:
        "Сотрудники выйдут из подразделения, роли подразделения снимутся — права пересчитаются сразу. Вложенные подразделения сначала перенесите.",
    });
    if (!ok) return;
    try {
      await accessRpc("org_unit_delete", { p_id: unit.id });
      await invalidateAccess(qc);
      onDeleted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  const removeAssignment = async (a: Assignment) => {
    const ok = await confirm({
      title: "Снять роль подразделения?",
      description: "Права пропадут у всех, кто получал их через это подразделение.",
      confirmLabel: "Снять",
    });
    if (!ok) return;
    try {
      await accessRpc("access_assignment_delete", { p_id: a.id });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <AccessSection
        title={unit.name}
        hint={unit.description ?? undefined}
        action={
          canEdit ? (
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" onClick={onAddChild}>
                <FolderPlus /> Вложенное
              </Button>
              <Button size="sm" variant="outline" onClick={onEdit}>
                <Pencil /> Изменить
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void removeUnit()}
                aria-label="Удалить"
              >
                <Trash2 />
              </Button>
            </div>
          ) : null
        }
      >
        {own.length === 0 ? (
          <InfoNote variant="empty">В подразделении пока никого.</InfoNote>
        ) : (
          <ul className="divide-y">
            {own.map((m) => {
              const u = userOf.get(m.user_id);
              return (
                <li key={m.user_id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link
                    to="/access/users/$userId"
                    params={{ userId: m.user_id }}
                    className="min-w-0 flex-1"
                  >
                    <PersonLine
                      name={u?.full_name ?? names.user.get(m.user_id) ?? null}
                      email={u?.email}
                      avatar={u?.avatar_url ?? null}
                    />
                  </Link>
                  {canEdit ? (
                    <>
                      <Select
                        value={m.member_role}
                        onValueChange={(v) => void setMember(m.user_id, v as MemberRole)}
                      >
                        <SelectTrigger aria-label="Роль в подразделении" className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(MEMBER_ROLE_LABEL) as MemberRole[]).map((r) => (
                            <SelectItem key={r} value={r}>
                              {MEMBER_ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Убрать из подразделения"
                        onClick={() => void setMember(m.user_id, null)}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {MEMBER_ROLE_LABEL[m.member_role]}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Select
              value={adding.user}
              onValueChange={(user) => setAdding((s) => ({ ...s, user }))}
            >
              <SelectTrigger aria-label="Сотрудник" className="min-w-48 flex-1">
                <SelectValue placeholder="Добавить сотрудника" />
              </SelectTrigger>
              <SelectContent>
                {(users ?? [])
                  .filter((u) => !own.some((m) => m.user_id === u.user_id))
                  .map((u) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.full_name || u.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select
              value={adding.role}
              onValueChange={(v) => setAdding((s) => ({ ...s, role: v as MemberRole }))}
            >
              <SelectTrigger aria-label="Роль в подразделении" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MEMBER_ROLE_LABEL) as MemberRole[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {MEMBER_ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!adding.user}
              onClick={async () => {
                await setMember(adding.user, adding.role);
                setAdding({ user: "", role: "member" });
              }}
            >
              Добавить
            </Button>
          </div>
        )}
        {below.length > 0 && (
          <p className="text-xs text-muted-foreground">
            В подразделениях ниже: {new Set(below.map((m) => m.user_id)).size} чел.
          </p>
        )}
      </AccessSection>

      <AccessSection
        title="Роли подразделения"
        hint="Действуют на сотрудников (или только руководителей) подразделения — и ниже, если отмечено. Новый сотрудник получает их сам."
        action={
          canAssign ? (
            <Button size="sm" onClick={() => setAssign({ open: true, existing: null })}>
              <Plus /> Назначить роль
            </Button>
          ) : null
        }
      >
        {roles.length === 0 && parentRoles.length === 0 ? (
          <InfoNote variant="empty">Ролей нет.</InfoNote>
        ) : (
          <ul className="divide-y">
            {roles.map((a) => (
              <AssignmentLine
                key={a.id}
                a={a}
                names={names}
                extra={`${a.unit_members === "heads" ? "руководителям" : "всем"}${a.with_subunits ? ", и ниже" : ""}`}
                onEdit={canAssign ? () => setAssign({ open: true, existing: a }) : undefined}
                onRemove={canAssign ? () => void removeAssignment(a) : undefined}
              />
            ))}
            {parentRoles.map((a) => (
              <AssignmentLine
                key={a.id}
                a={a}
                names={names}
                extra={`от «${names.unit.get(a.unit_id ?? "")}»`}
                muted
              />
            ))}
          </ul>
        )}
      </AccessSection>
      <AssignDialog
        open={assign.open}
        onOpenChange={(open) => setAssign((s) => ({ ...s, open }))}
        subject={{ type: "unit", id: unit.id, label: `Подразделение «${unit.name}»` }}
        existing={assign.existing}
      />
      {confirmDialog}
    </div>
  );
}

function AssignmentLine({
  a,
  names,
  extra,
  muted,
  onEdit,
  onRemove,
}: {
  a: Assignment;
  names: ReturnType<typeof useAccessNames>;
  extra?: string;
  muted?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const role = names.role.get(a.role_id);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <RoleChip name={role?.name ?? "Роль"} color={role?.color} muted={muted} />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {scopeText(a, names, names.role.get(a.role_id)?.studio ?? true)}
        {extra ? ` · ${extra}` : ""}
      </span>
      {onEdit && (
        <Button variant="ghost" size="icon" aria-label="Изменить назначение" onClick={onEdit}>
          <Pencil />
        </Button>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon" aria-label="Снять роль" onClick={onRemove}>
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

function UnitDialog({
  state,
  units,
  onClose,
  onSaved,
}: {
  state: { unit: OrgUnit | null; parentId: string | null } | null;
  units: OrgUnit[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {state && (
          <UnitForm
            key={state.unit?.id ?? `new-${state.parentId}`}
            unit={state.unit}
            parentId={state.parentId}
            units={units}
            onDone={(id) => {
              onClose();
              if (id) onSaved(id);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const ROOT = "root";

function UnitForm({
  unit,
  parentId,
  units,
  onDone,
}: {
  unit: OrgUnit | null;
  parentId: string | null;
  units: OrgUnit[];
  onDone: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(unit?.name ?? "");
  const [description, setDescription] = useState(unit?.description ?? "");
  const [parent, setParent] = useState(parentId ?? ROOT);
  const [saving, setSaving] = useState(false);
  // Внутрь себя и своей ветки перенести нельзя.
  const blocked = unit ? unitSubtree(units, unit.id) : new Set<string>();
  const save = async () => {
    if (!name.trim()) {
      toast.error("Укажите название");
      return;
    }
    setSaving(true);
    try {
      const id = await accessRpc<string>("org_unit_save", {
        p: {
          id: unit?.id ?? null,
          name: name.trim(),
          description,
          parent_id: parent === ROOT ? null : parent,
        },
      });
      await invalidateAccess(qc);
      onDone(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{unit ? "Подразделение" : "Новое подразделение"}</DialogTitle>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <FormField label="Название" required>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label="Входит в" htmlFor={null}>
              <Select value={parent} onValueChange={setParent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT}>— верхний уровень —</SelectItem>
                  {unitTree(units)
                    .filter(({ unit: u }) => !blocked.has(u.id))
                    .map(({ unit: u, depth }) => (
                      <SelectItem key={u.id} value={u.id}>
                        {"  ".repeat(depth)}
                        {u.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Описание" optional>
              <Textarea
                rows={2}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

// --- Должности -----------------------------------------------------------------

function PositionsTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const names = useAccessNames();
  const { confirm, confirmDialog } = useConfirm();
  const { data: positions } = useQuery(orgPositionsQuery);
  const { data: users } = useQuery(accessUsersQuery);
  const { data: assignments } = useGroupAssignments();
  const [editing, setEditing] = useState<OrgPosition | "new" | null>(null);
  const [assignFor, setAssignFor] = useState<AssignSubject | null>(null);
  const canAssign = !!access?.manageAll || hasRight(access, "portal.admin");
  const remove = async (p: OrgPosition) => {
    const ok = await confirm({
      title: `Удалить должность «${p.name}»?`,
      description: "У людей она станет «не указана», роли должности снимутся.",
    });
    if (!ok) return;
    try {
      await accessRpc("org_position_delete", { p_id: p.id });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Должность стоит в карточке человека. Роль, выданная должности, действует на всех с ней.
        </p>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> Должность
          </Button>
        )}
      </div>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Должность</TableHead>
              <TableHead className="text-right">Людей</TableHead>
              <TableHead>Роли должности</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(positions ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Должностей пока нет: эксперт отдела развития, HR, бухгалтер, таргетолог…
                </TableCell>
              </TableRow>
            ) : (
              (positions ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    {p.description && (
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(users ?? []).filter((u) => u.position_id === p.id).length}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(assignments ?? [])
                        .filter((a) => a.position_id === p.id)
                        .map((a) => {
                          const role = names.role.get(a.role_id);
                          return (
                            <RoleChip key={a.id} name={role?.name ?? "Роль"} color={role?.color} />
                          );
                        })}
                    </div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {canAssign && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Назначить роль должности"
                        onClick={() =>
                          setAssignFor({
                            type: "position",
                            id: p.id,
                            label: `Должность «${p.name}»`,
                          })
                        }
                      >
                        <Plus />
                      </Button>
                    )}
                    {canEdit && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Изменить"
                          onClick={() => setEditing(p)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Удалить"
                          onClick={() => void remove(p)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <NameDialog
        open={!!editing}
        title={editing === "new" ? "Новая должность" : "Должность"}
        initial={editing && editing !== "new" ? editing : null}
        onClose={() => setEditing(null)}
        onSave={async (v) => {
          await accessRpc("org_position_save", {
            p: { id: editing && editing !== "new" ? editing.id : null, ...v },
          });
          await invalidateAccess(qc);
        }}
      />
      <AssignDialog
        open={!!assignFor}
        onOpenChange={(o) => !o && setAssignFor(null)}
        subject={assignFor}
      />
      {confirmDialog}
    </div>
  );
}

function NameDialog({
  open,
  title,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: { name: string; description: string | null } | null;
  onClose: () => void;
  onSave: (v: { name: string; description: string }) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {open && <NameForm title={title} initial={initial} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: { name: string; description: string | null } | null;
  onClose: () => void;
  onSave: (v: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) {
      toast.error("Укажите название");
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), description });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <FormField label="Название" required>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label="Описание" optional>
              <Textarea
                rows={2}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

// --- Сеть клубов ---------------------------------------------------------------

const NONE = "none";

function NetworkTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: brands } = useQuery(orgBrandsQuery);
  const { data: studios } = useQuery(networkStudiosQuery);
  const [editing, setEditing] = useState<OrgBrand | "new" | null>(null);
  const count = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of studios ?? []) if (s.brand_id) m.set(s.brand_id, (m.get(s.brand_id) ?? 0) + 1);
    return m;
  }, [studios]);
  const saveStudio = async (s: NetworkStudio, patch: Record<string, string>) => {
    try {
      await accessRpc("org_studio_save", { p_studio: s.id, p: patch });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    }
  };
  const removeBrand = async (b: OrgBrand) => {
    const ok = await confirm({ title: `Удалить бренд «${b.name}»?` });
    if (!ok) return;
    try {
      await accessRpc("org_brand_delete", { p_id: b.id });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  return (
    <div className="space-y-4">
      <AccessSection
        title="Бренды"
        hint="Роль можно выдать «в клубах бренда» — тогда и новые клубы бренда войдут сами."
        action={
          canEdit ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Бренд
            </Button>
          ) : null
        }
      >
        <ul className="divide-y">
          {(brands ?? []).map((b) => (
            <li key={b.id} className="flex items-center gap-2 py-2 text-sm">
              <span
                aria-hidden
                className="size-3 rounded-full"
                style={{ backgroundColor: b.color ?? "#94a3b8" }}
              />
              <span className="font-medium">{b.name}</span>
              {b.short_name && <span className="text-muted-foreground">{b.short_name}</span>}
              <span className="flex-1 text-muted-foreground">· клубов: {count.get(b.id) ?? 0}</span>
              {canEdit && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Изменить"
                    onClick={() => setEditing(b)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Удалить"
                    onClick={() => void removeBrand(b)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </AccessSection>

      <AccessSection
        title="Клубы"
        hint="Бренд, свой или франшиза, город. Создаются и настраиваются клубы в «Управлении» → «Клубы»."
      >
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Клуб</TableHead>
                <TableHead>Бренд</TableHead>
                <TableHead>Тип</TableHead>
                <TableHead>Город</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(studios ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {STUDIO_FORMAT_LABEL[s.format as keyof typeof STUDIO_FORMAT_LABEL] ??
                        s.format}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={s.brand_id ?? NONE}
                      disabled={!canEdit}
                      onValueChange={(v) => void saveStudio(s, { brand_id: v === NONE ? "" : v })}
                    >
                      <SelectTrigger aria-label="Бренд" className="h-8 w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Без бренда</SelectItem>
                        {(brands ?? []).map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={s.ownership}
                      disabled={!canEdit}
                      onValueChange={(v) => void saveStudio(s, { ownership: v })}
                    >
                      <SelectTrigger aria-label="Свой или франшиза" className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="own">Свой</SelectItem>
                        <SelectItem value="franchise">Франшиза</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-40"
                      defaultValue={s.city ?? ""}
                      disabled={!canEdit}
                      maxLength={80}
                      aria-label="Город"
                      onBlur={(e) => {
                        if (e.target.value.trim() !== (s.city ?? ""))
                          void saveStudio(s, { city: e.target.value });
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </AccessSection>
      <BrandDialog
        brand={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void invalidateAccess(qc)}
      />
      {confirmDialog}
    </div>
  );
}

function BrandDialog({
  brand,
  onClose,
  onSaved,
}: {
  brand: OrgBrand | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={!!brand} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {brand && (
          <BrandForm
            brand={brand === "new" ? null : brand}
            onDone={() => {
              onClose();
              onSaved();
            }}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BrandForm({
  brand,
  onDone,
  onCancel,
}: {
  brand: OrgBrand | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(brand?.name ?? "");
  const [short, setShort] = useState(brand?.short_name ?? "");
  const [color, setColor] = useState(brand?.color ?? "#e5007e");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) {
      toast.error("Укажите название");
      return;
    }
    setSaving(true);
    try {
      await accessRpc("org_brand_save", {
        p: { id: brand?.id ?? null, name: name.trim(), short_name: short, color },
      });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{brand ? "Бренд" : "Новый бренд"}</DialogTitle>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <FormField label="Название" required>
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Сокращение" optional>
                <Input value={short} maxLength={12} onChange={(e) => setShort(e.target.value)} />
              </FormField>
              <FormField label="Цвет" htmlFor={null}>
                <ColorInput value={color} onChange={setColor} fallback="#e5007e" />
              </FormField>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
