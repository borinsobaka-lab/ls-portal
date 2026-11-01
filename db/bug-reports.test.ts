/**
 * Тесты «Сообщить об ошибке» (db/migrations/2026-11-01_portal_bug_reports.sql):
 * отправляет только человек портала, таблица закрыта браузеру, читает и
 * отмечает только суперадминистратор (portal.admin), лимит в час.
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

class Rollback extends Error {}

describe.skipIf(!url)("сообщения об ошибках (база)", () => {
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
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function staff(tx: Tx, name = "Сотрудник"): Promise<string> {
    const [{ id: studioId }] =
      await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studioId}, ${name}, 'staff@example.com')
             on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
    return id;
  }

  async function superadmin(tx: Tx): Promise<string> {
    const id = await user(tx);
    await tx`set local session_replication_role = replica`;
    await tx`insert into access_user_rights (user_id, portal, rights) values (${id}, true, '{portal.admin}')`;
    await tx`set local session_replication_role = origin`;
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

  const submit = (tx: Tx, message = "Не открывается статья") =>
    tx`select portal_bug_report_submit('/kb/1', 'База знаний', ${message}, '1.40', 'UA', '390×844') as id`;

  test("сотрудник отправляет, снимок имени и страницы", async () => {
    await scenario(async (tx) => {
      const s = await staff(tx, "Иванова Анна");
      await as(tx, s);
      const [{ id }] = await submit(tx);
      expect(id).toBeTruthy();
      await asServer(tx);
      const [row] = await tx`select * from portal_bug_reports where id = ${id}`;
      expect(row.user_id).toBe(s);
      expect(row.author_name).toBe("Иванова Анна");
      expect(row.author_email).toBe("staff@example.com");
      expect(row.page_path).toBe("/kb/1");
      expect(row.viewport).toBe("390×844");
      expect(row.resolved_at).toBeNull();
    });
  });

  test("не человек портала и пустой текст — отказ", async () => {
    await scenario(async (tx) => {
      const stranger = await user(tx);
      await as(tx, stranger);
      expect(await failure(tx, () => submit(tx))).toContain("forbidden");
      await asServer(tx);
      const s = await staff(tx);
      await as(tx, s);
      expect(await failure(tx, () => submit(tx, "   "))).toContain("bug_report_empty");
    });
  });

  test("таблица закрыта браузеру, список — только суперадминистратору", async () => {
    await scenario(async (tx) => {
      const s = await staff(tx);
      const admin = await superadmin(tx);
      await as(tx, s);
      const [{ id }] = await submit(tx);
      expect(await failure(tx, () => tx`select * from portal_bug_reports`)).toContain("permission");
      expect(await failure(tx, () => tx`select * from portal_bug_reports_list(null)`)).toContain(
        "forbidden",
      );
      expect(
        await failure(tx, () => tx`select portal_bug_report_resolve(${id}, true)`),
      ).toContain("forbidden");
      const [{ n: zero }] = await tx`select portal_bug_reports_open_count() as n`;
      expect(zero).toBe(0);

      await asServer(tx);
      await as(tx, admin);
      const [{ n }] = await tx`select portal_bug_reports_open_count() as n`;
      expect(n).toBeGreaterThanOrEqual(1);
      const open = await tx`select id from portal_bug_reports_list('open')`;
      expect(open.map((r: { id: string }) => r.id)).toContain(id);

      await tx`select portal_bug_report_resolve(${id}, true)`;
      const resolved = await tx`select id, resolved_at from portal_bug_reports_list('resolved')`;
      expect(resolved.map((r: { id: string }) => r.id)).toContain(id);
      const stillOpen = await tx`select id from portal_bug_reports_list('open')`;
      expect(stillOpen.map((r: { id: string }) => r.id)).not.toContain(id);

      await tx`select portal_bug_report_resolve(${id}, false)`;
      await tx`select portal_bug_report_delete(${id})`;
      const all = await tx`select id from portal_bug_reports_list(null)`;
      expect(all.map((r: { id: string }) => r.id)).not.toContain(id);
    });
  });

  test("не больше 20 сообщений в час", async () => {
    await scenario(async (tx) => {
      const s = await staff(tx);
      await as(tx, s);
      for (let i = 0; i < 20; i++) await submit(tx, `Ошибка ${i}`);
      expect(await failure(tx, () => submit(tx))).toContain("bug_report_rate_limit");
    });
  });
});
