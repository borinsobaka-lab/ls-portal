/**
 * «Академия» — загрузка (React Query + Supabase). Все ключи начинаются с
 * ACAD_KEY: после любой записи достаточно сбросить ["acad"]. Команда
 * (создатели и проверяющие) читает таблицы напрямую под RLS, ученик — только
 * через RPC (вопросы с отметками верных ему закрыты).
 * Схема — db/migrations/2026-10-25_zzzzzzz_academy.sql.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import type {
  AcadAccessInfo,
  AcadAssignment,
  AcadAttempt,
  AcadCourse,
  AcadCourseView,
  AcadFolder,
  AcadMyCourse,
  AcadOverviewRow,
  AcadPeopleRow,
  AcadPerson,
  AcadQuestion,
  AcadQuestionStat,
  AcadQuiz,
  AcadReportRow,
  AcadReviewItem,
  AcadSource,
  AcadStaffPerson,
  AcadStep,
} from "./types";

export const ACAD_KEY = "acad";

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Сбросить всё «Академии» после записи. */
export function invalidateAcademy(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: [ACAD_KEY] });
}

/** Свои права и счётчики (рейка, меню); заранее грузит проверка входа. */
export const acadAccessQuery = queryOptions({
  queryKey: [ACAD_KEY, "access"],
  queryFn: () => rpc<AcadAccessInfo>("acad_access"),
  staleTime: 60_000,
  refetchInterval: 120_000,
  meta: { errorMessage: "Не удалось загрузить права в «Академии»" },
});

export const acadFoldersQuery = queryOptions({
  queryKey: [ACAD_KEY, "folders"],
  queryFn: () =>
    unwrap<AcadFolder[]>(
      supabase
        .from("acad_folders")
        .select("id, title, sort_order")
        .order("sort_order")
        .order("created_at"),
    ),
  meta: { errorMessage: "Не удалось загрузить папки курсов" },
});

const COURSE_COLUMNS =
  "id, folder_id, title, description, cover, status, sequential, pass_percent, default_due_days, sort_order, created_at, updated_at, published_at";

export const acadCoursesQuery = queryOptions({
  queryKey: [ACAD_KEY, "courses"],
  queryFn: () =>
    unwrap<AcadCourse[]>(
      supabase.from("acad_courses").select(COURSE_COLUMNS).order("sort_order").order("created_at"),
    ),
  meta: { errorMessage: "Не удалось загрузить курсы" },
});

export function acadCourseQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "course", courseId],
    queryFn: () =>
      unwrap<AcadCourse>(
        supabase.from("acad_courses").select(COURSE_COLUMNS).eq("id", courseId).single(),
      ),
    meta: { errorMessage: "Не удалось загрузить курс" },
  });
}

const STEP_COLUMNS =
  "id, course_id, kind, title, sort_order, source_node_id, source_published_at, pass_percent, content_updated_at, questions_updated_at, created_at";

export function acadStepsQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "steps", courseId],
    queryFn: () =>
      unwrap<AcadStep[]>(
        supabase
          .from("acad_steps")
          .select(STEP_COLUMNS)
          .eq("course_id", courseId)
          .order("sort_order")
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить шаги курса" },
  });
}

/** Текст урока — для конструктора (ученик берёт его через acad_lesson). */
export function acadStepContentQuery(stepId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "step-content", stepId],
    queryFn: async () => {
      const row = await unwrap<{ content: unknown[] | null }>(
        supabase.from("acad_steps").select("content").eq("id", stepId).single(),
      );
      return row.content ?? [];
    },
    // Пока урок открыт в редакторе, свежая копия с сервера затёрла бы правки.
    staleTime: Infinity,
    meta: { errorMessage: "Не удалось загрузить урок" },
  });
}

export function acadQuestionsQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "questions", courseId],
    queryFn: () =>
      unwrap<AcadQuestion[]>(
        supabase
          .from("acad_questions")
          .select(
            "id, step_id, sort_order, kind, text, options, points, allow_file, explanation, review_notes",
          )
          .eq("course_id", courseId)
          .order("sort_order")
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить вопросы" },
  });
}

export function acadAssignmentsQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "assignments", courseId],
    queryFn: () =>
      unwrap<AcadAssignment[]>(
        supabase
          .from("acad_assignments")
          .select(
            "id, course_id, subject_type, user_id, role, studio_ids, access_role_id, unit_id, position_id, with_subunits, due_date, due_days, created_at",
          )
          .eq("course_id", courseId)
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить назначения" },
  });
}

export function acadSourcesQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "sources", courseId],
    queryFn: () => rpc<AcadSource[]>("acad_course_sources", { p_course: courseId }),
    meta: { errorMessage: "Не удалось проверить статьи уроков" },
  });
}

export const acadStaffQuery = queryOptions({
  queryKey: [ACAD_KEY, "staff"],
  queryFn: () => rpc<AcadStaffPerson[]>("acad_staff_directory"),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить сотрудников" },
});

export const acadMyCoursesQuery = queryOptions({
  queryKey: [ACAD_KEY, "my"],
  queryFn: () => rpc<AcadMyCourse[]>("acad_my_courses"),
  meta: { errorMessage: "Не удалось загрузить ваши курсы" },
});

export function acadCourseViewQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "view", courseId],
    queryFn: () => rpc<AcadCourseView>("acad_course_view", { p_course: courseId }),
    meta: { errorMessage: "Не удалось открыть курс" },
  });
}

export function acadLessonQuery(stepId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "lesson", stepId],
    queryFn: () =>
      rpc<{ id: string; title: string; content: unknown[] | null; course_id: string }>(
        "acad_lesson",
        {
          p_step: stepId,
        },
      ),
    meta: { errorMessage: "Не удалось открыть урок" },
  });
}

export function acadQuizQuery(stepId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "quiz", stepId],
    queryFn: () => rpc<AcadQuiz>("acad_quiz_start", { p_step: stepId }),
    // Ответы набираются долго: фоновое обновление сбросило бы набор вопросов.
    staleTime: Infinity,
    retry: false,
  });
}

export function acadAttemptQuery(attemptId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "attempt", attemptId],
    queryFn: () => rpc<AcadAttempt>("acad_attempt", { p_attempt: attemptId }),
    meta: { errorMessage: "Не удалось загрузить ответы" },
  });
}

export const acadReviewQueueQuery = queryOptions({
  queryKey: [ACAD_KEY, "review-queue"],
  queryFn: () => rpc<AcadReviewItem[]>("acad_review_queue"),
  meta: { errorMessage: "Не удалось загрузить ответы на проверку" },
});

export function acadCourseReportQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "report", courseId],
    queryFn: () => rpc<AcadReportRow[]>("acad_course_report", { p_course: courseId }),
    meta: { errorMessage: "Не удалось загрузить ход курса" },
  });
}

export function acadQuestionStatsQuery(courseId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "question-stats", courseId],
    queryFn: () => rpc<AcadQuestionStat[]>("acad_question_stats", { p_course: courseId }),
    meta: { errorMessage: "Не удалось загрузить разбор ошибок" },
  });
}

export const acadOverviewQuery = queryOptions({
  queryKey: [ACAD_KEY, "overview"],
  queryFn: () => rpc<AcadOverviewRow[]>("acad_overview"),
  meta: { errorMessage: "Не удалось загрузить отчёт по курсам" },
});

export const acadPeopleQuery = queryOptions({
  queryKey: [ACAD_KEY, "people"],
  queryFn: () => rpc<AcadPeopleRow[]>("acad_people_overview"),
  meta: { errorMessage: "Не удалось загрузить отчёт по сотрудникам" },
});

export function acadPersonQuery(userId: string) {
  return queryOptions({
    queryKey: [ACAD_KEY, "person", userId],
    queryFn: () => rpc<AcadPerson>("acad_person", { p_user: userId }),
    meta: { errorMessage: "Не удалось загрузить обучение сотрудника" },
  });
}

/** Папка файлов курса в бакете kb-media (уроки, обложка). */
export const acadCourseFolder = (courseId: string) => `academy/${courseId}`;
/** Папка файлов к ответам ученика. */
export const acadAnswersFolder = (userId: string) => `academy/answers/${userId}`;

/**
 * Эталон и критерии свободных ответов — проверяющему (команда читает
 * acad_questions под RLS; ученику ни таблица, ни заметки не уходят).
 */
export function acadReviewNotesQuery(questionIds: string[]) {
  return queryOptions({
    queryKey: [ACAD_KEY, "review-notes", questionIds.join(",")],
    queryFn: async () => {
      const rows = await unwrap<{ id: string; review_notes: string }[]>(
        supabase.from("acad_questions").select("id, review_notes").in("id", questionIds),
      );
      return new Map(rows.filter((r) => r.review_notes).map((r) => [r.id, r.review_notes]));
    },
    enabled: questionIds.length > 0,
    meta: { errorMessage: "Не удалось загрузить критерии проверки" },
  });
}
