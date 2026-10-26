import { describe, expect, test } from "bun:test";

import {
  acadError,
  answerGiven,
  assignmentDueText,
  dueLabel,
  kbLinkCount,
  learnersCount,
  plural,
  progressPercent,
  publishIssues,
  questionError,
  quizzesToRecheck,
  recheckText,
  staleLessons,
  unanswered,
} from "./logic";
import type { AcadAssignment, AcadQuizQuestion, AcadStaffPerson, AcadStep } from "./types";

const opt = (text: string, correct = false) => ({ id: text, text, correct });

describe("вопрос в форме", () => {
  test("как проверит база", () => {
    expect(questionError({ kind: "open", text: "  ", options: [] })).toBe("Напишите вопрос");
    expect(questionError({ kind: "open", text: "Расскажите", options: [] })).toBeNull();
    expect(questionError({ kind: "single", text: "?", options: [opt("a", true)] })).toBe(
      "Нужно хотя бы два варианта",
    );
    expect(questionError({ kind: "single", text: "?", options: [opt("a"), opt("")] })).toBe(
      "Заполните все варианты или удалите пустые",
    );
    expect(
      questionError({ kind: "single", text: "?", options: [opt("a", true), opt("b", true)] }),
    ).toBe("Отметьте один верный вариант");
    expect(questionError({ kind: "multiple", text: "?", options: [opt("a"), opt("b")] })).toBe(
      "Отметьте хотя бы один верный вариант",
    );
    expect(
      questionError({ kind: "multiple", text: "?", options: [opt("a", true), opt("b", true)] }),
    ).toBeNull();
  });
});

describe("ответы ученика", () => {
  const q = (kind: AcadQuizQuestion["kind"]): AcadQuizQuestion => ({
    id: kind,
    kind,
    text: "?",
    points: 1,
    allow_file: kind === "open",
    options: [],
  });
  test("ответ дан", () => {
    expect(answerGiven(q("single"), { question_id: "single", options: ["a", "b"] })).toBe(false);
    expect(answerGiven(q("single"), { question_id: "single", options: ["a"] })).toBe(true);
    expect(answerGiven(q("multiple"), { question_id: "multiple", options: [] })).toBe(false);
    expect(answerGiven(q("open"), { question_id: "open", text: " " })).toBe(false);
    expect(answerGiven(q("open"), { question_id: "open", file: "kbfile:x" })).toBe(true);
    expect(
      unanswered([q("single"), q("open")], { single: { question_id: "single", options: ["a"] } }),
    ).toBe(1);
  });
});

describe("сроки и слова", () => {
  test("срок прохождения", () => {
    expect(dueLabel(null, "2026-10-25")).toBeNull();
    expect(dueLabel("2026-11-02", "2026-10-25")).toEqual({ text: "До 02.11.2026", overdue: false });
    expect(dueLabel("2026-10-25", "2026-10-25")).toEqual({
      text: "Сегодня последний день",
      overdue: false,
    });
    expect(dueLabel("2026-10-22", "2026-10-25")).toEqual({
      text: "Просрочен на 3 дня",
      overdue: true,
    });
  });
  test("формы слов и проценты", () => {
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, ["урок", "урока", "уроков"]))).toEqual([
      "урок",
      "урока",
      "уроков",
      "уроков",
      "урок",
      "урока",
    ]);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(0, 0)).toBe(0);
    expect(assignmentDueText({ due_date: "2026-12-01", due_days: null })).toBe("до 01.12.2026");
    expect(assignmentDueText({ due_date: null, due_days: 14 })).toBe("14 дней с назначения");
    expect(assignmentDueText({ due_date: null, due_days: null })).toBe("без срока");
  });
  test("ошибки базы — по-человечески", () => {
    expect(acadError(new Error("PostgresError: acad_locked"))).toBe(
      "Сначала пройдите предыдущие шаги курса",
    );
    expect(acadError(new Error("сеть"))).toBe("сеть");
  });
});

describe("напоминания конструктора", () => {
  const step = (id: string, kind: AcadStep["kind"], extra: Partial<AcadStep> = {}): AcadStep => ({
    id,
    course_id: "c",
    kind,
    title: id,
    sort_order: null,
    source_node_id: null,
    source_published_at: null,
    pass_percent: null,
    content_updated_at: null,
    questions_updated_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...extra,
  });

  test("статья опубликована заново после копии", () => {
    const steps = [
      step("l1", "lesson", { source_node_id: "n1", source_published_at: "2026-10-10T00:00:00Z" }),
      step("l2", "lesson", { source_node_id: "n2", source_published_at: "2026-10-10T00:00:00Z" }),
    ];
    const sources = [
      {
        step_id: "l1",
        node_id: "n1",
        base_id: "b",
        node_title: "",
        published_at: "2026-10-20T00:00:00Z",
        available: true,
      },
      {
        step_id: "l2",
        node_id: "n2",
        base_id: "b",
        node_title: "",
        published_at: "2026-10-10T00:00:00Z",
        available: true,
      },
    ];
    expect([...staleLessons(steps, sources)]).toEqual(["l1"]);
  });

  test("урок изменился после правки вопросов теста за ним", () => {
    const steps = [
      step("урок 1", "lesson", { content_updated_at: "2026-10-20T00:00:00Z" }),
      step("тест 1", "quiz", { questions_updated_at: "2026-10-15T00:00:00Z" }),
      step("урок 2", "lesson", { content_updated_at: "2026-10-01T00:00:00Z" }),
      step("тест 2", "quiz", { questions_updated_at: "2026-10-15T00:00:00Z" }),
      step("тест 3", "quiz", { questions_updated_at: null }),
    ];
    const recheck = quizzesToRecheck(steps, { "тест 1": 3, "тест 2": 2, "тест 3": 0 });
    expect([...recheck]).toEqual([["тест 1", [{ title: "урок 1", added: false }]]]);
  });

  test("новый урок перед тестом — «добавлен», а не «изменился»", () => {
    const steps = [
      step("старый", "lesson", {
        created_at: "2026-10-01T00:00:00Z",
        content_updated_at: "2026-10-20T00:00:00Z",
      }),
      step("новый", "lesson", {
        created_at: "2026-10-18T00:00:00Z",
        content_updated_at: "2026-10-18T00:00:00Z",
      }),
      step("тест", "quiz", { questions_updated_at: "2026-10-15T00:00:00Z" }),
    ];
    const list = quizzesToRecheck(steps, { тест: 2 }).get("тест")!;
    expect(list).toEqual([
      { title: "старый", added: false },
      { title: "новый", added: true },
    ]);
    expect(recheckText(list)).toBe(
      "После правки вопросов добавлен урок «новый», изменился урок «старый»",
    );
    expect(
      recheckText([
        { title: "a", added: true },
        { title: "b", added: true },
      ]),
    ).toBe("После правки вопросов добавлены уроки «a», «b»");
  });

  test("сколько людей получат курс", () => {
    const extra = { position_id: null, units: [], access_role_ids: [] };
    const people: AcadStaffPerson[] = [
      {
        user_id: "a",
        full_name: "А",
        avatar_url: null,
        email: null,
        roles: [{ role: "admin", studio_id: "s1" }],
        ...extra,
      },
      {
        user_id: "b",
        full_name: "Б",
        avatar_url: null,
        email: null,
        roles: [{ role: "trainer", studio_id: "s2" }],
        ...extra,
      },
      {
        user_id: "c",
        full_name: "В",
        avatar_url: null,
        email: null,
        roles: [{ role: "trainer", studio_id: "s1" }],
        ...extra,
      },
      // Сотрудник УК без клуба: подразделение «Кураторы» внутри «Отдела развития».
      {
        user_id: "d",
        full_name: "Г",
        avatar_url: null,
        email: null,
        roles: [],
        position_id: "p1",
        units: [{ unit_id: "u2", path: ["u1"], member_role: "member" }],
        access_role_ids: ["r1"],
      },
    ];
    const base = {
      id: "x",
      course_id: "c",
      due_date: null,
      due_days: null,
      created_at: "",
      access_role_id: null,
      unit_id: null,
      position_id: null,
      with_subunits: true,
    };
    const assignments: AcadAssignment[] = [
      { ...base, subject_type: "role", role: "trainer", studio_ids: ["s2"], user_id: null },
      { ...base, subject_type: "user", user_id: "a", role: null, studio_ids: [] },
    ];
    expect(learnersCount(people, assignments)).toBe(2);
    const unit = {
      ...base,
      subject_type: "unit" as const,
      unit_id: "u1",
      user_id: null,
      role: null,
      studio_ids: [],
    };
    expect(learnersCount(people, [unit])).toBe(1);
    expect(learnersCount(people, [{ ...unit, with_subunits: false }])).toBe(0);
    expect(
      learnersCount(people, [
        { ...unit, subject_type: "position", unit_id: null, position_id: "p1" },
      ]),
    ).toBe(1);
    expect(
      learnersCount(people, [
        { ...unit, subject_type: "access_role", unit_id: null, access_role_id: "r1" },
      ]),
    ).toBe(1);
  });
});

describe("публикация курса", () => {
  const steps = [
    { id: "l", kind: "lesson" as const, title: "Урок" },
    { id: "q1", kind: "quiz" as const, title: "Тест 1" },
    { id: "q2", kind: "quiz" as const, title: "Тест 2" },
  ];
  test("пустой курс и тесты без вопросов", () => {
    expect(publishIssues([], {}, true)).toEqual(["В курсе нет ни одного урока или теста."]);
    expect(publishIssues(steps, { q1: 3, q2: 1 }, true)).toEqual([]);
    expect(publishIssues(steps, { q1: 3 }, false)).toEqual([
      "В тесте «Тест 2» нет вопросов — ученик не сможет его сдать.",
    ]);
    expect(publishIssues(steps, {}, true)[0]).toBe(
      "В тестах «Тест 1», «Тест 2» нет вопросов — ученик не сможет их сдать, а курс проходится по порядку: дальше теста он не продвинется.",
    );
  });
});

describe("ссылки на базу знаний в уроке", () => {
  const link = (href: string) => ({ type: "link", href, content: [{ type: "text", text: "x" }] });
  test("в тексте, вложенных блоках и таблицах; внешние и якоря не в счёт", () => {
    const doc = [
      { type: "paragraph", content: [link("/kb/b/n"), link("https://example.com"), link("#h")] },
      {
        type: "columns",
        children: [
          { type: "column", children: [{ type: "paragraph", content: [link("/kb/b/m")] }] },
        ],
      },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [{ type: "tableCell", content: [link("/kb/b/k")] }] }],
        },
      },
    ];
    expect(kbLinkCount(doc)).toBe(3);
    expect(kbLinkCount([])).toBe(0);
  });
});
