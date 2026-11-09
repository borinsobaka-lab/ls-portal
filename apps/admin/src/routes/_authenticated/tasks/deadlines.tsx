import { createFileRoute } from "@tanstack/react-router";

import { TasksDeadlinesPageSkeleton } from "@/components/page-skeletons";
import { DeadlinesBoard } from "@/components/tasks/deadlines-board";
import { PORTAL_NAME } from "@/lib/brand";
import type { RoleTab } from "@/lib/tasks/types";

type Search = { role?: RoleTab; task?: number };

/** «Задачи» → «Сроки»: колонки по срокам, перенос перетаскиванием. */
export const Route = createFileRoute("/_authenticated/tasks/deadlines")({
  head: () => ({ meta: [{ title: `Сроки задач — ${PORTAL_NAME}` }] }),
  validateSearch: (raw: Record<string, unknown>): Search => {
    const role = ["do", "help", "assigned", "watch", "all"].includes(String(raw.role))
      ? (raw.role as RoleTab)
      : undefined;
    const n = Number(raw.task);
    return { ...(role ? { role } : {}), ...(Number.isInteger(n) && n > 0 ? { task: n } : {}) };
  },
  pendingComponent: TasksDeadlinesPageSkeleton,
  component: DeadlinesRoute,
});

function DeadlinesRoute() {
  const { role, task } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DeadlinesBoard
      role={role ?? "do"}
      task={task}
      onRole={(r) => void navigate({ search: (s) => ({ ...s, role: r === "do" ? undefined : r }) })}
      onTask={(n) => void navigate({ search: (s) => ({ ...s, task: n }) })}
    />
  );
}
