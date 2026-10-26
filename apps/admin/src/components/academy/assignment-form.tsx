import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PersonCell } from "@/components/academy/parts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckboxOption, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { supabase } from "@/integrations/supabase/client";
import { acadStaffQuery, invalidateAcademy } from "@/lib/academy/data";
import { orgPositionsQuery, orgUnitsQuery } from "@/lib/access/data";
import { unitTree } from "@/lib/access/logic";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { acadError, ROLE_LABEL } from "@/lib/academy/logic";
import type { AcadAssignment } from "@/lib/academy/types";
import { unwrap } from "@/lib/query";
import { CLUBS_HIDDEN, isHiddenRole } from "@/lib/launch";

type Mode = "user" | "role" | "unit" | "position" | "access_role";
const MODE_LABEL: Record<Mode, string> = {
  user: "Сотрудникам",
  role: "По роли в клубе",
  unit: "Подразделению",
  position: "По должности",
  access_role: "По роли портала",
};
type Due = "none" | "date" | "days";
type Role = "owner" | "admin" | "trainer";

const TIPS = {
  role: "Курс получат все сотрудники с этой ролью в выбранных клубах — и те, кому роль выдадут позже: им курс назначится сам.",
  group:
    "Курс получат все, кто в подразделении (и ниже, если отмечено), с этой должностью или ролью портала — и те, кто появится там позже.",
  due: "Подставлен срок из настроек курса. «Дней с назначения» — у правила по роли отсчёт для нового сотрудника идёт с выдачи ему роли.",
};

/** Клубы — для правила по роли (studios читаются публично). */
function useAllStudios() {
  return useQuery({
    queryKey: ["acad", "studios"],
    queryFn: () =>
      unwrap<{ id: string; name: string }[]>(
        supabase.from("studios").select("id, name").order("created_at"),
      ),
    staleTime: 10 * 60_000,
    meta: { errorMessage: "Не удалось загрузить клубы" },
  });
}

/**
 * Назначить курс: конкретным сотрудникам или правилом «роль в клубах»
 * (решение владельца 2026-10-25: «людям и ролям»). Срок — дата или «N дней с
 * назначения». Уже назначенных людей в списке нет.
 */
export function AcadAssignmentForm({
  courseId,
  existing,
  defaultDueDays,
  onDone,
}: {
  courseId: string;
  existing: AcadAssignment[];
  /** Срок курса по умолчанию (настройки курса) — подставляется сам. */
  defaultDueDays: number | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: staff } = useQuery(acadStaffQuery);
  const { data: studios } = useAllStudios();
  const [mode, setMode] = useState<Mode>("user");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const [groupId, setGroupId] = useState("");
  const [withSubunits, setWithSubunits] = useState(true);
  const { data: units } = useQuery({ ...orgUnitsQuery, enabled: mode === "unit" });
  const { data: positions } = useQuery({ ...orgPositionsQuery, enabled: mode === "position" });
  const { data: accessRoles } = useQuery({
    queryKey: ["acad", "access-roles"],
    queryFn: () =>
      unwrap<{ id: string; name: string; system_key: string | null }[]>(
        supabase
          .from("access_roles")
          .select("id, name, system_key")
          .is("personal_user_id", null)
          .order("sort_order"),
      ),
    // Стартовые роли клубов пока не показываются (lib/launch.ts).
    select: (rows: { id: string; name: string; system_key: string | null }[]) =>
      rows.filter((r) => !isHiddenRole(r)),
    enabled: mode === "access_role",
    meta: { errorMessage: "Не удалось загрузить роли" },
  });
  const [allStudios, setAllStudios] = useState(true);
  const [studioIds, setStudioIds] = useState<Set<string>>(new Set());
  const [due, setDue] = useState<Due>(defaultDueDays ? "days" : "none");
  const [dueDate, setDueDate] = useState("");
  const [dueDays, setDueDays] = useState(String(defaultDueDays ?? 14));
  const [saving, setSaving] = useState(false);

  const assigned = useMemo(
    () => new Set(existing.filter((a) => a.subject_type === "user").map((a) => a.user_id)),
    [existing],
  );
  const term = q.trim().toLowerCase();
  const people = (staff ?? []).filter(
    (p) =>
      !assigned.has(p.user_id) &&
      (!term || `${p.full_name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(term)),
  );
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const save = async () => {
    if (mode === "user" && picked.size === 0) {
      toast.error("Отметьте сотрудников");
      return;
    }
    if ((mode === "unit" || mode === "position" || mode === "access_role") && !groupId) {
      toast.error(
        mode === "unit"
          ? "Выберите подразделение"
          : mode === "position"
            ? "Выберите должность"
            : "Выберите роль",
      );
      return;
    }
    if (mode === "role" && !allStudios && studioIds.size === 0) {
      toast.error("Отметьте клубы или «Во всех клубах»");
      return;
    }
    const days = Number(dueDays);
    if (due === "date" && !dueDate) {
      toast.error("Укажите дату срока");
      return;
    }
    if (due === "days" && (!Number.isInteger(days) || days < 1 || days > 365)) {
      toast.error("Срок — от 1 до 365 дней");
      return;
    }
    const term = {
      due_date: due === "date" ? dueDate : null,
      due_days: due === "days" ? days : null,
    };
    setSaving(true);
    try {
      const rows: Record<string, unknown>[] =
        mode === "user"
          ? [...picked].map((user_id) => ({
              course_id: courseId,
              subject_type: "user",
              user_id,
              ...term,
            }))
          : mode === "role"
            ? [
                {
                  course_id: courseId,
                  subject_type: "role",
                  role,
                  studio_ids: allStudios ? [] : [...studioIds],
                  ...term,
                },
              ]
            : [
                {
                  course_id: courseId,
                  subject_type: mode,
                  unit_id: mode === "unit" ? groupId : null,
                  position_id: mode === "position" ? groupId : null,
                  access_role_id: mode === "access_role" ? groupId : null,
                  with_subunits: withSubunits,
                  ...term,
                },
              ];
      const { error } = await supabase.from("acad_assignments").insert(rows);
      if (error) throw new Error(error.message);
      toast.success("Курс назначен");
      await invalidateAcademy(qc);
      onDone();
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Назначить курс</DialogTitle>
        <DialogDescription>
          Ученики увидят курс в «Моих курсах», пока он опубликован.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Кому" htmlFor={null}>
              <Select
                value={mode}
                onValueChange={(v) => {
                  setMode(v as Mode);
                  setGroupId("");
                }}
              >
                <SelectTrigger aria-label="Кому">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODE_LABEL) as Mode[])
                    // «По роли в клубе» — пока клубы скрыты (lib/launch.ts), нет.
                    .filter((m) => !CLUBS_HIDDEN || m !== "role")
                    .map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormField>
            {mode === "user" ? (
              <div className="space-y-2">
                <SearchInput value={q} onChange={setQ} placeholder="Имя или почта" />
                <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border p-1">
                  {people.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      {staff ? "Ничего не нашлось" : "Загружаем сотрудников…"}
                    </p>
                  ) : (
                    people.map((p) => (
                      <label
                        key={p.user_id}
                        className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={picked.has(p.user_id)}
                          onCheckedChange={(v) =>
                            setPicked((s) => toggle(s, p.user_id, v === true))
                          }
                        />
                        <PersonCell name={p.full_name} avatar={p.avatar_url} />
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {[...new Set(p.roles.map((r) => ROLE_LABEL[r.role].toLowerCase()))].join(
                            ", ",
                          )}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {picked.size > 0 && (
                  <p className="text-xs text-muted-foreground">Отмечено: {picked.size}</p>
                )}
              </div>
            ) : mode !== "role" ? (
              <FormField
                label={
                  mode === "unit"
                    ? "Подразделение"
                    : mode === "position"
                      ? "Должность"
                      : "Роль портала"
                }
                tip={TIPS.group}
                htmlFor={null}
              >
                <div className="space-y-2">
                  <Select value={groupId} onValueChange={setGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Выберите" />
                    </SelectTrigger>
                    <SelectContent>
                      {mode === "unit"
                        ? unitTree(units ?? []).map(({ unit, depth }) => (
                            <SelectItem key={unit.id} value={unit.id}>
                              {"\u00A0\u00A0".repeat(depth)}
                              {unit.name}
                            </SelectItem>
                          ))
                        : (mode === "position" ? (positions ?? []) : (accessRoles ?? [])).map(
                            (x) => (
                              <SelectItem key={x.id} value={x.id}>
                                {x.name}
                              </SelectItem>
                            ),
                          )}
                    </SelectContent>
                  </Select>
                  {mode === "unit" && (
                    <CheckboxOption checked={withSubunits} onCheckedChange={setWithSubunits}>
                      И в подразделениях ниже
                    </CheckboxOption>
                  )}
                </div>
              </FormField>
            ) : (
              <div className="space-y-3">
                <FormField label="Роль" tip={TIPS.role} htmlFor={null}>
                  <SegmentedControl
                    aria-label="Роль"
                    fullWidth
                    value={role}
                    onChange={setRole}
                    options={(["admin", "trainer", "owner"] as const).map((r) => ({
                      value: r,
                      label: ROLE_LABEL[r],
                    }))}
                  />
                </FormField>
                <FormField label="В каких клубах" htmlFor={null}>
                  <div className="space-y-2 rounded-md border p-3">
                    <CheckboxOption checked={allStudios} onCheckedChange={setAllStudios}>
                      Во всех клубах — и в новых
                    </CheckboxOption>
                    {!allStudios &&
                      (studios ?? []).map((s) => (
                        <CheckboxOption
                          key={s.id}
                          checked={studioIds.has(s.id)}
                          onCheckedChange={(v) => setStudioIds((set) => toggle(set, s.id, v))}
                        >
                          {s.name}
                        </CheckboxOption>
                      ))}
                  </div>
                </FormField>
              </div>
            )}
            <FormField label="Срок" tip={TIPS.due} htmlFor={null}>
              <div className="space-y-2">
                <SegmentedControl
                  aria-label="Срок"
                  fullWidth
                  value={due}
                  onChange={setDue}
                  options={[
                    { value: "none", label: "Без срока" },
                    { value: "date", label: "До даты" },
                    { value: "days", label: "Дней" },
                  ]}
                />
                {due === "date" && (
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                )}
                {due === "days" && (
                  <div className="flex items-center gap-2 text-sm">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={365}
                      className="w-24"
                      value={dueDays}
                      onChange={(e) => setDueDays(e.target.value)}
                    />
                    дней с назначения
                  </div>
                )}
              </div>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Назначить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
