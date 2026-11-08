import { createFileRoute } from "@tanstack/react-router";

import { TasksPlanPageSkeleton } from "@/components/page-skeletons";
import { PlanBoard } from "@/components/tasks/plan-board";
import { PORTAL_NAME } from "@/lib/brand";

type Search = { task?: number };

/** «Задачи» → «Мой план»: личная доска задач со своими колонками. */
export const Route = createFileRoute("/_authenticated/tasks/plan")({
  head: () => ({ meta: [{ title: `Мой план — ${PORTAL_NAME}` }] }),
  validateSearch: (raw: Record<string, unknown>): Search => {
    const n = Number(raw.task);
    return Number.isInteger(n) && n > 0 ? { task: n } : {};
  },
  pendingComponent: TasksPlanPageSkeleton,
  component: PlanRoute,
});

function PlanRoute() {
  const { task } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PlanBoard task={task} onTask={(n) => void navigate({ search: (s) => ({ ...s, task: n }) })} />
  );
}
