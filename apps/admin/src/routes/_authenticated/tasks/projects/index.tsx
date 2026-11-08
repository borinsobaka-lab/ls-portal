import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPageSkeleton } from "@/components/page-skeletons";
import { ProjectsPage } from "@/components/tasks/projects-page";
import { PORTAL_NAME } from "@/lib/brand";

/** «Задачи» → «Проекты»: мои, открытые, архив; «Новый проект». */
export const Route = createFileRoute("/_authenticated/tasks/projects/")({
  head: () => ({ meta: [{ title: `Проекты — ${PORTAL_NAME}` }] }),
  pendingComponent: ProjectsPageSkeleton,
  component: ProjectsPage,
});
