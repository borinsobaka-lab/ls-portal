/**
 * «Сроки» (план, 3.4, бриф 1.31): мои незавершённые задачи колонками
 * «Просрочены / Сегодня / Завтра / Эта неделя / Следующая / Позже / Без
 * срока» — по поясу человека, задачи переезжают сами. Перетаскивание
 * карточки в колонку меняет срок (конец рабочего дня, рабочие дни
 * производственного календаря); исполнитель — с причиной (правило срока).
 * На телефоне — «Перенести срок» у карточки. «Позже» — выбор даты; в
 * «Просрочены» не переносят (колонка не принимает карточку). Роли — общий
 * набор `ROLE_TABS`, вид — переключатель «Список · Сроки · Мой план»
 * (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.6).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ListChecks, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { DeadlinePicker } from "@/components/tasks/deadline-picker";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { TaskMenu } from "@/components/tasks/task-menu";
import { TaskSheet } from "@/components/tasks/task-table";
import { TasksViewTabs } from "@/components/tasks/tasks-views";
import { DeadlineText, PersonLine, TaskStatusChip, UrgentMark } from "@/components/tasks/task-bits";
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
import { FormField } from "@/components/ui/form-field";
import { TableToolbar } from "@/components/table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CountBadge } from "@/components/ui/status-chip";
import {
  taskErrorText,
  updateTask,
  useTaskClock,
  useTaskList,
  useWorkCalendar,
} from "@/lib/tasks/data";
import {
  assigneeOf,
  columnDeadline,
  COLUMNS,
  deadlineColumn,
  formatMoment,
  taskPerms,
  type ColumnKey,
  type WorkCalendar,
} from "@/lib/tasks/logic";
import type { RoleTab, TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

type Move = { task: TaskRow; deadline: Date | null };

export function DeadlinesBoard({
  role,
  task,
  onRole,
  onTask,
}: {
  role: RoleTab;
  task: number | undefined;
  onRole: (r: RoleTab) => void;
  onTask: (n: number | undefined) => void;
}) {
  const qc = useQueryClient();
  const { tz, workdayEnd } = useTaskClock();
  const calendar = useWorkCalendar(tz);
  const [pages, setPages] = useState(1);
  const { data, isPending, isFetching } = useTaskList({ role }, pages);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const [drag, setDrag] = useState<TaskRow | null>(null);
  const [reasonFor, setReasonFor] = useState<Move | null>(null);
  const [pickFor, setPickFor] = useState<TaskRow | null>(null);
  const now = new Date();
  const rows = data?.rows ?? [];
  const byColumn = new Map<ColumnKey, TaskRow[]>(COLUMNS.map((c) => [c.key, []]));
  for (const t of rows) byColumn.get(deadlineColumn(t.deadline, now, tz))!.push(t);

  const setDeadline = (t: TaskRow, deadline: Date | null) => {
    if ((deadline?.toISOString() ?? null) === t.deadline) return;
    if (taskPerms(t).deadline === "reason") {
      setReasonFor({ task: t, deadline });
      return;
    }
    void updateTask(qc, t, { deadline: deadline?.toISOString() ?? null })
      .then(() =>
        toast.success(`#${t.number}: срок — ${formatMoment(deadline?.toISOString(), tz)}`),
      )
      .catch((e) => toast.error(taskErrorText(e)));
  };

  const move = (t: TaskRow, to: ColumnKey) => {
    const perms = taskPerms(t);
    if (!perms.deadline) {
      toast.info("Срок этой задачи меняет постановщик");
      return;
    }
    if (to === "none" && !perms.boss) {
      toast.info("Убрать срок может только постановщик");
      return;
    }
    if (to === "overdue") return;
    const deadline =
      to === "later" ? undefined : columnDeadline(to, new Date(), tz, workdayEnd, calendar);
    if (deadline === undefined) {
      setPickFor(t);
      return;
    }
    setDeadline(t, deadline);
  };

  return (
    <AdminShell
      title="Сроки"
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Новая задача
        </Button>
      }
    >
      <div className="space-y-3">
        <TableToolbar tabs={<TasksViewTabs view="deadlines" role={role} onRole={onRole} />}>
          <p className="toolbar-full mr-auto px-1 text-sm text-muted-foreground">
            Перетащите карточку в колонку — срок изменится. На телефоне — «⋯» у карточки.
          </p>
          {data?.hasMore && (
            <Button variant="outline" disabled={isFetching} onClick={() => setPages((p) => p + 1)}>
              {isFetching && <Loader2 className="animate-spin" />}
              Показать ещё задачи
            </Button>
          )}
        </TableToolbar>
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {COLUMNS.map((col) => {
            const list = byColumn.get(col.key) ?? [];
            const noDrop = col.key === "overdue";
            return (
              <div
                key={col.key}
                title={noDrop ? "В просроченные не переносят" : undefined}
                onDragOver={(e) => {
                  if (!drag || noDrop) return;
                  e.preventDefault();
                  setOver(col.key);
                }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  if (drag) move(drag, col.key);
                  setDrag(null);
                }}
                className={cn(
                  "flex w-64 shrink-0 flex-col rounded-lg border bg-background transition-colors",
                  over === col.key && "border-chat-accent bg-chat-accent-soft",
                  drag && noDrop && "bg-muted/60 opacity-70",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    className={cn(
                      "text-sm font-semibold",
                      col.key === "overdue" && list.length > 0 && "text-destructive",
                    )}
                  >
                    {col.title}
                  </span>
                  {list.length > 0 && (
                    <CountBadge
                      count={list.length}
                      tone={col.key === "overdue" ? "urgent" : "quiet"}
                    />
                  )}
                </div>
                <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                  {isPending
                    ? Array.from({ length: 2 }, (_, i) => (
                        <Skeleton key={i} className="h-20 w-full" />
                      ))
                    : list.map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          tz={tz}
                          onOpen={() => onTask(t.number)}
                          onDragStart={() => setDrag(t)}
                          onDragEnd={() => {
                            setDrag(null);
                            setOver(null);
                          }}
                          onMove={(to) => move(t, to)}
                          onPick={() => setPickFor(t)}
                        />
                      ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <TaskSheet
        number={task}
        onClose={() => onTask(undefined)}
        onOpen={onTask}
        list={COLUMNS.flatMap((c) => (byColumn.get(c.key) ?? []).map((t) => t.number))}
      />
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} onOpenTask={onTask} />
      <ReasonDialog move={reasonFor} tz={tz} onClose={() => setReasonFor(null)} />
      <PickDialog
        task={pickFor}
        tz={tz}
        workdayEnd={workdayEnd}
        calendar={calendar}
        onPick={(t, iso) => {
          setPickFor(null);
          setDeadline(t, iso ? new Date(iso) : null);
        }}
        onClose={() => setPickFor(null)}
      />
    </AdminShell>
  );
}

function Card({
  task,
  tz,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
  onPick,
}: {
  task: TaskRow;
  tz: string;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: ColumnKey) => void;
  onPick: () => void;
}) {
  const perms = taskPerms(task);
  return (
    <div
      draggable={!!perms.deadline}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(task.number));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group rounded-md border bg-background p-2.5 text-sm shadow-xs",
        perms.deadline && "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex items-start gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className={cn("block break-words", task.unseen ? "font-semibold" : "font-medium")}>
            {task.title}
            {task.unseen && <span className="sr-only"> (есть новое)</span>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>#{task.number}</span>
            <DeadlineText task={task} tz={tz} />
            {task.check_total > 0 && (
              <span
                className="inline-flex items-center gap-0.5"
                title={`${task.check_done} из ${task.check_total} пунктов чек-листа`}
              >
                <ListChecks className="size-3.5" aria-hidden />
                {task.check_done}/{task.check_total}
              </span>
            )}
          </span>
        </button>
        {perms.deadline && (
          <TaskMenu
            label="Перенести срок"
            reveal
            className="-mt-1 -mr-1"
            items={[
              { heading: "Перенести срок" },
              ...COLUMNS.filter((c) => c.key !== "overdue" && c.key !== "later")
                .filter((c) => c.key !== "none" || perms.boss)
                .map((c) => ({ label: c.title, run: () => onMove(c.key) })),
              { label: "Выбрать дату…", icon: CalendarClock, run: onPick },
            ]}
          />
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <PersonLine id={assigneeOf(task)} size="xs" className="min-w-0 flex-1 text-xs" />
        {task.urgent && <UrgentMark />}
        <TaskStatusChip status={task.status} />
      </div>
    </div>
  );
}

/** Новый срок датой — перенос в «Позже» или «Выбрать дату…». */
function PickDialog({
  task,
  tz,
  workdayEnd,
  calendar,
  onPick,
  onClose,
}: {
  task: TaskRow | null;
  tz: string;
  workdayEnd: string;
  calendar: WorkCalendar;
  onPick: (t: TaskRow, iso: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {task && (
          <>
            <DialogHeader className="border-b px-4 py-4 sm:px-6">
              <DialogTitle>Новый срок</DialogTitle>
              <DialogDescription>
                #{task.number} {task.title}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <FormField label="Срок" htmlFor="deadlines-pick">
                <DeadlinePicker
                  id="deadlines-pick"
                  value={task.deadline}
                  onChange={(iso) => onPick(task, iso)}
                  tz={tz}
                  workdayEnd={workdayEnd}
                  calendar={calendar}
                  allowClear={taskPerms(task).boss}
                />
              </FormField>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Отмена
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({
  move,
  tz,
  onClose,
}: {
  move: Move | null;
  tz: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!move} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {move && (
          <ReasonForm
            key={move.task.id + String(move.deadline?.getTime())}
            move={move}
            tz={tz}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({ move, tz, onClose }: { move: Move; tz: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!text.trim()) {
          setError("Напишите причину");
          return;
        }
        try {
          await updateTask(
            qc,
            move.task,
            { deadline: move.deadline?.toISOString() ?? null },
            text.trim(),
          );
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Перенести срок</DialogTitle>
        <DialogDescription>
          #{move.task.number} {move.task.title}: новый срок —{" "}
          {formatMoment(move.deadline?.toISOString(), tz)}. Постановщик увидит причину.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormField label="Причина переноса" required error={error}>
          <Textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit">Перенести</Button>
      </DialogFooter>
    </DialogForm>
  );
}
