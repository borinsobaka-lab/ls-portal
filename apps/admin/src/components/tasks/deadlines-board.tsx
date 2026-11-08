/**
 * «Сроки» (план, 3.4, бриф 1.31): мои незавершённые задачи колонками
 * «Просрочены / Сегодня / Завтра / Эта неделя / Следующая / Позже / Без
 * срока» — по поясу человека, задачи переезжают сами. Перетаскивание
 * карточки в колонку меняет срок (конец рабочего дня, рабочие дни
 * производственного календаря); исполнитель — с причиной (правило срока).
 * На телефоне — «Перенести» у карточки.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { TaskCard } from "@/components/tasks/task-card";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { DeadlineText, PersonLine, UrgentMark } from "@/components/tasks/task-bits";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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
} from "@/lib/tasks/logic";
import type { RoleTab, TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const ROLES: { value: RoleTab; label: string }[] = [
  { value: "do", label: "Делаю" },
  { value: "assigned", label: "Поручил" },
  { value: "all", label: "Все мои" },
];

type Move = { task: TaskRow; to: ColumnKey; deadline: Date | null };

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
  const { data, isPending } = useTaskList({ role }, 2);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const [drag, setDrag] = useState<TaskRow | null>(null);
  const [reasonFor, setReasonFor] = useState<Move | null>(null);
  const now = new Date();
  const rows = data?.rows ?? [];
  const byColumn = new Map<ColumnKey, TaskRow[]>(COLUMNS.map((c) => [c.key, []]));
  for (const t of rows) byColumn.get(deadlineColumn(t.deadline, now, tz))!.push(t);

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
    const deadline = columnDeadline(to, new Date(), tz, workdayEnd, calendar);
    if (deadline === undefined) {
      toast.info(
        to === "overdue" ? "В просроченные не переносят" : "Точную дату — в карточке задачи",
      );
      return;
    }
    if (deadline?.toISOString() === t.deadline) return;
    if (perms.deadline === "reason") {
      setReasonFor({ task: t, to, deadline });
      return;
    }
    void updateTask(qc, t, { deadline: deadline?.toISOString() ?? null }).catch((e) =>
      toast.error(taskErrorText(e)),
    );
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
        <SegmentedControl aria-label="Чьи задачи" value={role} onChange={onRole} options={ROLES} />
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {COLUMNS.map((col) => {
            const list = byColumn.get(col.key) ?? [];
            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  if (!drag) return;
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
                  "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40 transition-colors",
                  over === col.key && "border-chat-accent bg-chat-accent-soft",
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
                        />
                      ))}
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
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} />
      <ReasonDialog move={reasonFor} tz={tz} onClose={() => setReasonFor(null)} />
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
}: {
  task: TaskRow;
  tz: string;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: ColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
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
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <span className="flex items-start gap-1.5">
          {task.unseen && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-chat-accent" />}
          <span className="min-w-0 font-medium break-words">{task.title}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>#{task.number}</span>
          <DeadlineText task={task} tz={tz} />
          {task.check_total > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <ListChecks className="size-3.5" />
              {task.check_done}/{task.check_total}
            </span>
          )}
        </span>
      </button>
      <div className="mt-2 flex items-center gap-2">
        <PersonLine id={assigneeOf(task)} size="xs" className="min-w-0 flex-1 text-xs" />
        {task.urgent && <UrgentMark />}
        {perms.deadline && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Перенести срок"
                title="Перенести срок"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <CalendarClock className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              {COLUMNS.filter((c) => c.key !== "overdue" && c.key !== "later").map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="block w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setOpen(false);
                    onMove(c.key);
                  }}
                >
                  {c.title}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
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
        {move && <ReasonForm key={move.task.id + move.to} move={move} tz={tz} onClose={onClose} />}
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
