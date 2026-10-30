/**
 * «Академия» без React: подписи, проверка вопроса в форме, готовность ответов,
 * сроки и напоминания конструктора (№65 брифа). Схема —
 * db/migrations/2026-10-25_zzzzzzz_academy.sql.
 */
import type { StatusTone } from "@/components/ui/status-chip-styles";
import type {
  AcadAnswerInput,
  AcadAssignment,
  AcadAttemptStatus,
  AcadCourseStatus,
  AcadOption,
  AcadProgressStatus,
  AcadQuestionKind,
  AcadQuizQuestion,
  AcadSource,
  AcadStaffPerson,
  AcadStep,
  AcadStepState,
} from "./types";

export const COURSE_STATUS_LABEL: Record<AcadCourseStatus, string> = {
  draft: "Черновик",
  published: "Опубликован",
  archived: "В архиве",
};
export const COURSE_STATUS_TONE: Record<AcadCourseStatus, StatusTone> = {
  draft: "warning",
  published: "positive",
  archived: "neutral",
};

export const PROGRESS_LABEL: Record<AcadProgressStatus, string> = {
  not_started: "Не начат",
  in_progress: "Проходит",
  review: "На проверке",
  completed: "Пройден",
};
export const PROGRESS_TONE: Record<AcadProgressStatus, StatusTone> = {
  not_started: "neutral",
  in_progress: "info",
  review: "warning",
  completed: "positive",
};

export const ATTEMPT_LABEL: Record<AcadAttemptStatus, string> = {
  review: "На проверке",
  passed: "Сдан",
  failed: "Не сдан",
};
export const ATTEMPT_TONE: Record<AcadAttemptStatus, StatusTone> = {
  review: "warning",
  passed: "positive",
  failed: "negative",
};

export const STEP_STATE_LABEL: Record<AcadStepState, string> = {
  todo: "Не пройден",
  done: "Пройден",
  passed: "Сдан",
  review: "На проверке",
  failed: "Не сдан",
};

export const QUESTION_KIND_LABEL: Record<AcadQuestionKind, string> = {
  single: "Один ответ",
  multiple: "Несколько ответов",
  open: "Свободный ответ",
};

/** Вид вопроса на телефоне — в переключателе окна вопроса полные не помещаются. */
export const QUESTION_KIND_SHORT: Record<AcadQuestionKind, string> = {
  single: "Один",
  multiple: "Несколько",
  open: "Свободный",
};

export const QUESTION_KIND_HINT: Record<AcadQuestionKind, string> = {
  single: "Ученик выбирает один вариант; верный — ровно один.",
  multiple:
    "Ученик отмечает все верные варианты; засчитывается, только если отмечены все и ничего лишнего.",
  open: "Ученик пишет ответ своими словами (можно с файлом); проверяет проверяющий.",
};

export const ROLE_LABEL: Record<"owner" | "admin" | "trainer", string> = {
  owner: "Владельцы",
  admin: "Администраторы",
  trainer: "Тренеры",
};

/** Шаг пройден для порядка курса (тест на проверке не держит следующий). */
export function stepCleared(state: AcadStepState): boolean {
  return state === "done" || state === "passed" || state === "review";
}

export function progressPercent(done: number, total: number): number {
  return total > 0 ? Math.round((done * 100) / total) : 0;
}

/** Новый вариант ответа. */
export function newOption(text = ""): AcadOption {
  return { id: crypto.randomUUID().slice(0, 8), text, correct: false };
}

/** Форма вопроса: текст ошибки (как проверит база) или null. */
export function questionError(q: {
  kind: AcadQuestionKind;
  text: string;
  options: AcadOption[];
}): string | null {
  if (!q.text.trim()) return "Напишите вопрос";
  if (q.kind === "open") return null;
  const options = q.options.filter((o) => o.text.trim());
  if (options.length !== q.options.length) return "Заполните все варианты или удалите пустые";
  if (options.length < 2) return "Нужно хотя бы два варианта";
  if (options.length > 20) return "Не больше 20 вариантов";
  const correct = options.filter((o) => o.correct).length;
  if (q.kind === "single" && correct !== 1) return "Отметьте один верный вариант";
  if (q.kind === "multiple" && correct < 1) return "Отметьте хотя бы один верный вариант";
  return null;
}

/** Ответ на вопрос дан (для кнопки «Отправить»). */
export function answerGiven(q: AcadQuizQuestion, a: AcadAnswerInput | undefined): boolean {
  if (!a) return false;
  if (q.kind === "open") return !!a.text?.trim() || !!a.file;
  const n = a.options?.length ?? 0;
  return q.kind === "single" ? n === 1 : n > 0;
}

/** Сколько вопросов без ответа. */
export function unanswered(
  questions: AcadQuizQuestion[],
  answers: Record<string, AcadAnswerInput>,
): number {
  return questions.filter((q) => !answerGiven(q, answers[q.id])).length;
}

/** Срок: «до 12.11.2026», «сегодня последний день», «просрочен на 3 дн.». */
export function dueLabel(
  due: string | null,
  today: string,
): { text: string; overdue: boolean } | null {
  if (!due) return null;
  // Дата без времени; сервер мог отдать и с ним.
  const day = due.slice(0, 10);
  const days = Math.round((Date.parse(day) - Date.parse(today.slice(0, 10))) / 86_400_000);
  const [y, m, d] = day.split("-");
  if (days < 0)
    return {
      text: `Просрочен на ${-days} ${plural(-days, ["день", "дня", "дней"])}`,
      overdue: true,
    };
  if (days === 0) return { text: "Сегодня последний день", overdue: false };
  return { text: `До ${d}.${m}.${y}`, overdue: false };
}

/** «1 урок», «2 урока», «5 уроков» — форма слова. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/**
 * Уроки из статей, у которых статья опубликована заново после копии —
 * «Статья изменилась, обновите урок».
 */
export function staleLessons(steps: AcadStep[], sources: AcadSource[]): Set<string> {
  const byStep = new Map(sources.map((s) => [s.step_id, s]));
  const out = new Set<string>();
  for (const step of steps) {
    const src = byStep.get(step.id);
    if (!src?.published_at || !step.source_published_at) continue;
    if (Date.parse(src.published_at) > Date.parse(step.source_published_at)) out.add(step.id);
  }
  return out;
}

/** Урок перед тестом, появившийся или изменившийся после правки его вопросов. */
export type RecheckLesson = { title: string; added: boolean };

/**
 * Тесты, после правки вопросов которых перед ними (до предыдущего теста)
 * добавили или изменили уроки — напомнить «проверьте вопросы» (№65:
 * напоминание, без запрета; снимает «Вопросы проверены»). Тест без вопросов
 * не напоминает — его и так нужно заполнить.
 */
export function quizzesToRecheck(
  steps: AcadStep[],
  questionCount: Record<string, number>,
): Map<string, RecheckLesson[]> {
  const out = new Map<string, RecheckLesson[]>();
  let lessons: AcadStep[] = [];
  for (const step of steps) {
    if (step.kind === "lesson") {
      lessons.push(step);
      continue;
    }
    const checked = step.questions_updated_at ? Date.parse(step.questions_updated_at) : 0;
    const changed = lessons.filter(
      (l) => l.content_updated_at && Date.parse(l.content_updated_at) > checked,
    );
    if ((questionCount[step.id] ?? 0) > 0 && changed.length) {
      out.set(
        step.id,
        changed.map((l) => ({ title: l.title, added: Date.parse(l.created_at) > checked })),
      );
    }
    lessons = [];
  }
  return out;
}

/** «После правки вопросов добавлен урок «А», изменился урок «Б»» — без хвоста. */
export function recheckText(list: RecheckLesson[]): string {
  const part = (items: RecheckLesson[], one: string, many: string) =>
    items.length
      ? `${items.length === 1 ? one : many} ${items.map((l) => `«${l.title}»`).join(", ")}`
      : "";
  const added = part(
    list.filter((l) => l.added),
    "добавлен урок",
    "добавлены уроки",
  );
  const changed = part(
    list.filter((l) => !l.added),
    "изменился урок",
    "изменились уроки",
  );
  return `После правки вопросов ${[added, changed].filter(Boolean).join(", ")}`;
}

/**
 * Что мешает ученикам пройти курс — предупреждение в окне публикации: курс
 * без шагов, тесты без вопросов (у ученика «Начать тест» не нажимается, а в
 * курсе «по порядку» дальше теста не пройти).
 */
export function publishIssues(
  steps: Pick<AcadStep, "id" | "kind" | "title">[],
  questionCount: Record<string, number>,
  sequential: boolean,
): string[] {
  if (steps.length === 0) return ["В курсе нет ни одного урока или теста."];
  const empty = steps.filter((s) => s.kind === "quiz" && !(questionCount[s.id] ?? 0));
  if (empty.length === 0) return [];
  const names = empty.map((s) => `«${s.title}»`).join(", ");
  return [
    `${empty.length === 1 ? "В тесте" : "В тестах"} ${names} нет вопросов — ученик не сможет ${
      empty.length === 1 ? "его" : "их"
    } сдать${sequential ? ", а курс проходится по порядку: дальше теста он не продвинется" : ""}.`,
  ];
}

/** Ссылки документа на статьи базы знаний (`/kb/…`) — у ученика без доступа к базе не откроются. */
export function kbLinkCount(doc: unknown): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "link" && typeof o.href === "string" && o.href.startsWith("/kb/")) n += 1;
    for (const key of ["content", "children", "rows", "cells"]) if (key in o) walk(o[key]);
  };
  walk(doc);
  return n;
}

/** Совпадает ли сотрудник с правилом назначения (для подсчёта в конструкторе). */
export function matchesAssignment(person: AcadStaffPerson, a: AcadAssignment): boolean {
  if (a.subject_type === "user") return a.user_id === person.user_id;
  if (a.subject_type === "access_role")
    return !!a.access_role_id && (person.access_role_ids ?? []).includes(a.access_role_id);
  if (a.subject_type === "position") return !!a.position_id && person.position_id === a.position_id;
  if (a.subject_type === "unit")
    return (person.units ?? []).some(
      (m) =>
        m.unit_id === a.unit_id || (a.with_subunits && !!a.unit_id && m.path.includes(a.unit_id)),
    );
  return person.roles.some(
    (r) => r.role === a.role && (a.studio_ids.length === 0 || a.studio_ids.includes(r.studio_id)),
  );
}

/** Сколько сотрудников получат курс по всем назначениям. */
export function learnersCount(people: AcadStaffPerson[], assignments: AcadAssignment[]): number {
  return people.filter((p) => assignments.some((a) => matchesAssignment(p, a))).length;
}

/** Срок назначения словами: «до 01.12.2026» / «14 дней с назначения» / «без срока». */
export function assignmentDueText(a: Pick<AcadAssignment, "due_date" | "due_days">): string {
  if (a.due_date) {
    const [y, m, d] = a.due_date.slice(0, 10).split("-");
    return `до ${d}.${m}.${y}`;
  }
  if (a.due_days)
    return `${a.due_days} ${plural(a.due_days, ["день", "дня", "дней"])} с назначения`;
  return "без срока";
}

/** Сообщения ошибок RPC Академии — по-человечески. */
const ERRORS: Record<string, string> = {
  acad_forbidden: "Нет доступа",
  acad_not_found: "Не найдено — возможно, удалено",
  acad_locked: "Сначала пройдите предыдущие шаги курса",
  acad_in_review: "Ответы на проверке — дождитесь результата",
  acad_already_passed: "Тест уже сдан",
  acad_incomplete: "Ответьте на все вопросы",
  acad_no_questions: "В тесте пока нет вопросов",
  acad_bad_file: "Файл не подходит к этому вопросу",
  acad_bad_options: "Нужно от 2 до 20 заполненных вариантов",
  acad_bad_correct: "Проверьте отметки верных вариантов",
  acad_not_in_review: "Эту попытку уже проверили",
  acad_own_attempt: "Свои ответы проверяет другой сотрудник",
  acad_not_quiz: "Вопросы — только в тесте",
};

export function acadError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const key = Object.keys(ERRORS).find((k) => msg.includes(k));
  return key ? ERRORS[key] : msg;
}
