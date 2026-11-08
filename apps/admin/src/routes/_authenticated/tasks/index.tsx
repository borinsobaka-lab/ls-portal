import { createFileRoute } from "@tanstack/react-router";

import { TasksPageSkeleton } from "@/components/page-skeletons";
import { TasksListPage } from "@/components/tasks/tasks-list-page";
import { PORTAL_NAME } from "@/lib/brand";
import { parseTaskFilters } from "@/lib/tasks/logic";
import type { TaskFilters } from "@/lib/tasks/types";

type Search = TaskFilters & { task?: number };

/**
 * «Задачи» — список задач человека (TASKS_CHATS_PLAN.md, веха 3): фильтры —
 * в адресе, `?task=1234` — карточка панелью поверх списка.
 */
export const Route = createFileRoute("/_authenticated/tasks/")({
  head: () => ({ meta: [{ title: `Задачи — ${PORTAL_NAME}` }] }),
  validateSearch: (raw: Record<string, unknown>): Search => {
    const n = Number(raw.task);
    return { ...parseTaskFilters(raw), ...(Number.isInteger(n) && n > 0 ? { task: n } : {}) };
  },
  pendingComponent: TasksPageSkeleton,
  component: TasksRoute,
});

function TasksRoute() {
  const { task, ...filters } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TasksListPage
      filters={filters}
      task={task}
      onFilters={(f) =>
        void navigate({ search: { ...f, ...(task ? { task } : {}) }, replace: true })
      }
      onTask={(n) => void navigate({ search: (s) => ({ ...s, task: n }) })}
    />
  );
}
