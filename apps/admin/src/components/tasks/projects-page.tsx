/**
 * «Проекты» (TASKS_CHATS_PLAN.md, 4.10): мои проекты карточками (задачи в
 * работе, просроченные, участники), открытые — ссылкой на проект (там
 * «Вступить»), архив — внизу.
 * «Новый проект» — любой человек портала (он — владелец).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Archive, FolderOpen, Lock, Plus, Users } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { NewProjectDialog } from "@/components/tasks/project-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { projectsQuery } from "@/lib/tasks/data";
import { PROJECT_KIND_LABEL, PROJECT_ROLE_LABEL, plural } from "@/lib/tasks/logic";
import type { Project } from "@/lib/tasks/types";

export function ProjectsPage() {
  const { data = [], isPending } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const mine = data.filter((p) => p.my_role && !p.archived_at);
  const open = data.filter((p) => !p.my_role && !p.archived_at);
  const archived = data.filter((p) => p.archived_at);

  return (
    <AdminShell
      title="Проекты"
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> Новый проект
        </Button>
      }
    >
      <div className="space-y-6">
        {isPending ? (
          <Grid>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </Grid>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-background px-4 py-12 text-center">
            <FolderOpen className="size-8 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">
              Проект — пространство отдела, города или инициативы: свои задачи списком и канбаном,
              участники и чат. Задачи закрытого проекта видят только его участники.
            </p>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Новый проект
            </Button>
          </div>
        ) : (
          <>
            {mine.length > 0 && (
              <Section title="Мои проекты">
                {mine.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </Section>
            )}
            {open.length > 0 && (
              <Section
                title="Открытые проекты"
                hint="Видны всем: откройте, чтобы посмотреть и вступить"
              >
                {open.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </Section>
            )}
            {archived.length > 0 && (
              <Section title="Архив">
                {archived.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </AdminShell>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">
        {title}
        {hint && <span className="ml-2 text-sm font-normal text-muted-foreground">{hint}</span>}
      </h2>
      <Grid>{children}</Grid>
    </section>
  );
}

function ProjectCard({ project: p }: { project: Project }) {
  const body = (
    <>
      <span className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1 size-3 shrink-0 rounded-full"
          style={{ background: p.color ?? "var(--muted-foreground)" }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{p.title}</span>
          <span className="block text-xs text-muted-foreground">
            {PROJECT_KIND_LABEL[p.kind]}
            {p.my_role ? ` · ${PROJECT_ROLE_LABEL[p.my_role].toLowerCase()}` : ""}
          </span>
        </span>
        {p.visibility === "closed" ? (
          <span title="Закрытый: видят только участники">
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Закрытый" />
          </span>
        ) : (
          <StatusChip tone="info">Открытый</StatusChip>
        )}
        {p.archived_at && (
          <span title="В архиве">
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-label="В архиве" />
          </span>
        )}
      </span>
      <span className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          {p.open_count} {plural(p.open_count, "задача", "задачи", "задач")} в работе
        </span>
        {p.overdue_count > 0 && (
          <span className="font-medium text-destructive">{p.overdue_count} просрочено</span>
        )}
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Users className="size-3.5" /> {p.member_count}
        </span>
      </span>
    </>
  );
  return (
    <Link
      to="/tasks/projects/$projectId"
      params={{ projectId: p.id }}
      className="flex flex-col rounded-lg border bg-background p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
    >
      {body}
    </Link>
  );
}
