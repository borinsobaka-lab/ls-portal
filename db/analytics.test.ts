/**
 * Тесты фундамента «Аналитики» (db/migrations/2026-10-29_z_analytics_core.sql,
 * ANALYTICS_PLAN.md): что открыто человеку — их allowed_dashboards
 * (администратор, таргетолог, партнёр, сотрудник), режимы модулей только
 * администратору, ключи интеграций закрыты браузеру, аренда фоновых задач,
 * приём синхронизации (upsert по ключу и удаление).
 *
 * Нужна база с полной схемой:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;
type Me = {
  visible: boolean;
  admin: boolean;
  reports: string[];
  partner_cities: string[] | null;
  targetologist: string | null;
  inbox: boolean;
};

class Rollback extends Error {}

describe.skipIf(!url)("аналитика: фундамент (база)", () => {
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

  /** Человек портала с правами (своя роль из перечня прав). */
  async function person(tx: Tx, name: string, perms: string[]): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    // У профиля обязательна студия: людям портала без клуба — любая.
    const [{ sid }] = await tx`
      insert into studios (name, format) values (${`Клуб ${crypto.randomUUID().slice(0, 4)}`}, 'packages')
      returning id as sid`;
    await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${sid}, ${name})
             on conflict (id) do update set full_name = excluded.full_name`;
    await tx`insert into portal_users (user_id) values (${id})`;
    if (perms.length > 0) {
      const [{ id: role }] = await tx`
        insert into access_roles (name) values (${`Роль ${crypto.randomUUID().slice(0, 8)}`}) returning id`;
      for (const p of perms) {
        await tx`insert into access_role_permissions (role_id, perm_key) values (${role}, ${p})`;
      }
      await tx`insert into access_assignments (role_id, subject_type, user_id)
               values (${role}, 'user', ${id})`;
    }
    await tx`select access_flush()`;
    return id as string;
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function me(tx: Tx, userId: string): Promise<Me> {
    await as(tx, userId);
    const [{ m }] = await tx`select an_me() as m`;
    await asServer(tx);
    return m as Me;
  }

  test("администратор аналитики — все отчёты, диалоги, без ограничений", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ Аналитики", ["an.admin"]);
      const m = await me(tx, admin);
      expect(m.admin).toBe(true);
      expect(m.visible).toBe(true);
      expect(m.inbox).toBe(true);
      expect(m.reports).toContain("onec.revenue");
      expect(m.reports).toContain("reviews");
      expect(m.reports.length).toBe(17);
      expect(m.partner_cities).toBeNull();
      expect(m.targetologist).toBeNull();
    });
  });

  test("суперадминистратор — как администратор, хоть у него и права партнёра/таргетолога", async () => {
    await scenario(async (tx) => {
      const sa = await person(tx, "Супер", ["portal.admin"]);
      await tx`insert into an_partner_cities (user_id, city) values (${sa}, 'Абакан')`;
      const m = await me(tx, sa);
      expect(m.admin).toBe(true);
      expect(m.partner_cities).toBeNull();
      expect(m.targetologist).toBeNull();
      expect(m.reports.length).toBe(17);
    });
  });

  test("партнёр: «Мой город» + из выданного только маркетинг, отзывы, FitBase; свои города", async () => {
    await scenario(async (tx) => {
      const p = await person(tx, "Партнёр", [
        "an.partner",
        "an.mkt.ls",
        "an.reviews",
        "an.onec.revenue",
        "an.vk.register",
        "an.fb.sales",
      ]);
      await tx`insert into an_partner_cities (user_id, city) values (${p}, 'Барнаул'), (${p}, 'Абакан')`;
      const m = await me(tx, p);
      expect(m.admin).toBe(false);
      expect([...m.reports].sort()).toEqual(["fb.sales", "mkt.ls", "onec.mycity", "reviews"]);
      expect(m.partner_cities).toEqual(["Абакан", "Барнаул"]);
    });
  });

  test("человек с городами партнёра без права «Партнёр» — тоже партнёр (как у них)", async () => {
    await scenario(async (tx) => {
      const p = await person(tx, "Партнёр без права", ["an.onec.revenue"]);
      await tx`insert into an_partner_cities (user_id, city) values (${p}, 'Тверь')`;
      const m = await me(tx, p);
      expect(m.reports).toEqual(["onec.mycity"]);
      expect(m.partner_cities).toEqual(["Тверь"]);
    });
  });

  test("право «Партнёр» без городов — пустой список городов, а не вся сеть", async () => {
    await scenario(async (tx) => {
      const p = await person(tx, "Новый партнёр", ["an.partner", "an.mkt.ls"]);
      const m = await me(tx, p);
      expect(m.partner_cities).toEqual([]);
      expect([...m.reports].sort()).toEqual(["mkt.ls", "onec.mycity"]);
    });
  });

  test("таргетолог: реестр и маркетинг всегда + выданное; ФИО для назначений", async () => {
    await scenario(async (tx) => {
      const t = await person(tx, "Иванова Анна", ["an.targetologist", "an.avito.register"]);
      const m = await me(tx, t);
      expect([...m.reports].sort()).toEqual(["avito.register", "mkt.lj", "mkt.ls", "vk.register"]);
      expect(m.targetologist).toBe("Иванова Анна");
      expect(m.partner_cities).toBeNull();
    });
  });

  test("сотрудник — ровно выданное; лид-менеджер — только диалоги; без прав — раздела нет", async () => {
    await scenario(async (tx) => {
      const s = await person(tx, "Сотрудник", ["an.onec.revenue", "an.onec.zero"]);
      const ms = await me(tx, s);
      expect([...ms.reports].sort()).toEqual(["onec.revenue", "onec.zero"]);
      expect(ms.inbox).toBe(false);

      const lm = await person(tx, "Лид-менеджер", ["an.inbox"]);
      const ml = await me(tx, lm);
      expect(ml.reports).toEqual([]);
      expect(ml.inbox).toBe(true);
      expect(ml.visible).toBe(true);

      const kb = await person(tx, "Только база знаний", ["kb.admin"]);
      const mk = await me(tx, kb);
      expect(mk.visible).toBe(false);
    });
  });

  test("стартовые роли: партнёр — с правом «Партнёр», таргетолог — с «Таргетолог»", async () => {
    await scenario(async (tx) => {
      const perms = await tx`
        select r.system_key, array_agg(p.perm_key order by p.perm_key) as perms
          from access_roles r join access_role_permissions p on p.role_id = r.id
         where r.system_key in ('an_partner', 'an_targetologist', 'an_admin')
         group by r.system_key order by r.system_key`;
      expect(perms.map((r: { system_key: string }) => r.system_key)).toEqual([
        "an_admin",
        "an_partner",
        "an_targetologist",
      ]);
      expect(perms[1].perms).toContain("an.partner");
    });
  });

  test("режимы модулей меняет только администратор; ключи интеграций браузеру закрыты", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);

      await as(tx, staff);
      const list = (await tx`select an_modules_list() as l`)[0].l as { module: string; mode: string }[];
      expect(list.find((m) => m.module === "onec")?.mode).toBe("mirror");
      expect(
        await failure(tx, () => tx`select an_module_set('onec', 'primary')`),
      ).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select * from an_secrets`)).toContain("permission denied");
      await asServer(tx);

      await as(tx, admin);
      await tx`select an_module_set('onec', 'check')`;
      expect(await failure(tx, () => tx`select an_module_set('onec', 'oops')`)).toContain("an_bad_mode");
      await asServer(tx);
      const [{ mode }] = await tx`select mode from an_modules where module = 'onec'`;
      expect(mode).toBe("check");
    });
  });

  test("аренда задачи: второй не возьмёт, пока не завершена; итог пишется в журнал", async () => {
    await scenario(async (tx) => {
      const [{ a }] = await tx`select an_job_claim('test.job', 60) as a`;
      const [{ b }] = await tx`select an_job_claim('test.job', 60) as b`;
      expect(a).toBe(true);
      expect(b).toBe(false);
      await tx`select an_job_finish('test.job', 'success', 'Готово', '{"n": 1}'::jsonb)`;
      const [{ c }] = await tx`select an_job_claim('test.job', 60) as c`;
      expect(c).toBe(true);
      const [run] = await tx`select status, message from an_job_runs where job = 'test.job'`;
      expect(run.status).toBe("success");
      expect(run.message).toBe("Готово");
    });
  });

  test("приём синхронизации: upsert по ключу и удаление ключей", async () => {
    await scenario(async (tx) => {
      await tx`create table public.an_test_target (id integer primary key, name text, n integer)`;
      await tx`insert into an_replica_targets (target, module, key_cols)
               values ('an_test_target', 'core', '{id}')`;
      const rows1 = [
        { id: 1, name: "Абакан", n: 1 },
        { id: 2, name: "Барнаул", n: 2 },
      ];
      const [{ r }] = await tx`select an_replica_apply('an_test_target', ${rows1}::jsonb, null) as r`;
      expect(r).toEqual({ upserts: 2, deletes: 0 });
      const rows2 = [{ id: 2, name: "Барнаул", n: 5 }];
      const del = [{ id: 1 }];
      await tx`select an_replica_apply('an_test_target', ${rows2}::jsonb, ${del}::jsonb)`;
      const rows = await tx`select id, n from an_test_target order by id`;
      expect(rows.map((x: { id: number; n: number }) => [x.id, x.n])).toEqual([[2, 5]]);
      expect(
        await failure(tx, () => tx`select an_replica_apply('profiles', '[]'::jsonb, null)`),
      ).toContain("an_replica_unknown_target");
    });
  });
});
