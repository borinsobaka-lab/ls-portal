/**
 * Строка табов плашки на страницах задач (UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 2.3): переключатель вида «Список · Сроки · Мой план» — одни и те же задачи
 * тремя способами — и, где он нужен, роль «Делаю / Помогаю / Поручил /
 * Наблюдаю / Все мои» (один набор `ROLE_TABS` на всех страницах).
 */
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { ROLE_TABS, TASK_VIEWS, type TaskView } from "@/lib/tasks/logic";
import type { RoleTab } from "@/lib/tasks/types";

export function TasksViewTabs({
  view,
  role,
  onRole,
  extra,
}: {
  view: TaskView;
  /** Роль — показать переключатель ролей (на «Моём плане» его нет). */
  role?: RoleTab;
  onRole?: (r: RoleTab) => void;
  extra?: ReactNode;
}) {
  const navigate = useNavigate();
  // Роль переезжает между «Списком» и «Сроками»; у каждого своя по умолчанию.
  const go = (v: TaskView) => {
    if (v === view) return;
    if (v === "list")
      void navigate({ to: "/tasks", search: role && role !== "all" ? { role } : {} });
    else if (v === "deadlines")
      void navigate({ to: "/tasks/deadlines", search: role && role !== "do" ? { role } : {} });
    else void navigate({ to: "/tasks/plan", search: {} });
  };
  return (
    <div className="flex items-center gap-3">
      <SegmentedControl
        aria-label="Вид задач"
        value={view}
        onChange={go}
        options={TASK_VIEWS.map((v) => ({ value: v.key, label: v.title }))}
      />
      {role && onRole && (
        <SegmentedControl
          aria-label="Моя роль в задаче"
          value={role}
          onChange={onRole}
          options={ROLE_TABS.map((t) => ({ value: t.key, label: t.title, title: t.hint }))}
        />
      )}
      {extra}
    </div>
  );
}
