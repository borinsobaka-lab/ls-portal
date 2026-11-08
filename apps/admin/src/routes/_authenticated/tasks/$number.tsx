import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { TaskPageSkeleton } from "@/components/page-skeletons";
import { TaskCard } from "@/components/tasks/task-card";
import { Button } from "@/components/ui/button";
import { PORTAL_NAME } from "@/lib/brand";

/**
 * Задача своей страницей — постоянная ссылка `/tasks/1234` (бриф 16.1):
 * из уведомлений, чата задачи, «Скопировать ссылку».
 */
export const Route = createFileRoute("/_authenticated/tasks/$number")({
  head: ({ params }) => ({ meta: [{ title: `Задача #${params.number} — ${PORTAL_NAME}` }] }),
  pendingComponent: TaskPageSkeleton,
  component: TaskRoute,
});

function TaskRoute() {
  const { number } = Route.useParams();
  const n = Number(number);
  return (
    <AdminShell
      title={`Задача #${number}`}
      actions={
        <Button variant="outline" asChild>
          <Link to="/tasks">
            <ArrowLeft className="size-4" /> Все задачи
          </Link>
        </Button>
      }
    >
      <div className="rounded-lg border bg-background p-4 sm:p-6">
        {Number.isInteger(n) && n > 0 ? (
          <TaskCard number={n} />
        ) : (
          <p className="text-muted-foreground">Нет такой задачи.</p>
        )}
      </div>
    </AdminShell>
  );
}
