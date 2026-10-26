/**
 * Тесты обратной связи в базе (db/migrations/2026-10-15_zz_feedback_in_app.sql):
 * форма приложения и публичная ссылка (anon) только присылают новое
 * обращение в клуб; читают и отрабатывают — сотрудники.
 *
 * Нужна база с полной схемой — как для db/packages.test.ts:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;

class Rollback extends Error {}

describe.skipIf(!url)("обратная связь (база)", () => {
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

  async function user(tx: Tx, email: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function studio(tx: Tx): Promise<string> {
    const [{ id }] =
      await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
    return id as string;
  }

  async function as(tx: Tx, userId: string) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }

  async function asAnon(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
    await tx`set local role anon`;
  }

  async function asOwner(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  test("без входа: новое обращение в клуб, отработку и дату не подделать", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      await asAnon(tx);
      await tx`
        insert into feedback (studio_id, topic, message, mood, status, resolution_comment, resolved_by_name, created_at, source)
        values (${s}, 'thanks', 'Спасибо!', 'positive', 'resolved', 'готово', 'Кто-то', '2020-01-01', 'portal')`;
      // Прочитать даже своё обращение нельзя.
      expect(await failure(tx, () => tx`select * from feedback`)).toContain("permission denied");
      await asOwner(tx);
      const [row] = await tx`select * from feedback where studio_id = ${s}`;
      expect(row.status).toBe("pending");
      expect(row.source).toBe("link");
      expect(row.resolution_comment).toBeNull();
      expect(row.resolved_by_name).toBeNull();
      expect(new Date(row.created_at).getFullYear()).toBeGreaterThan(2020);
    });
  });

  test("без клуба и с пустым текстом — отказ", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      await asAnon(tx);
      expect(
        await failure(tx, () => tx`insert into feedback (topic, message) values ('idea', 'Идея')`),
      ).toContain("row-level security");
      expect(
        await failure(
          tx,
          () => tx`insert into feedback (studio_id, topic, message) values (${s}, 'idea', '   ')`,
        ),
      ).toContain("feedback_lengths_check");
      expect(
        await failure(
          tx,
          () => tx`insert into feedback (studio_id, topic, message) values (${s}, 'nope', 'Текст')`,
        ),
      ).toContain("check");
    });
  });

  test("клиент приложения: источник app, читать и отрабатывать нельзя; сотрудник — может", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const client = await user(tx, `c-${crypto.randomUUID()}@example.com`);
      const staff = await user(tx, `s-${crypto.randomUUID()}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s}, 'admin')`;

      await as(tx, client);
      await tx`insert into feedback (studio_id, topic, message) values (${s}, 'app', 'Не грузится расписание')`;
      expect(await tx`select * from feedback`).toHaveLength(0);
      await tx`update feedback set status = 'resolved'`;
      await tx`delete from feedback`;

      await as(tx, staff);
      const [row] = await tx`select * from feedback where studio_id = ${s}`;
      expect(row.source).toBe("app");
      expect(row.status).toBe("pending");
      await tx`update feedback set status = 'resolved', resolved_by_name = 'Админ' where id = ${row.id}`;
      // Сотрудник добавляет обращение из админки как есть.
      await tx`insert into feedback (studio_id, topic, message, source) values (${s}, 'other', 'Звонок', 'portal')`;
      const rows =
        await tx`select status, source from feedback where studio_id = ${s} order by source`;
      expect(rows.map((r: { source: string }) => r.source)).toEqual(["app", "portal"]);
      expect(rows[0].status).toBe("resolved");
    });
  });
  test("сотрудник-клиент из приложения — обращение «из приложения», как у клиента", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const staff = await user(tx, `s-${crypto.randomUUID()}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s}, 'trainer')`;
      await as(tx, staff);
      // Форма приложения источник не передаёт; статус и дату не подделать.
      await tx`
        insert into feedback (studio_id, topic, message, status, created_at)
        values (${s}, 'app', 'Из приложения', 'resolved', '2020-01-01')`;
      await tx`insert into feedback (studio_id, topic, message, source) values (${s}, 'other', 'Звонок', 'portal')`;
      await asOwner(tx);
      const rows = await tx`
        select source, status, created_at from feedback where studio_id = ${s} order by source`;
      expect(rows.map((r: { source: string }) => r.source)).toEqual(["app", "portal"]);
      expect(rows[0].status).toBe("pending");
      expect(new Date(rows[0].created_at).getFullYear()).toBeGreaterThan(2020);
    });
  });
});
