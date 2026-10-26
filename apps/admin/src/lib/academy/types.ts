/**
 * «Академия» — типы строк и ответов RPC
 * (db/migrations/2026-10-25_zzzzzzz_academy.sql).
 */

export type AcadCourseStatus = "draft" | "published" | "archived";
export type AcadStepKind = "lesson" | "quiz";
export type AcadQuestionKind = "single" | "multiple" | "open";
export type AcadAttemptStatus = "review" | "passed" | "failed";
/** Ход ученика по курсу. */
export type AcadProgressStatus = "not_started" | "in_progress" | "review" | "completed";
/** Шаг у ученика: урок — done/todo, тест — passed/review/failed/todo. */
export type AcadStepState = "todo" | "done" | "passed" | "review" | "failed";

export type AcadAccessInfo = {
  is_admin: boolean;
  can_create: boolean;
  can_review: boolean;
  /** Назначенных опубликованных курсов. */
  my_courses: number;
  /** Из них не пройдено. */
  my_open: number;
  /** Попыток ждут проверки (проверяющему). */
  to_review: number;
};

export type AcadFolder = { id: string; title: string; sort_order: number };

export type AcadCourse = {
  id: string;
  folder_id: string | null;
  title: string;
  description: string;
  cover: string | null;
  status: AcadCourseStatus;
  sequential: boolean;
  pass_percent: number;
  /** Срок по умолчанию для новых назначений — дней с назначения. */
  default_due_days: number | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export type AcadStep = {
  id: string;
  course_id: string;
  kind: AcadStepKind;
  title: string;
  sort_order: number | null;
  source_node_id: string | null;
  source_published_at: string | null;
  pass_percent: number | null;
  content_updated_at: string | null;
  questions_updated_at: string | null;
  created_at: string;
};

export type AcadOption = { id: string; text: string; correct: boolean };

export type AcadQuestion = {
  id: string;
  step_id: string;
  sort_order: number | null;
  kind: AcadQuestionKind;
  text: string;
  options: AcadOption[];
  points: number;
  allow_file: boolean;
  explanation: string;
  /** Свободный ответ: эталон и критерии — только проверяющему. */
  review_notes: string;
};

export type AcadAssignment = {
  id: string;
  course_id: string;
  /**
   * user — человек; role — роль в клубах (owner/admin/trainer); access_role
   * — роль портала; unit — подразделение (with_subunits — и ниже); position —
   * должность (ACCESS.md).
   */
  subject_type: "user" | "role" | "access_role" | "unit" | "position";
  user_id: string | null;
  role: "owner" | "admin" | "trainer" | null;
  studio_ids: string[];
  access_role_id: string | null;
  unit_id: string | null;
  position_id: string | null;
  with_subunits: boolean;
  due_date: string | null;
  due_days: number | null;
  created_at: string;
};

export type AcadStaffPerson = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  email: string | null;
  roles: { role: "owner" | "admin" | "trainer"; studio_id: string }[];
  /** Должность, подразделения (с путём — для «и ниже») и действующие роли портала. */
  position_id: string | null;
  units: { unit_id: string; path: string[]; member_role: string }[];
  access_role_ids: string[];
};

export type AcadMyCourse = {
  course_id: string;
  title: string;
  description: string;
  cover: string | null;
  folder_title: string | null;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps_total: number;
  steps_done: number;
  status: AcadProgressStatus;
  overdue: boolean;
};

export type AcadViewStep = {
  id: string;
  kind: AcadStepKind;
  title: string;
  state: AcadStepState;
  attempts: number;
  last_attempt_id: string | null;
  last_percent: number | null;
  questions: number;
  pass_percent: number | null;
  locked: boolean;
};

export type AcadCourseView = {
  course: {
    id: string;
    title: string;
    description: string;
    cover: string | null;
    status: AcadCourseStatus;
    sequential: boolean;
    pass_percent: number;
    folder_title: string | null;
  };
  /** Курс назначен — прохождение; иначе просмотр команды. */
  learner: boolean;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  overdue: boolean;
  steps: AcadViewStep[];
};

/** Вопрос ученику — без отметок «верный». */
export type AcadQuizQuestion = {
  id: string;
  kind: AcadQuestionKind;
  text: string;
  points: number;
  allow_file: boolean;
  options: { id: string; text: string }[];
};

export type AcadQuiz = {
  step_id: string;
  title: string;
  total: number;
  preview: boolean;
  pass_percent: number;
  questions: AcadQuizQuestion[];
};

export type AcadAnswerInput = {
  question_id: string;
  options?: string[];
  text?: string;
  file?: string | null;
};

export type AcadAttemptAnswer = {
  id: string;
  question_id: string | null;
  question: {
    kind: AcadQuestionKind;
    text: string;
    /** У ученика отметок верных нет там, где он ошибся. */
    options: { id: string; text: string; correct?: boolean }[];
    points: number;
    explanation: string;
    allow_file?: boolean;
  };
  answer: { options?: string[]; text?: string; file?: string | null };
  correct: boolean | null;
  score: number | null;
  comment: string;
  carried: boolean;
};

export type AcadAttempt = {
  id: string;
  status: AcadAttemptStatus;
  attempt_no: number;
  score: number;
  max_score: number;
  percent: number;
  pass_percent: number;
  submitted_at: string;
  reviewed_at: string | null;
  review_comment: string;
  reviewed_by_name: string | null;
  user_id: string;
  user_name: string | null;
  course_id: string;
  course_title: string | null;
  step_id: string;
  step_title: string | null;
  /** Команда видит верные варианты везде. */
  full: boolean;
  answers: AcadAttemptAnswer[];
};

export type AcadReviewItem = {
  attempt_id: string;
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  course_id: string;
  course_title: string;
  step_title: string;
  attempt_no: number;
  submitted_at: string;
  open_answers: number;
};

export type AcadReportRow = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  assigned_at: string;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  steps_total: number;
  steps_done: number;
  attempts: number;
  avg_percent: number | null;
  status: AcadProgressStatus;
  overdue: boolean;
};

export type AcadQuestionStat = {
  question_id: string;
  step_id: string;
  step_title: string;
  text: string;
  kind: AcadQuestionKind;
  answers: number;
  wrong: number;
  people: number;
};

export type AcadOverviewRow = {
  course_id: string;
  title: string;
  status: AcadCourseStatus;
  folder_id: string | null;
  learners: number;
  completed: number;
  in_progress: number;
  not_started: number;
  review: number;
  overdue: number;
};

export type AcadPeopleRow = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  courses: number;
  completed: number;
  in_progress: number;
  not_started: number;
  review: number;
  overdue: number;
  last_activity_at: string | null;
};

export type AcadPerson = {
  user_id: string;
  full_name: string | null;
  courses: {
    course_id: string;
    title: string;
    status: AcadProgressStatus;
    overdue: boolean;
    due_date: string | null;
    started_at: string | null;
    completed_at: string | null;
    steps_total: number;
    steps_done: number;
    avg_percent: number | null;
  }[];
  attempts: {
    id: string;
    course_title: string;
    step_title: string;
    attempt_no: number;
    status: AcadAttemptStatus;
    percent: number;
    submitted_at: string;
  }[];
};

export type AcadSource = {
  step_id: string;
  node_id: string;
  base_id: string;
  node_title: string;
  published_at: string | null;
  /** Статья опубликована и база открыта вызывающему — можно «Обновить». */
  available: boolean;
};
