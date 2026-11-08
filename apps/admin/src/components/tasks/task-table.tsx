/**
 * Таблица задач (список «Задач», задачи проекта, «Подчинённые») и карточка
 * задачи панелью справа. Задачи одной постановки «отдельно каждому» —
 * строкой-сводкой (раскрывается).
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  FileText,
  ListChecks,
  ListTodo,
} from "lucide-react";

import { TableSkeletonRows } from "@/components/skeletons";
import { TaskCard } from "@/components/tasks/task-card";
import { TaskTagChip } from "@/components/tasks/task-tags";
import {
  DeadlineText,
  PersonLine,
  ProjectTag,
  TaskStatusChip,
  UrgentMark,
} from "@/components/tasks/task-bits";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { assigneeOf, batchText, creatorOf } from "@/lib/tasks/logic";
import type { TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

export function TaskTable({
  rows,
  isPending,
  tz,
  active,
  onOpen,
  groupBatches = false,
  showProject = true,
  empty,
  footer,
}: {
  rows: TaskRow[];
  isPending: boolean;
  tz: string;
  active: number | undefined;
  onOpen: (n: number) => void;
  groupBatches?: boolean;
  showProject?: boolean;
  empty: string;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">№</TableHead>
            <TableHead>Задача</TableHead>
            <TableHead className="w-44">Срок</TableHead>
            <TableHead className="w-48">Исполнитель</TableHead>
            <TableHead className="w-48">Постановщик</TableHead>
            <TableHead className="w-32">Статус</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isPending ? (
            <TableSkeletonRows rows={8} columns={6} />
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            <Rows
              rows={rows}
              tz={tz}
              active={active}
              onOpen={onOpen}
              groupBatches={groupBatches}
              showProject={showProject}
            />
          )}
        </TableBody>
      </Table>
      {footer}
    </div>
  );
}

/** Карточка задачи панелью справа поверх страницы (`?task=`). */
export function TaskSheet({
  number,
  onClose,
}: {
  number: number | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!number} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-5xl sm:p-6">
        <SheetTitle className="sr-only">Задача #{number}</SheetTitle>
        <SheetDescription className="sr-only">Карточка задачи</SheetDescription>
        {number && <TaskCard number={number} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

type Item = { kind: "task"; task: TaskRow } | { kind: "batch"; id: string; tasks: TaskRow[] };

function Rows({
  rows,
  tz,
  active,
  onOpen,
  groupBatches,
  showProject,
}: {
  rows: TaskRow[];
  tz: string;
  active: number | undefined;
  onOpen: (n: number) => void;
  groupBatches: boolean;
  showProject: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const items = useMemo(() => {
    if (!groupBatches) return rows.map((task): Item => ({ kind: "task", task }));
    const count = new Map<string, number>();
    for (const r of rows)
      if (r.batch_id && r.my_roles.includes("creator"))
        count.set(r.batch_id, (count.get(r.batch_id) ?? 0) + 1);
    const out: Item[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.batch_id && (count.get(r.batch_id) ?? 0) > 1) {
        if (seen.has(r.batch_id)) continue;
        seen.add(r.batch_id);
        out.push({
          kind: "batch",
          id: r.batch_id,
          tasks: rows.filter((x) => x.batch_id === r.batch_id),
        });
      } else out.push({ kind: "task", task: r });
    }
    return out;
  }, [rows, groupBatches]);

  return (
    <>
      {items.map((it) =>
        it.kind === "task" ? (
          <TaskLine
            key={it.task.id}
            task={it.task}
            tz={tz}
            active={active === it.task.number}
            onOpen={onOpen}
            showProject={showProject}
          />
        ) : (
          <BatchLines
            key={it.id}
            tasks={it.tasks}
            tz={tz}
            open={open.has(it.id)}
            onToggle={() =>
              setOpen((s) => {
                const n = new Set(s);
                if (n.has(it.id)) n.delete(it.id);
                else n.add(it.id);
                return n;
              })
            }
            active={active}
            onOpen={onOpen}
          />
        ),
      )}
    </>
  );
}

function TaskLine({
  task,
  tz,
  active,
  onOpen,
  nested,
  showProject = true,
}: {
  task: TaskRow;
  tz: string;
  active: boolean;
  onOpen: (n: number) => void;
  nested?: boolean;
  showProject?: boolean;
}) {
  return (
    <TableRow
      className={cn("cursor-pointer", active && "bg-selected/8", nested && "bg-muted/30")}
      onClick={() => onOpen(task.number)}
    >
      <TableCell className="text-muted-foreground tabular-nums">#{task.number}</TableCell>
      <TableCell>
        <div className={cn("flex items-center gap-2", nested && "pl-4")}>
          {task.unseen && (
            <span
              aria-label="Есть новое"
              title="Есть новое"
              className="size-2 shrink-0 rounded-full bg-chat-accent"
            />
          )}
          <span
            className={cn(
              "min-w-0 font-medium break-words",
              (task.status === "done" || task.status === "cancelled") &&
                "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          {task.urgent && <UrgentMark className="shrink-0" />}
        </div>
        {(task.check_total > 0 ||
          task.files_count > 0 ||
          task.subtasks_total > 0 ||
          task.parent_number != null ||
          task.tags.length > 0 ||
          (showProject && task.project)) && (
          <div
            className={cn(
              "mt-0.5 flex flex-wrap gap-3 text-xs text-muted-foreground",
              nested && "pl-4",
            )}
          >
            {showProject && task.project && <ProjectTag project={task.project} />}
            {task.tags.map((g) => (
              <TaskTagChip key={g.id} tag={g} className="py-0" />
            ))}
            {task.parent_number != null && (
              <span className="inline-flex items-center gap-1" title="Подзадача">
                <CornerLeftUp className="size-3.5" />#{task.parent_number}
              </span>
            )}
            {task.subtasks_total > 0 && (
              <span className="inline-flex items-center gap-1" title="Подзадачи: готово из всех">
                <ListTodo className="size-3.5" />
                {task.subtasks_done}/{task.subtasks_total}
              </span>
            )}
            {task.check_total > 0 && (
              <span className="inline-flex items-center gap-1">
                <ListChecks className="size-3.5" />
                {task.check_done}/{task.check_total}
              </span>
            )}
            {task.files_count > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileText className="size-3.5" />
                {task.files_count}
              </span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <DeadlineText task={task} tz={tz} />
      </TableCell>
      <TableCell>
        <PersonLine id={assigneeOf(task)} />
      </TableCell>
      <TableCell>
        <PersonLine id={creatorOf(task)} />
      </TableCell>
      <TableCell>
        <TaskStatusChip status={task.status} />
      </TableCell>
    </TableRow>
  );
}

function BatchLines({
  tasks,
  tz,
  open,
  onToggle,
  active,
  onOpen,
}: {
  tasks: TaskRow[];
  tz: string;
  open: boolean;
  onToggle: () => void;
  active: number | undefined;
  onOpen: (n: number) => void;
}) {
  const first = tasks[0];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="text-muted-foreground">
          <Chevron className="size-4" />
        </TableCell>
        <TableCell>
          <div className="font-medium">{first.title}</div>
          <div className="text-xs text-muted-foreground">
            {first.batch ? batchText(first.batch) : `${tasks.length} задач`} · отдельно каждому
          </div>
        </TableCell>
        <TableCell>
          <DeadlineText task={first} tz={tz} />
        </TableCell>
        <TableCell className="text-muted-foreground">{tasks.length} исполнителей</TableCell>
        <TableCell>
          <PersonLine id={creatorOf(first)} />
        </TableCell>
        <TableCell />
      </TableRow>
      {open &&
        tasks.map((t) => (
          <TaskLine
            key={t.id}
            task={t}
            tz={tz}
            active={active === t.number}
            onOpen={onOpen}
            nested
          />
        ))}
    </>
  );
}
