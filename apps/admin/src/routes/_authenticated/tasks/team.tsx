import { createFileRoute } from "@tanstack/react-router";

import { TasksTeamPageSkeleton } from "@/components/page-skeletons";
import { TeamPage } from "@/components/tasks/team-page";
import { PORTAL_NAME } from "@/lib/brand";

/** «Задачи» → «Подчинённые» (TASKS_CHATS_PLAN.md, веха 4). */
export const Route = createFileRoute("/_authenticated/tasks/team")({
  head: () => ({ meta: [{ title: `Подчинённые — ${PORTAL_NAME}` }] }),
  pendingComponent: TasksTeamPageSkeleton,
  component: TeamPage,
});
