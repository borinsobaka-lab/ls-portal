/**
 * «Задачи» — список (план, 3.4, боль № 18): вкладки ролей («Делаю»,
 * «Помогаю», «Поручил», «Наблюдаю», «Все»), по умолчанию — по сроку,
 * завершённые скрыты; фильтры (статус, срок, постановщик, исполнитель,
 * «Пункты на мне», поиск по номеру, названию и описанию) — в адресе,
 * сохраняются своими фильтрами в меню. Задачи одной постановки «отдельно
 * каждому» — одной строкой-сводкой. Строка — карточка панелью справа
 * (`?task=`), список не теряется.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, ListChecks, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { PeoplePicker } from "@/components/chats/dialogs";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { TaskSheet, TaskTable } from "@/components/tasks/task-table";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { DeadlineText, PersonLine, TaskStatusChip, UrgentMark } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { usePeople } from "@/lib/chats/people";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  taskAction,
  taskErrorText,
  useMyProjects,
  useTaskClock,
  useTaskList,
} from "@/lib/tasks/data";
import {
  assigneeOf,
  batchText,
  cleanFilters,
  creatorOf,
  DEADLINE_FILTERS,
  hasExtraFilters,
  ROLE_TABS,
  STATUS_LABEL,
  STATUS_ORDER,
} from "@/lib/tasks/logic";
import type { RoleTab, TaskFilters, TaskRow, TaskStatus } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const ALL = "all";

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
  const access = useAdminAccess();
  const isAdmin = !!access && hasRight(access, "tasks.admin");
  const { tz } = useTaskClock();
  const [pages, setPages] = useState(1);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(filters.q ?? "");
  const debounced = useDebouncedValue(q.trim(), 300);
  const effective = useMemo(
    () => cleanFilters({ ...filters, q: debounced || undefined }),
    [filters, debounced],
  );
  const { data, isPending, isFetching } = useTaskList(effective, pages);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const set = (patch: Partial<TaskFilters>) => {
    setPages(1);
    onFilters(cleanFilters({ ...filters, q: debounced || undefined, ...patch }));
  };
  const role = filters.role ?? "all";
  const projects = useMyProjects();
  const title = filters.team
    ? "Подчинённые"
    : filters.mine
      ? "Пункты на мне"
      : (ROLE_TABS.find((t) => t.key === role)?.title ?? "Задачи");

  return (
    <AdminShell
      title={title === "Все" ? "Задачи" : `Задачи: ${title.toLowerCase()}`}
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Новая задача
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-label="Моя роль в задаче"
            value={role}
            onChange={(v: RoleTab) => set({ role: v === "all" ? undefined : v, mine: undefined })}
            options={ROLE_TABS.map((t) => ({ value: t.key, label: t.title }))}
          />
        </div>
        <TableToolbar>
          <ToolbarSearch value={q} onChange={setQ} placeholder="Номер, название, описание" />
          <Select
            value={filters.status?.[0] ?? ALL}
            onValueChange={(v) => set({ status: v === ALL ? undefined : [v as TaskStatus] })}
          >
            <SelectTrigger className="w-44" aria-label="Статус">
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
              set({ deadline: v === ALL ? undefined : (v as TaskFilters["deadline"]) })
            }
          >
            <SelectTrigger className="w-40" aria-label="Срок">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Любой срок</SelectItem>
              {DEADLINE_FILTERS.map((d) => (
                <SelectItem key={d.key} value={d.key}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filters.deadline === "range" && (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                className="w-40"
                aria-label="Срок с"
                value={filters.dfrom ?? ""}
                onChange={(e) => set({ dfrom: e.target.value || undefined })}
              />
              <span className="text-muted-foreground">—</span>
              <Input
                type="date"
                className="w-40"
                aria-label="Срок по"
                value={filters.dto ?? ""}
                onChange={(e) => set({ dto: e.target.value || undefined })}
              />
            </div>
          )}
          {projects.length > 0 && (
            <Select
              value={filters.project ?? ALL}
              onValueChange={(v) => set({ project: v === ALL ? undefined : v })}
            >
              <SelectTrigger className="w-44" aria-label="Проект">
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
          )}
          <PersonFilter
            label="Постановщик"
            value={filters.creator}
            onChange={(id) => set({ creator: id })}
          />
          <PersonFilter
            label="Исполнитель"
            value={filters.assignee}
            onChange={(id) => set({ assignee: id })}
          />
          <div className="flex h-10 items-center gap-2 px-1">
            <Switch
              id="tasks-done"
              checked={!!filters.done}
              onCheckedChange={(v) => set({ done: v || undefined })}
            />
            <Label htmlFor="tasks-done" className="cursor-pointer whitespace-nowrap">
              Завершённые
            </Label>
          </div>
          {isAdmin && (
            <div className="flex h-10 items-center gap-2 px-1">
              <Switch
                id="tasks-all"
                checked={!!filters.all}
                onCheckedChange={(v) => set({ all: v || undefined })}
              />
              <Label htmlFor="tasks-all" className="cursor-pointer whitespace-nowrap">
                Все задачи портала
              </Label>
            </div>
          )}
          {hasExtraFilters(effective) && (
            <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
              <Save className="size-4" /> Сохранить фильтр
            </Button>
          )}
          <ToolbarReset
            active={hasExtraFilters(effective)}
            onReset={() => {
              setQ("");
              setPages(1);
              onFilters(cleanFilters({ role: filters.role }));
            }}
          />
        </TableToolbar>

        <TaskTable
          rows={rows}
          isPending={isPending}
          tz={tz}
          active={task}
          onOpen={onTask}
          groupBatches={role === "assigned" || role === "all"}
          showProject={!filters.project}
          empty={
            hasExtraFilters(effective)
              ? "Под фильтр ничего не подошло."
              : "Задач нет. Новая — кнопкой «Новая задача»."
          }
          footer={
            data?.hasMore && (
              <div className="border-t p-3 text-center">
                <Button
                  variant="outline"
                  disabled={isFetching}
                  onClick={() => setPages((p) => p + 1)}
                >
                  Показать ещё
                </Button>
              </div>
            )
          }
        />
      </div>

      <TaskSheet number={task} onClose={() => onTask(undefined)} />
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} />
      <SaveFilterDialog open={saving} filters={effective} onClose={() => setSaving(false)} />
    </AdminShell>
  );
}

function PersonFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const { name } = usePeople();
  if (value)
    return (
      <span className="inline-flex h-10 items-center gap-1 rounded-md border bg-background pr-1 pl-3 text-sm">
        <span className="text-muted-foreground">{label}:</span>
        <span className="max-w-40 truncate">{name(value)}</span>
        <button
          type="button"
          aria-label={`Сбросить: ${label}`}
          className="rounded p-1 hover:bg-muted"
          onClick={() => onChange(undefined)}
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-10">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
        <PeoplePicker
          single
          selected={[]}
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
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!name.trim()) {
          setError("Назовите фильтр");
          return;
        }
        try {
          await taskAction(qc, "task_filter_save", {
            p_id: null,
            p_name: name.trim(),
            p_params: filters,
          });
          toast.success("Фильтр сохранён — он в меню раздела");
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
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
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit">Сохранить</Button>
      </DialogFooter>
    </DialogForm>
  );
}
