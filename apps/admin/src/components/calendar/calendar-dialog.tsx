/**
 * Календарь: создать общий или настроить (название, цвет, описание и для
 * общего — кому открыт: вся компания, подразделение, участники проекта,
 * сотрудник; «Просмотр» / «Добавление событий» / «Полный доступ»). Кому
 * открыт — одной кнопкой «+ Добавить» с выбором тут же, в выпадающем окне
 * (передумал — закрыл окно). Проверки прав — у базы (cal_calendar_save).
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  ChevronLeft,
  FolderOpen,
  Globe,
  Loader2,
  Plus,
  Trash2,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PeoplePicker } from "@/components/chats/dialogs";
import { useConfirm } from "@/components/confirm-dialog";
import { UnitScopeFields } from "@/components/people/unit-scope-fields";
import { PersonLine } from "@/components/tasks/task-bits";
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
import { Input } from "@/components/ui/input";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import {
  CAL_COLOR_KEYS,
  CAL_COLORS,
  calErrorText,
  LEVEL_LABEL,
  LEVEL_TIP,
} from "@/lib/calendar/logic";
import type { CalAccessRow, CalColor, CalLevel, CalendarFull } from "@/lib/calendar/types";
import { companyStructureQuery, unitChildren } from "@/lib/company";

const TIPS = {
  access: `Кто видит календарь у себя в «Календаре». ${LEVEL_TIP}`,
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
  const [nameError, setNameError] = useState<string | null>(null);
  const personal = value?.kind === "personal";
  const shared = !value || value.kind === "shared";
  const manage = !value || value.level === "manage";

  const submit = async () => {
    if (!personal && !name.trim()) {
      setNameError("Напишите название");
      document.getElementById("cal-name")?.focus();
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
          {personal
            ? "Личный календарь"
            : value
              ? manage
                ? "Настройки календаря"
                : value.name
              : "Новый общий календарь"}
        </DialogTitle>
        <DialogDescription>
          {personal
            ? "Его видите только вы (встречу — и те, кого вы пригласили). Удалить нельзя."
            : "Планёрки отдела, акции и маркетинг, проекты — календарь видят все, кому он открыт."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {!manage ? (
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <span
                className="size-3 shrink-0 rounded-sm"
                style={{ backgroundColor: CAL_COLORS[color].solid }}
              />
              {name}
            </p>
            {description && <p className="text-muted-foreground">{description}</p>}
            <InfoNote>
              Ваш доступ — «{LEVEL_LABEL[value?.level ?? "view"]}». Настройки меняют те, у кого
              «Полный доступ».
            </InfoNote>
          </div>
        ) : (
          <>
            {!personal && (
              <FormField label="Название" required htmlFor="cal-name" error={nameError}>
                <Input
                  id="cal-name"
                  autoFocus={!value}
                  maxLength={80}
                  value={name}
                  placeholder="Например: Акции и маркетинг"
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                />
              </FormField>
            )}
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
                    className="flex size-8 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow aria-checked:ring-2 aria-checked:ring-foreground"
                    style={{ backgroundColor: CAL_COLORS[c].solid }}
                    onClick={() => setColor(c)}
                  >
                    {color === c && <Check className="size-4 text-white" />}
                  </button>
                ))}
              </div>
            </FormField>
            {!personal && (
              <FormField
                label="Описание"
                optional
                htmlFor="cal-desc"
                hint="Видно при наведении на календарь в меню и в карточках его событий."
              >
                <Textarea
                  id="cal-desc"
                  rows={2}
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </FormField>
            )}
            {shared && (
              <FormField label="Кому открыт" htmlFor={null} tip={TIPS.access}>
                <AccessEditor value={access} onChange={setAccess} />
              </FormField>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div>
          {value?.kind === "shared" && manage && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => void remove()}
            >
              <Trash2 /> Удалить календарь
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            {manage ? "Отмена" : "Закрыть"}
          </Button>
          {manage && (
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {value ? "Сохранить" : "Создать календарь"}
            </Button>
          )}
        </div>
      </DialogFooter>
      {confirmDialog}
    </DialogForm>
  );
}

const LEVELS: CalLevel[] = ["view", "edit", "manage"];

type UnitOption = { id: string; name: string; depth: number };

function useUnits(allowed: string[]) {
  const { data: units = [] } = useQuery(companyStructureQuery);
  return useMemo(() => {
    const ok = new Set(allowed);
    const children = unitChildren(units);
    const all = new Map(units.map((u) => [u.id, u.name]));
    const options: UnitOption[] = [];
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
  const set = (i: number, patch: Partial<CalAccessRow>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const projectName = (id: string | null | undefined) =>
    opts?.projects.find((p) => p.id === id)?.title ?? "Проект";

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
          <div className="flex flex-wrap items-center gap-2">
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
              <SelectTrigger aria-label="Права" className="w-48">
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
              className="shrink-0"
              aria-label="Убрать"
              title="Убрать"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X />
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
      <AddAccess
        value={value}
        company={!!opts?.company}
        units={units.options}
        projects={opts?.projects ?? []}
        onAdd={(row) => onChange(row.subject === "all" ? [row, ...value] : [...value, row])}
      />
    </div>
  );
}

/** «+ Добавить»: «Вся компания / Подразделение… / Проект… / Сотрудник…», выбор — тут же. */
function AddAccess({
  value,
  company,
  units,
  projects,
  onAdd,
}: {
  value: CalAccessRow[];
  company: boolean;
  units: UnitOption[];
  projects: { id: string; title: string }[];
  onAdd: (row: CalAccessRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"menu" | "unit" | "project" | "user">("menu");
  const hasAll = value.some((r) => r.subject === "all");
  const usedUnits = new Set(value.map((r) => r.unit_id).filter(Boolean));
  const usedProjects = new Set(value.map((r) => r.project_id).filter(Boolean));
  const usedUsers = value.map((r) => r.user_id).filter((x): x is string => !!x);
  const add = (row: CalAccessRow) => {
    onAdd(row);
    setOpen(false);
  };
  const back = (
    <ListItemButton className="text-muted-foreground" onClick={() => setStep("menu")}>
      <ChevronLeft /> Назад
    </ListItemButton>
  );
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setStep("menu");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus /> Добавить
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-1">
        {step === "menu" && (
          <>
            {company && (
              <ListItemButton
                disabled={hasAll}
                onClick={() => add({ subject: "all", level: "view" })}
              >
                <Globe /> Вся компания
              </ListItemButton>
            )}
            <ListItemButton disabled={units.length === 0} onClick={() => setStep("unit")}>
              <Building2 /> Подразделение…
            </ListItemButton>
            <ListItemButton disabled={projects.length === 0} onClick={() => setStep("project")}>
              <FolderOpen /> Проект…
            </ListItemButton>
            <ListItemButton onClick={() => setStep("user")}>
              <User /> Сотрудник…
            </ListItemButton>
          </>
        )}
        {step === "unit" && (
          <>
            {back}
            <div className="max-h-72 overflow-y-auto">
              {units.map((u) => (
                <ListItemButton
                  key={u.id}
                  disabled={usedUnits.has(u.id)}
                  style={{ paddingLeft: `${12 + u.depth * 12}px` }}
                  onClick={() =>
                    add({
                      subject: "unit",
                      unit_id: u.id,
                      unit_scope: "all",
                      with_subunits: true,
                      level: "view",
                    })
                  }
                >
                  {u.name}
                </ListItemButton>
              ))}
            </div>
          </>
        )}
        {step === "project" && (
          <>
            {back}
            <div className="max-h-72 overflow-y-auto">
              {projects.map((p) => (
                <ListItemButton
                  key={p.id}
                  disabled={usedProjects.has(p.id)}
                  onClick={() => add({ subject: "project", project_id: p.id, level: "view" })}
                >
                  {p.title}
                </ListItemButton>
              ))}
            </div>
          </>
        )}
        {step === "user" && (
          <div className="space-y-1">
            {back}
            <div className="p-2">
              <PeoplePicker
                single
                selected={[]}
                exclude={usedUsers}
                onToggle={(uid) => add({ subject: "user", user_id: uid, level: "view" })}
              />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
