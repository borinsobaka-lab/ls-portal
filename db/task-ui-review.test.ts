/**
 * Тесты правок задач по разбору интерфейса (db/migrations/2026-11-09_task_ui_review.sql):
 * регулярная задача из поставленной («Повторять» в форме, «Сделать
 * регулярной» в карточке) — скрытый шаблон, первая задача — поставленная,
 * права; стартовые колонки «Моего плана».
 *
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;
class Rollback extends Error {}

describe.skipIf(!url)("задачи: регулярная из задачи, стартовые колонки плана (база)", () => {
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

  let studio: string | null = null;
  async function staff(tx: Tx, name: string): Promise<string> {
    if (!studio) {
      const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
      studio = id;
    }
    await tx`set local session_replication_role = replica`;
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studio}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studio}, ${name}, 'x@example.com')
             on conflict (id) do update set full_name = excluded.full_name`;
    return id as string;
  }

  async function as(tx: Tx, userId: string) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function people(tx: Tx) {
    studio = null;
    const a = await staff(tx, "Анна Постановщик");
    const b = await staff(tx, "Борис Исполнитель");
    const c = await staff(tx, "Вера Посторонняя");
    return { a, b, c };
  }

  const create = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ r }] = await tx`select task_create(${p}::jsonb) as r`;
    return r as { tasks: { id: string; number: number }[]; batch_id: string | null };
  };

  type Rec = {
    id: string;
    template_id: string;
    template_name: string;
    template_hidden: boolean;
    title: string;
    next_run_at: string | null;
    last_task: { number: number } | null;
    mode: string;
  };
  const recurrences = async (tx: Tx) => {
    const [{ r }] = await tx`select task_recurrences_list() as r`;
    return r as Rec[];
  };

  test("сделать регулярной: скрытый шаблон из задачи, поставленная — первая", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const r = await create(tx, {
        title: "Отчёт за неделю",
        assignees: [b],
        deadline: "2030-01-10T15:00:00Z",
        checklists: [{ title: "Шаги", items: [{ text: "Собрать цифры" }] }],
        urgent: true,
      });
      const id = r.tasks[0].id;

      // Посторонний и исполнитель не делают регулярной.
      await as(tx, c);
      expect(
        await failure(tx, () => tx`select task_make_recurring(${id}, ${{ rule: { freq: "daily" } }}::jsonb)`),
      ).toContain("task_forbidden");
      await as(tx, b);
      expect(
        await failure(tx, () => tx`select task_make_recurring(${id}, ${{ rule: { freq: "daily" } }}::jsonb)`),
      ).toContain("task_forbidden");

      await as(tx, a);
      expect(
        await failure(tx, () => tx`select task_make_recurring(${id}, ${{ rule: { freq: "weekly" } }}::jsonb)`),
      ).toContain("recurrence_invalid");
      const [{ rec }] =
        await tx`select task_make_recurring(${id}, ${{ rule: { freq: "weekly", weekdays: [1] }, at_time: "10:00" }}::jsonb) as rec`;

      // В «Шаблонах» скрытого нет, в «Регулярных» — с названием задачи.
      const [{ t }] = await tx`select task_templates_list() as t`;
      expect(t).toEqual([]);
      const list = await recurrences(tx);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(rec);
      expect(list[0].template_hidden).toBe(true);
      expect(list[0].template_name).toBe("Отчёт за неделю");
      expect(list[0].last_task?.number).toBe(r.tasks[0].number);
      expect(list[0].mode).toBe("wait");
      expect(new Date(list[0].next_run_at!).getTime()).toBeGreaterThan(Date.now());

      // Поля шаблона — из задачи.
      await asServer(tx);
      const [tp] = await tx`select hidden, scope, task from task_templates where id = ${list[0].template_id}`;
      expect(tp.hidden).toBe(true);
      expect(tp.scope).toBe("personal");
      expect(tp.task.assignees).toEqual([b]);
      expect(tp.task.urgent).toBe(true);
      expect(tp.task.checklists[0].items[0].text).toBe("Собрать цифры");
      expect(tp.task.deadline_time).toBe("18:00");
      const [{ rid }] = await tx`select recurrence_id as rid from tasks where id = ${id}`;
      expect(rid).toBe(rec);

      // Второй раз — нельзя.
      await as(tx, a);
      expect(
        await failure(tx, () => tx`select task_make_recurring(${id}, ${{ rule: { freq: "daily" } }}::jsonb)`),
      ).toContain("task_already_recurring");

      // Удалили регулярную — ушёл и скрытый шаблон.
      await tx`select task_recurrence_delete(${rec})`;
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from task_templates where id = ${list[0].template_id}`;
      expect(n).toBe(0);
    });
  });

  test("повторять из формы: поля шаблона — из формы, «после закрытия» ждёт прежнюю", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Обзвон", assignees: [b, c], mode: "separate" });
      const [{ rec }] = await tx`select task_make_recurring(${r.tasks[0].id}, ${{
        rule: { freq: "after_close", after_days: 1 },
        mode: "skip",
        task: { title: "Обзвон", assignees: [b, c], mode: "separate", deadline: "x", files: [1] },
      }}::jsonb) as rec`;
      const list = await recurrences(tx);
      expect(list[0].next_run_at).toBeNull();
      expect(list[0].mode).toBe("skip");
      await asServer(tx);
      const [tp] = await tx`select task from task_templates where id = ${list[0].template_id}`;
      expect(tp.task.mode).toBe("separate");
      expect(tp.task.assignees).toEqual([b, c]);
      expect(tp.task.files).toBeUndefined();
      expect(tp.task.deadline).toBeUndefined();
      // Обе задачи постановки — от этой регулярной.
      const rows = await tx`select recurrence_id from tasks where batch_id = ${r.batch_id}`;
      expect(rows.map((x: { recurrence_id: string }) => x.recurrence_id)).toEqual([rec, rec]);
    });
  });

  test("картинки описания новой задачи — в своей папке tasks/new/<я>/", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await tx`grant usage on schema storage to authenticated`;
      await tx`grant select, insert, update, delete on storage.objects to authenticated`;
      const obj = (name: string, owner: string) =>
        tx`insert into storage.objects (bucket_id, name, owner, metadata)
           values ('kb-media', ${name}, ${owner}, '{"size": 100}')`;
      const sees = async (uid: string) => {
        await as(tx, uid);
        const rows = await tx`select name from storage.objects where bucket_id = 'kb-media'`;
        return rows.map((r: { name: string }) => r.name);
      };
      await as(tx, a);
      expect(await failure(tx, () => obj(`tasks/new/${a}/pic.webp`, a))).toBeNull();
      expect(await failure(tx, () => obj(`tasks/new/${b}/pic.webp`, a))).not.toBeNull();
      expect(await sees(a)).toEqual([`tasks/new/${a}/pic.webp`]);
      expect(await sees(b)).toEqual([]);
    });
  });

  test("«Мой план»: стартовые колонки — «Сейчас», «Дальше», «Когда-нибудь»", async () => {
    await scenario(async (tx) => {
      const { a } = await people(tx);
      await as(tx, a);
      const [{ p }] = await tx`select task_plan_get() as p`;
      expect(p.columns.map((x: { title: string }) => x.title)).toEqual(["Сейчас", "Дальше", "Когда-нибудь"]);
    });
  });
});
