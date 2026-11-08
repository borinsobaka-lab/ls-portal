import { createFileRoute } from "@tanstack/react-router";

import { TaskTemplatesPageSkeleton } from "@/components/page-skeletons";
import { TemplatesPage } from "@/components/tasks/templates-page";
import { PORTAL_NAME } from "@/lib/brand";

/** «Задачи» → «Шаблоны задач» (TASKS_CHATS_PLAN.md, веха 4). */
export const Route = createFileRoute("/_authenticated/tasks/templates")({
  head: () => ({ meta: [{ title: `Шаблоны задач — ${PORTAL_NAME}` }] }),
  pendingComponent: TaskTemplatesPageSkeleton,
  component: TemplatesPage,
});
