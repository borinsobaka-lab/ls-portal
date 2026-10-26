-- ============================================================================
-- «Академия» — правки по тестированию 2026-10-25 (ACADEMY.md, «Правки после
-- тестирования»).
--
-- * acad_courses.default_due_days — срок курса по умолчанию («N дней с
--   назначения»): окно назначения подставляет его само, чтобы при
--   назначении частями не выставлять срок каждый раз. У самих назначений
--   срок по-прежнему свой (acad_assignments.due_date / due_days); правка
--   умолчания прежние назначения не меняет.
-- * acad_questions.review_notes — эталонный ответ и критерии для
--   проверяющего у свободного ответа. Ученику не уходит: acad_quiz_start
--   отдаёт поля вопроса поимённо, снимок вопроса в acad_answers (его видит
--   ученик через acad_attempt) собирается тоже поимённо и заметки не
--   включает, таблица вопросов ученику закрыта. Проверяющий читает их из
--   acad_questions (команда читает таблицу под RLS).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.acad_courses
  add column if not exists default_due_days integer
    check (default_due_days is null or default_due_days between 1 and 365);

alter table public.acad_questions
  add column if not exists review_notes text not null default ''
    check (char_length(review_notes) <= 2000);
