import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { RoleChip } from "@/components/access/parts";
import { ScopePicker, type Scope } from "@/components/access/scope-picker";
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
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import {
  accessCatalogQuery,
  accessRolesQuery,
  accessRpc,
  accessUsersQuery,
  invalidateAccess,
  orgPositionsQuery,
  orgUnitsQuery,
} from "@/lib/access/data";
import {
  hasStudioPerms,
  isoToLocalInput,
  localInputToIso,
  roleSummary,
  unitTree,
} from "@/lib/access/logic";
import type { Assignment, SubjectType } from "@/lib/access/types";

export type AssignSubject = { type: SubjectType; id: string; label: string };

const TIPS = {
  role: "Права роли — в «Ролях». Недоступные вам роли выключены: выдавать можно не больше своих прав.",
  scope:
    "Права роли «в клубе» (данные и разделы клуба, управление людьми) действуют только здесь. Сетевые права (базы знаний, Академия, разделы админки) — везде.",
  until:
    "Временный или демо-доступ: после этого момента роль перестаёт действовать сама. Пусто — бессрочно.",
  heads: "Только руководители и заместители подразделения — например, кураторам их отделов.",
  subunits: "Роль получат и сотрудники подразделений ниже по дереву — в том числе будущие.",
};

/**
 * Назначить роль человеку, подразделению или должности (или изменить
 * назначение). База проверит, можно ли вызывающему (access_assignment_save):
 * управляющий клубами выдаёт роли только в своих клубах и не больше своих
 * прав.
 */
export function AssignDialog({
  open,
  onOpenChange,
  subject,
  existing,
  defaultRoleId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Нет — выбор «кому» в окне (страница роли). */
  subject: AssignSubject | null;
  existing?: Assignment | null;
  defaultRoleId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" anchor="top">
        {open && (
          <AssignForm
            key={existing?.id ?? "new"}
            fixedSubject={subject}
            existing={existing ?? null}
            defaultRoleId={defaultRoleId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({
  fixedSubject,
  existing,
  defaultRoleId,
  onDone,
}: {
  fixedSubject: AssignSubject | null;
  existing: Assignment | null;
  defaultRoleId?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const { data: roles } = useQuery(accessRolesQuery);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const { data: users } = useQuery({ ...accessUsersQuery, enabled: !fixedSubject });
  const { data: units } = useQuery({ ...orgUnitsQuery, enabled: !fixedSubject });
  const { data: positions } = useQuery({ ...orgPositionsQuery, enabled: !fixedSubject });
  const restricted = !access?.manageAll && !hasRight(access, "portal.admin");
  const [subjectType, setSubjectType] = useState<SubjectType>("user");
  const [subjectId, setSubjectId] = useState("");
  const subject: AssignSubject | null =
    fixedSubject ??
    (subjectId
      ? {
          type: subjectType,
          id: subjectId,
          label:
            subjectType === "user"
              ? (users?.find((u) => u.user_id === subjectId)?.full_name ?? "")
              : subjectType === "unit"
                ? (units?.find((u) => u.id === subjectId)?.name ?? "")
                : (positions?.find((p) => p.id === subjectId)?.name ?? ""),
        }
      : null);
  const [roleId, setRoleId] = useState(existing?.role_id ?? defaultRoleId ?? "");
  const [scope, setScope] = useState<Scope>(() =>
    existing
      ? { scope_type: existing.scope_type, scope_ids: existing.scope_ids }
      : restricted
        ? { scope_type: "studios", scope_ids: [] }
        : { scope_type: "all", scope_ids: [] },
  );
  const [heads, setHeads] = useState(existing?.unit_members === "heads");
  const [subunits, setSubunits] = useState(existing?.with_subunits ?? true);
  const [from, setFrom] = useState(isoToLocalInput(existing?.valid_from ?? null));
  const [until, setUntil] = useState(isoToLocalInput(existing?.valid_until ?? null));
  const [note, setNote] = useState(existing?.note ?? "");
  const [saving, setSaving] = useState(false);

  const role = roles?.find((r) => r.id === roleId) ?? null;
  const studioPerms = role ? hasStudioPerms(role.permissions, catalog ?? []) : false;

  const save = async () => {
    if (!subject) {
      toast.error("Выберите, кому выдать роль");
      return;
    }
    if (!role) {
      toast.error("Выберите роль");
      return;
    }
    if (studioPerms && scope.scope_type !== "all" && scope.scope_ids.length === 0) {
      toast.error(scope.scope_type === "brands" ? "Отметьте бренды" : "Отметьте клубы");
      return;
    }
    const validFrom = localInputToIso(from);
    const validUntil = localInputToIso(until);
    if (validFrom && validUntil && validUntil <= validFrom) {
      toast.error("Окончание должно быть позже начала");
      return;
    }
    setSaving(true);
    try {
      // Роль без прав «в клубе»: клубы не важны.
      const finalScope: Scope = studioPerms ? scope : { scope_type: "all", scope_ids: [] };
      await accessRpc("access_assignment_save", {
        p: {
          id: existing?.id ?? null,
          role_id: role.id,
          subject_type: subject.type,
          user_id: subject.type === "user" ? subject.id : null,
          unit_id: subject.type === "unit" ? subject.id : null,
          position_id: subject.type === "position" ? subject.id : null,
          unit_members: heads ? "heads" : "all",
          with_subunits: subunits,
          scope_type: finalScope.scope_type,
          scope_ids: finalScope.scope_ids,
          valid_from: validFrom,
          valid_until: validUntil,
          note,
        },
      });
      toast.success(existing ? "Назначение сохранено" : "Роль выдана — права уже действуют");
      await invalidateAccess(qc);
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
        <DialogTitle>{existing ? "Назначение роли" : "Назначить роль"}</DialogTitle>
        <DialogDescription>
          {fixedSubject ? fixedSubject.label : "Человеку, подразделению или должности."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            {!fixedSubject && (
              <FormField label="Кому" htmlFor={null} required>
                <div className="space-y-2">
                  <SegmentedControl
                    aria-label="Кому"
                    fullWidth
                    value={subjectType}
                    onChange={(v) => {
                      setSubjectType(v);
                      setSubjectId("");
                    }}
                    options={[
                      { value: "user", label: "Человеку" },
                      ...(restricted
                        ? []
                        : [
                            { value: "unit" as const, label: "Подразделению" },
                            { value: "position" as const, label: "Должности" },
                          ]),
                    ]}
                  />
                  <Select value={subjectId} onValueChange={setSubjectId}>
                    <SelectTrigger aria-label="Кому">
                      <SelectValue placeholder="Выберите" />
                    </SelectTrigger>
                    <SelectContent>
                      {subjectType === "user"
                        ? (users ?? [])
                            .filter((u) => u.can_manage)
                            .map((u) => (
                              <SelectItem key={u.user_id} value={u.user_id}>
                                {u.full_name || u.email}
                              </SelectItem>
                            ))
                        : subjectType === "unit"
                          ? unitTree(units ?? []).map(({ unit, depth }) => (
                              <SelectItem key={unit.id} value={unit.id}>
                                {"\u00A0\u00A0".repeat(depth)}
                                {unit.name}
                              </SelectItem>
                            ))
                          : (positions ?? []).map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                    </SelectContent>
                  </Select>
                </div>
              </FormField>
            )}
            <FormField label="Роль" tip={TIPS.role} required>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите роль" />
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id} disabled={!!r.grant_problem}>
                      <RoleChip name={r.name} color={r.color} className="border-0 px-0" />
                      {r.grant_problem && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.grant_problem}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {role && (
              <div className="flex flex-wrap gap-1">
                {roleSummary(role.permissions, catalog ?? []).map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
                {role.permissions.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Без прав: только вход в портал (Академия, если назначены курсы)
                  </span>
                )}
              </div>
            )}

            {subject?.type === "unit" && (
              <FormField label="Кому в подразделении" htmlFor={null}>
                <div className="space-y-2 rounded-md border p-3">
                  <SegmentedControl
                    aria-label="Кому в подразделении"
                    fullWidth
                    value={heads ? "heads" : "all"}
                    onChange={(v) => setHeads(v === "heads")}
                    options={[
                      { value: "all", label: "Всем сотрудникам" },
                      { value: "heads", label: "Руководителям" },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">{heads ? TIPS.heads : null}</p>
                  <CheckboxOption checked={subunits} onCheckedChange={setSubunits}>
                    И в подразделениях ниже
                  </CheckboxOption>
                  <p className="text-xs text-muted-foreground">{TIPS.subunits}</p>
                </div>
              </FormField>
            )}

            {role && studioPerms ? (
              <FormField label="Где действует" tip={TIPS.scope} htmlFor={null} required>
                <ScopePicker
                  value={scope}
                  onChange={setScope}
                  allowedStudioIds={restricted ? (access?.manageStudioIds ?? []) : null}
                />
              </FormField>
            ) : role ? (
              <InfoNote>Права этой роли общие для сети — клубы выбирать не нужно.</InfoNote>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Действует с" optional>
                <Input
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </FormField>
              <FormField label="Действует до" tip={TIPS.until} optional>
                <Input
                  type="datetime-local"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </FormField>
            </div>
            <FormField label="Комментарий" optional>
              <Input
                value={note}
                maxLength={500}
                placeholder="Например: демо-доступ до подписания договора"
                onChange={(e) => setNote(e.target.value)}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {existing ? "Сохранить" : "Назначить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
