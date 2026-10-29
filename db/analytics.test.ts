/**
 * Тесты фундамента «Аналитики» (db/migrations/2026-10-29_z_analytics_core.sql,
 * ANALYTICS_PLAN.md): что открыто человеку — их allowed_dashboards
 * (администратор, таргетолог, партнёр, сотрудник), режимы модулей только
 * администратору, ключи интеграций закрыты браузеру, аренда фоновых задач,
 * приём синхронизации (upsert по ключу и удаление), люди старого портала —
 * список с типами и перенос (города, карточка, связь).
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
      // Колонки, которых нет в пачке (свои у портала), не перезаписываются;
      // лишние поля строки — пропускаются.
      const rows3 = [{ id: 2, name: "Бийск", extra: "x" }];
      await tx`select an_replica_apply('an_test_target', ${rows3}::jsonb, null)`;
      const [kept] = await tx`select name, n from an_test_target where id = 2`;
      expect([kept.name, kept.n]).toEqual(["Бийск", 5]);
      expect(
        await failure(tx, () => tx`select an_replica_apply('an_test_target', '[{"x": 1}]'::jsonb, null)`),
      ).toContain("an_replica_no_columns");
      expect(
        await failure(tx, () => tx`select an_replica_apply('profiles', '[]'::jsonb, null)`),
      ).toContain("an_replica_unknown_target");
    });
  });

  async function legacyUser(
    tx: Tx,
    id: number,
    login: string,
    fullName: string,
    extra: { role?: string; targetologist?: boolean; leadManager?: boolean } = {},
  ) {
    await tx`insert into an_legacy_users (id, login, full_name, role, created_at, is_targetologist, is_lead_manager)
             values (${id}, ${login}, ${fullName}, ${extra.role ?? "viewer"}, 1760000000,
                     ${extra.targetologist ? 1 : 0}, ${extra.leadManager ? 1 : 0})`;
  }

  test("люди старого портала: типы по их приоритету, совпадение по почте, только администратору", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);
      const email = `p-${crypto.randomUUID().slice(0, 8)}@example.com`;
      await tx`update profiles set email = ${email} where id = ${staff}`;
      await legacyUser(tx, 9001, "boss@example.com", "Админ Старый", { role: "admin" });
      await legacyUser(tx, 9002, email.toUpperCase(), "ИП Иванова Анна Сергеевна");
      await tx`insert into an_legacy_partner_cities (user_id, city) values (9002, 'Абакан')`;
      await legacyUser(tx, 9003, "t@example.com", "Таргетолог", { targetologist: true });
      await legacyUser(tx, 9004, "lm@example.com", "Лид", { leadManager: true });
      await legacyUser(tx, 9005, "login-without-mail", "Сотрудник Старый");
      await tx`insert into an_legacy_dashboard_access (user_id, dashboard_name)
               values (9005, 'revenue_city_dashboard.html'), (9005, 'reviews')`;
      await tx`insert into an_legacy_sessions (id, user_id, created_at, last_seen_at)
               values (1, 9005, 1760000000, 1760000600)`;

      await as(tx, admin);
      const [{ list }] = await tx`select an_legacy_people() as list`;
      await asServer(tx);
      const byId = new Map((list as { id: number }[]).map((x) => [x.id, x as Record<string, unknown>]));
      expect(byId.get(9001)!.kind).toBe("admin");
      expect(byId.get(9002)!.kind).toBe("partner");
      expect(byId.get(9002)!.cities).toEqual(["Абакан"]);
      expect(byId.get(9002)!.match_user_id).toBe(staff);
      expect(byId.get(9002)!.match_in_portal).toBe(true);
      expect(byId.get(9003)!.kind).toBe("targetologist");
      expect(byId.get(9004)!.kind).toBe("lead_manager");
      expect(byId.get(9005)!.kind).toBe("staff");
      expect(byId.get(9005)!.grants).toEqual(["revenue_city_dashboard.html", "reviews"]);
      expect(byId.get(9005)!.match_user_id).toBeNull();
      expect(byId.get(9005)!.last_seen_at).not.toBeNull();

      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_legacy_people()`)).toContain("an_forbidden");
      await asServer(tx);
    });
  });

  test("перенос: города, карточка и условия партнёра — один раз, связь; только суперадминистратору", async () => {
    await scenario(async (tx) => {
      const sa = await person(tx, "Супер", ["portal.admin"]);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const partner = await person(tx, "Партнёр Новый", ["an.partner"]);
      await legacyUser(tx, 9101, "p@example.com", "ИП Петрова Ольга Ивановна");
      await tx`insert into an_legacy_partner_cities (user_id, city) values (9101, 'Абакан'), (9101, 'Бийск')`;
      await tx`insert into an_legacy_partner_profiles (user_id, individual_entrepreneur, inn)
               values (9101, 'ИП Петрова', '')`;
      await tx`insert into an_legacy_partner_city_settings (user_id, city, trial_price, directions)
               values (9101, 'Абакан', '', 'Растяжка')`;
      await tx`insert into an_partner_cities (user_id, city) values (${partner}, 'Барнаул')`;

      await as(tx, admin);
      expect(await failure(tx, () => tx`select an_legacy_link(9101, ${partner})`)).toContain("an_forbidden");
      await as(tx, sa);
      await tx`select an_legacy_link(9101, ${partner})`;
      await tx`select an_legacy_link(9101, ${partner})`;
      await asServer(tx);

      const cities = await tx`select city from an_partner_cities where user_id = ${partner} order by city`;
      expect(cities.map((c: { city: string }) => c.city)).toEqual(["Абакан", "Барнаул", "Бийск"]);
      const [prof] = await tx`select individual_entrepreneur, inn from an_partner_profiles where user_id = ${partner}`;
      expect(prof.individual_entrepreneur).toBe("ИП Петрова");
      expect(prof.inn).toBeNull();
      const [set] = await tx`select trial_price, directions from an_partner_city_settings where user_id = ${partner}`;
      expect([set.trial_price, set.directions]).toEqual([null, "Растяжка"]);
      const [link] = await tx`select user_id, imported_by from an_legacy_users where id = 9101`;
      expect([link.user_id, link.imported_by]).toEqual([partner, sa]);
      const [{ n }] = await tx`select count(*)::int as n from access_log
                               where action = 'analytics.import' and target_user = ${partner}`;
      expect(n).toBe(2);

      const other = await person(tx, "Другой", []);
      await as(tx, sa);
      expect(await failure(tx, () => tx`select an_legacy_link(9101, ${other})`)).toContain("an_legacy_linked");
      await asServer(tx);
      // Синхронизация не трогает связь (её колонок агент не присылает).
      await tx`select an_replica_apply('an_legacy_users',
        '[{"id": 9101, "login": "p@example.com", "full_name": "ИП Петрова Ольга Ивановна", "role": "viewer",
           "is_active": 0, "created_at": 1760000000}]'::jsonb, null)`;
      const [after] = await tx`select user_id, is_active from an_legacy_users where id = 9101`;
      expect([after.user_id, after.is_active]).toEqual([partner, 0]);
    });
  });

  test("таргетолог, перенесённый со старого портала, — ФИО оттуда (ключ назначений)", async () => {
    await scenario(async (tx) => {
      const t = await person(tx, "Сидорова Мария", ["an.targetologist"]);
      expect((await me(tx, t)).targetologist).toBe("Сидорова Мария");
      await legacyUser(tx, 9201, "t2@example.com", "Сидорова Мария Петровна", { targetologist: true });
      await tx`update an_legacy_users set user_id = ${t} where id = 9201`;
      expect((await me(tx, t)).targetologist).toBe("Сидорова Мария Петровна");
    });
  });

  test("перенос, как делает сервер: регистрация, стартовая роль или личные права, связь → an_me", async () => {
    await scenario(async (tx) => {
      const sa = await person(tx, "Супер", ["portal.admin"]);
      // Учётная запись, как createStaffAccount: auth.users + профиль, без portal_users.
      async function account(name: string): Promise<string> {
        await tx`set local session_replication_role = replica`;
        const [{ id }] = await tx`
          insert into auth.users (email) values (${`n-${crypto.randomUUID()}@example.com`}) returning id`;
        await tx`set local session_replication_role = origin`;
        const [{ sid }] = await tx`select studio_id as sid from profiles where id = ${sa}`;
        await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${sid}, ${name})
                 on conflict (id) do update set full_name = excluded.full_name`;
        return id as string;
      }
      await legacyUser(tx, 9301, "p1@example.com", "ИП Орлова Вера Павловна");
      await tx`insert into an_legacy_partner_cities (user_id, city) values (9301, 'Абакан')`;
      await legacyUser(tx, 9302, "s1@example.com", "Лебедев Олег");

      const partner = await account("ИП Орлова Вера Павловна");
      const staff = await account("Лебедев Олег");
      const [{ role }] = await tx`select id as role from access_roles where system_key = 'an_partner'`;
      const note = "Перенесено со старого портала аналитики";
      await as(tx, sa);
      await tx`select access_user_save(${partner}, ${{
        last_name: "ИП",
        first_name: "Орлова Вера Павловна",
        user_type: "partner",
        position_id: "",
        note,
      }}::jsonb)`;
      await tx`select access_assignment_save(${{
        role_id: role,
        subject_type: "user",
        user_id: partner,
        scope_type: "all",
        scope_ids: [],
        note,
      }}::jsonb)`;
      await tx`select an_legacy_link(9301, ${partner})`;
      await tx`select access_user_save(${staff}, ${{ user_type: "hq", position_id: "", note }}::jsonb)`;
      await tx`select access_personal_save(${staff}, ${[
        { perm_key: "an.mkt.lj", target_id: null, level: "on" },
        { perm_key: "an.reviews", target_id: null, level: "on" },
      ]}::jsonb)`;
      await tx`select an_legacy_link(9302, ${staff})`;
      await asServer(tx);
      await tx`select access_flush()`;

      const [pu] = await tx`select user_type from portal_users where user_id = ${partner}`;
      expect(pu.user_type).toBe("partner");
      const [prof] = await tx`select full_name from profiles where id = ${partner}`;
      expect(prof.full_name).toBe("ИП Орлова Вера Павловна");
      const mp = await me(tx, partner);
      expect(mp.partner_cities).toEqual(["Абакан"]);
      expect([...mp.reports].sort()).toEqual(["mkt.ls", "onec.mycity", "reviews"]);
      const ms = await me(tx, staff);
      expect([...ms.reports].sort()).toEqual(["mkt.lj", "reviews"]);
      expect(ms.partner_cities).toBeNull();
    });
  });
});
