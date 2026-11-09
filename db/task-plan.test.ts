/**
 * Тесты «Мой план» (db/migrations/2026-11-08_zzzzzzz_task_plan.sql): стартовые
 * колонки, свои задачи на доске, раскладка и порядок, добавить чужую
 * видимую, удалить колонку — карточки в «Не разобрано», чужие колонки.
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

type Brief = { id: string; number: number; title: string; status: string; assignee_id: string | null };
type TaskJson = {
  id: string;
  number: number;
  title: string;
  status: string;
  urgent: boolean;
  my_roles: string[];
  parent_id: string | null;
  parent_number: number | null;
  subtasks_total: number;
  subtasks_done: number;
  result_required: boolean;
  has_result: boolean;
  result?: { text: string; by: string; at: string } | null;
  parent?: (Brief & { hidden?: boolean }) | { number: number; hidden: true } | null;
  subtasks?: Brief[];
  source?: { chat_id: string; seq: number } | null;
};

describe.skipIf(!url)("мой план (база)", () => {
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
    const c = await staff(tx, "Вера Соисполнитель");
    const d = await staff(tx, "Глеб Посторонний");
    return { a, b, c, d };
  }

  const create = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ r }] = await tx`select task_create(${p}::jsonb) as r`;
    return r as { tasks: { id: string; number: number }[]; batch_id: string | null };
  };
  const get = async (tx: Tx, n: number) => {
    const [{ r }] = await tx`select task_get(${n}) as r`;
    return r as TaskJson;
  };
  const list = async (tx: Tx, p: Record<string, unknown> = {}) => {
    const [{ r }] = await tx`select task_list(${p}::jsonb) as r`;
    return (r as { rows: TaskJson[] }).rows;
  };

  type Plan = {
    columns: { id: string; title: string }[];
    cards: { column_id: string | null; added: boolean; task: { id: string; title: string } }[];
  };
  const plan = async (tx: Tx) => {
    const [{ p }] = await tx`select task_plan_get() as p`;
    return p as Plan;
  };
  const col = (p: Plan, id: string | null) =>
    p.cards.filter((c) => c.column_id === id).map((c) => c.task.title);

  test("доска: стартовые колонки, мои задачи, раскладка и порядок", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const t1 = (await create(tx, { title: "Отчёт", assignees: [b] })).tasks[0];
      const t2 = (await create(tx, { title: "Афиша", assignees: [b] })).tasks[0];
      const t3 = (await create(tx, { title: "Чужая", assignees: [c] })).tasks[0];
      await create(tx, { title: "Помогаю", assignees: [c], coassignees: [b] });

      await as(tx, b);
      let p = await plan(tx);
      expect(p.columns.map((x) => x.title)).toEqual(["Сейчас", "Дальше", "Когда-нибудь"]);
      expect(col(p, null).sort()).toEqual(["Афиша", "Отчёт", "Помогаю"]);
      const today = p.columns[0].id;
      await tx`select task_plan_place(${today}, ${[t2.id, t1.id]}::uuid[])`;
      p = await plan(tx);
      expect(col(p, today)).toEqual(["Афиша", "Отчёт"]);
      expect(col(p, null)).toEqual(["Помогаю"]);
      // Чужую невидимую не положить.
      expect(await failure(tx, () => tx`select task_plan_place(${today}, ${[t3.id]}::uuid[])`)).toContain(
        "task_not_found",
      );
      // Завершённая уходит с доски.
      await tx`select task_set_status(${t2.id}, 'complete')`;
      expect(col(await plan(tx), today)).toEqual(["Отчёт"]);
      // Удалить колонку — карточки в «Не разобрано».
      await tx`select task_plan_column_delete(${today})`;
      p = await plan(tx);
      expect(p.columns).toHaveLength(2);
      expect(col(p, null).sort()).toEqual(["Отчёт", "Помогаю"]);
      // Колонки — до 10, свои.
      const [{ id: mine }] = await tx`select task_plan_column_save(null, 'Срочное') as id`;
      await as(tx, c);
      expect(await failure(tx, () => tx`select task_plan_column_save(${mine}, 'x')`)).toContain(
        "task_plan_column_not_found",
      );
      expect(await failure(tx, () => tx`select task_plan_place(${mine}, '{}'::uuid[])`)).toContain(
        "task_plan_column_not_found",
      );
    });
  });

  test("добавить в план задачу, которую поручил, и убрать", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const t = (await create(tx, { title: "Проверить договор", assignees: [b] })).tasks[0];
      expect(col(await plan(tx), null)).toEqual([]);
      await tx`select task_plan_add(${t.id})`;
      let p = await plan(tx);
      expect(p.cards.map((x) => [x.task.title, x.added])).toEqual([["Проверить договор", true]]);
      await tx`select task_plan_place(${p.columns[2].id}, ${[t.id]}::uuid[])`;
      expect(col(await plan(tx), p.columns[2].id)).toEqual(["Проверить договор"]);
      await tx`select task_plan_remove(${t.id})`;
      p = await plan(tx);
      expect(p.cards).toEqual([]);
    });
  });
});
