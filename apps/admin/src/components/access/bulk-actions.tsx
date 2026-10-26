import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Loader2, ShieldCheck, Tag, Users, X } from "lucide-react";
import { toast } from "sonner";

import { AssignDialog } from "@/components/access/assign-dialog";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accessRpc, invalidateAccess, orgPositionsQuery, orgUnitsQuery } from "@/lib/access/data";
import { MEMBER_ROLE_LABEL, unitTree, USER_TYPE_LABEL, USER_TYPES } from "@/lib/access/logic";
import type { MemberRole } from "@/lib/access/types";

export type BulkUser = { id: string; label: string };
type Field = "position" | "type" | "unit";

const NONE = "none";

/**
 * Действия над отмеченными в «Пользователях» (замечание тестирования
 * 2026-10-27: 84 партнёра — 84 захода в карточку): должность, тип,
 * подразделение, роль. Запись — те же RPC, что карточка, по одному человеку:
 * у каждого своя проверка прав, сбой одного не останавливает остальных.
 */
export function BulkActionsBar({
  users,
  canManageUsers,
  canEditStructure,
  onClear,
}: {
  users: BulkUser[];
  canManageUsers: boolean;
  canEditStructure: boolean;
  onClear: () => void;
}) {
  const [field, setField] = useState<Field | null>(null);
  const [assigning, setAssigning] = useState(false);
  if (users.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-background p-2 sm:px-3">
      <span className="text-sm font-medium">Выбрано: {users.length}</span>
      {canManageUsers && (
        <>
          <Button size="sm" variant="outline" onClick={() => setField("position")}>
            <Briefcase /> Должность
          </Button>
          <Button size="sm" variant="outline" onClick={() => setField("type")}>
            <Tag /> Тип
          </Button>
        </>
      )}
      {canEditStructure && (
        <Button size="sm" variant="outline" onClick={() => setField("unit")}>
          <Users /> Подразделение
        </Button>
      )}
      {canManageUsers && (
        <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
          <ShieldCheck /> Назначить роль
        </Button>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X /> Снять выделение
      </Button>
      <Dialog open={!!field} onOpenChange={(o) => !o && setField(null)}>
        <DialogContent className="max-w-md">
          {field && (
            <BulkFieldForm
              key={field}
              field={field}
              users={users}
              onDone={(ok) => {
                setField(null);
                if (ok) onClear();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <AssignDialog open={assigning} onOpenChange={setAssigning} subject={null} bulkUsers={users} />
    </div>
  );
}

const TITLE: Record<Field, string> = {
  position: "Должность",
  type: "Тип пользователя",
  unit: "Подразделение",
};

function BulkFieldForm({
  field,
  users,
  onDone,
}: {
  field: Field;
  users: BulkUser[];
  onDone: (ok: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: positions } = useQuery({ ...orgPositionsQuery, enabled: field === "position" });
  const { data: units } = useQuery({ ...orgUnitsQuery, enabled: field === "unit" });
  const [value, setValue] = useState(field === "unit" ? "" : NONE);
  const [memberRole, setMemberRole] = useState<MemberRole>("member");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [progress, setProgress] = useState<string | null>(null);

  const apply = async () => {
    if (field === "unit" && !value) {
      toast.error("Выберите подразделение");
      return;
    }
    const failed: string[] = [];
    for (const [i, u] of users.entries()) {
      setProgress(`${i + 1} из ${users.length}`);
      try {
        if (field === "unit") {
          await accessRpc("org_member_set", {
            p_unit: value,
            p_user: u.id,
            p_role: mode === "add" ? memberRole : null,
          });
        } else {
          await accessRpc("access_user_save", {
            p_user: u.id,
            p:
              field === "position"
                ? { position_id: value === NONE ? "" : value }
                : { user_type: value === NONE ? "" : value },
          });
        }
      } catch (e) {
        failed.push(`${u.label}: ${e instanceof Error ? e.message : "ошибка"}`);
      }
    }
    setProgress(null);
    await invalidateAccess(qc);
    if (failed.length) {
      toast.error(`Не сохранено у ${failed.length} из ${users.length}`, {
        description: failed.slice(0, 5).join("\n"),
      });
    } else {
      toast.success(`Сохранено: ${users.length} чел. — права пересчитаны`);
    }
    onDone(failed.length === 0);
  };

  const saving = progress !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{TITLE[field]}</DialogTitle>
        <DialogDescription>
          Для {users.length} чел.:{" "}
          {users
            .slice(0, 3)
            .map((u) => u.label)
            .join(", ")}
          {users.length > 3 ? ` и ещё ${users.length - 3}` : ""}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={apply}>
        <DialogBody>
          <div className="space-y-3">
            {field === "position" && (
              <FormField label="Должность" htmlFor={null}>
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Не указана</SelectItem>
                    {(positions ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {field === "type" && (
              <FormField label="Тип" htmlFor={null}>
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Не указан</SelectItem>
                    {USER_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {USER_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {field === "unit" && (
              <>
                <SegmentedControl
                  aria-label="Действие"
                  fullWidth
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "add", label: "Добавить" },
                    { value: "remove", label: "Убрать" },
                  ]}
                />
                <FormField label="Подразделение" htmlFor={null} required>
                  <Select value={value} onValueChange={setValue}>
                    <SelectTrigger>
                      <SelectValue placeholder="Выберите" />
                    </SelectTrigger>
                    <SelectContent>
                      {unitTree(units ?? []).map(({ unit, depth }) => (
                        <SelectItem key={unit.id} value={unit.id}>
                          {"  ".repeat(depth)}
                          {unit.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                {mode === "add" && (
                  <FormField label="Роль в подразделении" htmlFor={null}>
                    <Select
                      value={memberRole}
                      onValueChange={(v) => setMemberRole(v as MemberRole)}
                    >
                      <SelectTrigger>
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
                  </FormField>
                )}
                <InfoNote>
                  {mode === "add"
                    ? "Из других подразделений люди не убираются — человек может быть в нескольких."
                    : "Роли этого подразделения у них пропадут (если не выданы иначе)."}
                </InfoNote>
              </>
            )}
            {field === "position" && (
              <InfoNote>
                У человека одна должность — прежняя заменится. Роли новой должности появятся сразу,
                прежней — пропадут.
              </InfoNote>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? `Сохраняем… ${progress}` : "Применить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
