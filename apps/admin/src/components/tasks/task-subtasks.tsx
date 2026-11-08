/**
 * Этап 2 задач (TASKS_CHATS_PLAN.md): подзадачи (1.10), результат (1.20) и
 * откуда задача — родительская и сообщение чата (1.18). Части карточки
 * задачи (`task-card.tsx`); проверки прав — у базы.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CornerLeftUp, MessageSquareText, Pencil, Plus, Unlink } from "lucide-react";
import { toast } from "sonner";

import { NewTaskDialog } from "@/components/tasks/task-form";
import { DeadlineText, PersonLine, TaskStatusChip, UrgentMark } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { taskErrorText, updateTask } from "@/lib/tasks/data";
import { plural } from "@/lib/tasks/logic";
import type { TaskBrief, TaskFull } from "@/lib/tasks/types";
import { usePeople } from "@/lib/chats/people";
import { cn } from "@/lib/utils";

const closed = (s: TaskBrief["status"]) => s === "done" || s === "cancelled";

/** «Подзадача к #N» и «Из сообщения в чате» — под названием. */
export function TaskOrigin({ task, canEdit }: { task: TaskFull; canEdit: boolean }) {
  const qc = useQueryClient();
  const parent = task.parent;
  if (!parent && !task.source) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {parent && (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <CornerLeftUp className="size-4 shrink-0" />
          Подзадача к
          {"hidden" in parent ? (
            <span title="Эта задача вам не видна">#{parent.number}</span>
          ) : (
            <Link
              to="/tasks/$number"
              params={{ number: String(parent.number) }}
              className="min-w-0 truncate font-medium text-foreground hover:underline"
            >
              #{parent.number} {parent.title}
            </Link>
          )}
          {canEdit && (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-muted hover:text-foreground"
              title="Отвязать от родительской задачи"
              aria-label="Отвязать от родительской задачи"
              onClick={() =>
                void updateTask(qc, task, { parent_id: null }).catch((e) =>
                  toast.error(taskErrorText(e)),
                )
              }
            >
              <Unlink className="size-3.5" />
            </button>
          )}
        </span>
      )}
      {task.source && (
        <Link
          to="/chats/$chatId"
          params={{ chatId: task.source.chat_id }}
          search={{ m: task.source.seq }}
          className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
        >
          <MessageSquareText className="size-4" /> Из сообщения в чате
        </Link>
      )}
    </div>
  );
}

/** Подзадачи: список видимых, счётчик, «Добавить подзадачу». */
export function TaskSubtasks({ task, tz }: { task: TaskFull; tz: string }) {
  const [adding, setAdding] = useState(false);
  const hidden = Math.max(0, task.subtasks_total - task.subtasks.length);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">Подзадачи</h3>
        {task.subtasks_total > 0 && (
          <span className="text-sm text-muted-foreground">
            {task.subtasks_done} из {task.subtasks_total}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Добавить
        </Button>
      </div>
      {task.subtasks.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-background">
          {task.subtasks.map((s) => (
            <li key={s.id}>
              <Link
                to="/tasks/$number"
                params={{ number: String(s.number) }}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span className="shrink-0 text-muted-foreground">#{s.number}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    closed(s.status) && "text-muted-foreground line-through",
                  )}
                >
                  {s.title}
                </span>
                {s.urgent && !closed(s.status) && <UrgentMark />}
                <TaskStatusChip status={s.status} />
                <DeadlineText task={s} tz={tz} className="shrink-0 text-xs" />
                <PersonLine id={s.assignee_id} size="xs" className="max-w-40 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {hidden ? "" : "Нет — разбейте большую задачу на шаги с исполнителями и сроками"}
        </p>
      )}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          Ещё {hidden} {plural(hidden, "подзадача", "подзадачи", "подзадач")} — видны только их
          участникам
        </p>
      )}
      <NewTaskDialog
        open={adding}
        onClose={() => setAdding(false)}
        parent={task}
        initialProject={task.project_id ?? undefined}
        onCreated={() => undefined}
      />
    </section>
  );
}

/** Результат: текст, кто и когда; «Написать» — исполнителям и постановщику. */
export function TaskResult({
  task,
  canWrite,
  doer,
  onEdit,
}: {
  task: TaskFull;
  canWrite: boolean;
  /** Исполнитель или соисполнитель — ему блок виден и без результата. */
  doer: boolean;
  onEdit: () => void;
}) {
  const { name } = usePeople();
  const open = task.status !== "done" && task.status !== "cancelled";
  if (!task.result && !task.result_required && !(doer && open)) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">Результат</h3>
        {task.result_required && !task.result && (
          <span className="text-sm text-amber-700 dark:text-amber-400">нужен для завершения</span>
        )}
        {canWrite && task.status !== "cancelled" && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onEdit}>
            {task.result ? (
              <>
                <Pencil className="size-4" /> Изменить
              </>
            ) : (
              <>
                <Plus className="size-4" /> Написать
              </>
            )}
          </Button>
        )}
      </div>
      {task.result ? (
        <div className="space-y-1 rounded-lg border border-emerald-600/30 bg-emerald-50/60 px-4 py-3 dark:bg-emerald-950/20">
          <p className="text-sm break-words whitespace-pre-wrap">{task.result.text}</p>
          <p className="text-xs text-muted-foreground">
            {task.result.by ? name(task.result.by) : "—"} · {formatDateTime(task.result.at)}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {task.result_required
            ? "Постановщик просит написать, что сделано, — без этого задачу не завершить"
            : "Что сделано: итог, ссылки, цифры — постановщик увидит его в карточке"}
        </p>
      )}
    </section>
  );
}
