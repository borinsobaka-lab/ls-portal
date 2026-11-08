/**
 * Тесты этапа 2 задач, блок 1 (db/migrations/2026-11-08_zzzz_task_subtasks_results.sql):
 * подзадачи (видимость участникам родительской, без кругов, история),
 * задача из сообщения чата (системная строка, только участник чата),
 * результат и «Нужен результат», сортировка «срочные первыми».
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

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe.skipIf(!url)("подзадачи, задача из сообщения, результат (база)", () => {
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

  const send = async (tx: Tx, chat: string, text: string) => {
    const [{ m }] = await tx`select chat_send(${chat}, ${doc(text)}::jsonb, ${text}, null, '[]'::jsonb, null) as m`;
    return m as { id: string; seq: number };
  };
  const history = async (tx: Tx, id: string) =>
    (await tx`select kind, data from task_history(${id})`) as { kind: string; data: Record<string, unknown> }[];

  test("подзадачи: видят участники родительской, история, без кругов", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const parent = (await create(tx, { title: "Открыть клуб", assignees: [b] })).tasks[0];
      // Исполнитель родительской разбивает её на подзадачи.
      await as(tx, b);
      const sub = (await create(tx, { title: "Найти помещение", assignees: [c], parent_id: parent.id })).tasks[0];
      // Посторонний не может повесить подзадачу на чужую задачу.
      await as(tx, d);
      expect(await failure(tx, () => create(tx, { title: "x", parent_id: parent.id }))).toContain("task_not_found");

      // Постановщик родительской видит подзадачу (роль parent), но не правит её.
      await as(tx, a);
      const s = await get(tx, sub.number);
      expect(s.my_roles).toContain("parent");
      expect(s.parent_number).toBe(parent.number);
      expect((s.parent as Brief).title).toBe("Открыть клуб");
      expect(await failure(tx, () => tx`select task_update(${sub.id}, '{"title": "Другое"}'::jsonb)`)).toContain(
        "task_forbidden",
      );
      const p = await get(tx, parent.number);
      expect(p.subtasks_total).toBe(1);
      expect(p.subtasks?.map((x) => x.number)).toEqual([sub.number]);
      expect(p.subtasks?.[0].assignee_id).toBe(c);
      // Посторонний подзадачу не видит.
      await as(tx, d);
      expect(await failure(tx, () => get(tx, sub.number))).toContain("task_not_found");

      // Исполнитель подзадачи видит номер родительской, но не её саму.
      await as(tx, c);
      const own = await get(tx, sub.number);
      expect(own.parent).toEqual({ number: parent.number, hidden: true });
      await tx`select task_set_status(${sub.id}, 'complete')`;
      await as(tx, a);
      const p2 = await get(tx, parent.number);
      expect(p2.subtasks_done).toBe(1);
      const kinds = (await history(tx, parent.id)).map((e) => e.kind);
      expect(kinds).toContain("subtask");
      expect(kinds).toContain("subtask_status");

      // Круг: родительская не может стать подзадачей своей подзадачи.
      // (постановщик родительской видит подзадачу — может добавить к ней свою)
      await as(tx, a);
      const sub2 = (await create(tx, { title: "Ремонт", parent_id: sub.id })).tasks[0];
      expect(
        await failure(tx, () => tx`select task_update(${parent.id}, ${{ parent_id: sub2.id }}::jsonb)`),
      ).toContain("task_parent_invalid");
      // Отвязать подзадачу — постановщик подзадачи.
      await as(tx, b);
      await tx`select task_update(${sub.id}, '{"parent_id": null}'::jsonb)`;
      await as(tx, a);
      expect((await get(tx, parent.number)).subtasks_total).toBe(0);
    });
  });

  test("задача из сообщения: строка в чате, ссылка — участнику чата", async () => {
    await scenario(async (tx) => {
      const { a, b, d } = await people(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const m = await send(tx, chat, "Подготовьте отчёт по Казани");
      // Посторонний не ставит задачу из чужого чата.
      await as(tx, d);
      expect(
        await failure(tx, () => create(tx, { title: "x", source: { chat_id: chat, seq: m.seq } })),
      ).toContain("task_source_invalid");
      await as(tx, b);
      expect(
        await failure(tx, () => create(tx, { title: "x", source: { chat_id: chat, seq: m.seq + 100 } })),
      ).toContain("task_source_invalid");
      const r = await create(tx, {
        title: "Подготовить отчёт",
        assignees: [b, d],
        mode: "separate",
        source: { chat_id: chat, seq: m.seq },
      });
      expect(r.tasks).toHaveLength(2);
      const page = (await tx`select * from chat_messages_page(${chat})`) as { chat_messages_page: Record<string, unknown> }[];
      const last = page.map((x) => Object.values(x)[0] as { kind: string; content: { system?: Record<string, unknown> } }).at(-1)!;
      expect(last.kind).toBe("system");
      expect(last.content.system?.type).toBe("task_created");
      expect(last.content.system?.numbers).toEqual(r.tasks.map((t) => t.number));
      expect(last.content.system?.seq).toBe(m.seq);
      // Ссылка на сообщение — участнику чата; исполнитель вне чата её не получает.
      expect((await get(tx, r.tasks[0].number)).source).toEqual({ chat_id: chat, seq: m.seq });
      await as(tx, d);
      expect((await get(tx, r.tasks[1].number)).source ?? null).toBeNull();
    });
  });

  test("результат: пишет исполнитель, «Нужен результат» не даёт завершить без него", async () => {
    await scenario(async (tx) => {
      const { a, b, d } = await people(tx);
      await as(tx, a);
      const t = (await create(tx, { title: "Сверка", assignees: [b], result_required: true })).tasks[0];
      await as(tx, b);
      expect(await failure(tx, () => tx`select task_set_status(${t.id}, 'complete')`)).toContain(
        "task_result_required",
      );
      await as(tx, d);
      expect(await failure(tx, () => tx`select task_set_result(${t.id}, 'x')`)).toContain("task_not_found");
      await as(tx, b);
      await tx`select task_set_result(${t.id}, ${"  Сверено, расхождений нет  "})`;
      await tx`select task_set_status(${t.id}, 'complete')`;
      const done = await get(tx, t.number);
      expect(done.status).toBe("done");
      expect(done.result?.text).toBe("Сверено, расхождений нет");
      expect(done.result?.by).toBe(b);
      expect((await history(tx, t.id)).some((e) => e.kind === "result")).toBe(true);
      // Снять «Нужен результат» — только постановщик.
      expect(
        await failure(tx, () => tx`select task_update(${t.id}, '{"result_required": false}'::jsonb)`),
      ).toContain("task_forbidden");
      await as(tx, a);
      await tx`select task_update(${t.id}, '{"result_required": false}'::jsonb)`;
      expect((await get(tx, t.number)).result_required).toBe(false);
    });
  });

  test("список: срочные первыми, новые первыми", async () => {
    await scenario(async (tx) => {
      const { a } = await people(tx);
      await as(tx, a);
      const soon = new Date(Date.now() + 3600_000).toISOString();
      const later = new Date(Date.now() + 86400_000).toISOString();
      await create(tx, { title: "Ранний срок", deadline: soon });
      await create(tx, { title: "Срочная", deadline: later, urgent: true });
      await create(tx, { title: "Без срока" });
      expect((await list(tx)).map((t) => t.title)).toEqual(["Ранний срок", "Срочная", "Без срока"]);
      expect((await list(tx, { sort: "urgent" })).map((t) => t.title)).toEqual([
        "Срочная",
        "Ранний срок",
        "Без срока",
      ]);
      expect((await list(tx, { sort: "created" })).map((t) => t.title)).toEqual([
        "Без срока",
        "Срочная",
        "Ранний срок",
      ]);
    });
  });
});
