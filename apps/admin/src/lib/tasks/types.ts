/** Задачи портала — то, что отдают RPC `task_*` (db/migrations/2026-11-08_zz_tasks.sql). */

export type TaskStatus = "new" | "in_progress" | "review" | "done" | "deferred" | "cancelled";
export type MemberRole = "creator" | "assignee" | "coassignee" | "watcher";
/**
 * manager — руководитель участника, владелец или модератор проекта задачи,
 * «Администратор задач»: правит как постановщик; project — участник проекта
 * задачи: видит её; parent — постановщик или исполнитель родительской задачи:
 * видит подзадачу.
 */
export type TaskRole = MemberRole | "manager" | "project" | "parent";
export type TaskNotify = "all" | "mine" | "none";
export type DeadlineRule = "free" | "reason" | "forbid";

export type TaskMember = { user_id: string; role: MemberRole };

export type TaskRow = {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  urgent: boolean;
  deadline: string | null;
  requires_review: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  batch_id: string | null;
  chat_id: string | null;
  project_id: string | null;
  stage_id: string | null;
  recurrence_id: string | null;
  project: ProjectBrief | null;
  members: TaskMember[];
  my_roles: TaskRole[];
  notify: TaskNotify;
  unseen: boolean;
  check_total: number;
  check_done: number;
  files_count: number;
  batch?: { total: number; done: number; cancelled: number; overdue: number };
  /** Подзадача: родительская задача. */
  parent_id: string | null;
  parent_number: number | null;
  subtasks_total: number;
  subtasks_done: number;
  /** «Нужен результат» — завершить только с результатом. */
  result_required: boolean;
  has_result: boolean;
};

/** Подзадача и родительская задача в карточке. */
export type TaskBrief = {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  deadline: string | null;
  urgent: boolean;
  assignee_id: string | null;
};

export type ChecklistItem = {
  id: string;
  text: string;
  assignee_id: string | null;
  done_at: string | null;
  done_by: string | null;
};

export type Checklist = { id: string; title: string; items: ChecklistItem[] };

export type TaskFile = {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  created_at: string;
};

export type TaskReminder = {
  id: string;
  remind_at: string;
  before_minutes: number | null;
  sent_at: string | null;
};

export type TaskFull = TaskRow & {
  description: unknown[] | null;
  deadline_rule: DeadlineRule;
  checklists: Checklist[];
  files: TaskFile[];
  reminders: TaskReminder[];
  result: { text: string; by: string | null; at: string } | null;
  /** Родительская; hidden — человек её не видит (только номер). */
  parent: TaskBrief | { number: number; hidden: true } | null;
  subtasks: TaskBrief[];
  /** Задача из сообщения — участнику того чата. */
  source: { chat_id: string; seq: number } | null;
};

export type TaskEvent = {
  id: number;
  actor_id: string | null;
  kind: string;
  data: Record<string, unknown>;
  reason: string | null;
  created_at: string;
};

export type TaskCounters = {
  overdue: number;
  review: number;
  unseen: number;
  badge: number;
  /** Руководитель или заместитель подразделения — пункт «Подчинённые». */
  leader?: boolean;
};

export type TaskSort = "deadline" | "urgent" | "created";

/** Вкладки «Мои задачи» (роль в задаче). */
export type RoleTab = "do" | "help" | "assigned" | "watch" | "all";

/** Фильтры списка — в адресе и в сохранённых фильтрах. */
export type TaskFilters = {
  role?: RoleTab;
  status?: TaskStatus[];
  deadline?: "overdue" | "today" | "week" | "none" | "range";
  dfrom?: string;
  dto?: string;
  creator?: string;
  assignee?: string;
  cfrom?: string;
  cto?: string;
  q?: string;
  done?: boolean;
  mine?: boolean;
  all?: boolean;
  /** Задачи проекта (его участникам). */
  project?: string;
  /** Задачи людей моих подразделений («Подчинённые»). */
  team?: boolean;
  /** Порядок: по сроку (по умолчанию), срочные первыми, новые первыми. */
  sort?: TaskSort;
};

// ---- Проекты (веха 4) ----------------------------------------------------------

export type ProjectBrief = { id: string; title: string; color: string | null };
export type ProjectKind = "department" | "city" | "project";
export type ProjectRole = "owner" | "moderator" | "member";

export type Project = ProjectBrief & {
  description: string | null;
  kind: ProjectKind;
  visibility: "closed" | "open";
  deadline_rule: DeadlineRule;
  requires_review: boolean;
  unit_id: string | null;
  unit_scope: "all" | "heads";
  with_subunits: boolean;
  chat_id: string | null;
  archived_at: string | null;
  created_at: string;
  my_role: ProjectRole | null;
  can_manage: boolean;
  member_count: number;
  open_count: number;
  overdue_count: number;
};

export type ProjectFull = Project & {
  members: { user_id: string; role: ProjectRole; source: "manual" | "unit" }[];
  stages: { id: string; title: string }[];
};

export type Subordinate = {
  user_id: string;
  open_count: number;
  overdue_count: number;
  review_count: number;
  done_week: number;
};

/** Поля новой задачи в шаблоне. */
export type TemplateTask = {
  title: string;
  description?: unknown[] | null;
  assignees?: string[];
  mode?: "shared" | "separate";
  coassignees?: string[];
  watchers?: string[];
  checklists?: { title: string; items: { text: string; assignee_id?: string | null }[] }[];
  urgent?: boolean;
  requires_review?: boolean;
  /** Срок — через N рабочих дней (null — без срока). */
  deadline_days?: number | null;
  deadline_time?: string | null;
};

export type TaskTemplate = {
  id: string;
  name: string;
  scope: "personal" | "project" | "shared";
  project_id: string | null;
  project: ProjectBrief | null;
  owner_id: string | null;
  task: TemplateTask;
  updated_at: string;
  can_edit: boolean;
};

export type RecurrenceRule =
  | { freq: "daily" }
  | { freq: "workdays" }
  | { freq: "weekly"; weekdays: number[] }
  | { freq: "monthly"; monthday: number }
  | { freq: "after_close"; after_days: number };

export type Recurrence = {
  id: string;
  template_id: string;
  template_name: string;
  title: string;
  rule: RecurrenceRule;
  at_time: string;
  tz: string;
  mode: "wait" | "skip";
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  last_task: { number: number; status: TaskStatus } | null;
};

export type SavedFilter = { id: string; name: string; params: TaskFilters; sort_order: number };

/** «Мой план» — личная доска (task_plan_get). */
export type PlanColumn = { id: string; title: string };
export type PlanCard = {
  /** null — «Не разобрано». */
  column_id: string | null;
  sort_order: number;
  /** Добавлена в план вручную (не по роли исполнителя / соисполнителя). */
  added: boolean;
  task: TaskRow;
};
export type TaskPlan = { columns: PlanColumn[]; cards: PlanCard[] };
