/**
 * Тесты входа по логину Platrum (db/migrations/2026-11-01_zz_portal_logins.sql):
 * таблица закрыта браузеру, логин уникален без регистра, логин видят сам
 * человек и тот, кто им управляет, после 10 неверных паролей — закрыт.
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

const HASH = "scrypt$16384$8$1$AAAA$BBBB";

describe.skipIf(!url)("вход по логину Platrum (база)", () => {
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

  async function superadmin(tx: Tx): Promise<string> {
    const id = await user(tx);
    await tx`set local session_replication_role = replica`;
    await tx`insert into access_user_rights (user_id, portal, rights, manage_all) values (${id}, true, '{portal.admin,users.manage}', true)`;
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

  test("логин уникален без регистра, без пробелов, хэш — только scrypt", async () => {
    await scenario(async (tx) => {
      const a = await user(tx);
      const b = await user(tx);
      await tx`insert into portal_logins (user_id, login, password_hash) values (${a}, 'Ivanova', ${HASH})`;
      expect(
        await failure(
          tx,
          () =>
            tx`insert into portal_logins (user_id, login, password_hash) values (${b}, 'ivanova', ${HASH})`,
        ),
      ).toContain("portal_logins_login_key");
      expect(
        await failure(
          tx,
          () =>
            tx`insert into portal_logins (user_id, login, password_hash) values (${b}, 'iva nova', ${HASH})`,
        ),
      ).toContain("portal_logins_login_check");
      expect(
        await failure(
          tx,
          () =>
            tx`insert into portal_logins (user_id, login, password_hash) values (${b}, 'petrova', 'plain')`,
        ),
      ).toContain("portal_logins_hash_check");
    });
  });

  test("таблица закрыта браузеру, логин — себе и управляющему", async () => {
    await scenario(async (tx) => {
      const person = await user(tx);
      const stranger = await user(tx);
      const admin = await superadmin(tx);
      await tx`insert into portal_logins (user_id, login, password_hash) values (${person}, 'petrova', ${HASH})`;

      await as(tx, person);
      expect(await failure(tx, () => tx`select * from portal_logins`)).toContain("permission");
      const own = await tx`select * from portal_login_info(${person})`;
      expect(own[0].login).toBe("petrova");
      expect(Object.keys(own[0])).not.toContain("password_hash");
      expect(await failure(tx, () => tx`select portal_login_failed(${person})`)).toContain(
        "permission",
      );

      await asServer(tx);
      await as(tx, stranger);
      expect(await failure(tx, () => tx`select * from portal_login_info(${person})`)).toContain(
        "forbidden",
      );

      await asServer(tx);
      await as(tx, admin);
      const seen = await tx`select * from portal_login_info(${person})`;
      expect(seen[0].login).toBe("petrova");
    });
  });

  test("10 неверных паролей подряд — логин закрыт", async () => {
    await scenario(async (tx) => {
      const person = await user(tx);
      await tx`insert into portal_logins (user_id, login, password_hash) values (${person}, 'petrova', ${HASH})`;
      for (let i = 1; i <= 9; i++) {
        const [{ until }] = await tx`select portal_login_failed(${person}) as until`;
        expect(until).toBeNull();
      }
      const [{ until }] = await tx`select portal_login_failed(${person}) as until`;
      expect(until).not.toBeNull();
      const [row] =
        await tx`select failed_count, locked_until > now() as locked from portal_logins where user_id = ${person}`;
      expect(row.failed_count).toBe(0);
      expect(row.locked).toBe(true);
    });
  });
});
