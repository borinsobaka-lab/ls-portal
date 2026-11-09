/**
 * «Задачи» — список (план, 3.4; UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.2):
 * сверху плашки — вид «Список · Сроки · Мой план» и роль «Делаю / Помогаю /
 * Поручил / Наблюдаю / Все мои»; на виду — поиск, статус, срок, исполнитель
 * и «Показать завершённые», остальное (постановщик, проект, тег, периоды,
 * «Срочные — первыми», «Пункты на мне», «Все задачи портала») — за кнопкой
 * «Фильтры (N)». Фильтры — в адресе, «Сохранить фильтр» — в меню раздела.
 * Сортировка — по заголовкам колонок. Задачи одной постановки «каждому своя» —
 * одной строкой-сводкой. Строка — карточка панелью справа (`?task=`).
 * «Подчинённые» (`?team=1&assignee=…`) — задачи одного человека без моих ролей.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ArrowLeft, Plus, Save, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { PeoplePicker } from "@/components/chats/dialogs";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { TaskSheet, TaskTable } from "@/components/tasks/task-table";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { TasksViewTabs } from "@/components/tasks/tasks-views";
import { PersonLine } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { CheckboxOption, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTableSort } from "@/hooks/use-table-sort";
import { hasRight } from "@/lib/admin-access";
import { usePeople } from "@/lib/chats/people";
import { dateOf, isoOf } from "@/lib/day-format";
import {
  taskAction,
  taskErrorText,
  useMyProjects,
  useTaskClock,
  useTaskList,
  tagsQuery,
} from "@/lib/tasks/data";
import {
  cleanFilters,
  DEADLINE_FILTERS,
  filtersDiffer,
  hasExtraFilters,
  hiddenFilterCount,
  ROLE_TABS,
  serverSort,
  STATUS_LABEL,
  STATUS_ORDER,
  taskSortGetters,
  TODAY_PRESET,
} from "@/lib/tasks/logic";
import type { RoleTab, TaskFilters, TaskRow, TaskStatus } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const ALL = "all";

const range = (from?: string, to?: string): DateRange | undefined =>
  from || to
    ? { from: from ? dateOf(from) : undefined, to: to ? dateOf(to) : undefined }
    : undefined;

export function TasksListPage({
  filters,
  task,
  onFilters,
  onTask,
}: {
  filters: TaskFilters;
  task: number | undefined;
  onFilters: (f: TaskFilters) => void;
  onTask: (n: number | undefined) => void;
}) {
  const { tz } = useTaskClock();
  const { name } = usePeople();
  const [pages, setPages] = useState(1);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(filters.q ?? "");
  const debounced = useDebouncedValue(q.trim(), 300);
  const getters = useMemo(() => taskSortGetters(name), [name]);
  const sort = useTableSort<TaskRow>(getters);
  const effective = useMemo(
    () => cleanFilters({ ...filters, q: debounced || undefined }),
    [filters, debounced],
  );
  const request = useMemo(
    () => ({ ...effective, sort: serverSort(sort.sort?.key, filters.sort === "urgent") }),
    [effective, sort.sort, filters.sort],
  );
  const { data, isPending, isFetching } = useTaskList(request, pages);
  const rows = useMemo(() => sort.apply(data?.rows ?? []), [data, sort]);
  const set = (patch: Partial<TaskFilters>) => {
    setPages(1);
    onFilters(cleanFilters({ ...filters, q: debounced || undefined, ...patch }));
  };
  const role = filters.role ?? "all";
  const reset = () => {
    setQ("");
    setPages(1);
    onFilters(
      cleanFilters({
        role: filters.role,
        team: filters.team,
        assignee: filters.team ? filters.assignee : undefined,
      }),
    );
  };
  const extra = hasExtraFilters(effective) && !(filters.team && hiddenOnlyTeam(effective));
  const isToday = role === "do" && filters.deadline === "today";
  const title = filters.team
    ? filters.assignee
      ? `Задачи: ${name(filters.assignee)}`
      : "Задачи подчинённых"
    : isToday && !filters.status && !filters.q
      ? "Задачи на сегодня"
      : role === "all"
        ? "Задачи"
        : `Задачи: ${(ROLE_TABS.find((t) => t.key === role)?.title ?? "").toLowerCase()}`;

  return (
    <AdminShell
      title={title}
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Новая задача
        </Button>
      }
    >
      <div className="space-y-3">
        <TableToolbar
          tabs={
            filters.team ? (
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/tasks/team">
                    <ArrowLeft /> Все подчинённые
                  </Link>
                </Button>
                {filters.assignee && <PersonLine id={filters.assignee} className="text-sm" />}
              </div>
            ) : (
              <TasksViewTabs
                view="list"
                role={role}
                onRole={(v: RoleTab) =>
                  set({
                    role: v === "all" ? undefined : v,
                    deadline: isToday ? undefined : filters.deadline,
                  })
                }
              />
            )
          }
        >
          <ToolbarSearch value={q} onChange={setQ} placeholder="Номер, название, описание" />
          <Select
            value={filters.status?.[0] ?? ALL}
            onValueChange={(v) => set({ status: v === ALL ? undefined : [v as TaskStatus] })}
          >
            <SelectTrigger className="w-40" aria-label="Статус">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все статусы</SelectItem>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.deadline ?? ALL}
            onValueChange={(v) =>
              set({
                deadline: v === ALL ? undefined : (v as TaskFilters["deadline"]),
                dfrom: undefined,
                dto: undefined,
              })
            }
          >
            <SelectTrigger className="w-40" aria-label="Срок">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Любой срок</SelectItem>
              {DEADLINE_FILTERS.filter(
                (d) => d.key !== "range" || filters.deadline === "range",
              ).map((d) => (
                <SelectItem key={d.key} value={d.key}>
                  {d.key === "range" ? "Период (в фильтрах)" : d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!filters.team && (
            <PersonFilter
              label="Исполнитель"
              value={filters.assignee}
              onChange={(id) => set({ assignee: id })}
            />
          )}
          <MoreFilters filters={filters} set={set} />
          <div className="flex h-10 items-center gap-2 px-1">
            <Checkbox
              id="tasks-done"
              checked={!!filters.done}
              onCheckedChange={(v) => set({ done: v === true || undefined })}
            />
            <Label htmlFor="tasks-done" className="cursor-pointer font-normal whitespace-nowrap">
              Показать завершённые
            </Label>
          </div>
          {filtersDiffer(effective) && (
            <Button variant="ghost" onClick={() => setSaving(true)}>
              <Save className="size-4" /> Сохранить фильтр
            </Button>
          )}
          <ToolbarReset active={extra} onReset={reset} />
        </TableToolbar>

        <TaskTable
          rows={rows}
          isPending={isPending}
          tz={tz}
          active={task}
          onOpen={onTask}
          sort={sort}
          onTag={(tag) => set({ tag })}
          groupBatches={!sort.sort && (role === "assigned" || role === "all")}
          showProject={!filters.project}
          empty={
            extra ? (
              <div className="flex flex-col items-center gap-3">
                <span>Под фильтр ничего не подошло.</span>
                <Button variant="outline" onClick={reset}>
                  <X className="size-4" /> Сбросить фильтры
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <span>
                  {isToday
                    ? "На сегодня задач нет."
                    : filters.team
                      ? "У сотрудника нет открытых задач."
                      : "Задач пока нет."}
                </span>
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" /> Поставить задачу
                </Button>
              </div>
            )
          }
          footer={
            !isPending &&
            rows.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-3 border-t p-3 text-sm text-muted-foreground">
                <span>Показано {rows.length}</span>
                {data?.hasMore && (
                  <Button
                    variant="outline"
                    disabled={isFetching}
                    onClick={() => setPages((p) => p + 1)}
                  >
                    Показать ещё
                  </Button>
                )}
              </div>
            )
          }
        />
      </div>

      <TaskSheet
        number={task}
        onClose={() => onTask(undefined)}
        onOpen={onTask}
        list={rows.map((r) => r.number)}
      />
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        initialAssignee={filters.team ? filters.assignee : undefined}
        onOpenTask={onTask}
      />
      <SaveFilterDialog open={saving} filters={effective} onClose={() => setSaving(false)} />
    </AdminShell>
  );
}

/** В «Подчинённых» исполнитель — часть самой страницы, а не фильтр. */
function hiddenOnlyTeam(f: TaskFilters) {
  return Object.keys(cleanFilters(f)).every((k) =>
    ["team", "assignee", "role", "sort"].includes(k),
  );
}

/** «Фильтры (N)» — редкие фильтры в окне. */
function MoreFilters({
  filters,
  set,
}: {
  filters: TaskFilters;
  set: (patch: Partial<TaskFilters>) => void;
}) {
  const access = useAdminAccess();
  const isAdmin = !!access && hasRight(access, "tasks.admin");
  const projects = useMyProjects();
  const { data: tags = [] } = useQuery(tagsQuery);
  const n = hiddenFilterCount(filters);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={n ? "default" : "outline"}>
          <SlidersHorizontal className="size-4" />
          {n ? `Фильтры (${n})` : "Фильтры"}
          <ChevronDown className="size-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-3">
        <FormField label="Постановщик" htmlFor={null}>
          <PersonFilter
            label="Любой"
            value={filters.creator}
            onChange={(id) => set({ creator: id })}
            className="w-full"
          />
        </FormField>
        {projects.length > 0 && (
          <FormField label="Проект">
            <Select
              value={filters.project ?? ALL}
              onValueChange={(v) => set({ project: v === ALL ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все проекты</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        {tags.length > 0 && (
          <FormField label="Тег">
            <Select
              value={filters.tag ?? ALL}
              onValueChange={(v) => set({ tag: v === ALL ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все теги</SelectItem>
                {tags.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    #{g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <FormField label="Срок в периоде" htmlFor={null}>
          <DateRangeFilter
            className="w-full"
            placeholder="Срок"
            value={filters.deadline === "range" ? range(filters.dfrom, filters.dto) : undefined}
            onChange={(r) =>
              set(
                r?.from || r?.to
                  ? {
                      deadline: "range",
                      dfrom: r.from ? isoOf(r.from) : undefined,
                      dto: r.to ? isoOf(r.to) : undefined,
                    }
                  : { deadline: undefined, dfrom: undefined, dto: undefined },
              )
            }
          />
        </FormField>
        <FormField label="Поставлена в периоде" htmlFor={null}>
          <DateRangeFilter
            className="w-full"
            placeholder="Поставлена"
            value={range(filters.cfrom, filters.cto)}
            onChange={(r) =>
              set({
                cfrom: r?.from ? isoOf(r.from) : undefined,
                cto: r?.to ? isoOf(r.to) : undefined,
              })
            }
          />
        </FormField>
        <div className="space-y-2 rounded-md border p-3">
          <CheckboxOption
            checked={filters.sort === "urgent"}
            onCheckedChange={(v) => set({ sort: v ? "urgent" : undefined })}
          >
            Срочные — первыми
          </CheckboxOption>
          <CheckboxOption
            checked={!!filters.mine}
            onCheckedChange={(v) => set({ mine: v || undefined })}
          >
            Пункты чек-листа на мне
          </CheckboxOption>
          {isAdmin && (
            <CheckboxOption
              checked={!!filters.all}
              onCheckedChange={(v) => set({ all: v || undefined })}
            >
              Все задачи портала
            </CheckboxOption>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Человек в фильтре: поле с именем и «×», выбор — справочник «Компании». */
function PersonFilter({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { name } = usePeople();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative w-48", className)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={value ? `${label}: ${name(value)}` : label}
            className={cn(fieldTriggerClass, "w-full", value && "pr-9")}
          >
            <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
              {value ? name(value) : label}
            </span>
            {!value && <ChevronDown className="size-4 shrink-0 opacity-50" />}
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type="button"
            aria-label={`Сбросить: ${label}`}
            title="Сбросить"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onChange(undefined)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
        <PeoplePicker
          single
          selected={value ? [value] : []}
          onToggle={(uid) => {
            setOpen(false);
            onChange(uid);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function SaveFilterDialog({
  open,
  filters,
  onClose,
}: {
  open: boolean;
  filters: TaskFilters;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {open && <SaveFilterForm filters={filters} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function SaveFilterForm({ filters, onClose }: { filters: TaskFilters; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(() =>
    filters.role === TODAY_PRESET.role && filters.deadline === TODAY_PRESET.deadline
      ? "Сегодня"
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!name.trim()) {
          setError("Назовите фильтр");
          return;
        }
        setBusy(true);
        try {
          await taskAction(qc, "task_filter_save", {
            p_id: null,
            p_name: name.trim(),
            p_params: filters,
          });
          toast.success("Фильтр сохранён — он в меню раздела, «Мои фильтры»");
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Сохранить фильтр</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <FormField label="Название" required error={error}>
          <Input
            autoFocus
            maxLength={60}
            value={name}
            placeholder="Например: Казань, просроченные"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
