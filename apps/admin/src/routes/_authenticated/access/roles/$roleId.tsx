import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Copy, Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell, FloatingActions } from "@/components/admin-shell";
import { AssignDialog } from "@/components/access/assign-dialog";
import { AccessSection, RoleChip } from "@/components/access/parts";
import { RoleMatrix } from "@/components/access/role-matrix";
import { useConfirm } from "@/components/confirm-dialog";
import { AccessRolePageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { ColorInput } from "@/components/ui/color-input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import { hasRight } from "@/lib/admin-access";
import {
  ACCESS_KEY,
  accessCatalogQuery,
  accessRolesQuery,
  accessRpc,
  invalidateAccess,
} from "@/lib/access/data";
import { roleProblem, scopeText, subjectText, validityText } from "@/lib/access/logic";
import type { AccessRole, Assignment, RolePerm } from "@/lib/access/types";
import { unwrap } from "@/lib/query";
import { useAccessNames } from "@/hooks/use-access-names";

export const Route = createFileRoute("/_authenticated/access/roles/$roleId")({
  head: () => ({ meta: [{ title: "Роль — Base40 Admin" }] }),
  validateSearch: (search: Record<string, unknown>): { copy?: string } =>
    typeof search.copy === "string" ? { copy: search.copy } : {},
  pendingComponent: AccessRolePageSkeleton,
  component: RolePage,
});

const DEFAULT_COLOR = "#64748b";

function RolePage() {
  const { roleId } = Route.useParams();
  const { copy } = Route.useSearch();
  const { data: roles, error } = useQuery(accessRolesQuery);
  const { data: catalog } = useQuery(accessCatalogQuery);
  if (error && !roles) {
    return (
      <AdminShell title="Роль">
        <InfoNote variant="warning">{error.message}</InfoNote>
      </AdminShell>
    );
  }
  if (!roles || !catalog) return <AccessRolePageSkeleton />;
  const isNew = roleId === "new";
  const role = isNew ? null : (roles.find((r) => r.id === roleId) ?? null);
  if (!isNew && !role) {
    return (
      <AdminShell title="Роль">
        <InfoNote variant="warning">Роль не найдена — возможно, её удалили.</InfoNote>
      </AdminShell>
    );
  }
  const source = isNew && copy ? (roles.find((r) => r.id === copy) ?? null) : null;
  return <RoleEditor key={roleId + (copy ?? "")} role={role} source={source} />;
}

function RoleEditor({ role, source }: { role: AccessRole | null; source: AccessRole | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const access = useAdminAccess();
  const { confirm, confirmDialog } = useConfirm();
  const { data: catalog } = useQuery(accessCatalogQuery);
  const canEdit = hasRight(access, "roles.manage");
  const isAdmin = hasRight(access, "portal.admin");
  const base = role ?? source;
  const [name, setName] = useState(role?.name ?? (source ? `${source.name} (копия)` : ""));
  const [description, setDescription] = useState(base?.description ?? "");
  const [color, setColor] = useState(base?.color ?? DEFAULT_COLOR);
  const [perms, setPerms] = useState<RolePerm[]>(base?.permissions ?? []);
  const [saving, setSaving] = useState(false);
  const superOnly =
    !!role && (role.locked || role.permissions.some((p) => p.perm_key === "portal.admin"));
  const readOnly = !canEdit || (superOnly && !isAdmin);
  const permsLocked = !!role?.locked;
  const problem = roleProblem(perms);
  const dirty =
    !role ||
    name !== role.name ||
    (description || null) !== (role.description || null) ||
    color !== (role.color ?? DEFAULT_COLOR) ||
    JSON.stringify(sortPerms(perms)) !== JSON.stringify(sortPerms(role.permissions));

  const save = async () => {
    if (!name.trim()) {
      toast.error("Укажите название роли");
      return;
    }
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const id = await accessRpc<string>("access_role_save", {
        p: { id: role?.id ?? null, name: name.trim(), description, color, permissions: perms },
      });
      toast.success(role ? "Роль сохранена — права людей уже пересчитаны" : "Роль создана");
      await invalidateAccess(qc);
      if (!role)
        void navigate({ to: "/access/roles/$roleId", params: { roleId: id }, replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!role) return;
    const ok = await confirm({
      title: `Удалить роль «${role.name}»?`,
      description: "Удалить можно только роль, которая никому не выдана (и не назначает курсы).",
    });
    if (!ok) return;
    try {
      await accessRpc("access_role_delete", { p_id: role.id });
      toast.success("Роль удалена");
      await invalidateAccess(qc);
      void navigate({ to: "/access/roles" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить");
    }
  };

  return (
    <AdminShell title={role ? role.name : "Новая роль"}>
      <div className="mx-auto max-w-4xl space-y-4 pb-20">
        <Link
          to="/access/roles"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Все роли
        </Link>
        {role?.locked && (
          <InfoNote variant="info">
            <Lock className="mr-1 inline size-3.5" />
            Права суперадминистратора не меняются — так портал не останется без того, кто может всё.
            Название и описание можно.
          </InfoNote>
        )}
        {readOnly && !role?.locked && (
          <InfoNote>
            {canEdit
              ? "Роль с правами суперадминистратора меняет только суперадминистратор."
              : "Менять роли может тот, у кого есть право «Создаёт и меняет роли»."}
          </InfoNote>
        )}
        <section className="space-y-3 rounded-lg border bg-background p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <FormField label="Название" required>
              <Input
                value={name}
                maxLength={120}
                disabled={readOnly}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
            <FormField label="Цвет" htmlFor={null}>
              <ColorInput value={color} onChange={setColor} fallback={DEFAULT_COLOR} />
            </FormField>
          </div>
          <FormField label="Описание" optional>
            <Textarea
              rows={2}
              maxLength={1000}
              value={description}
              disabled={readOnly}
              placeholder="Кому и зачем эта роль"
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Так роль выглядит в списках:</span>
            <RoleChip name={name || "Роль"} color={color} />
          </div>
        </section>

        {problem && <InfoNote variant="warning">{problem}</InfoNote>}
        <RoleMatrix
          catalog={catalog ?? []}
          value={perms}
          onChange={setPerms}
          disabled={readOnly || permsLocked}
          canSuperadmin={isAdmin}
        />

        {role && <RoleAssignments role={role} canAssign={hasRight(access, "users.manage")} />}
      </div>
      {!readOnly && (
        <FloatingActions>
          {role && canEdit && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/access/roles/$roleId",
                    params: { roleId: "new" },
                    search: { copy: role.id },
                  })
                }
              >
                <Copy /> Копия
              </Button>
              {!role.locked && (
                <Button variant="outline" onClick={() => void remove()}>
                  <Trash2 /> Удалить
                </Button>
              )}
            </>
          )}
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving && <Loader2 className="animate-spin" />}
            {role ? "Сохранить" : "Создать роль"}
          </Button>
        </FloatingActions>
      )}
      {confirmDialog}
    </AdminShell>
  );
}

function sortPerms(perms: RolePerm[]) {
  return [...perms]
    .map((p) => ({ ...p, target_id: p.target_id ?? null }))
    .sort((a, b) =>
      `${a.perm_key}:${a.target_id ?? ""}`.localeCompare(`${b.perm_key}:${b.target_id ?? ""}`),
    );
}

/** Кому выдана роль: люди, подразделения, должности. */
function RoleAssignments({ role, canAssign }: { role: AccessRole; canAssign: boolean }) {
  const qc = useQueryClient();
  const names = useAccessNames();
  const { confirm, confirmDialog } = useConfirm();
  const [assign, setAssign] = useState<{ open: boolean; existing: Assignment | null }>({
    open: false,
    existing: null,
  });
  const { data: list } = useQuery({
    queryKey: [ACCESS_KEY, "role-assignments", role.id],
    queryFn: () =>
      unwrap<Assignment[]>(
        supabase.from("access_assignments").select("*").eq("role_id", role.id).order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить назначения роли" },
  });
  const remove = async (a: Assignment) => {
    const ok = await confirm({
      title: "Снять назначение?",
      description: `${subjectText(a, names)} — права роли «${role.name}» пропадут сразу.`,
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
    <AccessSection
      title="Кому выдана"
      hint={`Сейчас действует у ${role.users} чел. Новый сотрудник подразделения или должности получает роль сам.`}
      action={
        canAssign ? (
          <Button size="sm" onClick={() => setAssign({ open: true, existing: null })}>
            <Plus /> Назначить
          </Button>
        ) : null
      }
    >
      {(list ?? []).length === 0 ? (
        <InfoNote variant="empty">Роль пока никому не выдана.</InfoNote>
      ) : (
        <ul className="divide-y">
          {(list ?? []).map((a) => {
            const validity = validityText(a);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  {a.subject_type === "user" && a.user_id ? (
                    <Link
                      to="/access/users/$userId"
                      params={{ userId: a.user_id }}
                      className="font-medium hover:underline"
                    >
                      {subjectText(a, names)}
                    </Link>
                  ) : (
                    <span className="font-medium">{subjectText(a, names)}</span>
                  )}
                  <span className="text-muted-foreground">
                    {" "}
                    · {scopeText(a, names, names.role.get(a.role_id)?.studio ?? true)}
                  </span>
                  {validity && <span className="text-xs text-muted-foreground"> · {validity}</span>}
                </span>
                {canAssign && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Изменить назначение"
                      onClick={() => setAssign({ open: true, existing: a })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Снять назначение"
                      onClick={() => void remove(a)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AssignDialog
        open={assign.open}
        onOpenChange={(open) => setAssign((s) => ({ ...s, open }))}
        subject={
          assign.existing
            ? {
                type: assign.existing.subject_type,
                id:
                  assign.existing.user_id ??
                  assign.existing.unit_id ??
                  assign.existing.position_id ??
                  "",
                label: subjectText(assign.existing, names),
              }
            : null
        }
        existing={assign.existing}
        defaultRoleId={role.id}
      />
      {confirmDialog}
    </AccessSection>
  );
}
