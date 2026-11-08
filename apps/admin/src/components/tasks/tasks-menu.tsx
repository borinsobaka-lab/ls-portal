/**
 * Меню раздела «Задачи» в боковой панели: мои задачи по ролям (у «Делаю» —
 * просроченные, у «Поручил» — ждут моей проверки), «Сроки», «Пункты на
 * мне» и сохранённые фильтры (правой кнопкой — удалить).
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Copy,
  Eye,
  Filter,
  FolderOpen,
  ListChecks,
  ListTodo,
  Repeat,
  Send,
  UserCheck,
  Users,
  UserStar,
} from "lucide-react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CountBadge } from "@/components/ui/status-chip";
import { TASKS_DEADLINES_URL, TASKS_URL } from "@/lib/nav-sections";
import {
  taskAction,
  taskErrorText,
  taskFiltersQuery,
  useMyProjects,
  useTaskCounters,
} from "@/lib/tasks/data";
import { cleanFilters, ROLE_TABS } from "@/lib/tasks/logic";
import type { RoleTab, TaskFilters } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

type LucideIcon = typeof UserCheck;

const ROLE_ICONS: Record<RoleTab, LucideIcon> = {
  do: UserCheck,
  help: Users,
  assigned: Send,
  watch: Eye,
  all: ListTodo,
};

const same = (a: TaskFilters, b: TaskFilters) =>
  JSON.stringify(cleanFilters(a), Object.keys(cleanFilters(a)).sort()) ===
  JSON.stringify(cleanFilters(b), Object.keys(cleanFilters(b)).sort());

function MenuLink({
  to,
  search,
  icon: Icon,
  title,
  active,
  count,
  urgent,
  onNavigate,
}: {
  to: string;
  search?: TaskFilters;
  icon: LucideIcon;
  title: string;
  active: boolean;
  count?: number;
  urgent?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      search={search ?? {}}
      onClick={onNavigate}
      className={cn(
        "flex h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-white hover:bg-white/10",
        active && "bg-white/10 font-semibold",
      )}
    >
      <Icon className={cn("size-[18px] shrink-0", active && "text-brand-on-dark")} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {!!count && <CountBadge count={count} tone={urgent ? "urgent" : "quiet"} />}
    </Link>
  );
}

export function TasksMenu({ onNavigate }: { onNavigate?: () => void }) {
  const qc = useQueryClient();
  const counters = useTaskCounters();
  const { data: saved = [] } = useQuery(taskFiltersQuery);
  const projects = useMyProjects();
  const location = useRouterState({ select: (s) => s.location });
  const onList = location.pathname === TASKS_URL || location.pathname === `${TASKS_URL}/`;
  const search = (location.search ?? {}) as TaskFilters & { task?: number };
  const { task: _task, ...current } = search;
  void _task;

  return (
    <nav
      aria-label="Задачи"
      className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
    >
      <p className="px-2 pt-1 pb-1 text-[13px] text-white/50">Мои задачи</p>
      {ROLE_TABS.map((t) => {
        const filters: TaskFilters = t.key === "all" ? {} : { role: t.key };
        return (
          <MenuLink
            key={t.key}
            to={TASKS_URL}
            search={filters}
            icon={ROLE_ICONS[t.key]}
            title={t.title}
            active={onList && same(current, filters)}
            count={
              t.key === "do" ? counters.overdue : t.key === "assigned" ? counters.review : undefined
            }
            urgent
            onNavigate={onNavigate}
          />
        );
      })}
      <p className="mt-2 px-2 pt-1 pb-1 text-[13px] text-white/50">Вид</p>
      <MenuLink
        to={TASKS_DEADLINES_URL}
        icon={CalendarClock}
        title="Сроки"
        active={location.pathname.startsWith(TASKS_DEADLINES_URL)}
        onNavigate={onNavigate}
      />
      <MenuLink
        to={TASKS_URL}
        search={{ mine: true }}
        icon={ListChecks}
        title="Пункты на мне"
        active={onList && same(current, { mine: true })}
        onNavigate={onNavigate}
      />
      {counters.leader && (
        <MenuLink
          to="/tasks/team"
          icon={UserStar}
          title="Подчинённые"
          active={location.pathname.startsWith("/tasks/team") || (onList && !!current.team)}
          onNavigate={onNavigate}
        />
      )}
      <MenuLink
        to="/tasks/templates"
        icon={Copy}
        title="Шаблоны"
        active={location.pathname.startsWith("/tasks/templates")}
        onNavigate={onNavigate}
      />
      <MenuLink
        to="/tasks/recurring"
        icon={Repeat}
        title="Регулярные"
        active={location.pathname.startsWith("/tasks/recurring")}
        onNavigate={onNavigate}
      />
      <p className="mt-2 px-2 pt-1 pb-1 text-[13px] text-white/50">Проекты</p>
      {projects.map((p) => {
        const href = `/tasks/projects/${p.id}`;
        const active = location.pathname === href;
        return (
          <Link
            key={p.id}
            to="/tasks/projects/$projectId"
            params={{ projectId: p.id }}
            onClick={onNavigate}
            className={cn(
              "flex h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-white hover:bg-white/10",
              active && "bg-white/10 font-semibold",
            )}
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <span
                className="size-2.5 rounded-full"
                style={{ background: p.color ?? "#94a3b8" }}
              />
            </span>
            <span className="min-w-0 flex-1 truncate">{p.title}</span>
            {p.overdue_count > 0 && <CountBadge count={p.overdue_count} tone="urgent" />}
          </Link>
        );
      })}
      <MenuLink
        to="/tasks/projects"
        icon={FolderOpen}
        title={projects.length ? "Все проекты" : "Проекты"}
        active={location.pathname === "/tasks/projects" || location.pathname === "/tasks/projects/"}
        onNavigate={onNavigate}
      />
      {saved.length > 0 && (
        <p className="mt-2 px-2 pt-1 pb-1 text-[13px] text-white/50">Мои фильтры</p>
      )}
      {saved.map((f) => (
        <ContextMenu key={f.id}>
          <ContextMenuTrigger asChild>
            <div>
              <MenuLink
                to={TASKS_URL}
                search={f.params}
                icon={Filter}
                title={f.name}
                active={onList && same(current, f.params)}
                onNavigate={onNavigate}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem
              className="text-destructive"
              onSelect={() =>
                void taskAction(qc, "task_filter_delete", { p_id: f.id }).catch((e) =>
                  toast.error(taskErrorText(e)),
                )
              }
            >
              Удалить фильтр
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </nav>
  );
}
