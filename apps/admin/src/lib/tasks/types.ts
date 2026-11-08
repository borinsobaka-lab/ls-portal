/** Задачи портала — то, что отдают RPC `task_*` (db/migrations/2026-11-08_zz_tasks.sql). */

export type TaskStatus = "new" | "in_progress" | "review" | "done" | "deferred" | "cancelled";
export type MemberRole = "creator" | "assignee" | "coassignee" | "watcher";
/** manager — руководитель участника или «Администратор задач»: правит как постановщик. */
export type TaskRole = MemberRole | "manager";
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
  members: TaskMember[];
  my_roles: TaskRole[];
  notify: TaskNotify;
  unseen: boolean;
  check_total: number;
  check_done: number;
  files_count: number;
  batch?: { total: number; done: number; cancelled: number; overdue: number };
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
};

export type TaskEvent = {
  id: number;
  actor_id: string | null;
  kind: string;
  data: Record<string, unknown>;
  reason: string | null;
  created_at: string;
};

export type TaskCounters = { overdue: number; review: number; unseen: number; badge: number };

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
};

export type SavedFilter = { id: string; name: string; params: TaskFilters; sort_order: number };
