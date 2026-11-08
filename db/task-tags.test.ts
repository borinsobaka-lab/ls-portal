/**
 * Тесты тегов задач (db/migrations/2026-11-08_zzzzzzzzz_task_tags.sql): общий
 * тег по имени без регистра и «#», правка — автору, теги задачи — участникам,
 * до 10, фильтр списка, история.
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

describe.skipIf(!url)("теги задач (база)", () => {
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

  const tag = async (tx: Tx, name: string, color: string | null = null) => {
    const [{ id }] = await tx`select task_tag_save(null, ${name}, ${color}) as id`;
    return id as string;
  };

  test("теги: общие, без повторов, правит автор, у задачи — участники", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const kazan = await tag(tx, "  #Казань ", "blue");
      expect(await tag(tx, "казань")).toBe(kazan);
      const vk = await tag(tx, "VK");
      expect(await failure(tx, () => tx`select task_tag_save(null, '   ', null)`)).toContain("task_tag_invalid");
      const t1 = (await create(tx, { title: "Афиша", assignees: [b] })).tasks[0];
      const t2 = (await create(tx, { title: "Таргет", assignees: [c] })).tasks[0];
      // Исполнитель ставит теги, посторонний — нет.
      await as(tx, b);
      const [{ r }] = await tx`select task_set_tags(${t1.id}, ${[kazan, vk]}::uuid[]) as r`;
      expect((r as { tags: { name: string }[] }).tags.map((x) => x.name)).toEqual(["VK", "Казань"]);
      await as(tx, d);
      expect(await failure(tx, () => tx`select task_set_tags(${t1.id}, ${[vk]}::uuid[])`)).toContain(
        "task_not_found",
      );
      // Переименовать чужой тег нельзя.
      expect(await failure(tx, () => tx`select task_tag_save(${kazan}, 'Казань-2', null)`)).toContain(
        "task_tag_forbidden",
      );
      // Фильтр списка.
      await as(tx, a);
      await tx`select task_set_tags(${t2.id}, ${[vk]}::uuid[])`;
      const byKazan = await list(tx, { tag: kazan });
      expect(byKazan.map((x) => x.title)).toEqual(["Афиша"]);
      expect((await list(tx, { tag: vk })).map((x) => x.title).sort()).toEqual(["Афиша", "Таргет"]);
      // В истории — «теги».
      const hist = await tx`select kind, data from task_history(${t1.id})`;
      expect(hist.some((e: { kind: string }) => e.kind === "tags")).toBe(true);
      // Список тегов со счётчиком; удалить свой — снимается с задач.
      const [{ l }] = await tx`select task_tags_list() as l`;
      expect((l as { name: string; count: number }[]).map((x) => [x.name, x.count])).toEqual([
        ["VK", 2],
        ["Казань", 1],
      ]);
      await tx`select task_tag_delete(${vk})`;
      expect((await get(tx, t2.number)).title).toBe("Таргет");
      const [{ r: t2json }] = await tx`select task_get(${t2.number}) as r`;
      expect((t2json as { tags: unknown[] }).tags).toEqual([]);
    });
  });

  test("не больше 10 тегов", async () => {
    await scenario(async (tx) => {
      const { a } = await people(tx);
      await as(tx, a);
      const ids: string[] = [];
      for (let i = 0; i < 11; i++) ids.push(await tag(tx, `Тег ${i}`));
      const t = (await create(tx, { title: "Много тегов" })).tasks[0];
      expect(await failure(tx, () => tx`select task_set_tags(${t.id}, ${ids}::uuid[])`)).toContain(
        "task_too_many_tags",
      );
      await tx`select task_set_tags(${t.id}, ${ids.slice(0, 10)}::uuid[])`;
    });
  });
});
