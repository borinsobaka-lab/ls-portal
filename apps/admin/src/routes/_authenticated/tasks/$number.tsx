import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { TaskPageSkeleton } from "@/components/page-skeletons";
import { TaskCard } from "@/components/tasks/task-card";
import { PORTAL_NAME } from "@/lib/brand";
import { useTaskCard } from "@/lib/tasks/data";

/**
 * Задача своей страницей — постоянная ссылка `/tasks/1234` (бриф 16.1):
 * из уведомлений, чата задачи, «Скопировать ссылку». Над карточкой — крошки
 * «Задачи › Проект › #1234» (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 2.4).
 */
export const Route = createFileRoute("/_authenticated/tasks/$number")({
  head: ({ params }) => ({ meta: [{ title: `Задача #${params.number} — ${PORTAL_NAME}` }] }),
  pendingComponent: TaskPageSkeleton,
  component: TaskRoute,
});

function TaskRoute() {
  const { number } = Route.useParams();
  const n = Number(number);
  const valid = Number.isInteger(n) && n > 0;
  return (
    <AdminShell title={`Задача #${number}`}>
      <div className="space-y-3">
        {valid && <Crumbs number={n} />}
        <div className="rounded-lg border bg-background p-4 sm:p-6">
          {valid ? (
            <TaskCard number={n} />
          ) : (
            <p className="text-muted-foreground">Нет такой задачи.</p>
          )}
        </div>
      </div>
    </AdminShell>
  );
}

function Crumbs({ number }: { number: number }) {
  const { data: task } = useTaskCard(number);
  const project = task?.project;
  return (
    <nav aria-label="Где задача" className="flex flex-wrap items-center gap-1 text-sm">
      <Link to="/tasks" className="text-muted-foreground hover:text-foreground hover:underline">
        Задачи
      </Link>
      {project && (
        <>
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
          <Link
            to="/tasks/projects/$projectId"
            params={{ projectId: project.id }}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            {project.title}
          </Link>
        </>
      )}
      <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
      <span aria-current="page" className="font-medium">
        #{number}
      </span>
    </nav>
  );
}
