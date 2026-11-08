/**
 * Меню раздела «Задачи» в боковой панели: мои задачи по ролям (у «Делаю» —
 * просроченные, у «Поручил» — ждут моей проверки), «Мой план», «Сроки», «Пункты на
 * мне» и сохранённые фильтры (правой кнопкой — удалить).
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  CalendarMark,
  ChecklistMinimalistic,
  ClipboardList,
  Copy,
  Eye,
  Filter,
  FolderOpen,
  Plain,
  Repeat,
  Structure,
  UserCheckRounded,
  UsersGroupTwoRounded,
  Widget3,
  type NavIcon,
} from "@/components/nav-icons";
import {
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavGroup,
  SIDEBAR_NAV_LINK_CLASS,
} from "@/components/sidebar-nav";
import { SidebarContent, SidebarMenuItem } from "@/components/ui/sidebar";
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
// Иконки — Solar, как во всех меню второго уровня (`sidebar-nav.tsx`).
const ROLE_ICONS: Record<RoleTab, NavIcon> = {
  do: UserCheckRounded,
  help: UsersGroupTwoRounded,
  assigned: Plain,
  watch: Eye,
  all: ClipboardList,
};

const same = (a: TaskFilters, b: TaskFilters) =>
  JSON.stringify(cleanFilters(a), Object.keys(cleanFilters(a)).sort()) ===
  JSON.stringify(cleanFilters(b), Object.keys(cleanFilters(b)).sort());

function MenuLink({
  to,
  search,
  icon,
  title,
  active,
  count,
  urgent,
  onNavigate,
  ...item
}: Omit<ComponentProps<typeof SidebarMenuItem>, "title"> & {
  to: string;
  search?: TaskFilters;
  icon: NavIcon;
  title: string;
  active: boolean;
  count?: number;
  urgent?: boolean;
  onNavigate?: () => void;
}) {
  // Остальные свойства — строке меню: так её оборачивает ContextMenuTrigger.
  return (
    <SidebarMenuItem {...item}>
      <SidebarNavButton active={active}>
        <Link to={to} search={search ?? {}} onClick={onNavigate} className={SIDEBAR_NAV_LINK_CLASS}>
          <SidebarNavContent
            icon={icon}
            active={active}
            title={title}
            badge={count}
            badgeTone={urgent ? "urgent" : "quiet"}
          />
        </Link>
      </SidebarNavButton>
    </SidebarMenuItem>
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
    <SidebarContent aria-label="Задачи" className="sidebar-scroll gap-1">
      <SidebarNavGroup id="tasks-roles" label="Мои задачи">
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
                t.key === "do"
                  ? counters.overdue
                  : t.key === "assigned"
                    ? counters.review
                    : undefined
              }
              urgent
              onNavigate={onNavigate}
            />
          );
        })}
      </SidebarNavGroup>
      <SidebarNavGroup id="tasks-views" label="Вид">
        <MenuLink
          to="/tasks/plan"
          icon={Widget3}
          title="Мой план"
          active={location.pathname.startsWith("/tasks/plan")}
          onNavigate={onNavigate}
        />
        <MenuLink
          to={TASKS_DEADLINES_URL}
          icon={CalendarMark}
          title="Сроки"
          active={location.pathname.startsWith(TASKS_DEADLINES_URL)}
          onNavigate={onNavigate}
        />
        <MenuLink
          to={TASKS_URL}
          search={{ mine: true }}
          icon={ChecklistMinimalistic}
          title="Пункты на мне"
          active={onList && same(current, { mine: true })}
          onNavigate={onNavigate}
        />
        {counters.leader && (
          <MenuLink
            to="/tasks/team"
            icon={Structure}
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
      </SidebarNavGroup>
      <SidebarNavGroup id="tasks-projects" label="Проекты">
        {projects.map((p) => {
          const active = location.pathname === `/tasks/projects/${p.id}`;
          return (
            <SidebarMenuItem key={p.id}>
              {/* У проекта вместо иконки — точка его цвета, свечение того же цвета. */}
              <SidebarNavButton active={active}>
                <Link
                  to="/tasks/projects/$projectId"
                  params={{ projectId: p.id }}
                  onClick={onNavigate}
                  className={SIDEBAR_NAV_LINK_CLASS}
                >
                  <SidebarNavContent
                    marker={p.color ?? "#94a3b8"}
                    active={active}
                    title={p.title}
                    badge={p.overdue_count}
                  />
                </Link>
              </SidebarNavButton>
            </SidebarMenuItem>
          );
        })}
        <MenuLink
          to="/tasks/projects"
          icon={FolderOpen}
          title={projects.length ? "Все проекты" : "Проекты"}
          active={
            location.pathname === "/tasks/projects" || location.pathname === "/tasks/projects/"
          }
          onNavigate={onNavigate}
        />
      </SidebarNavGroup>
      {saved.length > 0 && (
        <SidebarNavGroup id="tasks-filters" label="Мои фильтры">
          {saved.map((f) => (
            <ContextMenu key={f.id}>
              <ContextMenuTrigger asChild>
                <MenuLink
                  to={TASKS_URL}
                  search={f.params}
                  icon={Filter}
                  title={f.name}
                  active={onList && same(current, f.params)}
                  onNavigate={onNavigate}
                />
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
        </SidebarNavGroup>
      )}
    </SidebarContent>
  );
}
