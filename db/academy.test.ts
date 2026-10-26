/**
 * Тесты «Академии» (db/migrations/2026-10-25_zzzzzzz_academy.sql): права
 * (владелец, «Создаёт курсы», «Проверяет ответы», ученик), назначения людям и
 * ролям, прохождение по порядку, автопроверка закрытых вопросов, пересдача
 * только ошибок, проверка открытых ответов, отчёты, файлы в kb-media/academy.
 *
 * Нужна база с полной схемой — как для db/knowledge-base.test.ts:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;
type Row = Record<string, unknown>;

class Rollback extends Error {}

const doc = (text: string) => [
  { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] },
];

describe.skipIf(!url)("академия (база)", () => {
  let db: SQL;

  beforeAll(() => {
    db = new SQL(url!);
  });
  afterAll(async () => {
    await db.close();
  });

  async function scenario(fn: (tx: Tx) => Promise<void>) {
    try {
      await db.begin(async (tx) => {
        await fn(tx as unknown as Tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }

  async function failure(tx: Tx, run: () => Promise<unknown>): Promise<string | null> {
    await tx`savepoint t`;
    try {
      await run();
      await tx`release savepoint t`;
      return null;
    } catch (e) {
      await tx`rollback to savepoint t`;
      return (e as Error).message;
    }
  }

  async function user(tx: Tx): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function studio(tx: Tx): Promise<string> {
    const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
    return id as string;
  }

  async function staff(tx: Tx, studioId: string, role = "admin", name = "Сотрудник"): Promise<string> {
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, ${role}::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${studioId}, ${name})
             on conflict (id) do update set full_name = excluded.full_name`;
    return id;
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  /** Команда, ученики и курс: урок → тест (один верный, несколько верных). */
  async function setup(tx: Tx) {
    const s = await studio(tx);
    const s2 = await studio(tx);
    const owner = await staff(tx, s, "owner", "Владелец");
    const creator = await staff(tx, s, "admin", "Создатель");
    const reviewer = await staff(tx, s, "trainer", "Тренер");
    const learner = await staff(tx, s, "admin", "Ученица");
    const other = await staff(tx, s2, "trainer", "Чужой");
    await tx`insert into acad_staff (user_id, can_create) values (${creator}, true)`;
    await tx`insert into acad_staff (user_id, can_review) values (${reviewer}, true)`;

    await as(tx, creator);
    const [{ id: course }] = await tx`
      insert into acad_courses (title, status) values ('Стандарты администратора', 'published') returning id`;
    const [{ id: lesson }] = await tx`
      insert into acad_steps (course_id, kind, title, content)
      values (${course}, 'lesson', 'Открытие смены', ${JSON.stringify(doc("Касса открывается в 9:00"))}::text::jsonb)
      returning id`;
    const [{ id: quiz }] = await tx`
      insert into acad_steps (course_id, kind, title) values (${course}, 'quiz', 'Проверка') returning id`;
    const [{ id: q1 }] = await tx`
      insert into acad_questions (step_id, kind, text, options)
      values (${quiz}, 'single', 'Во сколько открывается касса?',
              ${JSON.stringify([
                { id: "a", text: "9:00", correct: true },
                { id: "b", text: "10:00", correct: false },
              ])}::text::jsonb)
      returning id`;
    const [{ id: q2 }] = await tx`
      insert into acad_questions (step_id, kind, text, options, explanation)
      values (${quiz}, 'multiple', 'Что проверить?',
              ${JSON.stringify([
                { id: "x", text: "Кассу", correct: true },
                { id: "y", text: "Зал", correct: true },
                { id: "z", text: "Погоду", correct: false },
              ])}::text::jsonb, 'Касса и зал')
      returning id`;
    await tx`insert into acad_assignments (course_id, subject_type, user_id) values (${course}, 'user', ${learner})`;
    await asServer(tx);
    return { s, s2, owner, creator, reviewer, learner, other, course, lesson, quiz, q1, q2 };
  }

  async function rpc(tx: Tx, userId: string, query: () => Promise<Row[]>): Promise<Row[]> {
    await as(tx, userId);
    try {
      return await query();
    } finally {
      await asServer(tx);
    }
  }

  test("права: без них не видно; создатель пишет, проверяющий только читает; вопросы ученику закрыты", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const titles = async (uid: string) =>
        (await rpc(tx, uid, () => tx`select title from acad_courses`)).map((r) => r.title);
      expect(await titles(t.owner)).toEqual(["Стандарты администратора"]);
      expect(await titles(t.creator)).toEqual(["Стандарты администратора"]);
      expect(await titles(t.reviewer)).toEqual(["Стандарты администратора"]);
      expect(await titles(t.learner)).toEqual([]);
      expect(await titles(t.other)).toEqual([]);
      expect((await rpc(tx, t.learner, () => tx`select * from acad_questions`)).length).toBe(0);

      await as(tx, t.reviewer);
      await tx`update acad_courses set title = 'Взлом'`;
      await asServer(tx);
      expect((await tx`select title from acad_courses where id = ${t.course}`)[0].title).toBe(
        "Стандарты администратора",
      );

      // Права без роли сотрудника не действуют.
      await tx`delete from user_roles where user_id = ${t.creator}`;
      expect(await titles(t.creator)).toEqual([]);

      const [access] = await rpc(tx, t.reviewer, () => tx`select acad_access() as a`);
      expect(access.a).toMatchObject({ can_create: false, can_review: true, my_courses: 0 });
      const [mine] = await rpc(tx, t.learner, () => tx`select acad_access() as a`);
      expect(mine.a).toMatchObject({ can_create: false, can_review: false, my_courses: 1, my_open: 1 });
    }));

  test("вопросы проверяются: варианты и верные ответы по виду вопроса", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      const bad = (options: unknown, kind = "single") =>
        failure(
          tx,
          () => tx`insert into acad_questions (step_id, kind, text, options)
                   values (${t.quiz}, ${kind}, 'Вопрос', ${JSON.stringify(options)}::text::jsonb)`,
        );
      expect(await bad([{ id: "a", text: "Один", correct: true }])).toContain("acad_bad_options");
      expect(
        await bad([
          { id: "a", text: "1", correct: true },
          { id: "b", text: "2", correct: true },
        ]),
      ).toContain("acad_bad_correct");
      expect(
        await bad(
          [
            { id: "a", text: "1", correct: false },
            { id: "b", text: "2", correct: false },
          ],
          "multiple",
        ),
      ).toContain("acad_bad_correct");
      expect(
        await failure(
          tx,
          () => tx`insert into acad_questions (step_id, kind, text) values (${t.lesson}, 'open', 'В уроке')`,
        ),
      ).toContain("acad_not_quiz");
      // У открытого вариантов нет.
      const [{ options }] = await tx`
        insert into acad_questions (step_id, kind, text, options)
        values (${t.quiz}, 'open', 'Расскажите', '[{"id":"a","text":"x"}]') returning options`;
      expect(options).toEqual([]);
      await asServer(tx);
    }));

  test("назначение ролью: новый сотрудник с ролью получает курс сам; клубы и черновик", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      await tx`insert into acad_assignments (course_id, subject_type, role, studio_ids, due_days)
               values (${t.course}, 'role', 'trainer', ${[t.s2]}::uuid[], 14)`;
      await asServer(tx);
      const courses = async (uid: string) =>
        (await rpc(tx, uid, () => tx`select course_id from acad_my_courses()`)).map((r) => r.course_id);
      expect(await courses(t.other)).toEqual([t.course]);
      // Тренер другого клуба правилом не задет.
      const tr = await staff(tx, t.s, "trainer");
      expect(await courses(tr)).toEqual([]);
      // Новый тренер клуба s2 — сразу с курсом.
      const fresh = await staff(tx, t.s2, "trainer");
      expect(await courses(fresh)).toEqual([t.course]);
      const [{ d }] = await tx`select due_date::text as d from acad_pairs(${t.course}, ${fresh})`;
      expect(d).toBe(
        (await tx`select ((now() at time zone 'Asia/Tbilisi')::date + 14)::text as d`)[0].d as string,
      );
      // Черновик ученики не видят.
      await tx`update acad_courses set status = 'draft' where id = ${t.course}`;
      expect(await courses(t.other)).toEqual([]);
      expect(await courses(t.learner)).toEqual([]);
    }));

  test("прохождение: по порядку, вопросы без ответов, пересдача только ошибок, курс пройден", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const view = async () =>
        (await rpc(tx, t.learner, () => tx`select acad_course_view(${t.course}) as v`))[0].v as {
          steps: { id: string; state: string; locked: boolean }[];
          started_at: string | null;
          completed_at: string | null;
        };
      let v = await view();
      expect(v.started_at).not.toBeNull();
      expect(v.steps.map((s) => [s.state, s.locked])).toEqual([
        ["todo", false],
        ["todo", true],
      ]);
      await as(tx, t.learner);
      expect(await failure(tx, () => tx`select acad_quiz_start(${t.quiz})`)).toContain("acad_locked");
      // Чужой курс — нельзя.
      await asServer(tx);
      expect(
        await failure(tx, async () => {
          await as(tx, t.other);
          await tx`select acad_lesson(${t.lesson})`;
        }),
      ).toContain("acad_forbidden");
      await asServer(tx);

      await as(tx, t.learner);
      const [{ l }] = await tx`select acad_lesson(${t.lesson}) as l`;
      expect((l as { title: string }).title).toBe("Открытие смены");
      await tx`select acad_lesson_complete(${t.lesson})`;
      const [{ q }] = await tx`select acad_quiz_start(${t.quiz}) as q`;
      const quiz = q as { questions: { id: string; options: Row[] }[]; preview: boolean };
      expect(quiz.preview).toBe(false);
      expect(quiz.questions.length).toBe(2);
      expect(JSON.stringify(quiz.questions)).not.toContain("correct");

      // Неполные ответы не принимаются.
      expect(
        await failure(
          tx,
          () => tx`select acad_quiz_submit(${t.quiz}, ${JSON.stringify([{ question_id: t.q1, options: ["a"] }])}::text::jsonb)`,
        ),
      ).toContain("acad_incomplete");

      // Первая попытка: q1 верно, q2 — нет (не все варианты).
      const [{ a1 }] = await tx`
        select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
          { question_id: t.q1, options: ["a"] },
          { question_id: t.q2, options: ["x"] },
        ])}::text::jsonb) as a1`;
      const [att1] = await tx`select status, score, max_score, percent from acad_attempts where id = ${a1}`;
      expect(att1).toMatchObject({ status: "failed" });
      expect(Number(att1.percent)).toBe(50);

      // Ученик видит, где ошибся, но не правильные варианты.
      const [{ r }] = await tx`select acad_attempt(${a1}) as r`;
      const res = r as { full: boolean; answers: { correct: boolean; question: { options: Row[] } }[] };
      expect(res.full).toBe(false);
      const wrong = res.answers.find((x) => x.correct === false)!;
      expect(JSON.stringify(wrong.question.options)).not.toContain("correct");

      // Пересдача — только q2; q1 переносится.
      const [{ q: q2start }] = await tx`select acad_quiz_start(${t.quiz}) as q`;
      expect((q2start as { questions: { id: string }[] }).questions.map((x) => x.id)).toEqual([t.q2]);
      const [{ a2 }] = await tx`
        select acad_quiz_submit(${t.quiz}, ${JSON.stringify([{ question_id: t.q2, options: ["x", "y"] }])}::text::jsonb) as a2`;
      const [att2] = await tx`select status, percent, attempt_no from acad_attempts where id = ${a2}`;
      expect(att2).toMatchObject({ status: "passed", attempt_no: 2 });
      expect(Number(att2.percent)).toBe(100);
      await asServer(tx);
      const carried = await tx`select carried from acad_answers where attempt_id = ${a2} order by carried`;
      expect(carried.map((x: Row) => x.carried)).toEqual([false, true]);
      await as(tx, t.learner);
      // Сданный тест повторно не проходят.
      expect(await failure(tx, () => tx`select acad_quiz_start(${t.quiz})`)).toContain(
        "acad_already_passed",
      );
      await asServer(tx);

      v = await view();
      expect(v.completed_at).not.toBeNull();
      expect(v.steps.map((s) => s.state)).toEqual(["done", "passed"]);
      const [mine] = await rpc(tx, t.learner, () => tx`select status, steps_done, steps_total from acad_my_courses()`);
      expect(mine).toMatchObject({ status: "completed", steps_done: 2, steps_total: 2 });
    }));

  test("открытый вопрос: ждёт проверки, проверяет только проверяющий, ошибку — пересдать", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      await tx`update acad_courses set sequential = false where id = ${t.course}`;
      const [{ id: q3 }] = await tx`
        insert into acad_questions (step_id, kind, text, allow_file, points)
        values (${t.quiz}, 'open', 'Как встречаете гостя?', true, 2) returning id`;
      await asServer(tx);

      await as(tx, t.learner);
      // Файл — только из своей папки ответов.
      expect(
        await failure(
          tx,
          () => tx`select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
            { question_id: t.q1, options: ["a"] },
            { question_id: t.q2, options: ["x", "y"] },
            { question_id: q3, text: "", file: `kbfile:academy/answers/${t.other}/a.pdf` },
          ])}::text::jsonb)`,
        ),
      ).toContain("acad_bad_file");
      const [{ a }] = await tx`
        select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
          { question_id: t.q1, options: ["a"] },
          { question_id: t.q2, options: ["x", "y"] },
          { question_id: q3, text: "Улыбаюсь", file: `kbfile:academy/answers/${t.learner}/a.pdf` },
        ])}::text::jsonb) as a`;
      expect((await tx`select status from acad_attempts where id = ${a}`)[0].status).toBe("review");
      expect(await failure(tx, () => tx`select acad_quiz_start(${t.quiz})`)).toContain("acad_in_review");
      expect(await failure(tx, () => tx`select * from acad_review_queue()`)).toContain("acad_forbidden");
      await asServer(tx);

      const queue = await rpc(tx, t.reviewer, () => tx`select * from acad_review_queue()`);
      expect(queue.map((x) => [x.attempt_id, x.full_name, x.open_answers])).toEqual([[a, "Ученица", 1]]);
      const [{ id: openId }] = await tx`select id from acad_answers where attempt_id = ${a} and correct is null`;

      await as(tx, t.reviewer);
      expect(
        await failure(tx, () => tx`select acad_review_submit(${a}, '[]'::jsonb, '')`),
      ).toContain("acad_incomplete");
      const [{ st }] = await tx`
        select acad_review_submit(${a}, ${JSON.stringify([
          { answer_id: openId, correct: false, comment: "Нужно поздороваться по имени" },
        ])}::text::jsonb, 'Почти') as st`;
      // 2 из 4 баллов — ниже 80 %.
      expect(st).toBe("failed");
      await asServer(tx);

      await as(tx, t.learner);
      const [{ r }] = await tx`select acad_attempt(${a}) as r`;
      const res = r as { review_comment: string; answers: { comment: string; correct: boolean }[] };
      expect(res.review_comment).toBe("Почти");
      expect(res.answers.find((x) => x.correct === false)!.comment).toBe("Нужно поздороваться по имени");
      // Пересдача — только открытый.
      const [{ q }] = await tx`select acad_quiz_start(${t.quiz}) as q`;
      expect((q as { questions: { id: string }[] }).questions.map((x) => x.id)).toEqual([q3]);
      await asServer(tx);
    }));

  test("свои ответы не проверяют: нет в очереди и счётчике, проверка — исключение", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      await tx`update acad_courses set sequential = false where id = ${t.course}`;
      const [{ id: q3 }] = await tx`
        insert into acad_questions (step_id, kind, text) values (${t.quiz}, 'open', 'Как встречаете гостя?')
        returning id`;
      // Проверяющий — и ученик этого курса.
      await tx`insert into acad_assignments (course_id, subject_type, user_id) values (${t.course}, 'user', ${t.reviewer})`;
      await asServer(tx);

      await as(tx, t.reviewer);
      const [{ a }] = await tx`
        select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
          { question_id: t.q1, options: ["a"] },
          { question_id: t.q2, options: ["x", "y"] },
          { question_id: q3, text: "Улыбаюсь" },
        ])}::text::jsonb) as a`;
      expect(await tx`select * from acad_review_queue()`).toHaveLength(0);
      const [{ acc }] = await tx`select acad_access() as acc`;
      expect((acc as { to_review: number }).to_review).toBe(0);
      const [{ id: openId }] = await tx`select id from acad_answers where attempt_id = ${a} and correct is null`;
      const grades = JSON.stringify([{ answer_id: openId, correct: true }]);
      expect(
        await failure(tx, () => tx`select acad_review_submit(${a}, ${grades}::text::jsonb, '')`),
      ).toContain("acad_own_attempt");
      await asServer(tx);

      // Владелец проверяет чужую попытку.
      const queue = await rpc(tx, t.owner, () => tx`select attempt_id from acad_review_queue()`);
      expect(queue.map((x) => x.attempt_id)).toEqual([a]);
      const [{ st }] = await rpc(tx, t.owner, () => tx`select acad_review_submit(${a}, ${grades}::text::jsonb, '') as st`);
      expect(st).toBe("passed");
    }));

  test("замок «по порядку» — в порядке интерфейса и при равном sort_order", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      // Равный sort_order: первым в интерфейсе — шаг с большим id (раньше
      // замок решал по id и открывал не тот шаг).
      const [first, second] = [t.lesson, t.quiz].sort().reverse() as string[];
      await tx`update acad_steps set sort_order = 1 where course_id = ${t.course}`;
      await tx`update acad_steps set created_at = now() - interval '1 hour' where id = ${first}`;
      const [{ v }] = await rpc(tx, t.learner, () => tx`select acad_course_view(${t.course}) as v`);
      const steps = (v as { steps: { id: string; locked: boolean }[] }).steps;
      expect(steps.map((s) => [s.id, s.locked])).toEqual([
        [first, false],
        [second, true],
      ]);
      await as(tx, t.learner);
      // Внутренняя — ученику не выдана.
      expect(
        await failure(tx, () => tx`select acad_step_unlocked(${t.learner}, ${first})`),
      ).toContain("permission denied");
      await asServer(tx);
      const [{ a, b }] = await tx`select acad_step_unlocked(${t.learner}, ${first}) as a,
                                         acad_step_unlocked(${t.learner}, ${second}) as b`;
      expect([a, b]).toEqual([true, false]);
    }));

  test("критерии проверяющего ученику не уходят; срок курса по умолчанию — 1–365 дней", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      await tx`update acad_courses set sequential = false where id = ${t.course}`;
      const [{ id: q3 }] = await tx`
        insert into acad_questions (step_id, kind, text, review_notes)
        values (${t.quiz}, 'open', 'Как встречаете гостя?', 'Эталон: по имени, вода, раздевалка')
        returning id`;
      await tx`update acad_courses set default_due_days = 14 where id = ${t.course}`;
      expect(
        await failure(tx, () => tx`update acad_courses set default_due_days = 0 where id = ${t.course}`),
      ).toContain("check");
      await asServer(tx);

      await as(tx, t.learner);
      const [{ q }] = await tx`select acad_quiz_start(${t.quiz}) as q`;
      expect(JSON.stringify(q)).not.toContain("Эталон");
      const [{ a }] = await tx`
        select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
          { question_id: t.q1, options: ["a"] },
          { question_id: t.q2, options: ["x", "y"] },
          { question_id: q3, text: "Улыбаюсь" },
        ])}::text::jsonb) as a`;
      const [{ r }] = await tx`select acad_attempt(${a}) as r`;
      expect(JSON.stringify(r)).not.toContain("Эталон");
      expect((await tx`select review_notes from acad_questions`).length).toBe(0);
      await asServer(tx);

      const notes = await rpc(tx, t.reviewer, () => tx`select review_notes from acad_questions where id = ${q3}`);
      expect(notes[0].review_notes).toBe("Эталон: по имени, вода, раздевалка");
    }));

  test("отчёты: ход по курсу, разбор ошибок, сводки по курсам и людям", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.creator);
      await tx`update acad_assignments set due_date = current_date - 1 where course_id = ${t.course}`;
      await tx`insert into acad_assignments (course_id, subject_type, user_id) values (${t.course}, 'user', ${t.reviewer})`;
      await asServer(tx);
      await as(tx, t.learner);
      await tx`select acad_course_view(${t.course})`;
      await tx`select acad_lesson_complete(${t.lesson})`;
      await tx`select acad_quiz_submit(${t.quiz}, ${JSON.stringify([
        { question_id: t.q1, options: ["b"] },
        { question_id: t.q2, options: ["x", "y"] },
      ])}::text::jsonb)`;
      await asServer(tx);

      const report = await rpc(tx, t.creator, () => tx`select * from acad_course_report(${t.course})`);
      const byName = Object.fromEntries(report.map((r) => [r.full_name as string, r]));
      expect(byName["Ученица"]).toMatchObject({ status: "in_progress", steps_done: 1, steps_total: 2, overdue: true });
      expect(byName["Тренер"]).toMatchObject({ status: "not_started", overdue: false });

      const stats = await rpc(tx, t.reviewer, () => tx`select text, answers, wrong from acad_question_stats(${t.course})`);
      expect(stats.map((s) => [s.text, s.answers, s.wrong])).toEqual([
        ["Во сколько открывается касса?", 1, 1],
        ["Что проверить?", 1, 0],
      ]);

      const [ov] = await rpc(tx, t.owner, () => tx`select * from acad_overview()`);
      expect(ov).toMatchObject({ learners: 2, in_progress: 1, not_started: 1, overdue: 1 });
      const people = await rpc(tx, t.owner, () => tx`select full_name, courses, overdue from acad_people_overview()`);
      expect(people[0]).toMatchObject({ full_name: "Ученица", courses: 1, overdue: 1 });

      // Ученику отчёты закрыты.
      await as(tx, t.learner);
      expect(await failure(tx, () => tx`select * from acad_overview()`)).toContain("acad_forbidden");
      await asServer(tx);
    }));

  test("файлы: курс читают его ученики, пишет создатель, ответы — в своей папке", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await tx`grant usage on schema storage to authenticated`;
      await tx`grant select, insert, update, delete on storage.objects to authenticated`;
      const obj = (name: string, owner: string) =>
        tx`insert into storage.objects (bucket_id, name, owner, metadata)
           values ('kb-media', ${name}, ${owner}, '{"size": 100}')`;
      const lessonFile = `academy/${t.course}/pic.webp`;
      await obj(lessonFile, t.creator);
      await obj(`academy/answers/${t.learner}/a.pdf`, t.learner);
      const sees = async (uid: string) =>
        (await rpc(tx, uid, () => tx`select name from storage.objects where bucket_id = 'kb-media'`))
          .map((r) => r.name as string)
          .sort();
      // Папка курса — случайный uuid: порядок сравниваем отсортированным.
      expect(await sees(t.learner)).toEqual([lessonFile, `academy/answers/${t.learner}/a.pdf`].sort());
      expect(await sees(t.other)).toEqual([]);
      expect((await sees(t.reviewer)).length).toBe(2);

      await as(tx, t.learner);
      expect(await failure(tx, () => obj(`academy/${t.course}/x.png`, t.learner))).not.toBeNull();
      expect(await failure(tx, () => obj(`academy/answers/${t.other}/x.png`, t.learner))).not.toBeNull();
      expect(await failure(tx, () => obj(`academy/answers/${t.learner}/b.png`, t.learner))).toBeNull();
      await asServer(tx);
      await as(tx, t.creator);
      expect(await failure(tx, () => obj(`academy/${t.course}/y.png`, t.creator))).toBeNull();
      await asServer(tx);

      // Чистка не трогает файлы уроков и ответов, на которые ссылаются.
      await tx`update acad_steps set content = ${JSON.stringify([
        { id: "i", type: "image", props: { url: `kbfile:${lessonFile}` }, children: [] },
      ])}::text::jsonb where id = ${t.lesson}`;
      await tx`update storage.objects set created_at = now() - interval '30 days' where bucket_id = 'kb-media'`;
      const gc = (await tx`select name from kb_file_gc_candidates(7, 100) order by name`).map((r: Row) => r.name);
      expect(gc).not.toContain(lessonFile);
      expect(gc).toContain(`academy/${t.course}/y.png`);
      expect(gc).toContain(`academy/answers/${t.learner}/a.pdf`);

      const [{ u }] = await rpc(tx, t.owner, () => tx`select kb_storage_usage() as u`);
      expect((u as { academy: { files: number; courses: number } }).academy).toMatchObject({
        files: 4,
        courses: 1,
      });

      // Удалённый курс — папка в очередь стирания.
      await tx`delete from acad_courses where id = ${t.course}`;
      const [{ n }] = await tx`select count(*)::int as n from kb_file_purge where folder = ${`academy/${t.course}`}`;
      expect(n).toBe(1);
    }));
});
