import { createFileRoute } from "@tanstack/react-router";

import { ProjectPageSkeleton } from "@/components/page-skeletons";
import { ProjectPage, type ProjectTab } from "@/components/tasks/project-page";
import { PORTAL_NAME } from "@/lib/brand";

type Search = { tab?: ProjectTab; view?: "list" | "board"; task?: number };

/** Проект: задачи списком и канбаном, участники, настройки; `?task=` — карточка. */
export const Route = createFileRoute("/_authenticated/tasks/projects/$projectId")({
  head: () => ({ meta: [{ title: `Проект — ${PORTAL_NAME}` }] }),
  validateSearch: (raw: Record<string, unknown>): Search => {
    const tab = ["tasks", "members", "settings"].includes(String(raw.tab))
      ? (raw.tab as ProjectTab)
      : undefined;
    const view = raw.view === "board" ? "board" : undefined;
    const n = Number(raw.task);
    return {
      ...(tab && tab !== "tasks" ? { tab } : {}),
      ...(view ? { view } : {}),
      ...(Number.isInteger(n) && n > 0 ? { task: n } : {}),
    };
  },
  pendingComponent: ProjectPageSkeleton,
  component: ProjectRoute,
});

function ProjectRoute() {
  const { projectId } = Route.useParams();
  const { tab, view, task } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectPage
      projectId={projectId}
      tab={tab ?? "tasks"}
      view={view ?? "list"}
      task={task}
      onSearch={(s) =>
        void navigate({
          search: {
            ...(s.tab && s.tab !== "tasks" ? { tab: s.tab } : {}),
            ...(s.view === "board" ? { view: "board" as const } : {}),
            ...(s.task ? { task: s.task } : {}),
          },
        })
      }
    />
  );
}
