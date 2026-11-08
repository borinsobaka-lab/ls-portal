import { createFileRoute } from "@tanstack/react-router";

import { TaskRecurringPageSkeleton } from "@/components/page-skeletons";
import { RecurringPage } from "@/components/tasks/recurring-page";
import { PORTAL_NAME } from "@/lib/brand";

/** «Задачи» → «Регулярные задачи» (TASKS_CHATS_PLAN.md, веха 4). */
export const Route = createFileRoute("/_authenticated/tasks/recurring")({
  head: () => ({ meta: [{ title: `Регулярные задачи — ${PORTAL_NAME}` }] }),
  pendingComponent: TaskRecurringPageSkeleton,
  component: RecurringPage,
});
