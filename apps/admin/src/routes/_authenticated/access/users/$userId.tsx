import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Ban,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserMinus,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AssignDialog } from "@/components/access/assign-dialog";
import { AccessLogList } from "@/components/access/log-list";
import { UserClubsSection } from "@/components/access/club-owners";
import { AccessSection, RoleChip, UserStatusChip } from "@/components/access/parts";
import { RoleMatrix } from "@/components/access/role-matrix";
import { EditUserDialog } from "@/components/access/user-dialogs";
import { useConfirm } from "@/components/confirm-dialog";
import { StaffAvatar } from "@/components/employee-photo";
import { AccessUserPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import { hasRight } from "@/lib/admin-access";
import { removePortalUser } from "@/lib/access.functions";
import {
  accessCatalogQuery,
  accessExplainQuery,
  accessRpc,
  accessUserQuery,
  invalidateAccess,
  orgUnitsQuery,
} from "@/lib/access/data";
import {
  LEVEL_LABEL,
  lastSeenText,
  MEMBER_ROLE_LABEL,
  roleSummary,
  scopeText,
  TIER_LABEL,
  unitPathText,
  unitTree,
  USER_TYPE_LABEL,
  userStatus,
  validityText,
} from "@/lib/access/logic";
import type {
  Assignment,
  ExplainRow,
  MemberRole,
  PortalUserCard,
  RolePerm,
} from "@/lib/access/types";
import { formatDate, formatDateTime, todayISO } from "@/lib/format";
import { useAccessNames } from "@/hooks/use-access-names";
import { CLUBS_HIDDEN, isHiddenPermission } from "@/lib/launch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/access/users/$userId")({
  head: () => ({ meta: [{ title: "Пользователь — Lady Stretch" }] }),
  pendingComponent: AccessUserPageSkeleton,
  component: UserCardPage,
});

function UserCardPage() {
  const { userId } = Route.useParams();
  const { data: user, error } = useQuery(accessUserQuery(userId));
  if (error && !user) {
    return (
      <AdminShell title="Пользователь">
        <InfoNote variant="warning">{error.message}</InfoNote>
      </AdminShell>
    );
  }
  if (!user) return <AccessUserPageSkeleton />;
  return <UserCard user={user} />;
}

function UserCard({ user }: { user: PortalUserCard }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const access = useAdminAccess();
  const { confirm, confirmDialog } = useConfirm();
  const remove = useServerFn(removePortalUser);
  const { data: me } = useQuery({
    queryKey: ["access", "my-id"],
    queryFn: myId,
    staleTime: Infinity,
  });
  const isSelf = me === user.user_id;
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const status = userStatus({ ...user, portal: !!user.effective.portal }, todayISO());
  const canManage = user.can_manage;

  const unblock = async () => {
    try {
      await accessRpc("access_user_status", { p_user: user.user_id, p_status: "active" });
      toast.success("Разблокирован — роли снова действуют");
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  const removeUser = async () => {
    const ok = await confirm({
      title: "Убрать из портала?",
      description: `${user.full_name ?? user.email} потеряет вход в портал, роли, подразделения и личные права. История останется в журнале. Если человек — клиент приложения, вход в приложение сохранится.`,
      confirmLabel: "Убрать",
    });
    if (!ok) return;
    try {
      const res = await remove({ data: { user_id: user.user_id } });
      toast.success(
        res.accountKept ? "Убран из портала. Учётная запись клиента сохранена" : "Убран из портала",
      );
      await invalidateAccess(qc);
      void navigate({ to: "/access" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };

  return (
    <AdminShell
      title={user.full_name ?? user.email ?? "Пользователь"}
      actions={
        canManage || isSelf ? (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Данные
          </Button>
        ) : null
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        <Link
          to="/access"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Все пользователи
        </Link>

        <section className="flex flex-wrap items-start gap-4 rounded-lg border bg-background p-4">
          <StaffAvatar
            value={user.avatar_url}
            name={user.full_name ?? user.email ?? ""}
            className="size-16 text-base"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{user.full_name ?? "—"}</h2>
              <UserStatusChip status={status} />
            </div>
            <div className="text-sm text-muted-foreground">
              {[user.email, user.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>
                <span className="text-muted-foreground">Тип: </span>
                {user.user_type ? USER_TYPE_LABEL[user.user_type] : "не указан"}
              </span>
              <PositionName id={user.position_id} />
              {user.access_until && (
                <span>
                  <span className="text-muted-foreground">Доступ до: </span>
                  {formatDate(user.access_until)}
                </span>
              )}
              <span>
                <span className="text-muted-foreground">Последний вход: </span>
                {lastSeenText(user.last_sign_in_at)}
              </span>
              <span className="text-muted-foreground">
                Добавлен {formatDate(user.created_at)}
                {user.created_by_name ? ` · ${user.created_by_name}` : ""}
              </span>
            </div>
            {user.status === "blocked" && (
              <InfoNote variant="warning" className="mt-2">
                Заблокирован {formatDateTime(user.blocked_at)}
                {user.blocked_reason ? `: ${user.blocked_reason}` : ""}. Роли сохранены, но не
                действуют.
              </InfoNote>
            )}
            {user.note && <p className="pt-1 text-sm whitespace-pre-line">{user.note}</p>}
          </div>
          {canManage && !isSelf && (
            <div className="flex flex-wrap gap-2">
              {user.status === "blocked" ? (
                <Button variant="outline" onClick={() => void unblock()}>
                  <RotateCcw /> Разблокировать
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setBlocking(true)}>
                  <Ban /> Заблокировать
                </Button>
              )}
              <Button variant="outline" onClick={() => void removeUser()}>
                <UserMinus /> Убрать из портала
              </Button>
            </div>
          )}
        </section>

        {!canManage && !isSelf && (
          <InfoNote>
            Этого человека вы видите, но не управляете им: у него роли вне ваших клубов, роли от
            подразделения или должности или права шире ваших.
          </InfoNote>
        )}

        <RolesSection user={user} canManage={canManage && !isSelf} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <UnitsSection user={user} canEdit={hasRight(access, "structure.manage")} />
          <PersonalSection user={user} canManage={canManage && !isSelf} />
          <UserClubsSection userId={user.user_id} canEdit={hasRight(access, "structure.manage")} />
        </div>
        <EffectiveSection user={user} />
        {(canManage || hasRight(access, "audit.view") || hasRight(access, "roles.manage")) && (
          <AccessSection title="История" hint="Кто и когда менял роли и права этого человека.">
            <AccessLogList userId={user.user_id} limit={50} compact />
          </AccessSection>
        )}
      </div>
      <EditUserDialog open={editing} onOpenChange={setEditing} user={user} isSelf={isSelf} />
      <BlockDialog open={blocking} onOpenChange={setBlocking} user={user} />
      {confirmDialog}
    </AdminShell>
  );
}

async function myId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

function PositionName({ id }: { id: string | null }) {
  const names = useAccessNames(false);
  return (
    <span>
      <span className="text-muted-foreground">Должность: </span>
      {id ? (names.position.get(id) ?? "—") : "не указана"}
    </span>
  );
}

function BlockDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: PortalUserCard;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await accessRpc("access_user_status", {
        p_user: user.user_id,
        p_status: "blocked",
        p_reason: reason,
      });
      toast.success("Заблокирован: вход в портал закрыт, роли сохранены");
      await invalidateAccess(qc);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Заблокировать?</DialogTitle>
          <DialogDescription>
            {user.full_name ?? user.email} сразу потеряет доступ к порталу во всех клубах. Роли,
            подразделения и история сохранятся — разблокировать можно в любой момент.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={save}>
          <DialogBody>
            <FormField label="Причина" optional>
              <Input
                value={reason}
                maxLength={500}
                placeholder="Например: уволилась 25.10"
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Отмена
            </Button>
            <Button type="submit" variant="destructive" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Заблокировать
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

/** Назначения ролей: свои (можно менять) и полученные через подразделение и должность. */
function RolesSection({ user, canManage }: { user: PortalUserCard; canManage: boolean }) {
  const qc = useQueryClient();
  const names = useAccessNames();
  const { confirm, confirmDialog } = useConfirm();
  const { data: explain } = useQuery(accessExplainQuery(user.user_id));
  const { data: catalog } = useQuery(accessCatalogQuery);
  const [assign, setAssign] = useState<{ open: boolean; existing: Assignment | null }>({
    open: false,
    existing: null,
  });
  const inherited = useMemo(() => {
    const seen = new Map<string, ExplainRow>();
    for (const r of explain ?? []) if (r.subject_type !== "user") seen.set(r.assignment_id, r);
    return [...seen.values()];
  }, [explain]);
  const permsOf = (assignmentId: string): RolePerm[] =>
    (explain ?? [])
      .filter((r) => r.assignment_id === assignmentId && r.perm_key)
      .map((r) => ({ perm_key: r.perm_key!, target_id: r.target_id, level: r.level ?? "on" }));

  const removeAssignment = async (a: Assignment) => {
    const role = names.role.get(a.role_id)?.name ?? "роль";
    const ok = await confirm({
      title: `Снять роль «${role}»?`,
      description: "Права этой роли пропадут сразу (если не выданы иначе).",
      confirmLabel: "Снять",
    });
    if (!ok) return;
    try {
      await accessRpc("access_assignment_delete", { p_id: a.id });
      toast.success("Роль снята");
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };

  return (
    <AccessSection
      title="Роли"
      hint="Права человека — сумма его ролей. Роли подразделения и должности действуют, пока он в них."
      action={
        canManage ? (
          <Button size="sm" onClick={() => setAssign({ open: true, existing: null })}>
            <Plus /> Назначить роль
          </Button>
        ) : null
      }
    >
      {user.assignments.length === 0 && inherited.length === 0 ? (
        <InfoNote variant="empty">Ролей нет — без них человек не войдёт в портал.</InfoNote>
      ) : (
        <ul className="divide-y">
          {user.assignments.map((a) => {
            const role = names.role.get(a.role_id);
            const validity = validityText(a);
            const perms = permsOf(a.id);
            return (
              <li key={a.id} className="flex flex-wrap items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <RoleChip name={role?.name ?? "Роль"} color={role?.color} muted={!a.active} />
                    <span className="text-sm">
                      {scopeText(a, names, names.role.get(a.role_id)?.studio ?? true)}
                    </span>
                    {validity && (
                      <span
                        className={
                          a.active ? "text-xs text-muted-foreground" : "text-xs text-amber-700"
                        }
                      >
                        {validity}
                      </span>
                    )}
                  </div>
                  {perms.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {roleSummary(perms, catalog ?? []).join(" · ")}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Выдал {a.created_by_name ?? "—"} · {formatDate(a.created_at)}
                    {a.note ? ` · ${a.note}` : ""}
                  </div>
                </div>
                {canManage && (
                  <div className="flex gap-1">
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
                      aria-label="Снять роль"
                      onClick={() => void removeAssignment(a)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
          {inherited.map((r) => {
            const role = names.role.get(r.role_id);
            const validity = validityText(r);
            return (
              <li key={r.assignment_id} className="flex flex-wrap items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <RoleChip name={role?.name ?? r.role_name} color={role?.color} muted />
                    <span className="text-sm">
                      {scopeText(r, names, names.role.get(r.role_id)?.studio ?? true)}
                    </span>
                    {validity && <span className="text-xs text-muted-foreground">{validity}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Через: {r.via} ·{" "}
                    <Link to="/access/structure" className="underline">
                      оргструктура
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AssignDialog
        open={assign.open}
        onOpenChange={(open) => setAssign((s) => ({ ...s, open }))}
        subject={{ type: "user", id: user.user_id, label: user.full_name ?? user.email ?? "" }}
        existing={assign.existing}
      />
      {confirmDialog}
    </AccessSection>
  );
}

/** Подразделения человека; администратор структуры добавляет и меняет здесь же. */
function UnitsSection({ user, canEdit }: { user: PortalUserCard; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data: units } = useQuery(orgUnitsQuery);
  const [adding, setAdding] = useState(false);
  const [unitId, setUnitId] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const setMember = async (unit: string, memberRole: MemberRole | null) => {
    try {
      await accessRpc("org_member_set", { p_unit: unit, p_user: user.user_id, p_role: memberRole });
      await invalidateAccess(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось");
    }
  };
  const free = unitTree(units ?? []).filter(
    ({ unit }) => !user.units.some((m) => m.unit_id === unit.id),
  );
  return (
    <AccessSection
      title="Подразделения"
      hint="Оргструктура УК: человек может быть в нескольких. Руководители и заместители видны в «Оргструктуре»."
      action={
        canEdit && free.length > 0 && !adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Добавить
          </Button>
        ) : null
      }
    >
      {user.units.length === 0 && !adding ? (
        <InfoNote variant="empty">Не состоит в подразделениях.</InfoNote>
      ) : (
        <ul className="divide-y">
          {user.units.map((m) => (
            <li key={m.unit_id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 text-sm">{unitPathText(units ?? [], m.unit_id)}</span>
              {canEdit ? (
                <>
                  <Select
                    value={m.member_role}
                    onValueChange={(v) => void setMember(m.unit_id, v as MemberRole)}
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
                    onClick={() => void setMember(m.unit_id, null)}
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
          ))}
        </ul>
      )}
      {adding && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <Select value={unitId} onValueChange={setUnitId}>
            <SelectTrigger aria-label="Подразделение" className="min-w-48 flex-1">
              <SelectValue placeholder="Подразделение" />
            </SelectTrigger>
            <SelectContent>
              {free.map(({ unit, depth }) => (
                <SelectItem key={unit.id} value={unit.id}>
                  {"  ".repeat(depth)}
                  {unit.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
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
            disabled={!unitId}
            onClick={async () => {
              await setMember(unitId, role);
              setAdding(false);
              setUnitId("");
            }}
          >
            Добавить
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Отмена
          </Button>
        </div>
      )}
    </AccessSection>
  );
}

/** Личные права: сетевые права сверх ролей (разделы, базы знаний, Академия…). */
function PersonalSection({ user, canManage }: { user: PortalUserCard; canManage: boolean }) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const { data: catalog } = useQuery(accessCatalogQuery);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RolePerm[]>(user.personal);
  const [saving, setSaving] = useState(false);
  const summary = roleSummary(user.personal, catalog ?? []);
  const save = async () => {
    setSaving(true);
    try {
      await accessRpc("access_personal_save", { p_user: user.user_id, p_perms: draft });
      toast.success("Личные права сохранены");
      await invalidateAccess(qc);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };
  return (
    <AccessSection
      title="Личные права"
      hint="Исключения для одного человека сверх ролей — только сетевые права. Права в клубе выдаются ролью."
      action={
        canManage ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(user.personal);
              setOpen(true);
            }}
          >
            <ShieldCheck /> Изменить
          </Button>
        ) : null
      }
    >
      {summary.length === 0 ? (
        <InfoNote variant="empty">Нет — только права ролей.</InfoNote>
      ) : (
        <div className="flex flex-wrap gap-1">
          {summary.map((t) => (
            <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" anchor="top">
          <DialogHeader>
            <DialogTitle>Личные права</DialogTitle>
            <DialogDescription>{user.full_name ?? user.email}</DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={save}>
            <DialogBody>
              <RoleMatrix
                catalog={catalog ?? []}
                value={draft}
                onChange={setDraft}
                networkOnly
                canSuperadmin={hasRight(access, "portal.admin")}
              />
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                Отмена
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                Сохранить
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </AccessSection>
  );
}

/** Итог: что человеку доступно сейчас — по клубам и по сети. */
function EffectiveSection({ user }: { user: PortalUserCard }) {
  const names = useAccessNames(false);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const label = new Map((catalog ?? []).map((p) => [p.key, p.label]));
  const e = user.effective;
  const studios = Object.entries(e.studios ?? {}).sort(([a], [b]) =>
    (names.studio.get(a) ?? "").localeCompare(names.studio.get(b) ?? "", "ru"),
  );
  const kb = Object.entries(e.kb ?? {});
  // Права скрытых разделов (lib/launch.ts) не упоминаются.
  const rights = (e.rights ?? []).filter((r) => r !== "portal.admin" && !isHiddenPermission(r));
  const rails = e.rails;
  return (
    <AccessSection
      title="Итоговые права"
      hint="Так их видит портал сейчас — после всех ролей, подразделений, должности, сроков и блокировки."
    >
      {!e.portal ? (
        <InfoNote variant="warning">
          {user.status === "blocked"
            ? "Заблокирован — ничего не доступно."
            : e.active === false
              ? "Срок доступа истёк — ничего не доступно."
              : "Нет действующих ролей — вход в портал закрыт."}
        </InfoNote>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Клубы</h3>
            {e.rights?.includes("portal.admin") && (
              <InfoNote variant="info">
                Суперадминистратор: всё во всех клубах и в портале.
              </InfoNote>
            )}
            {CLUBS_HIDDEN ? null : studios.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет доступа к данным клубов</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {studios.map(([id, s]) => (
                  <li key={id}>
                    <span className="font-medium">{names.studio.get(id) ?? "Клуб"}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — {TIER_LABEL[s.tier]},{" "}
                      {s.sections === null
                        ? "все разделы"
                        : s.sections.length
                          ? s.sections.map((k) => label.get(`club.${k}`) ?? k).join(", ")
                          : "без разделов"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {e.manage && (e.manage.all || e.manage.studios.length > 0) && (
              <p className="text-sm">
                <span className="text-muted-foreground">Управляет пользователями: </span>
                {e.manage.all
                  ? "всеми"
                  : `в клубах ${e.manage.studios.map((id) => names.studio.get(id) ?? "—").join(", ")}`}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Сеть</h3>
            <ul className="space-y-1 text-sm">
              <li className={cn(CLUBS_HIDDEN && "hidden")}>
                <span className="text-muted-foreground">Разделы админки: </span>
                {rails === null
                  ? "все"
                  : rails?.length
                    ? rails
                        .map(
                          (r) =>
                            ({
                              club: "Клуб",
                              staff: "Сотрудники",
                              app: "Мобильное приложение",
                              scripts: "Скрипты LS",
                              "scripts-edit": "правка скриптов",
                            })[r] ?? r,
                        )
                        .join(", ")
                    : "нет"}
              </li>
              <li>
                <span className="text-muted-foreground">Базы знаний: </span>
                {e.rights?.includes("kb.admin")
                  ? "все (администратор)"
                  : kb.length
                    ? kb
                        .map(
                          ([id, lvl]) => `${names.kbBase.get(id) ?? "база"} — ${LEVEL_LABEL[lvl]}`,
                        )
                        .join(", ")
                    : "нет"}
              </li>
              {rights.length > 0 && (
                <li>
                  <span className="text-muted-foreground">Права: </span>
                  {rights.map((r) => label.get(r) ?? r).join(", ")}
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </AccessSection>
  );
}
