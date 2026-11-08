/**
 * «Мой план» (TASKS_CHATS_PLAN.md, этап 2, бриф 1.32): личная канбан-доска
 * задач со своими колонками. На доске — открытые задачи, где я исполнитель
 * или соисполнитель, и задачи, которые я добавил сам («Добавить задачу» —
 * например, из «Поручил»). «Не разобрано» — новые и без места. Карточки
 * перетаскиваются между колонками и внутри колонки; на телефоне —
 * «Переместить» в меню карточки. Доска не меняет задачу: ни статус, ни срок.
 * Схема — db/migrations/2026-11-08_zzzzzzz_task_plan.sql.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { TaskCard } from "@/components/tasks/task-card";
import { NewTaskDialog } from "@/components/tasks/task-form";
import {
  DeadlineText,
  PersonLine,
  ProjectTag,
  TaskStatusChip,
  UrgentMark,
} from "@/components/tasks/task-bits";
import { TaskTagChip } from "@/components/tasks/task-tags";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { CountBadge } from "@/components/ui/status-chip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  placePlanCards,
  planAction,
  taskErrorText,
  useTaskClock,
  useTaskList,
  useTaskPlan,
} from "@/lib/tasks/data";
import { assigneeOf, planColumnCards, planMoveOrder } from "@/lib/tasks/logic";
import type { PlanCard, PlanColumn } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const UNSORTED = "unsorted";
const keyOf = (id: string | null) => id ?? UNSORTED;
const idOf = (key: string) => (key === UNSORTED ? null : key);

type Drop = { column: string; before: string | null };

export function PlanBoard({
  task,
  onTask,
}: {
  task: number | undefined;
  onTask: (n: number | undefined) => void;
}) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { data, isPending } = useTaskPlan();
  const { confirm, confirmDialog } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<PlanColumn | "new" | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const columns = useMemo(() => data?.columns ?? [], [data]);
  const cards = useMemo(() => data?.cards ?? [], [data]);
  const lanes: { key: string; title: string; column: PlanColumn | null }[] = [
    { key: UNSORTED, title: "Не разобрано", column: null },
    ...columns.map((c) => ({ key: c.id, title: c.title, column: c })),
  ];

  const run = (p: Promise<unknown>) => void p.catch((e) => toast.error(taskErrorText(e)));

  const moveTo = (taskId: string, columnKey: string, before: string | null) => {
    const column = idOf(columnKey);
    run(placePlanCards(qc, column, planMoveOrder(cards, taskId, column, before)));
  };

  const shiftColumn = (c: PlanColumn, dir: -1 | 1) => {
    const ids = columns.map((x) => x.id);
    const i = ids.indexOf(c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(planAction(qc, "task_plan_columns_reorder", { p_ids: ids }));
  };

  const removeColumn = async (c: PlanColumn) => {
    const n = planColumnCards(cards, c.id).length;
    if (
      !(await confirm({
        title: `Удалить колонку «${c.title}»?`,
        description: n ? `Её задачи (${n}) перейдут в «Не разобрано».` : undefined,
        confirmLabel: "Удалить",
      }))
    )
      return;
    run(planAction(qc, "task_plan_column_delete", { p_id: c.id }));
  };

  return (
    <AdminShell
      title="Мой план"
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Новая задача
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm text-muted-foreground max-sm:w-full">
            Разложите свои задачи по колонкам, как удобно. Статус и срок задачи доска не меняет.
          </p>
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Search className="size-4" /> Добавить задачу
          </Button>
          <Button
            variant="outline"
            disabled={columns.length >= 10}
            onClick={() => setNaming("new")}
          >
            <Plus className="size-4" /> Колонка
          </Button>
        </div>
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {lanes.map((lane, li) => {
            const list = planColumnCards(cards, lane.column?.id ?? null);
            const over = drop?.column === lane.key;
            return (
              <div
                key={lane.key}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  if (!over || drop?.before !== null) setDrop({ column: lane.key, before: null });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drop) moveTo(drag, drop.column, drop.before);
                  setDrag(null);
                  setDrop(null);
                }}
                className={cn(
                  "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/40 transition-colors",
                  over && "border-chat-accent bg-chat-accent-soft",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 truncate text-sm font-semibold">{lane.title}</span>
                  {list.length > 0 && <CountBadge count={list.length} tone="quiet" />}
                  {lane.column && (
                    <Menu
                      label={`Колонка «${lane.title}»`}
                      className="ml-auto"
                      items={[
                        { label: "Переименовать", icon: Pencil, run: () => setNaming(lane.column) },
                        {
                          label: "Левее",
                          icon: ArrowLeft,
                          disabled: li <= 1,
                          run: () => shiftColumn(lane.column!, -1),
                        },
                        {
                          label: "Правее",
                          icon: ArrowRight,
                          disabled: li >= lanes.length - 1,
                          run: () => shiftColumn(lane.column!, 1),
                        },
                        {
                          label: "Удалить колонку",
                          icon: Trash2,
                          danger: true,
                          run: () => void removeColumn(lane.column!),
                        },
                      ]}
                    />
                  )}
                </div>
                <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                  {isPending ? (
                    Array.from({ length: 2 }, (_, i) => (
                      <Skeleton key={i} className="h-20 w-full" />
                    ))
                  ) : list.length === 0 ? (
                    <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                      {lane.column
                        ? "Перетащите сюда задачи"
                        : "Новые задачи, где вы исполнитель или соисполнитель"}
                    </p>
                  ) : (
                    list.map((c) => (
                      <PlanCardView
                        key={c.task.id}
                        card={c}
                        tz={tz}
                        lanes={lanes}
                        dropBefore={over && drop?.before === c.task.id}
                        dragging={drag === c.task.id}
                        onOpen={() => onTask(c.task.number)}
                        onDragStart={() => setDrag(c.task.id)}
                        onDragEnd={() => {
                          setDrag(null);
                          setDrop(null);
                        }}
                        onDragOverCard={() => {
                          if (drag && (drop?.column !== lane.key || drop.before !== c.task.id))
                            setDrop({ column: lane.key, before: c.task.id });
                        }}
                        onMove={(to) => moveTo(c.task.id, to, null)}
                        onRemove={() =>
                          run(planAction(qc, "task_plan_remove", { p_task: c.task.id }))
                        }
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Sheet open={!!task} onOpenChange={(o) => !o && onTask(undefined)}>
        <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-5xl sm:p-6">
          <SheetTitle className="sr-only">Задача #{task}</SheetTitle>
          <SheetDescription className="sr-only">Карточка задачи</SheetDescription>
          {task && <TaskCard number={task} onClose={() => onTask(undefined)} />}
        </SheetContent>
      </Sheet>
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => undefined}
      />
      <ColumnDialog value={naming} onClose={() => setNaming(null)} />
      <AddTaskDialog
        open={adding}
        inPlan={new Set(cards.map((c) => c.task.id))}
        onClose={() => setAdding(false)}
      />
      {confirmDialog}
    </AdminShell>
  );
}

function PlanCardView({
  card,
  tz,
  lanes,
  dropBefore,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onMove,
  onRemove,
}: {
  card: PlanCard;
  tz: string;
  lanes: { key: string; title: string }[];
  dropBefore: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
  onMove: (to: string) => void;
  onRemove: () => void;
}) {
  const t = card.task;
  const here = keyOf(card.column_id);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(t.number));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOverCard();
      }}
      className={cn(
        "group relative cursor-grab rounded-md border bg-background p-2.5 text-sm shadow-xs active:cursor-grabbing",
        dragging && "opacity-50",
        dropBefore &&
          "before:absolute before:inset-x-0 before:-top-1.5 before:h-0.5 before:rounded before:bg-chat-accent",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="flex items-start gap-1.5">
            {t.unseen && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-chat-accent" />}
            <span className="min-w-0 font-medium break-words">{t.title}</span>
          </span>
        </button>
        <Menu
          label="Действия с карточкой"
          className="-mt-0.5 -mr-1"
          heading="Переместить"
          items={[
            ...lanes
              .filter((l) => l.key !== here)
              .map((l) => ({ label: l.title, run: () => onMove(l.key) })),
            ...(card.added ? [{ label: "Убрать из плана", icon: X, run: onRemove }] : []),
          ]}
        />
      </div>
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>#{t.number}</span>
          <DeadlineText task={t} tz={tz} />
          {t.check_total > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <ListChecks className="size-3.5" />
              {t.check_done}/{t.check_total}
            </span>
          )}
          {t.project && <ProjectTag project={t.project} className="max-w-32" />}
          {t.tags.map((g) => (
            <TaskTagChip key={g.id} tag={g} className="py-0" />
          ))}
        </span>
      </button>
      <div className="mt-2 flex items-center gap-2">
        <PersonLine id={assigneeOf(t)} size="xs" className="min-w-0 flex-1 text-xs" />
        {t.urgent && <UrgentMark />}
        {t.status !== "new" && <TaskStatusChip status={t.status} />}
      </div>
    </div>
  );
}

type MenuItem = {
  label: string;
  icon?: typeof Pencil;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
};

/** Меню «⋯» колонки и карточки. */
function Menu({
  label,
  heading,
  items,
  className,
}: {
  label: string;
  heading?: string;
  items: MenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
            className,
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1">
        {heading && (
          <p className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{heading}</p>
        )}
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              setOpen(false);
              it.run();
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-40",
              it.danger && "text-destructive",
            )}
          >
            {it.icon && <it.icon className="size-4" />}
            {it.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ColumnDialog({
  value,
  onClose,
}: {
  value: PlanColumn | "new" | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-sm">
        {value && (
          <ColumnForm key={value === "new" ? "new" : value.id} value={value} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ColumnForm({ value, onClose }: { value: PlanColumn | "new"; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(value === "new" ? "" : value.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!title.trim()) {
          setError("Назовите колонку");
          return;
        }
        setBusy(true);
        try {
          await planAction(qc, "task_plan_column_save", {
            p_id: value === "new" ? null : value.id,
            p_title: title.trim(),
          });
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{value === "new" ? "Новая колонка" : "Переименовать колонку"}</DialogTitle>
        <DialogDescription>Например: «Сегодня», «Жду ответа», «Казань».</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormField label="Название" required error={error}>
          <Input
            autoFocus
            maxLength={40}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />} Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

/** Добавить в план видимую задачу (например, из «Поручил»). */
function AddTaskDialog({
  open,
  inPlan,
  onClose,
}: {
  open: boolean;
  inPlan: Set<string>;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
        {open && <AddTaskList inPlan={inPlan} />}
      </DialogContent>
    </Dialog>
  );
}

function AddTaskList({ inPlan }: { inPlan: Set<string> }) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 300);
  const { data, isPending } = useTaskList({ role: "all", q: query || undefined });
  const rows = (data?.rows ?? []).filter((t) => !inPlan.has(t.id));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить задачу в план</DialogTitle>
        <DialogDescription>
          Свои задачи как исполнителя уже на доске; здесь — остальные: поручил, наблюдаю, проекты.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <SearchInput
          autoFocus
          value={q}
          onChange={setQ}
          placeholder="Номер или название"
          aria-label="Поиск задачи"
        />
        {isPending ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ничего не нашлось</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.slice(0, 50).map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="shrink-0 text-muted-foreground">#{t.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.title}</span>
                  <DeadlineText task={t} tz={tz} className="text-xs" />
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void planAction(qc, "task_plan_add", { p_task: t.id })
                      .then(() => toast.success(`#${t.number} — в «Не разобрано»`))
                      .catch((e) => toast.error(taskErrorText(e)))
                  }
                >
                  <Plus className="size-3.5" /> В план
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
    </>
  );
}
