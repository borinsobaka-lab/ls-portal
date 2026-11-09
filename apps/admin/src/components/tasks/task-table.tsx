/**
 * Таблица задач (список «Задач», задачи проекта, «Подчинённые») и карточка
 * задачи панелью справа. Задачи одной постановки «отдельно каждому» —
 * строкой-сводкой (раскрывается). В строке — кружок «выполнить» (у задачи с
 * проверкой исполнитель отправляет на проверку, с отчётом — сначала отчёт),
 * непрочитанное — полужирным, теги — фильтр по нажатию. Сортировка — по
 * заголовкам колонок (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.2).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerLeftUp,
  ExternalLink,
  FileText,
  ListChecks,
  ListTodo,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { TableSortState } from "@/hooks/use-table-sort";
import { setTaskResult, setTaskStatus, taskErrorText } from "@/lib/tasks/data";
import {
  assigneeOf,
  batchText,
  creatorOf,
  isClosed,
  plural,
  quickComplete,
} from "@/lib/tasks/logic";
import type { TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

type Head = Pick<TableSortState, "head">;

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
  sort,
  onTag,
}: {
  rows: TaskRow[];
  isPending: boolean;
  tz: string;
  active: number | undefined;
  onOpen: (n: number) => void;
  groupBatches?: boolean;
  showProject?: boolean;
  empty: ReactNode;
  footer?: ReactNode;
  /** Сортировка по заголовкам (`useTableSort`); строки уже отсортированы. */
  sort?: Head;
  /** Нажатие на тег в строке — фильтр по тегу. */
  onTag?: (tagId: string) => void;
}) {
  const head = (key: string) => (sort ? sort.head(key) : {});
  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20" {...head("number")}>
              №
            </TableHead>
            <TableHead {...head("title")}>Задача</TableHead>
            <TableHead className="w-44" {...head("deadline")}>
              Срок
            </TableHead>
            <TableHead className="w-48" {...head("assignee")}>
              Исполнитель
            </TableHead>
            <TableHead className="w-48" {...head("creator")}>
              Постановщик
            </TableHead>
            <TableHead className="w-32" {...head("status")}>
              Статус
            </TableHead>
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
              onTag={onTag}
            />
          )}
        </TableBody>
      </Table>
      {footer}
    </div>
  );
}

/**
 * Карточка задачи панелью справа поверх страницы (`?task=`): в шапке —
 * «Открыть страницей» и ‹ › по текущему списку; подзадачи и родительская
 * открываются в той же панели.
 */
export function TaskSheet({
  number,
  onClose,
  onOpen,
  list,
}: {
  number: number | undefined;
  onClose: () => void;
  /** Открыть другую задачу в этой же панели. */
  onOpen: (n: number) => void;
  /** Номера задач текущего списка — для ‹ ›. */
  list?: number[];
}) {
  const at = number && list ? list.indexOf(number) : -1;
  const prev = at > 0 ? list![at - 1] : undefined;
  const next = at >= 0 && at < list!.length - 1 ? list![at + 1] : undefined;
  return (
    <Sheet open={!!number} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-5xl sm:p-6">
        <SheetTitle className="sr-only">Задача #{number}</SheetTitle>
        <SheetDescription className="sr-only">Карточка задачи</SheetDescription>
        {number && (
          <>
            <div className="mb-4 flex items-center gap-1 pr-10">
              {list && list.length > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Предыдущая задача"
                    title="Предыдущая задача"
                    disabled={!prev}
                    onClick={() => prev && onOpen(prev)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Следующая задача"
                    title="Следующая задача"
                    disabled={!next}
                    onClick={() => next && onOpen(next)}
                  >
                    <ChevronRight />
                  </Button>
                  {at >= 0 && (
                    <span className="mr-2 text-xs text-muted-foreground tabular-nums">
                      {at + 1} из {list.length}
                    </span>
                  )}
                </>
              )}
              <Button variant="ghost" size="sm" asChild className="ml-auto">
                <Link to="/tasks/$number" params={{ number: String(number) }}>
                  Открыть страницей <ExternalLink />
                </Link>
              </Button>
            </div>
            <TaskCard number={number} onClose={onClose} onOpenTask={onOpen} />
          </>
        )}
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
  onTag,
}: {
  rows: TaskRow[];
  tz: string;
  active: number | undefined;
  onOpen: (n: number) => void;
  groupBatches: boolean;
  showProject: boolean;
  onTag?: (tagId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [resultFor, setResultFor] = useState<TaskRow | null>(null);
  const done = useComplete(setResultFor);
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
            onTag={onTag}
            onComplete={done.run}
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
            onComplete={done.run}
          />
        ),
      )}
      {done.confirmDialog}
      <ResultDialog task={resultFor} onClose={() => setResultFor(null)} />
    </>
  );
}

/** «Выполнить» из строки: открытые подзадачи — спросить, нужен отчёт — окно отчёта. */
function useComplete(askResult: (t: TaskRow) => void) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const run = async (t: TaskRow) => {
    const q = quickComplete(t);
    if (!q) return;
    if (
      q.openSubtasks > 0 &&
      !(await confirm({
        title: "Завершить задачу?",
        description: `Не завершены ${q.openSubtasks} ${plural(q.openSubtasks, "подзадача", "подзадачи", "подзадач")}. Они останутся в работе.`,
        confirmLabel: q.label,
        destructive: false,
      }))
    )
      return;
    if (q.needsResult) {
      askResult(t);
      return;
    }
    try {
      await setTaskStatus(qc, t, "complete");
      toast.success(
        q.label === "На проверку" ? `#${t.number} — на проверке` : `#${t.number} завершена`,
      );
    } catch (e) {
      toast.error(taskErrorText(e));
    }
  };
  return { run: (t: TaskRow) => void run(t), confirmDialog };
}

function ResultDialog({ task, onClose }: { task: TaskRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {task && <ResultForm key={task.id} task={task} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ResultForm({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = quickComplete(task)?.label ?? "Завершить";
  return (
    <DialogForm
      onSubmit={async () => {
        if (!text.trim()) {
          setError("Напишите, что сделано");
          return;
        }
        setBusy(true);
        try {
          await setTaskResult(qc, task, text.trim());
          await setTaskStatus(qc, task, "complete");
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Результат задачи</DialogTitle>
        <DialogDescription>
          #{task.number} {task.title}: постановщик просит отчёт — без него задачу не завершить.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormField label="Что сделано" required error={error}>
          <Textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
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
          {busy && <Loader2 className="animate-spin" />}
          {label}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

/** Кружок «выполнить» перед названием (как в Todoist). */
function DoneCircle({ task, onComplete }: { task: TaskRow; onComplete: (t: TaskRow) => void }) {
  const closed = isClosed(task.status);
  const q = quickComplete(task);
  if (closed)
    return (
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
          task.status === "done"
            ? "border-emerald-600 bg-emerald-600 text-white"
            : "border-muted-foreground/40",
        )}
      >
        {task.status === "done" && <Check className="size-3" />}
      </span>
    );
  if (!q) return <span aria-hidden className="size-5 shrink-0" />;
  const label = `${q.label}: «${task.title}»`;
  return (
    <button
      type="button"
      aria-label={label}
      title={q.label}
      onClick={(e) => {
        e.stopPropagation();
        onComplete(task);
      }}
      className="group/done mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 text-transparent transition-colors hover:border-emerald-600 hover:text-emerald-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:size-6"
    >
      <Check className="size-3" />
    </button>
  );
}

function TaskLine({
  task,
  tz,
  active,
  onOpen,
  nested,
  showProject = true,
  onTag,
  onComplete,
}: {
  task: TaskRow;
  tz: string;
  active: boolean;
  onOpen: (n: number) => void;
  nested?: boolean;
  showProject?: boolean;
  onTag?: (tagId: string) => void;
  onComplete: (t: TaskRow) => void;
}) {
  const closed = isClosed(task.status);
  return (
    <TableRow
      className={cn("cursor-pointer", active && "bg-selected/8", nested && "bg-muted/30")}
      onClick={() => onOpen(task.number)}
    >
      <TableCell className="text-muted-foreground tabular-nums">#{task.number}</TableCell>
      <TableCell>
        <div className={cn("flex items-start gap-2", nested && "pl-4")}>
          <DoneCircle task={task} onComplete={onComplete} />
          <span
            className={cn(
              "min-w-0 break-words",
              task.unseen ? "font-semibold" : "font-medium",
              closed && "text-muted-foreground line-through",
            )}
          >
            {task.title}
            {task.unseen && <span className="sr-only"> (есть новое)</span>}
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
              "mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs text-muted-foreground",
              nested && "pl-11",
            )}
          >
            {showProject && task.project && <ProjectTag project={task.project} />}
            {task.tags.map((g) =>
              onTag ? (
                <button
                  key={g.id}
                  type="button"
                  title={`Задачи с тегом #${g.name}`}
                  className="rounded-full hover:opacity-80"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTag(g.id);
                  }}
                >
                  <TaskTagChip tag={g} className="py-0" />
                </button>
              ) : (
                <TaskTagChip key={g.id} tag={g} className="py-0" />
              ),
            )}
            {task.parent_number != null && (
              <span
                className="inline-flex items-center gap-1"
                title={`Подзадача к #${task.parent_number}`}
              >
                <CornerLeftUp className="size-3.5" aria-hidden />
                <span className="sr-only">Подзадача к </span>#{task.parent_number}
              </span>
            )}
            {task.subtasks_total > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={`${task.subtasks_done} из ${task.subtasks_total} ${plural(task.subtasks_total, "подзадачи", "подзадач", "подзадач")} готово`}
              >
                <ListTodo className="size-3.5" aria-hidden />
                {task.subtasks_done}/{task.subtasks_total}
              </span>
            )}
            {task.check_total > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={`${task.check_done} из ${task.check_total} ${plural(task.check_total, "пункта", "пунктов", "пунктов")} чек-листа`}
              >
                <ListChecks className="size-3.5" aria-hidden />
                {task.check_done}/{task.check_total}
              </span>
            )}
            {task.files_count > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={`${task.files_count} ${plural(task.files_count, "файл", "файла", "файлов")}`}
              >
                <FileText className="size-3.5" aria-hidden />
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
  onComplete,
}: {
  tasks: TaskRow[];
  tz: string;
  open: boolean;
  onToggle: () => void;
  active: number | undefined;
  onOpen: (n: number) => void;
  onComplete: (t: TaskRow) => void;
}) {
  const first = tasks[0];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle} aria-expanded={open}>
        <TableCell className="text-muted-foreground">
          <Chevron className="size-4" aria-label={open ? "Свернуть" : "Раскрыть"} />
        </TableCell>
        <TableCell>
          <div className="font-medium">{first.title}</div>
          <div className="text-xs text-muted-foreground">
            {first.batch ? batchText(first.batch) : `${tasks.length} задач`} · каждому своя
          </div>
        </TableCell>
        <TableCell>
          <DeadlineText task={first} tz={tz} />
        </TableCell>
        <TableCell className="text-muted-foreground">
          {tasks.length} {plural(tasks.length, "исполнитель", "исполнителя", "исполнителей")}
        </TableCell>
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
            onComplete={onComplete}
            nested
          />
        ))}
    </>
  );
}
