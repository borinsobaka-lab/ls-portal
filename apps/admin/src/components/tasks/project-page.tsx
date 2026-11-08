/**
 * Проект (TASKS_CHATS_PLAN.md, 4.10): «Задачи» — списком или канбаном по
 * стадиям проекта (перетаскивание меняет стадию, статус — нет), «Участники»
 * (роли, из подразделения, добавить, выйти), «Настройки» (владелец и
 * модераторы: проект, стадии, архив, удаление). Чат проекта — в «Чатах» →
 * «Проекты».
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MessageSquare, Plus, Trash2, UserMinus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { ProjectSettingsForm } from "@/components/tasks/project-form";
import { PeopleField, PersonLine, UrgentMark, DeadlineText } from "@/components/tasks/task-bits";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { TaskSheet, TaskTable } from "@/components/tasks/task-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CountBadge, StatusChip } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import {
  invalidateTasks,
  projectQuery,
  taskAction,
  taskErrorText,
  useTaskClock,
  useTaskList,
} from "@/lib/tasks/data";
import {
  assigneeOf,
  DEADLINE_RULE_LABEL,
  PROJECT_KIND_LABEL,
  PROJECT_ROLE_LABEL,
  taskPerms,
} from "@/lib/tasks/logic";
import type { ProjectFull, ProjectRole, TaskRow } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

export type ProjectTab = "tasks" | "members" | "settings";

export function ProjectPage({
  projectId,
  tab,
  view,
  task,
  onSearch,
}: {
  projectId: string;
  tab: ProjectTab;
  view: "list" | "board";
  task: number | undefined;
  onSearch: (s: { tab?: ProjectTab; view?: "list" | "board"; task?: number }) => void;
}) {
  const { data: project, isPending, error } = useQuery(projectQuery(projectId));
  const [creating, setCreating] = useState(false);

  if (isPending)
    return (
      <AdminShell title="Проект">
        <Skeleton className="h-64 w-full" />
      </AdminShell>
    );
  if (error || !project)
    return (
      <AdminShell title="Проект">
        <div className="rounded-lg border bg-background p-8 text-center">
          <p className="font-medium">Проект не найден</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Его удалили, или он закрытый — его видят только участники.
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/tasks/projects">Все проекты</Link>
          </Button>
        </div>
      </AdminShell>
    );

  return (
    <AdminShell
      title={project.title}
      actions={
        project.my_role && !project.archived_at ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Новая задача
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <span
              className="size-3 rounded-full"
              style={{ background: project.color ?? "var(--muted-foreground)" }}
            />
            {PROJECT_KIND_LABEL[project.kind]}
          </span>
          <StatusChip tone={project.visibility === "open" ? "info" : "neutral"}>
            {project.visibility === "open" ? "Открытый" : "Закрытый"}
          </StatusChip>
          {project.archived_at && <StatusChip tone="warning">В архиве</StatusChip>}
          {project.my_role && (
            <span className="text-muted-foreground">
              Вы — {PROJECT_ROLE_LABEL[project.my_role].toLowerCase()}
            </span>
          )}
          <span className="text-muted-foreground">
            {DEADLINE_RULE_LABEL[project.deadline_rule]}
          </span>
          {project.chat_id && project.my_role && (
            <Button variant="outline" size="sm" asChild className="ml-auto">
              <Link to="/chats/$chatId" params={{ chatId: project.chat_id }}>
                <MessageSquare className="size-4" /> Чат проекта
              </Link>
            </Button>
          )}
        </div>
        {project.description && (
          <p className="max-w-3xl text-sm text-muted-foreground">{project.description}</p>
        )}

        <Tabs value={tab} onValueChange={(t) => onSearch({ tab: t as ProjectTab, view, task })}>
          <TabsList>
            <TabsTrigger value="tasks">Задачи</TabsTrigger>
            <TabsTrigger value="members">Участники · {project.member_count}</TabsTrigger>
            {project.can_manage && <TabsTrigger value="settings">Настройки</TabsTrigger>}
          </TabsList>
          <TabsContent value="tasks" className="pt-3">
            <ProjectTasks project={project} view={view} task={task} onSearch={onSearch} />
          </TabsContent>
          <TabsContent value="members" className="pt-3">
            <ProjectMembers project={project} />
          </TabsContent>
          {project.can_manage && (
            <TabsContent value="settings" className="space-y-6 pt-3">
              <ProjectSettingsForm key={project.id} project={project} />
              <StagesEditor project={project} />
              <DangerZone project={project} />
            </TabsContent>
          )}
        </Tabs>
      </div>
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        initialProject={project.id}
        onCreated={(numbers) =>
          onSearch({ tab: "tasks", view, task: numbers.length === 1 ? numbers[0] : undefined })
        }
      />
    </AdminShell>
  );
}

function ProjectTasks({
  project,
  view,
  task,
  onSearch,
}: {
  project: ProjectFull;
  view: "list" | "board";
  task: number | undefined;
  onSearch: (s: { tab?: ProjectTab; view?: "list" | "board"; task?: number }) => void;
}) {
  const { tz } = useTaskClock();
  const [done, setDone] = useState(false);
  const { data, isPending } = useTaskList(
    { project: project.id, done: view === "list" && done },
    2,
  );
  const rows = data?.rows ?? [];
  const open = (n: number | undefined) => onSearch({ tab: "tasks", view, task: n });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          aria-label="Вид"
          value={view}
          onChange={(v) => onSearch({ tab: "tasks", view: v, task })}
          options={[
            { value: "list", label: "Список" },
            { value: "board", label: "Канбан" },
          ]}
        />
        {view === "list" && (
          <div className="flex items-center gap-2">
            <Switch id="project-done" checked={done} onCheckedChange={setDone} />
            <Label htmlFor="project-done" className="cursor-pointer">
              Завершённые
            </Label>
          </div>
        )}
      </div>
      {view === "list" ? (
        <TaskTable
          rows={rows}
          isPending={isPending}
          tz={tz}
          active={task}
          onOpen={open}
          groupBatches
          showProject={false}
          empty="В проекте пока нет задач."
        />
      ) : (
        <Board project={project} rows={rows} isPending={isPending} tz={tz} onOpen={open} />
      )}
      <TaskSheet number={task} onClose={() => open(undefined)} />
    </div>
  );
}

function Board({
  project,
  rows,
  isPending,
  tz,
  onOpen,
}: {
  project: ProjectFull;
  rows: TaskRow[];
  isPending: boolean;
  tz: string;
  onOpen: (n: number) => void;
}) {
  const qc = useQueryClient();
  const [drag, setDrag] = useState<TaskRow | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const first = project.stages[0]?.id;
  const move = (t: TaskRow, stage: string) => {
    if ((t.stage_id ?? first) === stage) return;
    if (!taskPerms(t).worker && !project.can_manage) {
      toast.info("Стадию меняют исполнители задачи и ведущие проекта");
      return;
    }
    void taskAction(qc, "task_set_stage", { p_task: t.id, p_stage: stage }).catch((e) =>
      toast.error(taskErrorText(e)),
    );
  };
  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {project.stages.map((s) => {
        const list = rows.filter((t) => (t.stage_id ?? first) === s.id);
        return (
          <div
            key={s.id}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              setOver(s.id);
            }}
            onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              if (drag) move(drag, s.id);
              setDrag(null);
            }}
            className={cn(
              "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40",
              over === s.id && "border-chat-accent bg-chat-accent-soft",
            )}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-sm font-semibold">{s.title}</span>
              {list.length > 0 && <CountBadge count={list.length} tone="quiet" />}
            </div>
            <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
              {isPending
                ? Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)
                : list.map((t) => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(t.number));
                        setDrag(t);
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                      className="cursor-grab rounded-md border bg-background p-2.5 text-sm shadow-xs active:cursor-grabbing"
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(t.number)}
                        className="block w-full text-left"
                      >
                        <span className="font-medium break-words">{t.title}</span>
                        <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                          <span>#{t.number}</span>
                          <DeadlineText task={t} tz={tz} />
                        </span>
                      </button>
                      <div className="mt-2 flex items-center gap-2">
                        <PersonLine
                          id={assigneeOf(t)}
                          size="xs"
                          className="min-w-0 flex-1 text-xs"
                        />
                        {t.urgent && <UrgentMark />}
                        <Select value={t.stage_id ?? first} onValueChange={(v) => move(t, v)}>
                          <SelectTrigger
                            className="h-7 w-auto gap-1 border-0 px-1.5 text-xs shadow-none"
                            aria-label="Стадия"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {project.stages.map((st) => (
                              <SelectItem key={st.id} value={st.id}>
                                {st.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectMembers({ project }: { project: ProjectFull }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: profile } = useStaffProfile();
  const me = profile?.id ?? "";
  const { confirm, confirmDialog } = useConfirm();
  const call = (fn: string, args: Record<string, unknown>) =>
    taskAction(qc, fn, args)
      .then(() => qc.invalidateQueries({ queryKey: ["chat_list"] }))
      .catch((e) => toast.error(taskErrorText(e)));
  const canRole = (role: ProjectRole) =>
    project.my_role === "owner" || (project.can_manage && role !== "owner");
  return (
    <div className="max-w-3xl space-y-3">
      {project.can_manage && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3">
          <span className="text-sm font-medium">Добавить участников</span>
          <PeopleField
            value={[]}
            exclude={project.members.map((m) => m.user_id)}
            onChange={(ids) =>
              ids.length &&
              void call("task_project_members_add", {
                p_project: project.id,
                p_users: ids,
                p_role: "member",
              })
            }
          />
        </div>
      )}
      <div className="divide-y rounded-lg border bg-background">
        {project.members.map((m) => (
          <div key={m.user_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <PersonLine id={m.user_id} className="min-w-0 flex-1" />
            {m.source === "unit" && <StatusChip tone="neutral">из подразделения</StatusChip>}
            {canRole(m.role) ? (
              <Select
                value={m.role}
                onValueChange={(role) =>
                  void call("task_project_member_set_role", {
                    p_project: project.id,
                    p_user: m.user_id,
                    p_role: role,
                  })
                }
              >
                <SelectTrigger className="w-36" aria-label="Роль">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROJECT_ROLE_LABEL) as ProjectRole[])
                    .filter((r) => r !== "owner" || project.my_role === "owner")
                    .map((r) => (
                      <SelectItem key={r} value={r}>
                        {PROJECT_ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm text-muted-foreground">{PROJECT_ROLE_LABEL[m.role]}</span>
            )}
            {m.source === "manual" && (m.user_id === me || canRole(m.role)) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.user_id === me ? "Выйти из проекта" : "Убрать из проекта"}
                title={m.user_id === me ? "Выйти из проекта" : "Убрать из проекта"}
                onClick={async () => {
                  const self = m.user_id === me;
                  const ok = await confirm({
                    title: self ? "Выйти из проекта?" : "Убрать из проекта?",
                    description: "Задачи, где человек участник, останутся у него.",
                    confirmLabel: self ? "Выйти" : "Убрать",
                  });
                  if (!ok) return;
                  await call("task_project_member_remove", {
                    p_project: project.id,
                    p_user: m.user_id,
                  });
                  if (self && project.visibility === "closed")
                    void navigate({ to: "/tasks/projects" });
                }}
              >
                <UserMinus className="size-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
      {confirmDialog}
    </div>
  );
}

function StagesEditor({ project }: { project: ProjectFull }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const call = (fn: string, args: Record<string, unknown>) =>
    taskAction(qc, fn, args).catch((e) => toast.error(taskErrorText(e)));
  const order = (from: number, to: number) => {
    const ids = project.stages.map((s) => s.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    void call("task_stages_reorder", { p_project: project.id, p_ids: ids });
  };
  return (
    <section className="max-w-xl space-y-3 rounded-lg border bg-background p-4 sm:p-6">
      <div>
        <h3 className="font-semibold">Стадии канбана</h3>
        <p className="text-sm text-muted-foreground">
          Колонки канбана проекта. Стадия не меняет статус задачи; новая задача — в первой стадии.
        </p>
      </div>
      <ul className="space-y-1.5">
        {project.stages.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <Input
              defaultValue={s.title}
              maxLength={60}
              aria-label={`Стадия ${i + 1}`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.title)
                  void call("task_stage_save", { p_project: project.id, p_id: s.id, p_title: v });
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Выше"
              disabled={i === 0}
              onClick={() => order(i, i - 1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Ниже"
              disabled={i === project.stages.length - 1}
              onClick={() => order(i, i + 1)}
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Удалить стадию «${s.title}»`}
              disabled={project.stages.length === 1}
              onClick={() => void call("task_stage_delete", { p_id: s.id })}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void call("task_stage_save", {
            p_project: project.id,
            p_id: null,
            p_title: title.trim(),
          }).then(() => setTitle(""));
        }}
      >
        <Input
          value={title}
          maxLength={60}
          placeholder="Новая стадия"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" variant="outline">
          Добавить
        </Button>
      </form>
    </section>
  );
}

function DangerZone({ project }: { project: ProjectFull }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  return (
    <section className="flex max-w-xl flex-wrap gap-2">
      <Button
        variant="outline"
        onClick={() =>
          void taskAction(qc, "task_project_archive", {
            p_project: project.id,
            p_archived: !project.archived_at,
          })
            .then(() =>
              toast.success(project.archived_at ? "Проект возвращён из архива" : "Проект в архиве"),
            )
            .catch((e) => toast.error(taskErrorText(e)))
        }
      >
        {project.archived_at ? "Вернуть из архива" : "В архив"}
      </Button>
      {project.my_role === "owner" && (
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={async () => {
            const ok = await confirm({
              title: `Удалить проект «${project.title}»?`,
              description:
                "Задачи останутся без проекта, чат проекта удалится у всех. Вернуть нельзя.",
              confirmLabel: "Удалить проект",
            });
            if (!ok) return;
            try {
              await taskAction(qc, "task_project_delete", { p_project: project.id });
              void invalidateTasks(qc);
              void qc.invalidateQueries({ queryKey: ["chat_list"] });
              void navigate({ to: "/tasks/projects" });
            } catch (e) {
              toast.error(taskErrorText(e));
            }
          }}
        >
          Удалить проект
        </Button>
      )}
      {confirmDialog}
    </section>
  );
}
