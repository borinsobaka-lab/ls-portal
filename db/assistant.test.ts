/**
 * Тесты AI-ассистента Kate в базе (db/migrations/2026-10-19_zz_assistant_kate.sql,
 * 2026-10-20_assistant_single_thread.sql): переписка — только своя, только у
 * сотрудника и одна на сотрудника; сводки для Kate
 * (приложение, давно не был, дни рождения) — только сотрудник клуба, клиенты
 * базы клуба (у пакетного — общая база пакетных клубов).
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

type Row = Record<string, unknown>;

describe.skipIf(!url)("AI-ассистент Kate (база)", () => {
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

  /** Учётная запись в обход handle_new_user (тот пускает только по карточке). */
  async function user(tx: Tx, email: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function studio(tx: Tx, format: "packages" | "subscription" = "packages"): Promise<string> {
    const [{ id }] = await tx`insert into studios (name, format) values ('Тест', ${format}) returning id`;
    return id as string;
  }

  async function client(
    tx: Tx,
    studioId: string,
    opts: { app?: boolean; last?: string; birthday?: string } = {},
  ): Promise<{ client: string; user: string | null }> {
    const email = `c-${crypto.randomUUID()}@example.com`;
    const userId = opts.app === false ? null : await user(tx, email);
    const [{ id }] = await tx`
      insert into clients (studio_id, full_name, last_name, first_name, email, user_id, birthday)
      values (${studioId}, 'Клиент', ${opts.last ?? "Клиент"}, 'Тест', ${email}, ${userId},
              ${opts.birthday ?? null}) returning id`;
    return { client: id as string, user: userId };
  }

  async function staff(tx: Tx, studioId: string): Promise<string> {
    const id = await user(tx, `staff-${crypto.randomUUID()}@example.com`);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin')`;
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

  async function rpc(tx: Tx, as_: string, call: (tx: Tx) => Promise<Row[]>): Promise<Row[]> {
    await as(tx, as_);
    const [{ v }] = await call(tx);
    await asServer(tx);
    return v as Row[];
  }

  test("переписка: одна и своя у каждого, клиенту не завести, сообщение поднимает диалог", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await staff(tx, s);
      const b = await staff(tx, s);
      const c = await client(tx, s);

      await as(tx, a);
      const [t] = await tx`insert into assistant_threads (studio_id, title) values (${s}, 'Кто продлится?')
                           returning id, user_id, updated_at`;
      expect(t.user_id).toBe(a);
      // Второй диалог не завести: переписка у сотрудника одна.
      expect(
        await failure(tx, () => tx`insert into assistant_threads (title) values ('Ещё')`),
      ).toContain("assistant_threads_one_per_user");
      await tx`update assistant_threads set updated_at = now() - interval '1 day' where id = ${t.id}`;
      await tx`insert into assistant_messages (thread_id, id, role, parts)
               values (${t.id}, 'm1', 'user', ${[{ type: "text", text: "Привет" }]}::jsonb)`;
      const [after] = await tx`select updated_at from assistant_threads where id = ${t.id}`;
      expect(new Date(after.updated_at as string).getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );

      // Чужой диалог не виден и не правится.
      await as(tx, b);
      expect(await tx`select id from assistant_threads where id = ${t.id}`).toHaveLength(0);
      expect(await tx`select id from assistant_messages where thread_id = ${t.id}`).toHaveLength(0);
      expect(
        await failure(
          tx,
          () => tx`insert into assistant_messages (thread_id, id, role, parts)
                   values (${t.id}, 'x', 'assistant', '[]'::jsonb)`,
        ),
      ).toContain("row-level security");
      await tx`delete from assistant_threads where id = ${t.id}`;
      // Нельзя завести диалог на чужое имя.
      expect(
        await failure(tx, () => tx`insert into assistant_threads (user_id) values (${a})`),
      ).toContain("row-level security");

      // Клиент приложения — не сотрудник.
      await as(tx, c.user!);
      expect(
        await failure(tx, () => tx`insert into assistant_threads (title) values ('x')`),
      ).toContain("row-level security");
      await asServer(tx);

      const [still] = await tx`select count(*)::int as n from assistant_messages where thread_id = ${t.id}`;
      expect(still.n).toBe(1);
      // Удаление диалога уносит сообщения.
      await as(tx, a);
      await tx`delete from assistant_threads where id = ${t.id}`;
      await asServer(tx);
      const [gone] = await tx`select count(*)::int as n from assistant_messages where thread_id = ${t.id}`;
      expect(gone.n).toBe(0);
    });
  });

  test("сводки: только сотрудник клуба; пакетный клуб видит общую базу", async () => {
    await scenario(async (tx) => {
      const p1 = await studio(tx);
      const p2 = await studio(tx);
      const sub = await studio(tx, "subscription");
      const admin = await staff(tx, p1);
      const subAdmin = await staff(tx, sub);
      const inP2 = await client(tx, p2, { last: "Второй" });
      const inSub = await client(tx, sub, { last: "Подписка" });

      const listed = await rpc(tx, admin, (t) => t`select assistant_app_clients(${p1}) as v`);
      const ids = listed.map((r) => r.client_id);
      expect(ids).toContain(inP2.client);
      expect(ids).not.toContain(inSub.client);

      // Чужой клуб — отказ.
      await as(tx, subAdmin);
      expect(await failure(tx, () => tx`select assistant_app_clients(${p1})`)).toContain(
        "Нет доступа к клубу",
      );
      expect(await failure(tx, () => tx`select assistant_inactive_members(${p1})`)).toContain(
        "Нет доступа к клубу",
      );
      expect(await failure(tx, () => tx`select assistant_birthdays(${p1})`)).toContain(
        "Нет доступа к клубу",
      );
      // Клиенту приложения — тоже.
      await as(tx, inP2.user!);
      expect(await failure(tx, () => tx`select assistant_birthdays(${p2})`)).toContain(
        "Нет доступа к клубу",
      );
      // Внутренний помощник наружу не выдан.
      expect(await failure(tx, () => tx`select assistant_client_scope(${p2})`)).toContain(
        "permission denied",
      );
      await asServer(tx);

      const subList = await rpc(tx, subAdmin, (t) => t`select assistant_app_clients(${sub}) as v`);
      expect(subList.map((r) => r.client_id)).toEqual([inSub.client]);
    });
  });

  test("приложение: новые сверху, последний вход и просмотры абонементов за 30 дней", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const old = await client(tx, s, { last: "Старый" });
      const fresh = await client(tx, s, { last: "Новый" });
      await client(tx, s, { app: false, last: "Безприложения" });
      await tx`update auth.users set created_at = now() - interval '40 days' where id = ${old.user}`;

      await as(tx, fresh.user!);
      await tx`select app_ping('device-0001', 'packages', '{"platform":"ios"}'::jsonb,
                               '{"memberships": 3, "home": 1}'::jsonb)`;
      await asServer(tx);

      const byRegistered = await rpc(tx, admin, (t) => t`select assistant_app_clients(${s}) as v`);
      expect(byRegistered.map((r) => r.client_name)).toEqual(["Новый Тест", "Старый Тест"]);
      expect(byRegistered[0]).toMatchObject({ membership_views_30d: 3, sessions_30d: 1 });
      expect(byRegistered[0].sort_at).toBeUndefined();

      const since = await rpc(
        tx,
        admin,
        (t) => t`select assistant_app_clients(${s}, 'registered', current_date - 7) as v`,
      );
      expect(since.map((r) => r.client_name)).toEqual(["Новый Тест"]);

      const views = await rpc(
        tx,
        admin,
        (t) => t`select assistant_app_clients(${s}, 'membership_views') as v`,
      );
      expect(views.map((r) => r.client_name)).toEqual(["Новый Тест"]);

      const seen = await rpc(tx, admin, (t) => t`select assistant_app_clients(${s}, 'last_seen') as v`);
      expect(seen.map((r) => r.client_name)).toEqual(["Новый Тест"]);

      await as(tx, admin);
      expect(
        await failure(tx, () => tx`select assistant_app_clients(${s}, 'other')`),
      ).toContain("Неизвестная сортировка");
    });
  });

  test("давно не был: действующий абонемент без посещений N дней, ожидающий первого посещения", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const [{ id: plan }] = await tx`
        insert into memberships (studio_id, name, visits_count, duration_days, price)
        values (${s}, 'Пакет 8', 8, 30, 100) returning id`;
      const member = async (last: string, opts: { visitDaysAgo?: number; awaiting?: boolean } = {}) => {
        const c = await client(tx, s, { last });
        await tx`
          insert into client_memberships (studio_id, client_id, membership_id, status, started_at,
                                          ends_at, visits_left, starts_on_first_visit)
          values (${s}, ${c.client}, ${plan}, 'active',
                  ${opts.awaiting ? null : tx`current_date - 20`},
                  ${opts.awaiting ? null : tx`current_date + 10`}, 5, ${!!opts.awaiting})`;
        if (opts.visitDaysAgo !== undefined) {
          await tx`
            insert into bookings_log (studio_id, client_id, starts_at, ends_at, status)
            values (${s}, ${c.client}, now() - make_interval(days => ${opts.visitDaysAgo}),
                    now() - make_interval(days => ${opts.visitDaysAgo}) + interval '1 hour', 'attended')`;
        }
        return c.client;
      };
      const recent = await member("Ходит", { visitDaysAgo: 2 });
      const lapsed = await member("Пропал", { visitDaysAgo: 20 });
      const never = await member("Ждёт", { awaiting: true });

      const rows = await rpc(tx, admin, (t) => t`select assistant_inactive_members(${s}, 14) as v`);
      const ids = rows.map((r) => r.client_id);
      expect(ids).not.toContain(recent);
      // Ни разу не был — первым.
      expect(ids).toEqual([never, lapsed]);
      expect(rows[0]).toMatchObject({ membership_state: "awaiting", visits_total: 0 });
      expect(rows[1]).toMatchObject({ membership_name: "Пакет 8", days_since_visit: 20 });
    });
  });

  test("дни рождения: в ближайшие N дней, с возрастом", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const [{ d0, d3, d30 }] = await tx`
        select ((now() at time zone 'Asia/Tbilisi')::date - interval '30 years')::date::text as d0,
               ((now() at time zone 'Asia/Tbilisi')::date + 3 - interval '25 years')::date::text as d3,
               ((now() at time zone 'Asia/Tbilisi')::date + 30 - interval '20 years')::date::text as d30`;
      await client(tx, s, { last: "Сегодня", birthday: d0 as string });
      await client(tx, s, { last: "Скоро", birthday: d3 as string });
      await client(tx, s, { last: "Нескоро", birthday: d30 as string });

      const rows = await rpc(tx, admin, (t) => t`select assistant_birthdays(${s}, 7) as v`);
      expect(rows.map((r) => [r.client_name, r.turns])).toEqual([
        ["Сегодня Тест", 30],
        ["Скоро Тест", 25],
      ]);
    });
  });
});
