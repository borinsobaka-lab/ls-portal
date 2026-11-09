/**
 * Календарь: создать общий или настроить (название, цвет, описание и для
 * общего — кому открыт: вся компания, подразделение, участники проекта,
 * сотрудник; «Смотрит» / «Добавляет события» / «Управляет»). Проверки прав —
 * у базы (cal_calendar_save).
 */
import { UnitScopeFields } from "@/components/people/unit-scope-fields";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, FolderOpen, Globe, Loader2, Plus, Trash2, User, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { PeopleField, PersonLine } from "@/components/tasks/task-bits";
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
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  calendarQuery,
  calSourceOptionsQuery,
  deleteCalendar,
  saveCalendar,
} from "@/lib/calendar/data";
import { CAL_COLOR_KEYS, CAL_COLORS, calErrorText, LEVEL_LABEL } from "@/lib/calendar/logic";
import type { CalAccessRow, CalColor, CalLevel, CalendarFull } from "@/lib/calendar/types";
import { companyStructureQuery, unitChildren } from "@/lib/company";
import { cn } from "@/lib/utils";

const TIPS = {
  access:
    "Кто видит календарь у себя в «Календаре». «Добавляет события» — может создавать и править события, «Управляет» — ещё и настройки.",
};

export function CalendarDialog({
  target,
  onClose,
  onCreated,
}: {
  /** "new" — новый общий; id — настройки. */
  target: "new" | string | null;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-xl">
        {target === "new" ? (
          <CalendarForm key="new" value={null} onClose={onClose} onCreated={onCreated} />
        ) : target ? (
          <LoadedForm key={target} id={target} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LoadedForm({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useQuery(calendarQuery(id));
  if (error) {
    return (
      <DialogHeader className="px-4 py-4 sm:px-6">
        <DialogTitle>Календарь недоступен</DialogTitle>
        <DialogDescription>{calErrorText(error)}</DialogDescription>
      </DialogHeader>
    );
  }
  if (!data) {
    return (
      <>
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>Календарь</DialogTitle>
          <DialogDescription className="sr-only">Загрузка</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </DialogBody>
      </>
    );
  }
  return <CalendarForm value={data} onClose={onClose} />;
}

function CalendarForm({
  value,
  onClose,
  onCreated,
}: {
  value: CalendarFull | null;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [name, setName] = useState(value?.name ?? "");
  const [color, setColor] = useState<CalColor>(value?.color ?? "teal");
  const [description, setDescription] = useState(value?.description ?? "");
  const [access, setAccess] = useState<CalAccessRow[]>(value?.access ?? []);
  const [busy, setBusy] = useState(false);
  const shared = !value || value.kind === "shared";
  const manage = !value || value.level === "manage";

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Напишите название");
      return;
    }
    setBusy(true);
    try {
      const id = await saveCalendar(qc, value?.id ?? null, {
        name: name.trim(),
        color,
        description: description.trim(),
        ...(shared ? { access } : {}),
      });
      toast.success(value ? "Сохранено" : "Календарь создан");
      if (!value) onCreated?.(id);
      onClose();
    } catch (e) {
      toast.error(calErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!value) return;
    const ok = await confirm({
      title: `Удалить календарь «${value.name}»?`,
      description: "Все его события удалятся у всех, кому он открыт. Это не отменить.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    try {
      await deleteCalendar(qc, value.id);
      toast.success("Календарь удалён");
      onClose();
    } catch (e) {
      toast.error(calErrorText(e));
    }
  };

  return (
    <DialogForm onSubmit={submit}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>
          {value ? (manage ? "Настройки календаря" : value.name) : "Новый общий календарь"}
        </DialogTitle>
        <DialogDescription>
          {value?.kind === "personal"
            ? "Личный календарь видите только вы; встречи, куда вы пригласили людей, — и они."
            : "Планёрки отдела, акции и маркетинг, проекты — календарь видят все, кому он открыт."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название" required htmlFor="cal-name">
          <Input
            id="cal-name"
            autoFocus={!value}
            maxLength={80}
            value={name}
            disabled={!manage}
            placeholder="Например: Акции и маркетинг"
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label="Цвет" htmlFor={null}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Цвет">
            {CAL_COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={CAL_COLORS[c].label}
                title={CAL_COLORS[c].label}
                disabled={!manage}
                className="flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow aria-checked:ring-2 aria-checked:ring-foreground"
                style={{ backgroundColor: CAL_COLORS[c].solid }}
                onClick={() => setColor(c)}
              >
                {color === c && <Check className="size-4 text-white" />}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Описание" optional htmlFor="cal-desc">
          <Textarea
            id="cal-desc"
            rows={2}
            maxLength={500}
            value={description}
            disabled={!manage}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        {shared && manage && (
          <FormField label="Кому открыт" htmlFor={null} tip={TIPS.access}>
            <AccessEditor value={access} onChange={setAccess} />
          </FormField>
        )}
      </DialogBody>
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div>
          {value?.kind === "shared" && manage && (
            <Button variant="outline" onClick={() => void remove()}>
              <Trash2 className="size-4" /> Удалить
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            {manage ? "Отмена" : "Закрыть"}
          </Button>
          {manage && (
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {value ? "Сохранить" : "Создать"}
            </Button>
          )}
        </div>
      </DialogFooter>
      {confirmDialog}
    </DialogForm>
  );
}

const LEVELS: CalLevel[] = ["view", "edit", "manage"];

function useUnits(allowed: string[]) {
  const { data: units = [] } = useQuery(companyStructureQuery);
  return useMemo(() => {
    const ok = new Set(allowed);
    const children = unitChildren(units);
    const all = new Map(units.map((u) => [u.id, u.name]));
    const options: { id: string; name: string; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const u of children.get(parent) ?? []) {
        if (ok.has(u.id)) options.push({ id: u.id, name: u.name, depth });
        walk(u.id, depth + 1);
      }
    };
    walk(null, 0);
    return { options, name: (id: string) => all.get(id) ?? "Подразделение" };
  }, [units, allowed]);
}

/** Кому открыт общий календарь. */
function AccessEditor({
  value,
  onChange,
}: {
  value: CalAccessRow[];
  onChange: (v: CalAccessRow[]) => void;
}) {
  const { data: opts } = useQuery(calSourceOptionsQuery);
  const units = useUnits(opts?.units ?? []);
  const [adding, setAdding] = useState<"unit" | "project" | "user" | null>(null);
  const set = (i: number, patch: Partial<CalAccessRow>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const projectName = (id: string | null | undefined) =>
    opts?.projects.find((p) => p.id === id)?.title ?? "Проект";
  const hasAll = value.some((r) => r.subject === "all");
  const usedUnits = new Set(value.map((r) => r.unit_id).filter(Boolean));
  const usedProjects = new Set(value.map((r) => r.project_id).filter(Boolean));
  const usedUsers = value.map((r) => r.user_id).filter((x): x is string => !!x);

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <InfoNote>Пока только вам. Добавьте подразделение, проект или сотрудников.</InfoNote>
      )}
      {value.map((r, i) => (
        <div
          key={`${r.subject}:${r.unit_id ?? r.project_id ?? r.user_id ?? "all"}`}
          className="space-y-2 rounded-lg border p-3"
        >
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
              {r.subject === "all" && (
                <>
                  <Globe className="size-4 shrink-0 text-muted-foreground" /> Вся компания
                </>
              )}
              {r.subject === "unit" && (
                <>
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{units.name(r.unit_id ?? "")}</span>
                </>
              )}
              {r.subject === "project" && (
                <>
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">Проект «{projectName(r.project_id)}»</span>
                </>
              )}
              {r.subject === "user" && <PersonLine id={r.user_id} size="xs" />}
            </span>
            <Select value={r.level} onValueChange={(v) => set(i, { level: v as CalLevel })}>
              <SelectTrigger aria-label="Права" className="h-8 w-auto min-w-36 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Убрать"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </div>
          {r.subject === "unit" && (
            <UnitScopeFields
              scope={r.unit_scope ?? "all"}
              withSubunits={r.with_subunits ?? true}
              onChange={(v) => set(i, { unit_scope: v.scope, with_subunits: v.withSubunits })}
            />
          )}
        </div>
      ))}

      {adding === "unit" && (
        <Select
          value=""
          onValueChange={(id) => {
            onChange([
              ...value,
              {
                subject: "unit",
                unit_id: id,
                unit_scope: "all",
                with_subunits: true,
                level: "view",
              },
            ]);
            setAdding(null);
          }}
        >
          <SelectTrigger aria-label="Подразделение">
            <SelectValue placeholder="Выберите подразделение" />
          </SelectTrigger>
          <SelectContent>
            {units.options.map((u) => (
              <SelectItem key={u.id} value={u.id} disabled={usedUnits.has(u.id)}>
                <span style={{ paddingLeft: `${u.depth * 12}px` }}>{u.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {adding === "project" && (
        <Select
          value=""
          onValueChange={(id) => {
            onChange([...value, { subject: "project", project_id: id, level: "view" }]);
            setAdding(null);
          }}
        >
          <SelectTrigger aria-label="Проект">
            <SelectValue placeholder="Выберите проект" />
          </SelectTrigger>
          <SelectContent>
            {(opts?.projects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={usedProjects.has(p.id)}>
                {p.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {adding === "user" && (
        <PeopleField
          value={[]}
          exclude={usedUsers}
          addLabel="Выбрать сотрудника"
          single
          onChange={(ids) => {
            if (ids[0]) onChange([...value, { subject: "user", user_id: ids[0], level: "view" }]);
            setAdding(null);
          }}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {opts?.company && !hasAll && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange([{ subject: "all", level: "view" }, ...value])}
          >
            <Plus className="size-4" /> Вся компания
          </Button>
        )}
        {units.options.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className={cn(adding === "unit" && "bg-muted")}
            onClick={() => setAdding("unit")}
          >
            <Plus className="size-4" /> Подразделение
          </Button>
        )}
        {(opts?.projects.length ?? 0) > 0 && (
          <Button
            variant="outline"
            size="sm"
            className={cn(adding === "project" && "bg-muted")}
            onClick={() => setAdding("project")}
          >
            <Plus className="size-4" /> Проект
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className={cn(adding === "user" && "bg-muted")}
          onClick={() => setAdding("user")}
        >
          <User className="size-4" /> Сотрудник
        </Button>
      </div>
    </div>
  );
}
