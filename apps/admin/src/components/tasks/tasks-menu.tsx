/**
 * Меню раздела «Задачи» — только навигация (UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 2.3): первой строкой «Новая задача»; «Мои задачи» — «Сегодня» (делаю,
 * срок сегодня), роли «Делаю / Помогаю / Поручил / Наблюдаю / Все мои» и у
 * руководителей «Подчинённые»; «Проекты» — мои цветными точками и «Все
 * проекты»; «Мои фильтры» — у каждого «⋯» (переименовать, удалить);
 * «Настройки» — «Шаблоны», «Регулярные». Вид «Список · Сроки · Мой план» —
 * переключатель на самой странице.
 */
import { lazy, Suspense, useState, type ComponentProps } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import {
  AddCircle,
  CalendarDate,
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
  type NavIcon,
} from "@/components/nav-icons";
import {
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavGroup,
  SIDEBAR_NAV_LINK_CLASS,
} from "@/components/sidebar-nav";
import { TaskMenu } from "@/components/tasks/task-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { TASKS_URL } from "@/lib/nav-sections";
import {
  taskAction,
  taskErrorText,
  taskFiltersQuery,
  useMyProjects,
  useTaskCounters,
} from "@/lib/tasks/data";
import { cleanFilters, ROLE_TABS, TODAY_PRESET } from "@/lib/tasks/logic";
import type { RoleTab, SavedFilter, TaskFilters } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

// Форма постановки — отдельным куском: меню живёт в общем каркасе.
const NewTaskDialog = lazy(() =>
  import("@/components/tasks/task-form").then((m) => ({ default: m.NewTaskDialog })),
);

// Иконки — Solar, как во всех меню второго уровня (`sidebar-nav.tsx`).
const ROLE_ICONS: Record<RoleTab, NavIcon> = {
  do: UserCheckRounded,
  help: UsersGroupTwoRounded,
  assigned: Plain,
  watch: Eye,
  all: ClipboardList,
};

const norm = (f: TaskFilters) => {
  const c = cleanFilters({ ...f, role: f.role === "all" ? undefined : f.role });
  return JSON.stringify(c, Object.keys(c).sort());
};
const same = (a: TaskFilters, b: TaskFilters) => norm(a) === norm(b);

function MenuLink({
  to,
  search,
  icon,
  title,
  hint,
  active,
  count,
  tone = "urgent",
  onNavigate,
  ...item
}: Omit<ComponentProps<typeof SidebarMenuItem>, "title"> & {
  to: string;
  search?: TaskFilters;
  icon: NavIcon;
  title: string;
  /** Всплывающая подпись (что значит счётчик). */
  hint?: string;
  active: boolean;
  count?: number;
  tone?: "urgent" | "quiet";
  onNavigate?: () => void;
}) {
  return (
    <SidebarMenuItem {...item}>
      <SidebarNavButton active={active}>
        <Link
          to={to}
          search={search ?? {}}
          onClick={onNavigate}
          title={hint}
          aria-label={hint}
          className={SIDEBAR_NAV_LINK_CLASS}
        >
          <SidebarNavContent
            icon={icon}
            active={active}
            title={title}
            badge={count}
            badgeTone={tone}
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
  const { confirm, confirmDialog } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SavedFilter | null>(null);
  const location = useRouterState({ select: (s) => s.location });
  const path = location.pathname.replace(/\/$/, "");
  const onList = path === TASKS_URL;
  const search = (location.search ?? {}) as TaskFilters & { task?: number };
  const { task: _task, ...current } = search;
  void _task;

  const countOf = (key: RoleTab) =>
    key === "do"
      ? { count: counters.overdue, hint: counters.overdue ? `Просрочено: ${counters.overdue}` : "" }
      : key === "assigned"
        ? {
            count: counters.review,
            hint: counters.review ? `Ждут проверки: ${counters.review}` : "",
          }
        : { count: 0, hint: "" };

  return (
    <SidebarContent aria-label="Задачи" className="sidebar-scroll gap-1">
      <SidebarGroup className="py-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarNavButton active={false}>
              <button
                type="button"
                className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full text-left")}
                onClick={() => setCreating(true)}
              >
                <SidebarNavContent icon={AddCircle} active={false} title="Новая задача" />
              </button>
            </SidebarNavButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarNavGroup id="tasks-roles" label="Мои задачи">
        <MenuLink
          to={TASKS_URL}
          search={TODAY_PRESET}
          icon={CalendarDate}
          title="Сегодня"
          hint="Делаю, срок — сегодня"
          active={onList && same(current, TODAY_PRESET)}
          onNavigate={onNavigate}
        />
        {ROLE_TABS.map((t) => {
          const filters: TaskFilters = t.key === "all" ? {} : { role: t.key };
          const c = countOf(t.key);
          return (
            <MenuLink
              key={t.key}
              to={TASKS_URL}
              search={filters}
              icon={ROLE_ICONS[t.key]}
              title={t.title}
              hint={c.hint ? `${t.title} · ${c.hint}` : t.hint}
              active={onList && !current.team && same(current, filters)}
              count={c.count}
              tone={t.key === "assigned" ? "quiet" : "urgent"}
              onNavigate={onNavigate}
            />
          );
        })}
        {counters.leader && (
          <MenuLink
            to="/tasks/team"
            icon={Structure}
            title="Подчинённые"
            hint="Задачи людей моих подразделений"
            active={path === "/tasks/team" || (onList && !!current.team)}
            onNavigate={onNavigate}
          />
        )}
      </SidebarNavGroup>

      <SidebarNavGroup id="tasks-projects" label="Проекты">
        {projects.map((p) => {
          const active = path === `/tasks/projects/${p.id}`;
          return (
            <SidebarMenuItem key={p.id}>
              {/* У проекта вместо иконки — точка его цвета, свечение того же цвета. */}
              <SidebarNavButton active={active}>
                <Link
                  to="/tasks/projects/$projectId"
                  params={{ projectId: p.id }}
                  onClick={onNavigate}
                  title={p.overdue_count ? `Просрочено: ${p.overdue_count}` : undefined}
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
          active={path === "/tasks/projects"}
          onNavigate={onNavigate}
        />
      </SidebarNavGroup>

      {saved.length > 0 && (
        <SidebarNavGroup id="tasks-filters" label="Мои фильтры">
          {saved.map((f) => (
            <SidebarMenuItem key={f.id}>
              <SidebarNavButton active={onList && same(current, f.params)} className="pr-8">
                <Link
                  to={TASKS_URL}
                  search={f.params}
                  onClick={onNavigate}
                  className={SIDEBAR_NAV_LINK_CLASS}
                >
                  <SidebarNavContent
                    icon={Filter}
                    active={onList && same(current, f.params)}
                    title={f.name}
                  />
                </Link>
              </SidebarNavButton>
              <TaskMenu
                label={`Фильтр «${f.name}»`}
                trigger={
                  <SidebarMenuAction
                    showOnHover
                    className="text-white/60 hover:bg-white/10 hover:text-white pointer-coarse:opacity-100"
                    aria-label={`Фильтр «${f.name}»: действия`}
                    title="Действия"
                  >
                    <MoreHorizontal />
                  </SidebarMenuAction>
                }
                items={[
                  { label: "Переименовать", icon: Pencil, run: () => setRenaming(f) },
                  "separator",
                  {
                    label: "Удалить фильтр",
                    icon: Trash2,
                    danger: true,
                    run: async () => {
                      const ok = await confirm({
                        title: `Удалить фильтр «${f.name}»?`,
                        description: "Задачи не изменятся — пропадёт только пункт меню.",
                        confirmLabel: "Удалить",
                      });
                      if (!ok) return;
                      void taskAction(qc, "task_filter_delete", { p_id: f.id })
                        .then(() => toast.success("Фильтр удалён"))
                        .catch((e) => toast.error(taskErrorText(e)));
                    },
                  },
                ]}
              />
            </SidebarMenuItem>
          ))}
        </SidebarNavGroup>
      )}

      <SidebarNavGroup id="tasks-settings" label="Настройки">
        <MenuLink
          to="/tasks/templates"
          icon={Copy}
          title="Шаблоны"
          hint="Заготовки задач"
          active={path === "/tasks/templates"}
          onNavigate={onNavigate}
        />
        <MenuLink
          to="/tasks/recurring"
          icon={Repeat}
          title="Регулярные"
          hint="Задачи по расписанию"
          active={path === "/tasks/recurring"}
          onNavigate={onNavigate}
        />
      </SidebarNavGroup>

      {creating && (
        <Suspense fallback={null}>
          <NewTaskDialog open onClose={() => setCreating(false)} />
        </Suspense>
      )}
      <RenameFilterDialog filter={renaming} onClose={() => setRenaming(null)} />
      {confirmDialog}
    </SidebarContent>
  );
}

function RenameFilterDialog({
  filter,
  onClose,
}: {
  filter: SavedFilter | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!filter} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {filter && <RenameFilterForm key={filter.id} filter={filter} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameFilterForm({ filter, onClose }: { filter: SavedFilter; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(filter.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!name.trim()) {
          setError("Назовите фильтр");
          return;
        }
        setBusy(true);
        try {
          await taskAction(qc, "task_filter_save", {
            p_id: filter.id,
            p_name: name.trim(),
            p_params: filter.params,
          });
          toast.success("Фильтр переименован");
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Переименовать фильтр</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <FormField label="Название" required error={error}>
          <Input
            autoFocus
            maxLength={60}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
