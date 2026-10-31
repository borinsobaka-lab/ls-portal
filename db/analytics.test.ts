/**
 * Тесты фундамента «Аналитики» (db/migrations/2026-10-29_z_analytics_core.sql,
 * 2026-10-29_zz_analytics_standalone.sql, ANALYTICS_PLAN.md): что открыто
 * человеку — их allowed_dashboards (администратор, таргетолог, партнёр,
 * сотрудник), ключи интеграций и фоновые задачи закрыты браузеру, аренда
 * задач.
 *
 * Нужна база с полной схемой:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

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

  test("ключи интеграций и задачи браузеру закрыты; включает задачу только администратор", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);

      await as(tx, staff);
      expect(await failure(tx, () => tx`select * from an_secrets`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from an_job_state`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select an_job_set_enabled('vk.telegram', true)`)).toContain(
        "an_forbidden",
      );
      const [{ jobs }] = await tx`select an_jobs_list() as jobs`;
      expect(jobs).toBeNull();
      await asServer(tx);

      await as(tx, admin);
      await tx`select an_job_set_enabled('vk.telegram', true)`;
      await tx`select an_job_set_enabled('vk.telegram', false)`;
      const [{ list }] = await tx`select an_jobs_list() as list`;
      expect(
        (list as { job: string; enabled: boolean }[]).find((j) => j.job === "vk.telegram")?.enabled,
      ).toBe(false);
      await asServer(tx);
      // Выключенную задачу сервер не берёт.
      const [{ claimed }] = await tx`select an_job_claim('vk.telegram', 60) as claimed`;
      expect(claimed).toBe(false);
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
  // --- «Обработка 1С» (db/migrations/2026-10-30_analytics_onec.sql) ---------------

  async function asService(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
    await tx`set local role service_role`;
  }
  /** Объект в бакете an-onec (его кладёт браузер через Storage API). */
  async function storageObject(tx: Tx, path: string, size = 1000) {
    await tx`reset role`;
    await tx`insert into storage.objects (bucket_id, name, metadata)
             values ('an-onec', ${path}, ${{ size }})`;
  }
  const filePath = (kind: string) => `${kind}/${crypto.randomUUID()}.xlsx`;
  /** Пустая «Обработка 1С» внутри сценария (откатывается вместе с ним). */
  async function onecReset(tx: Tx) {
    await tx`reset role`;
    await tx`delete from an_onec_snapshots`;
    await tx`delete from an_onec_runs`;
    await tx`delete from an_onec_files`;
    await tx`delete from an_onec_studios`;
    await tx`delete from an_onec_nomenclature`;
    await tx`delete from an_onec_break_even`;
    await tx`delete from an_onec_refs`;
  }

  test("1С: обработка и снимок закрыты всем, кроме администратора аналитики и сервера", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_onec_overview()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select an_onec_run_start()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select * from an_onec_facts`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select * from an_onec_facts_1`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select * from an_onec_files`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select an_onec_run_claim()`)).toContain(
        "permission denied",
      );
      await asServer(tx);
      await as(tx, admin);
      expect(await failure(tx, () => tx`select an_onec_run_claim()`)).toContain(
        "permission denied",
      );
      expect(
        await failure(
          tx,
          () =>
            tx`select an_onec_snapshot_facts(1, 1, '{1}', '{2026-01-01}', '{1}', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}')`,
        ),
      ).toContain("permission denied");
      const [{ o }] = await tx`select an_onec_overview() as o`;
      expect(o.files).toEqual([]);
      expect(o.refs.nomenclature.rows).toBe(0);
      await asServer(tx);
    });
  });

  test("1С: выгрузки — одно имя на вид без регистра, замена отдаёт прежний путь; при обработке не меняются", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const p1 = filePath("sales");
      const p2 = filePath("sales");
      await storageObject(tx, p1, 5000);
      await storageObject(tx, p2, 6000);
      await as(tx, admin);
      expect(
        await failure(
          tx,
          () =>
            tx`select an_onec_file_register('sales', 'Продажи 2026г.xlsx', ${filePath("sales")}, null, false)`,
        ),
      ).toContain("an_onec_no_object");
      expect(
        await failure(
          tx,
          () => tx`select an_onec_file_register('cash', 'НДЯ.xlsx', ${p1}, null, false)`,
        ),
      ).toContain("an_onec_bad_file");
      const [{ old1 }] =
        await tx`select an_onec_file_register('sales', 'Продажи 2026г.xlsx', ${p1}, null, false) as old1`;
      expect(old1).toBeNull();
      const [{ old2 }] =
        await tx`select an_onec_file_register('sales', 'ПРОДАЖИ 2026г.xlsx', ${p2}, ${"a".repeat(64)}, true) as old2`;
      expect(old2).toBe(p1);
      const [{ o }] = await tx`select an_onec_overview() as o`;
      expect(o.files.length).toBe(1);
      expect(o.files[0]).toMatchObject({
        kind: "sales",
        name: "ПРОДАЖИ 2026г.xlsx",
        size: 6000,
        cleaned: true,
      });

      const [{ run }] = await tx`select an_onec_run_start() as run`;
      expect(Number(run)).toBeGreaterThan(0);
      expect(await failure(tx, () => tx`select an_onec_run_start()`)).toContain("an_onec_busy");
      expect(await failure(tx, () => tx`select an_onec_file_delete(${o.files[0].id})`)).toContain(
        "an_onec_busy",
      );
      expect(
        await failure(tx, () => tx`select an_onec_ref_replace('studios', '[]'::jsonb, 'edit')`),
      ).toContain("an_onec_busy");
      await asServer(tx);
    });
  });

  test("1С: запуск — очередь, ход и журнал, отмена; зависший завершается ошибкой", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      await as(tx, admin);
      await tx`select an_onec_ref_replace('studios', ${[{ studio: "Абакан Ленина", status: "Открыта", city: "Абакан", partner: null, comment: null }]}::jsonb, 'import')`;
      const [{ run }] = await tx`select an_onec_run_start() as run`;
      await asService(tx);
      const [{ c }] = await tx`select an_onec_run_claim() as c`;
      expect(Number(c.id)).toBe(Number(run));
      expect(c.studios).toEqual([
        {
          studio: "Абакан Ленина",
          status: "Открыта",
          city: "Абакан",
          partner: null,
          comment: null,
        },
      ]);
      const [{ again }] = await tx`select an_onec_run_claim() as again`;
      expect(again).toBeNull();
      const [{ cancel }] =
        await tx`select an_onec_run_progress(${run}, 'Читаю: Продажи/Продажи 2026г.xlsx', ${["Читаю: Продажи/Продажи 2026г.xlsx"]}) as cancel`;
      expect(cancel).toBe(false);
      // Журнал — не длиннее 1500 строк.
      const many = Array.from({ length: 1600 }, (_, i) => `строка ${i}`);
      await tx`select an_onec_run_progress(${run}, null, ${many})`;
      await asServer(tx);
      await as(tx, admin);
      const [{ g }] = await tx`select an_onec_run_get(${run}) as g`;
      expect(g.status).toBe("running");
      expect(g.log.length).toBe(1500);
      expect(g.log[1499]).toBe("строка 1599");
      expect(g.progress).toBe("Читаю: Продажи/Продажи 2026г.xlsx");
      await tx`select an_onec_run_cancel(${run})`;
      await asService(tx);
      const [{ cancel2 }] = await tx`select an_onec_run_progress(${run}, null, null) as cancel2`;
      expect(cancel2).toBe(true);
      await tx`select an_onec_run_fail(${run}, 'Обработка отменена.', true)`;
      const [{ st }] = await tx`select status as st from an_onec_runs where id = ${run}`;
      expect(st).toBe("cancelled");
      expect(
        await failure(tx, () => tx`select an_onec_run_progress(${run}, null, null)`),
      ).toContain("an_onec_run_gone");

      // Зависший: сервер перезапустился посреди обработки.
      await asServer(tx);
      await as(tx, admin);
      const [{ run2 }] = await tx`select an_onec_run_start() as run2`;
      await asService(tx);
      await tx`select an_onec_run_claim()`;
      await tx`reset role`;
      await tx`update an_onec_runs set heartbeat_at = now() - interval '5 minutes' where id = ${run2}`;
      await asService(tx);
      const [{ none }] = await tx`select an_onec_run_claim() as none`;
      expect(none).toBeNull();
      const [r2] = await tx`select status, error from an_onec_runs where id = ${run2}`;
      expect(r2.status).toBe("error");
      expect(r2.error).toContain("перезапустился");
      await asServer(tx);
    });
  });

  test("1С: окно новых номенклатур — категории в справочник, обработка новым запуском с отвеченными", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      await as(tx, admin);
      const [{ run }] = await tx`select an_onec_run_start() as run`;
      await asService(tx);
      await tx`select an_onec_run_claim()`;
      await tx`select an_onec_nomenclature_store(${run}, ${[
        { code: "0001", names: "Абонемент 8", category: "Абонемент", direction: "" },
        {
          code: " 0009",
          names: "Пробное 2 за 490 | Акция",
          category: "Не определено",
          direction: "",
        },
      ]}::jsonb)`;
      const review = {
        items: [
          {
            code: "0009",
            name: "Пробное 2 за 490 | Акция",
            reason: "Новая номенклатура",
            suggested_designation: "Пробное занятие",
          },
        ],
        choices: ["Абонемент", "Пробное занятие", "Не определено"],
      };
      await tx`select an_onec_run_review(${run}, ${review}::jsonb)`;
      await asServer(tx);
      await as(tx, admin);
      expect(
        await failure(tx, () => tx`select an_onec_review_submit(${run}, '{}'::jsonb)`),
      ).toContain("an_onec_review_incomplete");
      expect(
        await failure(
          tx,
          () => tx`select an_onec_review_submit(${run}, '{"0009": "Не определено"}'::jsonb)`,
        ),
      ).toContain("an_onec_review_bad_category");
      expect(
        await failure(
          tx,
          () => tx`select an_onec_review_submit(${run}, '{"0009": "Что-то"}'::jsonb)`,
        ),
      ).toContain("an_onec_review_bad_category");
      const [{ next }] =
        await tx`select an_onec_review_submit(${run}, '{"0009": "Пробное занятие"}'::jsonb) as next`;
      const [{ rows }] = await tx`select an_onec_ref_rows('nomenclature') as rows`;
      expect(rows.map((r: { code: string; category: string }) => [r.code, r.category])).toEqual([
        ["0001", "Абонемент"],
        [" 0009", "Пробное занятие"],
      ]);
      await asServer(tx);
      const [n] = await tx`select status, answered, log from an_onec_runs where id = ${next}`;
      expect(n.status).toBe("queued");
      expect(n.answered).toEqual([["0009", "Пробное 2 за 490 | Акция"]]);
      expect(n.log).toEqual(["Категории сохранены в справочник. Продолжаем обработку."]);
      const [{ old }] = await tx`select status as old from an_onec_runs where id = ${run}`;
      expect(old).toBe("answered");
    });
  });

  test("1С: снимок — пачки складываются, покрытие и meta как у них, загрузка, откат, слоты", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);

      async function build(revenue: number): Promise<number> {
        await as(tx, admin);
        const [{ run }] = await tx`select an_onec_run_start() as run`;
        await asService(tx);
        await tx`select an_onec_run_claim()`;
        const [{ s }] = await tx`select an_onec_snapshot_begin(${run}) as s`;
        await tx`select an_onec_snapshot_items(${s.id}, '{1,2}', '{revenue,zero}', '{Абакан,Абакан}',
          '{"Абакан Ленина","Абакан Ленина"}', '{Абонементы,Заморозка}', '{"",0003}', '{Открыта,Открыта}')`;
        await tx`select an_onec_snapshot_facts(${s.id}, 1, '{1,1,2}', '{2026-10-01,2026-10-02,2026-10-03}',
          ${[revenue, 10, 1]}, '{0,0,0}', ${[revenue, 10, 0]}, '{0,0,0}', '{0,0,0}', '{0,0,0}', '{0,0,0}', '{0,0,0}')`;
        // Тот же (item, день) в следующей пачке — складывается; повтор пачки — нет.
        for (let i = 0; i < 2; i++) {
          await tx`select an_onec_snapshot_facts(${s.id}, 2, '{1}', '{2026-10-01}', '{0.5}', '{0}', '{0.5}',
            '{0}', '{0}', '{0}', '{0}', '{0}')`;
        }
        expect(
          await failure(
            tx,
            () =>
              tx`select an_onec_snapshot_facts(${s.id}, 4, '{1}', '{2026-10-01}', '{1}', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}', '{0}')`,
          ),
        ).toContain("an_onec_seq_gap");
        const [{ meta }] = await tx`select an_onec_run_finish(${run}, ${s.id}, ${{
          source_rows: { revenue: 3, zero: 1 },
          issues: { zero_invalid_rows: 2 },
          breakEven: { Абакан: 700000 },
          zeroControls: { blankCostRows: 1, explicitZeroRows: 0, excludedTrialRows: 0 },
          stats: {},
        }}::jsonb) as meta`;
        expect(meta.version).toBe(1);
        expect(meta.coverage.revenue).toEqual({
          rows: 2,
          min: "2026-10-01",
          max: "2026-10-02",
          totals: [revenue + 10.5, 0, revenue + 10.5, 0, 0, 0, 0, 0],
          source_rows: 3,
        });
        expect(meta.coverage.sales).toEqual({
          rows: 0,
          min: null,
          max: null,
          totals: [0, 0, 0, 0, 0, 0, 0, 0],
          source_rows: 0,
        });
        expect(meta.coverage.zero.rows).toBe(1);
        expect(meta.breakEven).toEqual({ Абакан: 700000 });
        expect(meta.issues).toEqual({ zero_invalid_rows: 2 });
        expect(Object.keys(meta.coverage).sort()).toEqual([
          "activities",
          "funnel",
          "revenue",
          "sales",
          "trial_products",
          "zero",
        ]);
        await asServer(tx);
        return Number(s.id);
      }
      const state = async () =>
        Object.fromEntries(
          (await tx`select id, state, slot from an_onec_snapshots where state <> 'discarded'`).map(
            (r: { id: number; state: string; slot: number }) => [r.state, [Number(r.id), r.slot]],
          ),
        );
      const revenueOf = async (st: string) => {
        const [{ v }] = await tx`select sum(f.v1) as v from an_onec_facts f
          where f.slot = an_onec_slot(${st}) and f.item_id = 1`;
        return Number(v);
      };

      const a = await build(100);
      await as(tx, admin);
      await tx`select an_onec_snapshot_activate(${a})`;
      await asServer(tx);
      const b = await build(200);
      expect((await state()).ready[0]).toBe(b);
      await as(tx, admin);
      await tx`select an_onec_snapshot_activate(${b})`;
      const [{ o }] = await tx`select an_onec_overview() as o`;
      expect(o.snapshots.map((s: { state: string }) => s.state)).toEqual(["current", "previous"]);
      expect(o.snapshots[0].coverage.revenue).toEqual({
        rows: 2,
        min: "2026-10-01",
        max: "2026-10-02",
        source_rows: 3,
      });
      expect(o.snapshots[0].breakEvenCities).toBe(1);
      expect(o.snapshots[0].coverage.revenue.totals).toBeUndefined();
      await asServer(tx);
      expect(await revenueOf("current")).toBe(210.5);
      expect(await revenueOf("previous")).toBe(110.5);

      // Откат: предыдущий снова текущий — и обратно.
      await as(tx, admin);
      await tx`select an_onec_snapshot_rollback()`;
      await asServer(tx);
      expect((await state()).current[0]).toBe(a);
      expect((await state()).previous[0]).toBe(b);
      expect(await revenueOf("current")).toBe(110.5);

      // Третий снимок — в свободный слот; после загрузки самый ранний уходит.
      const c = await build(300);
      const st = await state();
      expect(new Set([st.current[1], st.previous[1], st.ready[1]]).size).toBe(3);
      await as(tx, admin);
      await tx`select an_onec_snapshot_activate(${c})`;
      await asServer(tx);
      const st2 = await state();
      expect(st2.current[0]).toBe(c);
      expect(st2.previous[0]).toBe(a);
      // Четвёртый занимает освобождённый слот b — он очищен.
      const freed = st[b === st.previous[0] ? "previous" : "current"][1];
      const d = await build(400);
      const st3 = await state();
      expect(st3.ready).toEqual([d, freed]);
      expect(await revenueOf("ready")).toBe(410.5);
      // Новый «обработан, не загружен» вытесняется следующей обработкой.
      const e = await build(500);
      const st4 = await state();
      expect(st4.ready[0]).toBe(e);
      expect(Object.keys(st4).sort()).toEqual(["current", "previous", "ready"]);
    });
  });
  // --- Отчёты 1С (db/migrations/2026-10-30_z_analytics_onec_reports.sql) ---------

  /** Текущий снимок: выручка двух городов и продажи (items/facts как у них). */
  async function onecCurrentSnapshot(tx: Tx) {
    await onecReset(tx);
    await tx`insert into an_onec_runs (status) values ('running')`;
    const [{ run }] = await tx`select id as run from an_onec_runs order by id desc limit 1`;
    await asService(tx);
    const [{ s }] = await tx`select an_onec_snapshot_begin(${run}) as s`;
    await tx`select an_onec_snapshot_items(${s.id},
      '{1,2,3,4}', '{revenue,revenue,sales,zero}', '{Абакан,Бийск,Абакан,Бийск}',
      '{"Абакан Ленина","Бийск Мира","Абакан Ленина","Бийск Мира"}',
      '{Абонементы,Абонементы,"Абонемент 8",Заморозка}', '{"","",0001,0003}',
      '{Открыта,Открыта,Открыта,Закрыта}')`;
    await tx`select an_onec_snapshot_facts(${s.id}, 1, '{1,1,2,3,4}',
      '{2026-10-01,2026-09-15,2026-10-02,2026-10-03,2026-10-04}',
      '{100,50,70,1,1}', '{0,0,0,0,0}', '{100,50,70,0,0}', '{0,0,0,0,0}', '{0,0,0,0,0}',
      '{0,0,0,1000,0}', '{0,0,0,0,0}', '{0,0,0,0,0}')`;
    await tx`select an_onec_run_finish(${run}, ${s.id}, ${{
      source_rows: {},
      issues: {},
      breakEven: { Абакан: 700000, Бийск: 500000 },
      zeroControls: { blankCostRows: 1, explicitZeroRows: 0, excludedTrialRows: 0 },
      stats: {},
    }}::jsonb)`;
    await tx`reset role`;
    await tx`update an_onec_snapshots set state = 'current' where id = ${s.id}`;
  }
  const agg = (tx: Tx, board: string, report: string, grain: string, studio = "", city = "") =>
    tx`select an_onec_aggregate(${board}, ${report}, '2026-09-01', '2026-10-31', ${grain}, ${studio}, ${city}) as r`;

  test("1С отчёты: разрезы как их aggregate(); без снимка — an_onec_empty", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      await as(tx, admin);
      expect(await failure(tx, () => agg(tx, "revenue", "revenue", "studio"))).toContain(
        "an_onec_empty",
      );
      const [{ m0 }] = await tx`select an_onec_report_meta('revenue') as m0`;
      expect(m0).toBeNull();
      await asServer(tx);
      await onecCurrentSnapshot(tx);
      await as(tx, admin);
      const [{ r: studio }] = await agg(tx, "revenue", "revenue", "studio");
      expect(studio).toEqual([
        [null, "Абакан", "Абакан Ленина", "Открыта", null, null, 150, 0, 150, 0, 0, 0, 0, 0],
        [null, "Бийск", "Бийск Мира", "Открыта", null, null, 70, 0, 70, 0, 0, 0, 0, 0],
      ]);
      const [{ r: monthly }] = await agg(tx, "revenue", "revenue", "monthly");
      expect(monthly.map((x: unknown[]) => [x[0], x[1], x[6]])).toEqual([
        ["2026-09", "Абакан", 50],
        ["2026-10", "Абакан", 100],
        ["2026-10", "Бийск", 70],
      ]);
      const [{ r: daily }] = await agg(tx, "revenue", "revenue", "daily");
      expect(daily[0][0]).toBe("2026-09-15");
      const [{ r: detail }] = await agg(tx, "sales", "sales", "detail");
      expect(detail).toEqual([
        [
          null,
          "Абакан",
          "Абакан Ленина",
          "Открыта",
          "Абонемент 8",
          "0001",
          1,
          0,
          0,
          0,
          0,
          1000,
          0,
          0,
        ],
      ]);
      // Доска читает только свои отчёты; неизвестный разрез — ошибка.
      expect(await failure(tx, () => agg(tx, "revenue", "sales", "detail"))).toContain(
        "an_onec_bad_report",
      );
      expect(await failure(tx, () => agg(tx, "revenue", "revenue", "weekly"))).toContain(
        "an_onec_bad_grain",
      );
      expect(
        await failure(
          tx,
          () =>
            tx`select an_onec_aggregate('revenue', 'revenue', '2026-10-31', '2026-10-01', 'studio')`,
        ),
      ).toContain("Начало периода позже конца");
      const [{ m }] = await tx`select an_onec_report_meta('revenue') as m`;
      expect(m.coverage).toEqual({ min: "2026-09-15", max: "2026-10-02" });
      expect(m.breakEven).toEqual({ Абакан: 700000, Бийск: 500000 });
      expect(m.zeroControls).toBeNull();
      const [{ z }] = await tx`select an_onec_report_meta('zero') as z`;
      expect(z.zeroControls).toEqual({
        blankCostRows: 1,
        explicitZeroRows: 0,
        excludedTrialRows: 0,
      });
      await asServer(tx);
    });
  });

  test("1С отчёты: партнёр — только «Мой город» и свои города; студия — только своего города", async () => {
    await scenario(async (tx) => {
      await onecCurrentSnapshot(tx);
      const partner = await person(tx, "Партнёр", ["an.partner", "an.onec.revenue"]);
      await tx`insert into an_partner_cities (user_id, city) values (${partner}, 'Абакан')`;
      const empty = await person(tx, "Партнёр без городов", ["an.partner"]);
      await as(tx, partner);
      expect(await failure(tx, () => agg(tx, "revenue", "revenue", "studio"))).toContain(
        "an_forbidden",
      );
      const [{ r }] = await agg(tx, "partner", "revenue", "studio");
      expect(r.map((x: unknown[]) => x[1])).toEqual(["Абакан"]);
      const [{ m }] = await tx`select an_onec_report_meta('partner') as m`;
      expect(m.studioOptions).toEqual({ Абакан: ["Абакан Ленина"] });
      expect(m.breakEven).toEqual({ Абакан: 700000 });
      // Чужая студия — их «Выбранная студия недоступна в этом городе».
      expect(
        await failure(tx, () => agg(tx, "partner", "revenue", "studio", "Бийск Мира", "Бийск")),
      ).toContain("Выбранная студия недоступна");
      const [{ r: own }] = await agg(tx, "partner", "revenue", "studio", "Абакан Ленина", "Абакан");
      expect(own.length).toBe(1);
      await asServer(tx);
      await as(tx, empty);
      const [{ r: none }] = await agg(tx, "partner", "revenue", "studio");
      expect(none).toEqual([]);
      await asServer(tx);
    });
  });

  test("1С отчёты: сотруднику — выданные доски; «Мой город» — только при всех четырёх", async () => {
    await scenario(async (tx) => {
      await onecCurrentSnapshot(tx);
      const one = await person(tx, "Сотрудник", ["an.onec.revenue", "an.onec.mycity"]);
      const four = await person(tx, "Сотрудник 2", [
        "an.onec.revenue",
        "an.onec.sales",
        "an.onec.classes",
        "an.onec.trials",
        "an.onec.mycity",
      ]);
      await as(tx, one);
      const [{ r }] = await agg(tx, "revenue", "revenue", "studio");
      expect(r.length).toBe(2);
      expect(await failure(tx, () => agg(tx, "sales", "sales", "detail"))).toContain(
        "an_forbidden",
      );
      expect(await failure(tx, () => agg(tx, "partner", "revenue", "studio"))).toContain(
        "an_forbidden",
      );
      await asServer(tx);
      await as(tx, four);
      const [{ r: all }] = await agg(tx, "partner", "trial_products", "detail");
      expect(all).toEqual([]);
      const [{ m }] = await tx`select an_onec_report_meta('partner') as m`;
      expect(Object.keys(m.studioOptions).sort()).toEqual(["Абакан", "Бийск"]);
      await asServer(tx);
    });
  });

  // ---- «Топ-10 городов» (2026-10-30_zzz_analytics_top10.sql) ----

  test("Топ-10 городов: месяц × город — воронка и продажи с возвращёнными; только администратору", async () => {
    await scenario(async (tx) => {
      await onecReset(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.sales", "an.onec.trials"]);
      await as(tx, admin);
      const [{ none }] = await tx`select an_onec_top10_range() as none`;
      expect(none).toBeNull();
      expect(await failure(tx, () => tx`select an_onec_top10(array['2026-09'])`)).toContain(
        "an_onec_empty",
      );

      await asServer(tx);
      await tx`insert into an_onec_runs (status) values ('running')`;
      const [{ run }] = await tx`select id as run from an_onec_runs order by id desc limit 1`;
      await asService(tx);
      const [{ s }] = await tx`select an_onec_snapshot_begin(${run}) as s`;
      await tx`select an_onec_snapshot_items(${s.id},
        '{1,2,3,4,5}', '{sales,sales,funnel,sales,funnel}', '{Абакан,Абакан,Абакан,Бийск,Бийск}',
        '{"Абакан Ленина","Абакан Мира","Абакан Ленина","Бийск Мира","Бийск Мира"}',
        '{"Абонемент 8","Абонемент 8",Stretching,"Абонемент 8",Stretching}',
        '{0001,0001,"",0001,""}', '{Открыта,Открыта,Открыта,Закрыта,Закрыта}')`;
      // Продажи: v1 все, v2 новые, v3 прежние продления, v7 из них возвращённые;
      // воронка: v1 записались, v2 пришли, v3 база в день, v4 купили в день,
      // v5 база 14 дней, v6 купили за 14 дней.
      const facts: [number, string, number[]][] = [
        [1, "2026-09-03", [3, 1, 2, 0, 0, 0, 1, 0]],
        [2, "2026-09-20", [2, 0, 2, 0, 0, 0, 0, 0]],
        [1, "2026-10-05", [1, 1, 0, 0, 0, 0, 0, 0]],
        [3, "2026-09-10", [5, 4, 4, 2, 4, 3, 1, 0]],
        [3, "2026-08-31", [9, 9, 9, 9, 9, 9, 0, 0]],
        [4, "2026-10-01", [4, 0, 4, 0, 0, 0, 2, 0]],
        [5, "2026-10-02", [2, 2, 2, 1, 2, 1, 0, 1]],
      ];
      const arr = (xs: (string | number)[]) => `{${xs.join(",")}}`;
      const col = (i: number) => arr(facts.map((f) => f[2][i]));
      await tx`select an_onec_snapshot_facts(${s.id}, 1, ${arr(facts.map((f) => f[0]))}::int[],
        ${arr(facts.map((f) => f[1]))}::date[], ${col(0)}::float8[], ${col(1)}::float8[],
        ${col(2)}::float8[], ${col(3)}::float8[], ${col(4)}::float8[], ${col(5)}::float8[],
        ${col(6)}::float8[], ${col(7)}::float8[])`;
      await tx`select an_onec_run_finish(${run}, ${s.id}, ${{ source_rows: {}, issues: {}, breakEven: {}, zeroControls: {}, stats: {} }}::jsonb)`;
      await tx`reset role`;
      await tx`update an_onec_snapshots set state = 'current' where id = ${s.id}`;

      await as(tx, admin);
      const [{ info }] = await tx`select an_onec_top10_range() as info`;
      expect(info).toMatchObject({
        sales_min: "2026-09-03",
        sales_max: "2026-10-05",
        funnel_min: "2026-08-31",
        funnel_max: "2026-10-02",
        returned_ready: true,
      });
      const [{ t }] = await tx`select an_onec_top10(array['2026-10', '2026-09']) as t`;
      const zero = {
        booked: 0,
        attended: 0,
        day_base: 0,
        bought_day: 0,
        window_base: 0,
        bought_14: 0,
      };
      expect(t.rows).toEqual([
        {
          month: "2026-09",
          city: "Абакан",
          booked: 5,
          attended: 4,
          day_base: 4,
          bought_day: 2,
          window_base: 4,
          bought_14: 3,
          sales: 5,
          new: 1,
          repeat_old: 4,
          returned: 1,
        },
        { month: "2026-10", city: "Абакан", ...zero, sales: 1, new: 1, repeat_old: 0, returned: 0 },
        {
          month: "2026-10",
          city: "Бийск",
          booked: 2,
          attended: 2,
          day_base: 2,
          bought_day: 1,
          window_base: 2,
          bought_14: 1,
          sales: 4,
          new: 0,
          repeat_old: 4,
          returned: 2,
        },
      ]);
      for (const bad of [[], ["2026-13"], ["2026-09", "2026-09"]]) {
        expect(await failure(tx, () => tx`select an_onec_top10(${bad}::text[])`)).toContain(
          "Выберите от 1 до 12 месяцев",
        );
      }
      await asServer(tx);
      // Снимок до 30.10.2026 «возвращённых» не считал — v7 продаж пустой.
      const [{ old }] =
        await tx`select an_onec_top10_info('{"coverage": {"sales": {"totals": [5, 1, 4, 0, 0, 0, 0, 0]}}}') as old`;
      expect(old.returned_ready).toBe(false);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_onec_top10(array['2026-09'])`)).toContain(
        "an_forbidden",
      );
      expect(await failure(tx, () => tx`select an_onec_top10_range()`)).toContain("an_forbidden");
      await asServer(tx);
    });
  });

  // ---- Администрирование (2026-10-30_zz_analytics_core_admin.sql) ----

  /** auth.jwt() читает claims, как в Supabase (заглушка тестов отдаёт {}). */
  async function realJwt(tx: Tx) {
    await tx`reset role`;
    await tx`create or replace function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$`;
  }
  async function pulse(tx: Tx, userId: string, session: string, dashboard = "Главная") {
    await as(tx, userId);
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, session_id: session })}, true)`;
    const [{ ok }] = await tx`select an_presence(${dashboard}) as ok`;
    await asServer(tx);
    return ok as boolean;
  }
  /** Сдвинуть «последнюю активность» сессии на n секунд назад. */
  async function idle(tx: Tx, session: string, seconds: number) {
    await tx`update an_activity_sessions
                set last_active_at = now() - make_interval(secs => ${seconds})
              where session_id = ${session}`;
  }

  test("посещаемость: первый пульс — «вход», засчитывается промежуток до 45 секунд", async () => {
    await scenario(async (tx) => {
      await realJwt(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);
      const outsider = await person(tx, "Без аналитики", []);
      const s1 = crypto.randomUUID();
      expect(await pulse(tx, staff, s1)).toBe(true);
      const logins = await tx`select event from an_audit where user_id = ${staff}`;
      expect(logins.map((r: { event: string }) => r.event)).toEqual(["login"]);
      await idle(tx, s1, 20);
      expect(await pulse(tx, staff, s1, "Выручка")).toBe(true);
      await idle(tx, s1, 100);
      expect(await pulse(tx, staff, s1, "Чужая страница")).toBe(true);
      const samples =
        await tx`select dashboard, active_seconds from an_activity where user_id = ${staff}`;
      expect(samples).toEqual([{ dashboard: "Выручка", active_seconds: 20 }]);
      const [sess] =
        await tx`select active_seconds from an_activity_sessions where session_id = ${s1}`;
      expect(sess.active_seconds).toBe(20);
      // Вторая сессия — второй визит; «Портал» вместо неизвестной страницы.
      const s2 = crypto.randomUUID();
      await pulse(tx, staff, s2);
      await idle(tx, s2, 30);
      await pulse(tx, staff, s2, "Чужая страница");
      // Без «Аналитики» пульс не пишется.
      expect(await pulse(tx, outsider, crypto.randomUUID())).toBe(false);
      expect((await tx`select 1 from an_audit where user_id = ${outsider}`).length).toBe(0);

      await tx`insert into an_audit (user_id, event, details) values
        (${staff}, 'dashboard_view', 'Отзывы и оценки'), (${staff}, 'dashboard_view', 'Выручка'),
        (${staff}, 'dashboard_view', 'Выручка')`;
      const [{ today }] =
        await tx`select (now() at time zone 'Europe/Moscow')::date::text as today`;
      await as(tx, staff);
      expect(
        await failure(tx, () => tx`select an_activity_report(${today}::date - 29, ${today}::date)`),
      ).toContain("an_forbidden");
      await asServer(tx);
      await as(tx, admin);
      const [{ r }] = await tx`select an_activity_report(${today}::date - 29, ${today}::date) as r`;
      const row = r.find((x: { user_id: string }) => x.user_id === staff);
      expect(row).toMatchObject({
        full_name: "Сотрудник",
        visits: 2,
        seconds: 50,
        views: 3,
        dashboards: ["Выручка", "Отзывы и оценки"],
      });
      expect(row.last_active).not.toBeNull();
      // Человек с «Аналитикой» без визитов — в отчёте нулём; без неё — нет.
      expect(r.find((x: { user_id: string }) => x.user_id === admin)).toMatchObject({
        visits: 0,
        seconds: 0,
      });
      expect(r.some((x: { user_id: string }) => x.user_id === outsider)).toBe(false);
      // Прошлый период — без этих визитов.
      const [{ r: old }] = await tx`select an_activity_report('2020-01-01', '2020-01-31') as r`;
      expect(old.find((x: { user_id: string }) => x.user_id === staff)).toMatchObject({
        visits: 0,
        views: 0,
      });
      expect(
        await failure(tx, () => tx`select an_activity_report('2026-10-05', '2026-10-01')`),
      ).toContain("Неверный период");
      // Журнал — новые сверху, «Система» без человека.
      const [{ j }] = await tx`select an_audit_list(2, 0) as j`;
      expect(j.total).toBeGreaterThanOrEqual(5);
      expect(j.rows.length).toBe(2);
      await asServer(tx);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_audit_list()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select * from an_activity`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from an_audit`)).toContain("permission denied");
      await asServer(tx);
    });
  });

  test("партнёры: города из 1С, карточка, ИНН; только администратору; в журнал", async () => {
    await scenario(async (tx) => {
      await onecCurrentSnapshot(tx);
      await tx`insert into an_onec_studios (sort_order, studio, status, city) values
        (1, 'Абакан Ленина', 'Открыта', 'Абакан'), (2, 'Абакан Мира', 'Закрыта', 'Абакан'),
        (3, 'Чита Центр', 'Открыта', 'Чита')`;
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);
      const p = await person(tx, "Иванова Анна", ["an.partner", "an.mkt.ls", "an.reviews"]);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_partners()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select an_partner_add(${p}, '{Абакан}')`)).toContain(
        "an_forbidden",
      );
      await asServer(tx);

      await as(tx, admin);
      const [{ cand }] = await tx`select an_partner_candidates() as cand`;
      expect(cand.some((x: { user_id: string }) => x.user_id === p)).toBe(true);
      const [{ c }] = await tx`select an_partner_city_options() as c`;
      expect(c).toEqual(["Абакан", "Бийск", "Чита"]);
      expect(await failure(tx, () => tx`select an_partner_add(${p}, '{}')`)).toContain(
        "Выберите хотя бы один",
      );
      expect(await failure(tx, () => tx`select an_partner_add(${p}, '{Москва}')`)).toContain(
        "нет данных 1С",
      );
      expect(
        await failure(tx, () => tx`select an_partner_add(${crypto.randomUUID()}, '{Абакан}')`),
      ).toContain("не найден");
      await tx`select an_partner_add(${p}, '{Чита,Абакан}')`;
      expect(await failure(tx, () => tx`select an_partner_add(${p}, '{Бийск}')`)).toContain(
        "уже партнёр",
      );
      const [{ list }] = await tx`select an_partners() as list`;
      expect(list).toEqual([
        expect.objectContaining({
          user_id: p,
          full_name: "Иванова Анна",
          active: true,
          cities: ["Абакан", "Чита"],
          reports: ["mkt.ls", "reviews"],
        }),
      ]);
      await tx`select an_partner_set_cities(${p}, '{Абакан,Бийск}')`;
      const [{ card }] = await tx`select an_partner_card(${p}) as card`;
      expect(card.cities.map((x: { city: string }) => x.city)).toEqual(["Абакан", "Бийск"]);
      expect(card.cities[0].studios).toEqual([
        { name: "Абакан Ленина", status: "Открыта" },
        { name: "Абакан Мира", status: "Закрыта" },
      ]);
      expect(card.profile.inn).toBe("");
      const save = (inn: string, cities: string[]) =>
        tx`select an_partner_card_save(${p}, ${{
          phone: " +7 999 ",
          telegram: "@anna",
          max_messenger: "",
          individual_entrepreneur: "ИП Иванова",
          inn,
          cities: cities.map((city) => ({
            city,
            trial_price: "500 ₽",
            directions: "Lady Stretch",
          })),
        }}::jsonb)`;
      expect(await failure(tx, () => save("123", ["Абакан", "Бийск"]))).toContain(
        "ИНН должен состоять из 10 или 12 цифр.",
      );
      expect(await failure(tx, () => save("1234567890", ["Абакан"]))).toContain(
        "Не удалось сопоставить",
      );
      await save("1234567890", ["Бийск", "Абакан"]);
      const [{ card: saved }] = await tx`select an_partner_card(${p}) as card`;
      expect(saved.profile).toEqual({
        phone: "+7 999",
        telegram: "@anna",
        max_messenger: "",
        individual_entrepreneur: "ИП Иванова",
        inn: "1234567890",
      });
      expect(saved.cities[1]).toMatchObject({ trial_price: "500 ₽", directions: "Lady Stretch" });
      await tx`select an_partner_remove(${p})`;
      const [{ cand: after }] = await tx`select an_partner_candidates() as cand`;
      expect(after.some((x: { user_id: string }) => x.user_id === p)).toBe(true);
      const [{ list: none }] = await tx`select an_partners() as list`;
      expect(none).toEqual([]);
      await asServer(tx);
      const events = await tx`select event from an_audit where user_id = ${admin} order by id`;
      expect(events.map((r: { event: string }) => r.event)).toEqual([
        "partner_created",
        "partner_cities_changed",
        "partner_profile_changed",
        "partner_removed",
      ]);
    });
  });

  test("API для GPT: ключ по хешу, журнал запросов; отчёты 1С — серверу по всей сети", async () => {
    await scenario(async (tx) => {
      await onecCurrentSnapshot(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.onec.revenue"]);
      const hash = "a".repeat(64);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_api_key_create('GPT', ${hash})`)).toContain(
        "an_forbidden",
      );
      expect(await failure(tx, () => tx`select an_api_key_check(${hash})`)).toContain(
        "permission denied",
      );
      await asServer(tx);
      await as(tx, admin);
      expect(await failure(tx, () => tx`select an_api_key_create(' ', ${hash})`)).toContain(
        "Укажите название ключа.",
      );
      expect(await failure(tx, () => tx`select an_api_key_create('GPT', 'не хеш')`)).toContain(
        "an_bad_key",
      );
      const [{ id }] = await tx`select an_api_key_create(' GPT ', ${hash}) as id`;
      expect(
        await failure(tx, () => tx`select an_api_key_create('GPT', ${"b".repeat(64)})`),
      ).toContain("уже есть");
      await asServer(tx);

      await asService(tx);
      const [{ k }] = await tx`select an_api_key_check(${hash}) as k`;
      expect(Number(k)).toBe(Number(id));
      const [{ k: nobody }] = await tx`select an_api_key_check(${"c".repeat(64)}) as k`;
      expect(nobody).toBeNull();
      await tx`select an_api_log(${id}, 'GET', '/api/analytics/v1/catalog', '', 200, 512)`;
      await tx`select an_api_log(null, 'GET', '/api/analytics/v1/catalog', '', 401, 24)`;
      // Сервер читает отчёты 1С по всей сети (у браузера — по правам).
      const [{ r }] = await agg(tx, "revenue", "revenue", "studio");
      expect(r.map((x: unknown[]) => x[1])).toEqual(["Абакан", "Бийск"]);
      const [{ m }] = await tx`select an_onec_report_meta('revenue') as m`;
      expect(m.breakEven).toEqual({ Абакан: 700000, Бийск: 500000 });
      await tx`reset role`;

      await as(tx, admin);
      const [{ o }] = await tx`select an_api_overview() as o`;
      expect(o.keys).toEqual([
        expect.objectContaining({ label: "GPT", is_active: true, requests_30d: 1 }),
      ]);
      expect(o.keys[0].last_used_at).not.toBeNull();
      expect(o.requests.map((x: { status_code: number }) => x.status_code).sort()).toEqual([
        200, 401,
      ]);
      await tx`select an_api_key_set_active(${id}, false)`;
      await asServer(tx);
      await asService(tx);
      const [{ k: off }] = await tx`select an_api_key_check(${hash}) as k`;
      expect(off).toBeNull();
      await tx`reset role`;
      const events = await tx`select event from an_audit where user_id = ${admin} order by id`;
      expect(events.map((x: { event: string }) => x.event)).toEqual([
        "analytics_api_key_created",
        "analytics_api_key_disabled",
      ]);
    });
  });

  test("загрузка снимка 1С в отчёты — в журнал (их onec_snapshot_imported)", async () => {
    await scenario(async (tx) => {
      await onecCurrentSnapshot(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const [{ s }] = await tx`select slot as s from an_onec_snapshots where state = 'current'`;
      const free = [1, 2, 3].find((x) => x !== s);
      const [{ id }] = await tx`
        insert into an_onec_snapshots (slot, state, meta) values (${free}, 'ready', '{}') returning id`;
      await as(tx, admin);
      await tx`select an_onec_snapshot_activate(${id})`;
      await asServer(tx);
      const rows = await tx`select user_id, event, details from an_audit
                             where event = 'onec_snapshot_imported' and user_id = ${admin}`;
      expect(rows).toEqual([
        { user_id: admin, event: "onec_snapshot_imported", details: `Снимок ${id}` },
      ]);
    });
  });
  // ---- «Отзывы» (2026-10-30_zzzz_analytics_reviews.sql) ----

  type RvRow = {
    client_name: string;
    studio: string;
    trainer: string;
    rating_date: string;
    rating: number;
    comment: string;
  };
  /** Строка выгрузки, как её отдаёт разбор в браузере (отпечаток — SHA-256). */
  function rvRow(r: RvRow) {
    const row = {
      ...r,
      service: "Stretching",
      class_date: r.rating_date,
      class_time: "19:00",
      client_group: "",
      age: "",
      gender: "",
    };
    const fp = [
      r.client_name,
      r.studio,
      row.service,
      row.class_date,
      "19:00",
      r.trainer,
      r.rating_date,
      String(r.rating),
      r.comment,
    ].join("\x1f");
    return { ...row, source_hash: createHash("sha256").update(fp).digest("hex") };
  }
  async function rvImport(tx: Tx, rows: ReturnType<typeof rvRow>[], name = "оценки.xlsx") {
    const [{ id }] = await tx`select an_rv_import_start(${name}, '2026-09-01', '2026-09-30') as id`;
    await tx`select an_rv_import_rows(${id}, ${rows}::jsonb)`;
    const [{ r }] = await tx`select an_rv_import_finish(${id}, ${rows.length}) as r`;
    return r as { id: number; rows: number; duplicates: number };
  }
  async function rvStudios(tx: Tx) {
    await onecReset(tx);
    await tx`delete from an_rv_rows`;
    await tx`delete from an_rv_uploads`;
    await tx`insert into an_onec_studios (sort_order, studio, status, city) values
      (1, 'Абакан Ленина', 'Открыта', 'Абакан'),
      (2, 'Самара Ёлочная', 'Открыта', 'Самара'),
      (3, 'Бийск Мира', 'Закрыта', 'Бийск')`;
  }

  test("Отзывы: статистика клиентов — город по студиям 1С, расчёты как у них; кому какие города", async () => {
    await scenario(async (tx) => {
      await rvStudios(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const partner = await person(tx, "Партнёр", ["an.partner", "an.reviews"]);
      await tx`insert into an_partner_cities (user_id, city) values (${partner}, 'Самара')`;
      const staff = await person(tx, "Сотрудник", ["an.reviews"]);
      const outsider = await person(tx, "Без отзывов", ["an.onec.revenue"]);

      await as(tx, admin);
      const r = await rvImport(tx, [
        rvRow({
          client_name: "Иванова Анна",
          studio: "Абакан Ленина",
          trainer: "Петрова (Группа)",
          rating_date: "2026-09-02",
          rating: 5,
          comment: "Супер",
        }),
        rvRow({
          client_name: "Сидорова Мария",
          studio: "АБАКАН  ленина!",
          trainer: "Петрова",
          rating_date: "2026-09-03",
          rating: 3,
          comment: "Холодно",
        }),
        rvRow({
          client_name: "Кузнецова Ольга",
          studio: "Абакан Ленина",
          trainer: "Орлова",
          rating_date: "2026-09-04",
          rating: 4.5,
          comment: "",
        }),
        rvRow({
          client_name: "Вне периода",
          studio: "Абакан Ленина",
          trainer: "Орлова",
          rating_date: "2026-08-31",
          rating: 1,
          comment: "Старое",
        }),
        rvRow({
          client_name: "Ёлкина Вера",
          studio: "Самара Елочная",
          trainer: "Орлова",
          rating_date: "2026-09-05",
          rating: 2,
          comment: "Тесно",
        }),
        rvRow({
          client_name: "Закрытая",
          studio: "Бийск Мира",
          trainer: "Орлова",
          rating_date: "2026-09-05",
          rating: 5,
          comment: "",
        }),
      ]);
      expect(r).toMatchObject({ rows: 6, duplicates: 0 });

      const [{ rep }] = await tx`select an_rv_report('Абакан', '2026-09-01', '2026-09-30') as rep`;
      expect(rep.cities).toEqual(["Абакан", "Самара"]);
      expect(rep.city).toBe("Абакан");
      expect(rep.report).toMatchObject({
        total: 3,
        period_from: "2026-09-02",
        period_to: "2026-09-04",
        negative: 1,
        ratings: [
          { rating: 5, count: 1 },
          { rating: 4.5, count: 1 },
          { rating: 3, count: 1 },
        ],
      });
      expect(rep.report.average).toBeCloseTo(12.5 / 3, 12);
      expect(rep.report.trainers).toEqual([
        { trainer: "Петрова", count: 2, average: 4, negative: 1, comments: 2 },
        { trainer: "Орлова", count: 1, average: 4.5, negative: 0, comments: 0 },
      ]);
      expect(rep.report.comments.map((c: { comment: string }) => c.comment)).toEqual([
        "Холодно",
        "Супер",
      ]);
      // Город не из разрешённых — первый разрешённый (как у них).
      const [{ other }] =
        await tx`select an_rv_report('Бийск', '2026-09-01', '2026-09-30') as other`;
      expect(other.city).toBe("Абакан");
      const [{ empty }] =
        await tx`select an_rv_report('Самара', '2026-10-01', '2026-10-30') as empty`;
      expect(empty.report.total).toBe(0);
      expect(
        await failure(tx, () => tx`select an_rv_report('Абакан', '1.09.2026', '2026-09-30')`),
      ).toContain("Неверный период");

      await as(tx, partner);
      const [{ p }] = await tx`select an_rv_report('Абакан', '2026-09-01', '2026-09-30') as p`;
      expect(p.cities).toEqual(["Самара"]);
      expect(p.city).toBe("Самара");
      expect(p.report.comments.map((c: { client_name: string }) => c.client_name)).toEqual([
        "Ёлкина Вера",
      ]);

      // У них сотруднику с правом без городов — пустая страница.
      await as(tx, staff);
      const [{ st }] = await tx`select an_rv_report('Абакан', '2026-09-01', '2026-09-30') as st`;
      expect(st).toEqual({ cities: [], city: "", report: null });
      expect(await failure(tx, () => tx`select an_rv_uploads()`)).toContain("an_forbidden");

      await as(tx, outsider);
      expect(
        await failure(tx, () => tx`select an_rv_report('Абакан', '2026-09-01', '2026-09-30')`),
      ).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select * from an_rv_rows`)).toContain("permission denied");

      await asServer(tx);
      const views =
        await tx`select details from an_audit where user_id = ${partner} and event = 'dashboard_view'`;
      expect(views).toEqual([{ details: "Отзывы и оценки" }]);
    });
  });

  test("Отзывы: загрузка — повторы не добавляются, удаление записи оставляет строки; только администратору", async () => {
    await scenario(async (tx) => {
      await rvStudios(tx);
      const admin = await person(tx, "Админ Отзывов", ["an.admin"]);
      const staff = await person(tx, "Сотрудник", ["an.reviews"]);
      const rows = [1, 2, 3].map((i) =>
        rvRow({
          client_name: `Клиентка ${i}`,
          studio: "Абакан Ленина",
          trainer: "Орлова",
          rating_date: `2026-09-0${i}`,
          rating: 5,
          comment: "",
        }),
      );
      await as(tx, admin);
      expect(await rvImport(tx, rows, "первая.xlsx")).toMatchObject({ rows: 3, duplicates: 0 });
      const second = await rvImport(
        tx,
        [...rows, rvRow({ ...rows[0], client_name: "Новая", comment: "" })],
        "вторая.xls",
      );
      expect(second).toMatchObject({ rows: 1, duplicates: 3, period_from: "2026-09-01" });
      // Строка с неверным отпечатком не пишется.
      const [{ id: third }] = await tx`select an_rv_import_start('третья.xlsx', '', '') as id`;
      const [{ n }] =
        await tx`select an_rv_import_rows(${third}, ${[{ ...rows[0], source_hash: "x" }]}::jsonb) as n`;
      expect(n).toBe(0);
      expect(await failure(tx, () => tx`select an_rv_import_rows(-1, '[]'::jsonb)`)).toContain(
        "Загрузка не найдена",
      );

      const [{ list }] = await tx`select an_rv_uploads() as list`;
      expect(
        list.map((u: { filename: string; row_count: number; imported_by: string }) => [
          u.filename,
          u.row_count,
          u.imported_by,
        ]),
      ).toEqual([
        ["третья.xlsx", 0, "Админ Отзывов"],
        ["вторая.xls", 1, "Админ Отзывов"],
        ["первая.xlsx", 3, "Админ Отзывов"],
      ]);
      await tx`select an_rv_upload_delete(${second.id})`;
      const [{ after }] = await tx`select an_rv_uploads() as after`;
      expect(after.length).toBe(2);
      await asServer(tx);
      expect((await tx`select 1 from an_rv_rows`).length).toBe(4);
      const events = await tx`select event, details from an_audit
                              where user_id = ${admin} and event like 'reviews%' order by id`;
      expect(events).toEqual([
        { event: "reviews_imported", details: "3 новых строк: первая.xlsx" },
        { event: "reviews_imported", details: "1 новых строк: вторая.xls" },
        { event: "reviews_upload_deleted", details: String(second.id) },
      ]);

      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_rv_import_start('x.xlsx', '', '')`)).toContain(
        "an_forbidden",
      );
      expect(
        await failure(tx, () => tx`select an_rv_import_rows(${third}, '[]'::jsonb)`),
      ).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select an_rv_upload_delete(${third})`)).toContain(
        "an_forbidden",
      );
    });
  });

  test("Отзывы сотрудников: ссылки, публичная форма без входа, проверки их текстами, статистика", async () => {
    await scenario(async (tx) => {
      await rvStudios(tx);
      const admin = await person(tx, "Админ", ["an.admin"]);
      const emp = await person(tx, "Яковлева Ирина", ["an.reviews"]);
      const partner = await person(tx, "Партнёр Город", ["an.partner"]);
      await tx`insert into an_partner_cities (user_id, city) values (${partner}, 'Самара')`;

      await as(tx, admin);
      const [{ name }] = await tx`select an_rv_staff_link_create(${emp}) as name`;
      expect(name).toBe("Яковлева Ирина");
      await tx`select an_rv_staff_link_create(${emp})`;
      expect(await failure(tx, () => tx`select an_rv_staff_link_create(${partner})`)).toContain(
        "Выберите действующего сотрудника.",
      );
      const [{ links }] = await tx`select an_rv_staff_links() as links`;
      type L = {
        user_id: string;
        link_id: number | null;
        token: string | null;
        is_active: boolean | null;
      };
      const mine = (links as L[]).filter((l) => l.user_id === emp);
      expect(mine).toHaveLength(1);
      expect(mine[0].token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((links as L[]).some((l) => l.user_id === partner)).toBe(false);
      expect((links as L[]).find((l) => l.user_id === admin)?.link_id).toBeNull();
      const { token, link_id: link } = mine[0];

      // Форма — без входа.
      await asServer(tx);
      await tx`set local role anon`;
      const [{ form }] = await tx`select an_rv_feedback_form(${token}) as form`;
      expect(form).toEqual({ full_name: "Яковлева Ирина", position: null });
      const [{ none }] = await tx`select an_rv_feedback_form('нет-такой-ссылки-123') as none`;
      expect(none).toBeNull();
      const submit = (
        who: string,
        city: string,
        prof: string,
        profText: string,
        next: string,
        nextText: string,
      ) =>
        tx`select an_rv_feedback_submit(${token}, ${who}, ${city}, ${prof}, ${profText}, ${next}, ${nextText}) as r`;
      const cases: [Parameters<typeof submit>, string][] = [
        [[" ", "Самара", "5", "", "5", ""], "Укажите имя партнёра."],
        [["Партнёр", "\t", "5", "", "5", ""], "Укажите город."],
        [
          ["П".repeat(201), "Самара", "5", "", "5", ""],
          "Имя партнёра и город не должны быть длиннее 200 символов.",
        ],
        [["Партнёр", "Самара", "", "", "5", ""], "Поставьте оценку по каждому вопросу."],
        [["Партнёр", "Самара", "пять", "", "5", ""], "Поставьте оценку по каждому вопросу."],
        [
          ["Партнёр", "Самара", "6", "", "5", ""],
          "Оценка по каждому вопросу должна быть от 1 до 5.",
        ],
        [["Партнёр", "Самара", "4", "  ", "5", ""], "Добавьте рекомендацию к первому вопросу."],
        [["Партнёр", "Самара", "5", "", "3", ""], "Добавьте рекомендацию ко второму вопросу."],
        [
          ["Партнёр", "Самара", "5", "x".repeat(4001), "5", ""],
          "Рекомендация не должна быть длиннее 4 000 символов.",
        ],
      ];
      for (const [args, message] of cases) {
        expect(await failure(tx, () => submit(...args))).toBe(message);
      }
      const [{ r: ok1 }] = await submit(
        " Петров Олег ",
        " Самара ",
        " 4 ",
        " Короче вступление ",
        "5",
        "",
      );
      expect(ok1).toEqual({ full_name: "Яковлева Ирина" });
      await submit("Смирнова Анна", "Казань", "5", "", "2", "Неясно, кто звонит");
      expect(await failure(tx, () => tx`select an_rv_staff_links()`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select * from an_rv_staff_responses`)).toContain(
        "permission denied",
      );

      // Статистика — за день по Москве.
      await as(tx, admin);
      const [{ today }] =
        await tx`select (now() at time zone 'Europe/Moscow')::date::text as today`;
      const [{ rep }] = await tx`select an_rv_staff_report(${today}::date, ${today}::date) as rep`;
      expect(rep.total).toBe(2);
      expect(rep.employees).toEqual([
        {
          name: "Яковлева Ирина",
          position: "",
          count: 2,
          professionalism_average: 4.5,
          next_steps_average: 3.5,
          overall_average: 4,
          comments: 2,
        },
      ]);
      expect(rep.responses.map((x: { partner_name: string }) => x.partner_name)).toEqual([
        "Смирнова Анна",
        "Петров Олег",
      ]);
      expect(rep.responses[1]).toMatchObject({
        partner_city: "Самара",
        professionalism_rating: 4,
        professionalism_comment: "Короче вступление",
        next_steps_rating: 5,
        next_steps_comment: "",
      });
      const [{ before }] =
        await tx`select an_rv_staff_report('2026-01-01', '2026-01-31') as before`;
      expect(before).toEqual({ total: 0, employees: [], responses: [] });

      // Приостановленная ссылка — формы нет.
      await tx`select an_rv_staff_link_set_active(${link}, false)`;
      await asServer(tx);
      await tx`set local role anon`;
      expect(await failure(tx, () => submit("П", "Самара", "5", "", "5", ""))).toBe(
        "an_rv_link_gone",
      );
      const [{ paused }] = await tx`select an_rv_feedback_form(${token}) as paused`;
      expect(paused).toBeNull();

      // Сверх их формы: не больше 50 ответов по ссылке за час.
      await as(tx, admin);
      await tx`select an_rv_staff_link_set_active(${link}, true)`;
      await asServer(tx);
      await tx`insert into an_rv_staff_responses (link_id, rating, partner_name, partner_city,
                 professionalism_rating, next_steps_rating)
               select ${link}, 10, 'Бот', 'Город', 5, 5 from generate_series(1, 48)`;
      await tx`set local role anon`;
      expect(await failure(tx, () => submit("П", "Самара", "5", "", "5", ""))).toBe(
        "Слишком много ответов по этой ссылке — попробуйте позже.",
      );

      await asServer(tx);
      const events = await tx`select event, details from an_audit where user_id = ${admin}
                               and event like 'staff_feedback%' order by id`;
      expect(events.map((e: { event: string }) => e.event)).toEqual([
        "staff_feedback_link_created",
        "staff_feedback_link_created",
        "staff_feedback_links_view",
        "staff_feedback_view",
        "staff_feedback_view",
        "staff_feedback_link_updated",
        "staff_feedback_link_updated",
      ]);
      expect(events[5].details).toBe(`${link}: active=0`);
    });
  });
  // ---- VK Ads (2026-10-30_zzzzz_analytics_vk.sql) ----

  /** Шифртекст ключа, как его отдаёт сервер портала (base64, от 40 знаков). */
  const vkCipher = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");

  test("VK Ads: кабинеты — создание, правила их кода, ключ, правка, вкл/выкл, удаление с историей", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      const admin = await person(tx, "Админ VK", ["an.admin"]);
      const staff = await person(tx, "Таргетолог", ["an.vk.register"]);
      await as(tx, admin);
      const create = (
        name: string,
        vk: string,
        city: string,
        brand: string,
        cipher: string,
        partner = "",
      ) =>
        tx`select an_vk_account_create(${name}, ${vk}, ${city}, ${partner}, ${brand}, ${cipher}) as id`;
      expect(await failure(tx, () => create(" ", "1", "Абакан", "Lady Stretch", vkCipher()))).toBe(
        "Название, ID VK Ads, город и API-ключ обязательны.",
      );
      expect(await failure(tx, () => create("К", "1", "Абакан", "Lady Stretch", ""))).toBe(
        "Название, ID VK Ads, город и API-ключ обязательны.",
      );
      expect(await failure(tx, () => create("К", "1", "Абакан", "Lady", vkCipher()))).toBe(
        "Выберите допустимый бренд.",
      );
      expect(
        await failure(tx, () => create("К", "1", "Абакан", "Lady Stretch", "plain-token")),
      ).toBe("Ключ не зашифрован — сохраните его через портал.");
      const [{ id: a }] = await create(
        " Абакан ЛС ",
        " 7000001 ",
        "Абакан",
        "Lady Stretch",
        vkCipher(),
        "Иванова",
      );
      const [{ id: b }] = await create("Казань ЛД", "7000002", " Казань ", "Lady Jump", vkCipher());
      expect(
        await failure(tx, () => create("Дубль", "7000001", "Абакан", "Lady Stretch", vkCipher())),
      ).toBe("Кабинет с таким ID VK Ads уже есть.");

      await asServer(tx);
      const rows = await tx`select id, name, vk_account_id, city, brand, partner_name, is_active
                              from an_vk_accounts order by id`;
      expect(
        rows.map((r: { name: string; vk_account_id: string; city: string; brand: string }) => [
          r.name,
          r.vk_account_id,
          r.city,
          r.brand,
        ]),
      ).toEqual([
        ["Абакан ЛС", "7000001", "Абакан", "Lady Stretch"],
        ["Казань ЛД", "7000002", "Казань · Вишневского", "Lady Jump"],
      ]);
      expect((await tx`select 1 from an_secrets where kind = 'vk_ads'`).length).toBe(2);
      // Сбор (сервер): остаток, кампании, статистика, связь ЛФ.
      await tx`insert into an_vk_balances (account_id, measured_at, balance) values
        (${a}, now() - interval '2 hours', 100), (${a}, now(), 15234.50)`;
      await tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent) values
        (${a}, '1', '2026-10-29', 100.25), (${a}, '2', '2026-10-29', 50.5), (${a}, '3', '2026-10-28', 7),
        (${b}, '9', '2026-10-29', 10)`;
      await tx`insert into an_vk_lead_form_links (account_id, vk_form_id, vk_plan_id) values (${a}, '11', '2')`;

      await as(tx, admin);
      const [{ list }] = await tx`select an_vk_accounts() as list`;
      expect(list.accounts.map((r: { name: string }) => r.name)).toEqual([
        "Казань ЛД",
        "Абакан ЛС",
      ]);
      expect(list.accounts[1]).toMatchObject({
        last_balance: "15234.50",
        partner_name: "Иванова",
        is_active: true,
      });
      expect(list.accounts[0].last_balance).toBeNull();
      const [{ spend }] = await tx`select an_vk_spend('2026-10-29') as spend`;
      expect(
        spend.map(
          (r: {
            name: string;
            platform_spent: number;
            lead_form_spent: number;
            campaign_rows: number;
          }) => [r.name, r.platform_spent, r.lead_form_spent, r.campaign_rows],
        ),
      ).toEqual([
        ["Абакан ЛС", 150.75, 50.5, 2],
        ["Казань ЛД", 10, 0, 1],
      ]);
      const [{ empty }] = await tx`select an_vk_spend('2026-01-01') as empty`;
      expect(empty.map((r: { campaign_rows: number }) => r.campaign_rows)).toEqual([0, 0]);

      await tx`select an_vk_account_update(${a}, 'Казань', 'Петрова', 'Lady Jump')`;
      expect(
        await failure(tx, () => tx`select an_vk_account_update(-1, '', '', 'Lady Stretch')`),
      ).toBe("Кабинет не найден.");
      expect(await failure(tx, () => tx`select an_vk_account_update(${a}, '', '', 'X')`)).toBe(
        "Выберите допустимый бренд.",
      );
      await asServer(tx);
      await tx`update an_vk_accounts set last_verification_status = 200, last_verified_at = now() where id = ${a}`;
      await as(tx, admin);
      expect(await failure(tx, () => tx`select an_vk_account_set_token(${a}, '')`)).toBe(
        "Введите API-ключ VK Ads.",
      );
      await tx`select an_vk_account_set_token(${a}, ${vkCipher()})`;
      const [{ off }] = await tx`select an_vk_account_toggle(${a}) as off`;
      const [{ on }] = await tx`select an_vk_account_toggle(${a}) as on`;
      expect([off, on]).toEqual([false, true]);
      await asServer(tx);
      const [acc] =
        await tx`select city, partner_name, brand, last_verification_status from an_vk_accounts where id = ${a}`;
      expect(acc).toEqual({
        city: "Казань · Вишневского",
        partner_name: "Петрова",
        brand: "Lady Jump",
        last_verification_status: null,
      });

      await as(tx, admin);
      await tx`select an_vk_account_delete(${a})`;
      expect(await failure(tx, () => tx`select an_vk_account_delete(${a})`)).toBe(
        "Кабинет не найден.",
      );
      await asServer(tx);
      expect(
        (await tx`select 1 from an_secrets where kind = 'vk_ads' and ref = ${String(a)}`).length,
      ).toBe(0);
      expect((await tx`select 1 from an_vk_balances where account_id = ${a}`).length).toBe(0);
      expect((await tx`select 1 from an_vk_daily_stats where account_id = ${a}`).length).toBe(0);
      const events =
        await tx`select event from an_audit where user_id = ${admin} and event like 'vk_ads%' order by id`;
      expect(events.map((e: { event: string }) => e.event)).toEqual([
        "vk_ads_account_created",
        "vk_ads_account_created",
        "vk_ads_account_metadata_changed",
        "vk_ads_account_token_changed",
        "vk_ads_account_toggled",
        "vk_ads_account_toggled",
        "vk_ads_account_deleted",
      ]);

      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_vk_accounts()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select an_vk_spend('2026-10-29')`)).toContain(
        "an_forbidden",
      );
      expect(await failure(tx, () => tx`select * from an_vk_accounts`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select an_vk_store_token(${b}, ${vkCipher()})`)).toContain(
        "permission denied",
      );
    });
  });

  test("VK Ads: импорт кабинетов — пропуски, обновление без стирания города, новые — Lady Stretch", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      const admin = await person(tx, "Админ VK", ["an.admin"]);
      await as(tx, admin);
      await tx`select an_vk_account_create('Старое имя', '7000001', 'Абакан', 'Иванова', 'Lady Jump', ${vkCipher()})`;
      const [{ id: off }] =
        await tx`select an_vk_account_create('Выключен', '7000009', 'Бийск', '', 'Lady Stretch', ${vkCipher()}) as id`;
      await tx`select an_vk_account_toggle(${off})`;
      const records = [
        {
          name: "Новое имя",
          vk_account_id: "7000001",
          token_cipher: vkCipher(),
          city: "",
          partner_name: "",
          brand: "",
        },
        {
          name: "Новый",
          vk_account_id: "7000002",
          token_cipher: vkCipher(),
          city: "",
          partner_name: "",
          brand: "",
        },
        {
          name: "Без ключа",
          vk_account_id: "7000003",
          token_cipher: "",
          city: "",
          partner_name: "",
          brand: "",
        },
        {
          name: "Чужой бренд",
          vk_account_id: "7000004",
          token_cipher: vkCipher(),
          city: "",
          partner_name: "",
          brand: "Lady X",
        },
        {
          name: "Выключен",
          vk_account_id: "7000009",
          token_cipher: vkCipher(),
          city: "Барнаул",
          partner_name: "",
          brand: "",
        },
      ];
      const [{ r }] = await tx`select an_vk_accounts_import(${records}::jsonb) as r`;
      expect(r).toEqual({ created: 1, updated: 2, skipped: 2 });
      await asServer(tx);
      const rows =
        await tx`select name, vk_account_id, city, partner_name, brand, is_active from an_vk_accounts order by vk_account_id`;
      expect(rows).toEqual([
        {
          name: "Новое имя",
          vk_account_id: "7000001",
          city: "Абакан",
          partner_name: "Иванова",
          brand: "Lady Jump",
          is_active: true,
        },
        {
          name: "Новый",
          vk_account_id: "7000002",
          city: "",
          partner_name: "",
          brand: "Lady Stretch",
          is_active: true,
        },
        {
          name: "Выключен",
          vk_account_id: "7000009",
          city: "Барнаул",
          partner_name: "",
          brand: "Lady Stretch",
          is_active: true,
        },
      ]);
      expect((await tx`select 1 from an_secrets where kind = 'vk_ads'`).length).toBe(3);
      const [{ details }] =
        await tx`select details from an_audit where event = 'vk_ads_accounts_imported' and user_id = ${admin}`;
      expect(details).toBe("created=1, updated=2, skipped=2");
    });
  });

  // ---- VK Ads, часть 2 (2026-10-30_zzzzzz_analytics_vk_register.sql) ----

  test("VK Ads: планы таргета — проверки их save_monthly_plans, без изменений, история, удаление", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_plans`;
      await tx`delete from an_vk_plan_changes`;
      const admin = await person(tx, "Админ Планов", ["an.admin"]);
      const target = await person(tx, "Таргет", ["an.targetologist"]);
      await as(tx, admin);
      const save = (brand: string, months: unknown, source = "single") =>
        tx`select an_vk_plans_save(${brand}, ${months}::jsonb, ${source}) as r`;
      const one = (month: string, plans: unknown) => [{ month, plans }];
      const plan = (city: string, applications_plan: unknown, target_cpl: unknown) => ({
        city,
        applications_plan,
        target_cpl,
      });
      expect(await failure(tx, () => save("Lady Stretch", one("2026-13", [plan("А", 1, 1)])))).toBe(
        "Укажите месяц в формате ГГГГ-ММ.",
      );
      expect(await failure(tx, () => save("Lady X", one("2026-10", [plan("А", 1, 1)])))).toBe(
        "Выберите допустимый бренд.",
      );
      expect(await failure(tx, () => save("Lady Stretch", one("2026-10", [])))).toBe(
        "В файле не найдено ни одного заполненного плана.",
      );
      expect(
        await failure(tx, () =>
          save("Lady Stretch", one("2026-10", [plan("Абакан", 1, 1), plan(" Абакан ", 2, 2)])),
        ),
      ).toBe("Город «Абакан» повторяется в файле.");
      expect(await failure(tx, () => save("Lady Stretch", one("2026-10", [plan(" ", 1, 1)])))).toBe(
        "Город «без названия» повторяется в файле.",
      );
      expect(
        await failure(tx, () => save("Lady Stretch", one("2026-10", [plan("Абакан", 1.5, 1)]))),
      ).toBe("План заявок для «Абакан» должен быть целым числом от нуля.");
      expect(
        await failure(tx, () => save("Lady Stretch", one("2026-10", [plan("Абакан", -1, 1)]))),
      ).toBe("План заявок для «Абакан» должен быть целым числом от нуля.");
      expect(
        await failure(tx, () => save("Lady Stretch", one("2026-10", [plan("Абакан", 3, 0)]))),
      ).toBe("Стоимость заявки для «Абакан» должна быть числом больше нуля.");
      expect(
        await failure(tx, () => save("Lady Stretch", one("2026-10", [plan("Абакан", 3, null)]))),
      ).toBe("Стоимость заявки для «Абакан» должна быть числом больше нуля.");

      const [{ r: first }] = await save(
        "Lady Jump",
        one("2026-10", [plan("Казань", 40, 333.3333333333333), plan("Бийск", 0, 500)]),
      );
      expect(first).toEqual({ changed: 2, months: 1 });
      // Казань у Lady Jump — их согласованная замена города.
      const [{ r: same }] = await save(
        "Lady Jump",
        one("2026-10", [plan("Казань · Вишневского", 40, 333.3333333333333)]),
        "manual",
      );
      expect(same).toEqual({ changed: 0, months: 1 });
      const [{ r: changed }] = await save(
        "Lady Jump",
        one("2026-10", [plan("Казань Вишневского", 45, 300)]),
        "manual",
      );
      expect(changed.changed).toBe(1);
      const [{ r: all }] = await save(
        "Lady Stretch",
        [
          { month: "2026-09", plans: [plan("Абакан", 30, 1000)] },
          { month: "2026-10", plans: [plan("Абакан", 31, 1000), plan("Бийск", 10, 700.5)] },
        ],
        "all",
      );
      expect(all).toEqual({ changed: 3, months: 2 });

      const [{ m }] = await tx`select an_vk_plans_month('2026-10') as m`;
      expect(m.plans.map((p: { brand: string; city: string }) => `${p.brand}·${p.city}`)).toEqual([
        "Lady Jump·Бийск",
        "Lady Jump·Казань · Вишневского",
        "Lady Stretch·Абакан",
        "Lady Stretch·Бийск",
      ]);
      expect(m.plans[1]).toEqual({
        month: "2026-10",
        brand: "Lady Jump",
        city: "Казань · Вишневского",
        applications_plan: 45,
        target_cpl: 300,
      });
      expect(m.changes[m.changes.length - 1]).toMatchObject({
        brand: "Lady Jump",
        previous_applications_plan: null,
        previous_target_cpl: null,
        changed_by: "Админ Планов",
      });
      const kazan = m.changes.find(
        (c: { city: string; previous_applications_plan: number | null }) =>
          c.city === "Казань · Вишневского" && c.previous_applications_plan !== null,
      );
      expect(kazan).toMatchObject({
        previous_applications_plan: 40,
        previous_target_cpl: 333.3333333333333,
        applications_plan: 45,
        target_cpl: 300,
      });
      expect(m.cities).toContain("Бийск");

      expect(
        await failure(tx, () => tx`select an_vk_plan_delete('2026-1', 'Lady Stretch', 'Бийск')`),
      ).toBe("Проверьте месяц.");
      expect(await failure(tx, () => tx`select an_vk_plan_delete('2026-10', 'X', 'Бийск')`)).toBe(
        "Проверьте бренд и город.",
      );
      const [{ d1 }] = await tx`select an_vk_plan_delete('2026-10', 'Lady Stretch', 'Бийск') as d1`;
      const [{ d2 }] = await tx`select an_vk_plan_delete('2026-10', 'Lady Stretch', 'Бийск') as d2`;
      expect([d1, d2]).toEqual([true, false]);

      await asServer(tx);
      const audit =
        await tx`select event, details from an_audit where user_id = ${admin} order by id`;
      expect(audit.map((a: { event: string }) => a.event)).toEqual([
        "target_plans_imported",
        "target_plan_changed",
        "target_plan_changed",
        "target_plans_imported_all",
        "target_plan_deleted",
      ]);
      expect(audit[0].details).toBe("2026-10: 2 из 2 городов");
      expect(audit[2].details).toBe("2026-10: Lady Jump · Казань Вишневского");
      expect(audit[3].details).toBe("2026-09: 1, 2026-10: 2");
      expect(JSON.parse(audit[4].details)).toMatchObject({
        month: "2026-10",
        brand: "Lady Stretch",
        city: "Бийск",
        applications_plan: 10,
        target_cpl: 700.5,
      });

      await as(tx, target);
      expect(await failure(tx, () => tx`select an_vk_plans_month('2026-10')`)).toContain(
        "an_forbidden",
      );
      expect(
        await failure(tx, () => save("Lady Stretch", one("2026-10", [plan("Абакан", 1, 1)]))),
      ).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select * from an_vk_plans`)).toContain("permission denied");
    });
  });

  test("VK Ads: таргетологи и источники СС — выбор из людей с правом, проверки ссылок, сбор сервером", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_targetologists`;
      await tx`delete from an_vk_ss_sources`;
      await tx`delete from an_vk_ss_daily`;
      const admin = await person(tx, "Админ Таргета", ["an.admin"]);
      await person(tx, "Яковлева Ирина", ["an.targetologist"]);
      await person(tx, "анна Петрова", ["an.targetologist"]);
      await person(tx, "Админ и таргетолог", ["an.admin", "an.targetologist"]);
      await as(tx, admin);
      const [{ t }] = await tx`select an_vk_targetologists() as t`;
      expect(
        t.people.filter((n: string) =>
          ["Яковлева Ирина", "анна Петрова", "Админ и таргетолог"].includes(n),
        ),
      ).toEqual(["Яковлева Ирина", "анна Петрова"]);
      expect(
        await failure(
          tx,
          () => tx`select an_vk_targetologist_save('Lady Stretch', 'Абакан', 'Кто-то')`,
        ),
      ).toBe("Выберите сотрудника с ролью «Таргетолог».");
      expect(
        await failure(
          tx,
          () => tx`select an_vk_targetologist_save('X', 'Абакан', 'Яковлева Ирина')`,
        ),
      ).toBe("Выберите допустимый бренд.");
      expect(
        await failure(
          tx,
          () => tx`select an_vk_targetologist_save('Lady Stretch', ' ', 'Яковлева Ирина')`,
        ),
      ).toBe("Укажите город и таргетолога.");
      await tx`select an_vk_targetologist_save('Lady Stretch', ' Абакан ', 'Яковлева Ирина')`;
      await tx`select an_vk_targetologist_save('Lady Stretch', 'Абакан', 'анна Петрова')`;
      await tx`select an_vk_targetologist_save('Lady Jump', 'Казань', 'анна Петрова')`;
      const [{ t: t2 }] = await tx`select an_vk_targetologists() as t`;
      expect(t2.assignments).toEqual([
        { brand: "Lady Jump", city: "Казань · Вишневского", targetologist_name: "анна Петрова" },
        { brand: "Lady Stretch", city: "Абакан", targetologist_name: "анна Петрова" },
      ]);
      expect(
        await failure(tx, () => tx`select an_vk_targetologist_delete('Lady Stretch', '')`),
      ).toBe("Укажите бренд и город.");
      await tx`select an_vk_targetologist_delete('Lady Jump', 'Казань')`;
      expect((await tx`select an_vk_targetologists() as t`)[0].t.assignments.length).toBe(1);

      const good = "https://docs.google.com/spreadsheets/d/abc_DEF-1/edit#gid=0";
      const src = (city: string, leads: string, apps: string, brand = "Lady Stretch") =>
        tx`select an_vk_ss_source_save(${brand}, ${city}, ${leads}, ${apps})`;
      expect(await failure(tx, () => src("", good, good))).toBe("Укажите город.");
      expect(await failure(tx, () => src("Г".repeat(121), good, good))).toBe(
        "Название города слишком длинное.",
      );
      for (const bad of [
        "http://docs.google.com/spreadsheets/d/x",
        "https://docs.google.com:443/spreadsheets/d/x",
        "https://evil.com/docs.google.com/spreadsheets/d/x",
        "https://docs.google.com/document/d/x",
        "https://docs.google.com/x?u=/spreadsheets/",
      ]) {
        expect(await failure(tx, () => src("Абакан", bad, good))).toBe(
          "Укажите корректную ссылку Google Таблицы для лидов СС.",
        );
      }
      expect(await failure(tx, () => src("Абакан", good, "нет"))).toBe(
        "Укажите корректную ссылку Google Таблицы для заявок СС.",
      );
      await src(" Абакан ", " HTTPS://www.docs.google.com/spreadsheets/d/1/edit ", good);
      await src("Казань", good, good, "Lady Jump");
      const [{ s }] = await tx`select an_vk_ss_sources() as s`;
      expect(
        s.sources.map((x: { city: string; leads_sheet_url: string }) => [
          x.city,
          x.leads_sheet_url,
        ]),
      ).toEqual([
        ["Казань · Вишневского", good],
        ["Абакан", "HTTPS://www.docs.google.com/spreadsheets/d/1/edit"],
      ]);
      expect(s.google).toBeNull();
      expect(await failure(tx, () => tx`select an_vk_ss_source_delete('Lady Stretch', '')`)).toBe(
        "Не указан город для удаления.",
      );
      expect(
        await failure(tx, () => tx`select an_vk_ss_store('Lady Stretch', 'Абакан', '[]'::jsonb)`),
      ).toContain("permission denied");

      await asService(tx);
      await tx`select an_vk_ss_store('Lady Stretch', 'Абакан',
        '[{"date":"2026-09-02","leads":5,"applications":2},{"date":"2026-09-03","leads":1,"applications":0}]'::jsonb)`;
      await tx`select an_vk_ss_store('Lady Stretch', 'Абакан',
        '[{"date":"2026-09-02","leads":6,"applications":3}]'::jsonb)`;
      await asServer(tx);
      expect(
        await tx`select stat_date::text as d, leads_count, applications_count from an_vk_ss_daily`,
      ).toEqual([{ d: "2026-09-02", leads_count: 6, applications_count: 3 }]);
      await tx`insert into an_google_settings (sa_client_email, sa_updated_at) values ('sa@x.iam.gserviceaccount.com', now())`;
      await tx`insert into an_secrets (kind, ref, name, ciphertext) values ('google', 'sheets', 'service_account', 'x')`;
      await as(tx, admin);
      const [{ s: s2 }] = await tx`select an_vk_ss_sources() as s`;
      expect(s2.google.client_email).toBe("sa@x.iam.gserviceaccount.com");
      await tx`select an_vk_ss_source_delete('Lady Jump', 'Казань')`;
      expect((await tx`select an_vk_ss_sources() as s`)[0].s.sources.length).toBe(1);
    });
  });

  test("VK Ads: дни без бюджета — правило 12.10 (numeric), прежнее правило, «без истории», исключение", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      await tx`delete from an_vk_plans`;
      const [{ a }] =
        await tx`insert into an_vk_accounts (name, vk_account_id, city, brand, created_at)
        values ('А', '9001', 'Абакан', 'Lady Stretch', '2026-08-01') returning id as a`;
      const [{ k }] =
        await tx`insert into an_vk_accounts (name, vk_account_id, city, brand, created_at)
        values ('К', '9002', 'Казань · Вишневского', 'Lady Jump', '2026-08-01') returning id as k`;
      // Выключенный кабинет не считается.
      await tx`insert into an_vk_accounts (name, vk_account_id, city, brand, is_active, created_at)
        values ('Выкл', '9003', 'Абакан', 'Lady Stretch', false, '2026-08-01')`;
      // План 30 заявок × 1000 ₽ на 30 дней: дневной бюджет 1000.
      await tx`insert into an_vk_plans (month, brand, city, applications_plan, target_cpl)
        values ('2026-09', 'Lady Stretch', 'Абакан', 30, 1000)`;
      const bal = (id: number, at: string, balance: number) =>
        tx`insert into an_vk_balances (account_id, measured_at, balance) values (${id}, ${at}, ${balance})`;
      const spent = (id: number, day: string, v: number) =>
        tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent) values (${id}, '1', ${day}, ${v})`;
      const day = async (d: string, open: number, close: number, sp: number) => {
        await bal(a, `${d} 00:30+03`, open);
        await bal(a, `${d} 23:30+03`, close);
        if (sp) await spent(a, d, sp);
      };
      await day("2026-09-01", 5000, 4000, 0); // остатки выше дневного — не простой
      await day("2026-09-02", 800, 600, 500); // потрачено 50 % — не простой
      await day("2026-09-03", 900, 1200, 100); // вечером выше дневного — простой (их правило)
      await day("2026-09-04", 400, 300, 100); // утром ниже 50 % — простой
      await day("2026-09-05", 600, 100, 200); // утром от 50 % — не простой
      // 06.09 — снимков нет: прежнее правило, «без истории».
      await bal(a, "2026-09-07 12:00+03", 0); // с планом и снимком: ноль — простой
      // Казань без плана: положительный остаток — не простой; ноль за 1 час —
      // простой «без истории»; ноль все 24 часа — простой с историей.
      await bal(k, "2026-09-01 10:00+03", 50);
      await bal(k, "2026-09-02 10:00+03", 0);
      await tx`insert into an_vk_balances (account_id, measured_at, balance)
        select ${k}, timestamptz '2026-09-03 00:10+03' + make_interval(hours => h), 0 from generate_series(0, 23) h`;
      await spent(k, "2026-09-04", 0.01);

      const keys = [
        { brand: "Lady Stretch", city: "Абакан" },
        { brand: "Lady Jump", city: "Казань · Вишневского" },
        { brand: "Lady Stretch", city: "Бийск" },
      ];
      const rows = await tx`
        select brand, city, zero_days::text[] as z, assumed_days::text[] as s
          from an_vk_outage_days('2026-09-01', '2026-09-30', ${keys}::jsonb, '2026-09-08')
         order by brand, city`;
      expect(rows).toEqual([
        {
          brand: "Lady Jump",
          city: "Казань · Вишневского",
          z: ["2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-07"],
          s: ["2026-09-02", "2026-09-05", "2026-09-06", "2026-09-07"],
        },
        {
          brand: "Lady Stretch",
          city: "Абакан",
          z: ["2026-09-03", "2026-09-04", "2026-09-06", "2026-09-07"],
          s: ["2026-09-06"],
        },
        {
          brand: "Lady Stretch",
          city: "Бийск",
          z: [
            "2026-09-01",
            "2026-09-02",
            "2026-09-03",
            "2026-09-04",
            "2026-09-05",
            "2026-09-06",
            "2026-09-07",
          ],
          s: [
            "2026-09-01",
            "2026-09-02",
            "2026-09-03",
            "2026-09-04",
            "2026-09-05",
            "2026-09-06",
            "2026-09-07",
          ],
        },
      ]);
      // Исключение их кода; кабинет, добавленный днём, считается с этого дня.
      const [vl] =
        await tx`select zero_days::text[] as z from an_vk_outage_days('2026-10-06', '2026-10-08',
        '[{"brand":"Lady Stretch","city":"Владимир"}]'::jsonb, '2026-10-30')`;
      expect(vl.z).toEqual(["2026-10-06", "2026-10-08"]);
      const [{ late }] =
        await tx`insert into an_vk_accounts (name, vk_account_id, city, brand, created_at)
        values ('Новый', '9004', 'Бийск', 'Lady Stretch', '2026-09-03 18:00+03') returning id as late`;
      await bal(late, "2026-09-03 19:00+03", 10);
      const [bi] =
        await tx`select zero_days::text[] as z from an_vk_outage_days('2026-09-02', '2026-09-04',
        '[{"brand":"Lady Stretch","city":"Бийск"}]'::jsonb, '2026-09-30')`;
      expect(bi.z).toEqual(["2026-09-02", "2026-09-04"]);
      // Конец периода — не позже вчера; пустой период — пустые списки.
      const [cut] =
        await tx`select zero_days::text[] as z from an_vk_outage_days('2026-09-01', '2026-09-30',
        '[{"brand":"Lady Stretch","city":"Бийск"}]'::jsonb, '2026-09-03')`;
      expect(cut.z).toEqual(["2026-09-01", "2026-09-02"]);
      const [none] =
        await tx`select zero_days::text[] as z from an_vk_outage_days('2026-09-05', '2026-09-30',
        '[{"brand":"Lady Stretch","city":"Бийск"}]'::jsonb, '2026-09-03')`;
      expect(none.z).toEqual([]);
    });
  });

  test("VK Ads: реестр таргета — строки по городам, планы, факт до периода, кому что видно", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      await tx`delete from an_vk_plans`;
      await tx`delete from an_vk_targetologists`;
      await tx`delete from an_vk_ss_daily`;
      const admin = await person(tx, "Админ Реестра", ["an.admin"]);
      const target = await person(tx, "Таргет Анна", ["an.targetologist"]);
      const noname = await person(tx, "Без имени", ["an.targetologist"]);
      await tx`update profiles set full_name = ' ' where id = ${noname}`;
      const staff = await person(tx, "Сотрудник Реестра", ["an.vk.register"]);
      const other = await person(tx, "Без права", ["an.onec.revenue"]);
      const [{ a }] = await tx`insert into an_vk_accounts (name, vk_account_id, city, brand)
        values ('А1', '9101', 'Абакан', 'Lady Stretch') returning id as a`;
      await tx`insert into an_vk_accounts (name, vk_account_id, city, brand)
        values ('А2', '9102', 'Абакан', 'Lady Stretch')`;
      const [{ k }] = await tx`insert into an_vk_accounts (name, vk_account_id, city, brand)
        values ('К', '9103', 'Казань · Вишневского', 'Lady Jump') returning id as k`;
      await tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent) values
        (${a}, '1', '2026-09-05', 1000.5), (${a}, '2', '2026-09-05', 200.25), (${a}, '1', '2026-09-06', 10),
        (${a}, '1', '2026-09-20', 99999), (${k}, '7', '2026-09-05', 300)`;
      await tx`insert into an_vk_lead_form_links (account_id, vk_form_id, vk_plan_id) values (${a}, 'f', '2')`;
      await tx`insert into an_vk_lf_daily (account_id, stat_date, applications_count) values
        (${a}, '2026-09-05', 2), (${a}, '2026-09-02', 4)`;
      await tx`insert into an_vk_ss_daily (brand, city, stat_date, leads_count, applications_count) values
        ('Lady Stretch', 'Абакан', '2026-09-06', 10, 3), ('Lady Stretch', 'Абакан', '2026-09-01', 7, 5),
        ('Lady Stretch', 'Барнаул', '2026-09-06', 4, 1)`;
      await tx`insert into an_vk_plans (month, brand, city, applications_plan, target_cpl) values
        ('2026-09', 'Lady Stretch', 'Абакан', 30, 1000), ('2026-09', 'Lady Stretch', 'Бийск', 12, 800.5),
        ('2026-10', 'Lady Stretch', 'Абакан', 31, 900), ('2026-08', 'Lady Stretch', 'Омск', 5, 100)`;
      await tx`insert into an_vk_targetologists (brand, city, targetologist_name) values
        ('Lady Stretch', 'Абакан', 'Таргет Анна'), ('Lady Stretch', 'Бийск', 'Кто-то другой')`;

      const reg = async (uid: string, from: string, to: string, t = "", brand = "") => {
        await as(tx, uid);
        const [{ r }] = await tx`select an_vk_register(${from}, ${to}, ${t}, ${brand}) as r`;
        await asServer(tx);
        return r;
      };
      const byKey = (r: { rows: { brand: string; city: string }[] }) =>
        Object.fromEntries(r.rows.map((x) => [`${x.brand}·${x.city}`, x]));

      const r = await reg(admin, "2026-09-04", "2026-09-10");
      const rows = byKey(r);
      expect(Object.keys(rows).sort()).toEqual([
        "Lady Jump·Казань · Вишневского",
        "Lady Stretch·Абакан",
        "Lady Stretch·Барнаул",
        "Lady Stretch·Бийск",
      ]);
      expect(rows["Lady Stretch·Абакан"]).toMatchObject({
        platform_spent: 1210.75,
        lead_form_spent: 200.25,
        campaign_rows: 2,
        accounts_count: 2,
        community_leads: 10,
        community_applications: 3,
        lead_form_applications: 2,
        targetologist_name: "Таргет Анна",
      });
      expect(rows["Lady Stretch·Бийск"]).toMatchObject({
        platform_spent: 0,
        accounts_count: 0,
        targetologist_name: "Кто-то другой",
      });
      expect(rows["Lady Stretch·Барнаул"].targetologist_name).toBeNull();
      expect(
        r.plans.map((p: { city: string; month: string }) => `${p.month}·${p.city}`).sort(),
      ).toEqual(["2026-09·Абакан", "2026-09·Бийск"]);
      // Факт сентября до 04.09: заявки СС 01.09 (5) + заявки ЛФ 02.09 (4).
      expect(r.facts).toEqual([
        { month: "2026-09", brand: "Lady Stretch", city: "Абакан", applications: 9 },
      ]);
      expect(r.people).toContain("Таргет Анна");
      expect(r.admin).toBe(true);
      expect(rows["Lady Stretch·Бийск"].zero_days.length).toBe(7);

      // Направление и выбор таргетолога администратором.
      expect(
        Object.keys(byKey(await reg(admin, "2026-09-04", "2026-09-10", "", "Lady Jump"))),
      ).toEqual(["Lady Jump·Казань · Вишневского"]);
      expect(
        Object.keys(byKey(await reg(admin, "2026-09-04", "2026-09-10", " Кто-то другой "))),
      ).toEqual(["Lady Stretch·Бийск"]);
      // Таргетолог — только свои города, что бы ни передал; без ФИО — ничего.
      const own = await reg(target, "2026-09-10", "2026-09-04", "Кто-то другой");
      expect(Object.keys(byKey(own))).toEqual(["Lady Stretch·Абакан"]);
      expect([own.from, own.to, own.targetologist, own.people]).toEqual([
        "2026-09-04",
        "2026-09-10",
        "Таргет Анна",
        [],
      ]);
      expect((await reg(noname, "2026-09-04", "2026-09-10")).rows).toEqual([]);
      // Сотрудник с правом на реестр — все города; не администратор — в журнале.
      expect((await reg(staff, "2026-09-04", "2026-09-10")).rows.length).toBe(4);
      expect(
        (
          await tx`select 1 from an_audit where user_id = ${staff} and event = 'dashboard_view' and details = 'Реестр таргета'`
        ).length,
      ).toBe(1);
      expect(
        (await tx`select 1 from an_audit where user_id = ${admin} and event = 'dashboard_view'`)
          .length,
      ).toBe(0);
      await as(tx, other);
      expect(
        await failure(tx, () => tx`select an_vk_register('2026-09-04', '2026-09-10', '', '')`),
      ).toContain("an_forbidden");
      await as(tx, admin);
      expect(
        await failure(tx, () => tx`select an_vk_register('04.09.2026', '2026-09-10', '', '')`),
      ).toBe("Неверный период");
      expect(
        await failure(tx, () => tx`select an_vk_register_base('2026-09-01', '2026-09-30')`),
      ).toContain("permission denied");
    });
  });

  // ---- VK Ads, часть 3 (2026-10-30_zzzzzzz_analytics_vk_lead_forms.sql) ----

  test("VK Ads: лид-формы — новые заявки без повторов, счётчик дня, пересчёт месяца не уменьшает", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      const admin = await person(tx, "Админ ЛФ", ["an.admin"]);
      const staff = await person(tx, "Без права ЛФ", ["an.vk.register"]);
      const [{ a }] =
        await tx`insert into an_vk_accounts (name, vk_account_id, city) values ('Каб', '9201', 'Абакан') returning id as a`;
      const lead = (id: string, day: string | null) => ({
        lead_id: id,
        form_id: "5",
        created_at_vk: "1759660245",
        ad_plan_id: "10",
        encrypted_payload: "cipher",
        payload_sha256: "x",
        stat_date: day,
      });
      await asService(tx);
      const store = async (leads: unknown[], metrics = true) =>
        (await tx`select an_vk_lf_store(${a}, ${leads}::jsonb, ${metrics}) as n`)[0].n;
      expect(await store([lead("1", "2026-10-05"), lead("2", "2026-10-05"), lead("3", null)])).toBe(
        3,
      );
      expect(await store([lead("1", "2026-10-05"), lead("4", "2026-10-06")])).toBe(1);
      expect(await store([lead("5", "2026-10-06")], false)).toBe(1);
      await asServer(tx);
      const daily = async () =>
        (
          await tx`select stat_date::text as d, applications_count as n from an_vk_lf_daily
                   where account_id = ${a} order by stat_date`
        ).map((r: { d: string; n: number }) => [r.d, r.n]);
      expect(await daily()).toEqual([
        ["2026-10-05", 2],
        ["2026-10-06", 1],
      ]);
      // Пересчёт месяца: известные заявки + новые; меньше прежнего — не становится.
      await asService(tx);
      const [{ s }] = await tx`select an_vk_lf_merge_metrics(${a}, '2026-10-01', '2026-10-31',
        ${[
          { lead_id: "4", stat_date: "2026-10-06" },
          { lead_id: "5", stat_date: "2026-10-06" },
          { lead_id: "6", stat_date: "2026-10-07" },
          { lead_id: "7", stat_date: "2026-09-30" },
        ]}::jsonb) as s`;
      expect(Number(s)).toBe(5);
      await asServer(tx);
      expect(await daily()).toEqual([
        ["2026-10-05", 2],
        ["2026-10-06", 2],
        ["2026-10-07", 1],
      ]);
      await tx`update an_vk_lf_daily set applications_count = 9 where account_id = ${a} and stat_date = '2026-10-07'`;
      await asService(tx);
      await tx`select an_vk_lf_merge_metrics(${a}, '2026-10-01', '2026-10-31', '[]'::jsonb)`;
      await asServer(tx);
      expect((await daily())[2]).toEqual(["2026-10-07", 9]);

      // Обзор «Сбора лид-форм»: таблицы и статусы записи; задача записи выключена.
      await tx`insert into an_vk_lf_sources (account_id, spreadsheet_id) values (${a}, 'sheetA')`;
      await tx`update an_vk_lf_submissions set sheet_status = 'sent' where account_id = ${a} and vk_lead_id in ('1', '2')`;
      await tx`update an_vk_lf_submissions set sheet_status = 'error', sheet_error = 'Google Sheets вернул HTTP 403.'
               where account_id = ${a} and vk_lead_id = '3'`;
      await as(tx, admin);
      const [{ o }] = await tx`select an_vk_lf_overview() as o`;
      expect(o.collector_enabled).toBe(false);
      expect(o.drive).toMatchObject({ client: false, connected: false, folder_id: "" });
      expect(o.sources).toEqual([
        expect.objectContaining({
          account_id: Number(a),
          spreadsheet_id: "sheetA",
          sheet_name: "Заявки",
          sent: 2,
          pending: 2,
          errors: 1,
          last_error: "Google Sheets вернул HTTP 403.",
        }),
      ]);
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_vk_lf_overview()`)).toContain("an_forbidden");
      expect(await failure(tx, () => tx`select an_vk_lf_store(${a}, '[]'::jsonb, true)`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select * from an_vk_lf_submissions`)).toContain(
        "permission denied",
      );
      // Удалённый кабинет уносит таблицу, заявки и счётчики.
      await asServer(tx);
      await tx`delete from an_vk_accounts where id = ${a}`;
      expect((await tx`select 1 from an_vk_lf_submissions where account_id = ${a}`).length).toBe(0);
      expect((await tx`select 1 from an_vk_lf_daily where account_id = ${a}`).length).toBe(0);
    });
  });

  // ---- VK Ads, часть 4 (2026-10-30_zzzzzzzz_analytics_vk_budget.sql) ----

  test("VK Ads: контроль бюджетов — входные данные, уровни без дублей, отправка партнёрам, обзор", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      await tx`delete from an_vk_partner_channels`;
      const admin = await person(tx, "Админ бюджетов", ["an.admin"]);
      const staff = await person(tx, "Без права бюджетов", ["an.vk.register"]);
      const acc = async (name: string, partner: string, active = true) =>
        (
          await tx`insert into an_vk_accounts (name, vk_account_id, city, partner_name, is_active)
                   values (${name}, ${"vk-" + name}, 'Тула', ${partner}, ${active}) returning id as a`
        )[0].a as string;
      const a = await acc("Первый", "ИП Иванова");
      const b = await acc("Второй", "ИП Иванова");
      const off = await acc("Выключен", "ИП Иванова", false);
      for (const [id, spent] of [
        [a, "1000.10"],
        [b, "10"],
      ] as const) {
        await tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent)
                 select ${id}, p, d::date, ${spent}::numeric
                   from unnest(array['p1', 'p2']) p, generate_series('2026-10-23'::date, '2026-10-29', '1 day') d`;
      }
      await tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent)
               values (${a}, 'p1', '2026-10-22', 999999)`;
      await tx`insert into an_vk_balances (account_id, measured_at, balance) values
                 (${a}, now() - interval '1 hour', 1), (${a}, now(), 2500.50), (${off}, now(), 1)`;

      // Входные данные: последний остаток, сумма float за 7 дней и число дней.
      await asService(tx);
      const inputs = await tx`select account_id, balance, spent, days
                                from an_vk_budget_inputs('2026-10-23', '2026-10-29')`;
      // Сумма — float, как их SUM(CAST(spent AS REAL)): 14 × 1000.10 — не ровно 14001.4.
      expect(
        inputs.map((r) => [
          String(r.account_id),
          r.balance,
          Math.round(r.spent * 100),
          Number(r.days),
        ]),
      ).toEqual([
        [a, "2500.50", 1400140, 7],
        [b, null, 14000, 7],
      ]);
      expect(typeof inputs[0].spent).toBe("number");

      // Запись вердиктов: уровень заводится один раз, другие уровни снимаются.
      const apply = async (rows: unknown[]) =>
        (await tx`select an_vk_budget_apply('2026-10-23', '2026-10-29', ${rows}::jsonb) as r`)[0].r;
      const warning = {
        account_id: a,
        kind: "alert",
        stage: "warning",
        balance: "2500.50",
        average: "2000.2",
        forecast: "1.25",
        recommended: "11502",
      };
      expect(await apply([warning, { account_id: b, kind: "ok" }])).toEqual({
        created: 1,
        resolved: 0,
      });
      expect(await apply([warning])).toEqual({ created: 0, resolved: 0 });
      expect(await apply([{ ...warning, stage: "critical" }])).toEqual({ created: 1, resolved: 1 });
      const active = async () =>
        (
          await tx`select account_id, stage, balance::text, recommended_topup::text, period_start::text
                    from an_vk_budget_alerts where is_active order by id`
        ).map((r) => [
          String(r.account_id),
          r.stage,
          r.balance,
          r.recommended_topup,
          r.period_start,
        ]);
      expect(await active()).toEqual([[a, "critical", "2500.50", "11502", "2026-10-23"]]);
      // Удалённый между расчётом и записью кабинет — без ошибки и без строки.
      expect(await apply([{ ...warning, account_id: 999999999 }])).toEqual({
        created: 0,
        resolved: 0,
      });

      // Отправка: только партнёру с привязанным активным чатом, один раз на чат.
      await asServer(tx);
      await tx`insert into an_vk_partner_channels (partner_name, chat_id, chat_title) values ('ИП Иванова', '-100888', 'Чат')`;
      await asService(tx);
      const pending = async () =>
        (await tx`select alert_id, stage, balance, name, chat_id from an_vk_budget_pending()`).map(
          (r) => [r.stage, r.balance, r.name, r.chat_id],
        );
      expect(await pending()).toEqual([["critical", "2500.50", "Первый", "-100888"]]);
      const [{ id: alertId }] = await tx`select id from an_vk_budget_alerts where is_active`;
      const [{ id: channelId }] = await tx`select id from an_vk_partner_channels`;
      await tx`insert into an_vk_budget_deliveries (alert_id, channel_id, status, details)
               values (${alertId}, ${channelId}, 'error', 'Telegram не принял запрос: Bad Request: chat not found')`;
      expect(await pending()).toEqual([]);

      // no_spend снимает молча, ok — со счётом.
      expect(await apply([{ account_id: a, kind: "no_spend" }])).toEqual({
        created: 0,
        resolved: 0,
      });
      expect(await active()).toEqual([]);
      expect(await apply([warning])).toEqual({ created: 1, resolved: 0 });
      expect(await apply([{ account_id: a, kind: "ok" }])).toEqual({ created: 0, resolved: 1 });
      await apply([
        { ...warning, stage: "zero" },
        { ...warning, account_id: b, stage: "warning" },
      ]);

      // Обзор — администратору: пороги, Telegram без секретов, чаты, партнёры, предупреждения.
      await as(tx, admin);
      const [{ o }] = await tx`select an_vk_budget_overview() as o`;
      expect(o.settings).toEqual({
        is_enabled: true,
        warning_days: "3",
        critical_days: "1",
        target_days: 7,
      });
      expect(o.telegram).toMatchObject({ token_saved: false, gateway_secret_saved: false });
      expect(o.delivery_enabled).toBe(false);
      expect(o.partners).toEqual(["ИП Иванова"]);
      expect(o.channels).toEqual([
        {
          id: Number(channelId),
          partner_name: "ИП Иванова",
          chat_id: "-100888",
          chat_title: "Чат",
          is_active: true,
        },
      ]);
      expect(o.alerts.map((x: { name: string; stage: string }) => [x.name, x.stage])).toEqual([
        ["Первый", "zero"],
        ["Второй", "warning"],
      ]);
      await tx`select an_vk_partner_channel_delete(${channelId})`;
      expect(await failure(tx, () => tx`select an_vk_partner_channel_delete(${channelId})`)).toBe(
        "Привязка чата не найдена.",
      );
      await asServer(tx);
      expect(
        (await tx`select event from an_audit where event like 'vk_ads_partner%' order by id`).map(
          (r) => r.event,
        ),
      ).toEqual(["vk_ads_partner_notification_channel_deleted"]);
      expect((await tx`select 1 from an_vk_budget_deliveries`).length).toBe(0);

      // Посторонним — ничего.
      await as(tx, staff);
      expect(await failure(tx, () => tx`select an_vk_budget_overview()`)).toContain("an_forbidden");
      for (const q of [
        () => tx`select * from an_vk_budget_inputs('2026-10-23', '2026-10-29')`,
        () => tx`select an_vk_budget_apply('2026-10-23', '2026-10-29', '[]'::jsonb)`,
        () => tx`select * from an_vk_budget_pending()`,
        () => tx`select * from an_vk_budget_alerts`,
        () => tx`select * from an_tg_settings`,
      ]) {
        expect(await failure(tx, q)).toContain("permission denied");
      }
    });
  });
  // ---- amoCRM, часть 1 (2026-10-30_zzzzzzzzz_analytics_amocrm.sql) ----

  test("amoCRM: правила, ответственные, квалификация — проверки их кода; только администратору", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ amoCRM", ["an.admin"]);
      const staff = await person(tx, "Без права amoCRM", ["an.vk.register"]);
      const [{ id }] =
        await tx`insert into an_amo_connections (name, base_url) values ('CRM', 'https://t.amocrm.ru') returning id`;
      await as(tx, admin);
      const save = (values: Record<string, string>) =>
        failure(tx, () => tx`select an_amo_settings_save(${id}, ${values}::jsonb)`);
      const full = {
        brand: "Lady Jump",
        new_lead_pipeline_id: "111",
        auto_source_field_id: "1",
        manual_source_field_id: "2",
        booked_field_id: "3",
        attended_field_id: "4",
        paid_field_id: "5",
        close_basis_field_id: "6",
      };
      expect(await save({ ...full, brand: "Другой" })).toBe(
        "Выберите направление для воронки новых лидов.",
      );
      expect(await save({ ...full, paid_field_id: "" })).toBe(
        "Выберите воронку и все поля из списка AmoCRM.",
      );
      expect(await save(full)).toBe(
        "Настройки AmoCRM устарели. Сначала обновите список воронок и полей.",
      );
      expect(
        await failure(
          tx,
          () => tx`select an_amo_responsible_save(${id}, '9', 'Lady Stretch', 'Тула', '')`,
        ),
      ).toBe("Сначала обновите список ответственных из AmoCRM.");
      await asServer(tx);
      const fields = ["1", "2", "3", "4", "5"].map((f) => ({
        id: f,
        name: `Поле ${f}`,
        code: "",
        enums: [],
      }));
      fields.push({
        id: "6",
        name: "Основание",
        code: "",
        enums: [
          { id: "501", value: "Мужчина" },
          { id: "502", value: "" },
        ] as never,
      });
      await tx`insert into an_amo_metadata (connection_id, pipelines, lead_fields, users)
               values (${id}, ${[{ id: "111", name: "Новые", is_archive: false }]}::jsonb, ${fields}::jsonb,
                       ${[
                         { id: "9", name: "Анна" },
                         { id: "10", name: "" },
                       ]}::jsonb)`;
      await as(tx, admin);
      expect(await save(full)).toBeNull();
      expect(await save({ ...full, brand: "Lady Stretch" })).toBeNull();
      // Квалификация: значения поля «Основание», лишнее — «устарел».
      expect(await failure(tx, () => tx`select an_amo_basis_save(${id}, array['999'])`)).toContain(
        "устарел",
      );
      await tx`select an_amo_basis_save(${id}, array['501', ' 501 '])`;
      // Ответственные: Казань у Lady Jump — один город; пустой город — ошибка.
      await tx`select an_amo_responsible_save(${id}, ' 9 ', 'Lady Jump', ' Казань Вишневского ', ' ИП ')`;
      await tx`select an_amo_responsible_save(${id}, '10', 'Lady Stretch', 'Казань', '')`;
      expect(
        await failure(
          tx,
          () => tx`select an_amo_responsible_save(${id}, '9', 'Lady Stretch', '  ', '')`,
        ),
      ).toBe("Выберите направление и укажите город.");
      const [{ v }] = await tx`select an_amo_connection(${id}) as v`;
      expect(v.settings).toMatchObject({ new_lead_pipeline_id: "111", brand: "Lady Stretch" });
      expect(v.responsibles).toEqual([
        {
          amo_user_id: "9",
          amo_user_name: "Анна",
          brand: "Lady Jump",
          city: "Казань · Вишневского",
          partner_name: "ИП",
        },
        {
          amo_user_id: "10",
          amo_user_name: "Ответственный AmoCRM",
          brand: "Lady Stretch",
          city: "Казань",
          partner_name: "",
        },
      ]);
      expect(v.basis).toEqual({
        field_selected: true,
        values: [
          { id: "501", value: "Мужчина", unqualified: true },
          { id: "502", value: "Без названия", unqualified: false },
        ],
      });
      expect(v.running).toBe(false);
      await tx`select an_amo_responsible_delete(${id}, '10')`;
      expect(await failure(tx, () => tx`select an_amo_responsible_delete(${id}, '10')`)).toBe(
        "Соответствие уже удалено или не найдено.",
      );
      expect((await tx`select an_amo_responsibles_clear(${id}) as n`)[0].n).toBe(1);
      const [{ list }] = await tx`select an_amo_connections() as list`;
      expect(list).toEqual([expect.objectContaining({ id: Number(id), configured: true })]);
      await asServer(tx);
      expect(
        (await tx`select event from an_audit where event like 'amocrm%' order by id`).map(
          (r) => r.event,
        ),
      ).toEqual([
        "amocrm_settings_saved",
        "amocrm_settings_saved",
        "amocrm_qualification_basis_saved",
        "amocrm_responsible_mapping_saved",
        "amocrm_responsible_mapping_saved",
        "amocrm_responsible_mapping_deleted",
        "amocrm_responsible_mappings_cleared",
      ]);
      await as(tx, staff);
      for (const q of [
        () => tx`select an_amo_connections()`,
        () => tx`select an_amo_connection(${id})`,
        () => tx`select an_amo_responsibles_clear(${id})`,
      ]) {
        expect(await failure(tx, q)).toContain("an_forbidden");
      }
      for (const q of [
        () => tx`select * from an_amo_leads`,
        () => tx`select an_amo_store_leads(${id}, '111', '[]'::jsonb)`,
        () => tx`select an_amo_freeze_snapshots()`,
      ]) {
        expect(await failure(tx, q)).toContain("permission denied");
      }
    });
  });

  test("amoCRM: сбор — воронка, этапы, версии; срезы «на 1-е число»; квалификация VK в реестре", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      const admin = await person(tx, "Админ сбора amoCRM", ["an.admin"]);
      const [{ id }] =
        await tx`insert into an_amo_connections (name, base_url) values ('CRM', 'https://s.amocrm.ru') returning id`;
      const row = (lead: string, over: Record<string, unknown> = {}) => ({
        amo_lead_id: lead,
        created_at: Date.UTC(2026, 9, 5, 12) / 1000,
        updated_at: Date.UTC(2026, 9, 5, 12) / 1000,
        pipeline_id: "111",
        status_id: "10",
        responsible_user_id: "9",
        responsible_name: "Анна",
        brand: "Lady Stretch",
        city: "Абакан",
        partner_name: "ИП",
        automatic_source: "ВКонтакте сообщения",
        responsible_source: "",
        effective_source: "ВКонтакте сообщения",
        utm_source: "",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
        utm_term: "",
        utm_referrer: "",
        is_booked: 1,
        is_attended: 0,
        is_paid: 0,
        is_closed: 0,
        close_basis_value_id: "",
        close_basis_value: "",
        is_qualified: 1,
        ...over,
      });
      // До первого сбора учёт не начат — срезов нет (прошлое не выдумывается).
      await tx`delete from an_amo_history_state`;
      await asService(tx);
      expect((await tx`select an_amo_freeze_snapshots() as n`)[0].n).toBe(0);
      const store = async (rows: unknown[]) =>
        (await tx`select an_amo_store_leads(${id}, '111', ${rows}::jsonb) as r`)[0].r;
      expect(
        await store([
          row("1"),
          row("2", { pipeline_id: "222" }),
          row("3", { effective_source: " Сообщения сообщества ", is_closed: 1, is_qualified: 0 }),
          row("4", { effective_source: "Сайт" }),
          row("5", {
            created_at: Date.UTC(2026, 8, 10) / 1000,
            effective_source: "ВКонтакте ЛФ НК",
          }),
        ]),
      ).toEqual({ saved: 4, skipped_other: 1 });
      expect((await tx`select count(*)::int as n from an_amo_history_state`)[0].n).toBe(1);
      // Уже собранная сделка в другой воронке обновляется; created_at не меняется.
      expect(
        await store([row("1", { pipeline_id: "222", is_paid: 1, is_attended: 1, created_at: 1 })]),
      ).toEqual({ saved: 1, skipped_other: 0 });
      const [lead] =
        await tx`select pipeline_id, extract(epoch from created_at)::bigint as c from an_amo_leads where amo_lead_id = '1'`;
      expect([lead.pipeline_id, Number(lead.c)]).toEqual(["222", Date.UTC(2026, 9, 5, 12) / 1000]);
      expect(
        (
          await tx`select event_type from an_amo_lead_events where amo_lead_id = '1' order by 1`
        ).map((r) => r.event_type),
      ).toEqual(["attended", "booked", "paid"]);
      // Версия — только при изменении полей среза.
      await store([row("4", { effective_source: "Сайт", status_id: "20" })]);
      expect(
        (
          await tx`select amo_lead_id, count(*)::int as n from an_amo_versions group by 1 order by 1`
        ).map((r) => [r.amo_lead_id, r.n]),
      ).toEqual([
        ["1", 1],
        ["3", 1],
        ["4", 1],
        ["5", 1],
      ]);

      // Срезы: учёт с 15.08 — август и сентябрь по версиям до 1-го числа МСК.
      await asServer(tx);
      await tx`delete from an_amo_snapshots`;
      await tx`update an_amo_history_state set started_at = '2026-08-15 00:00+03'`;
      await tx`update an_amo_versions set observed_at = '2026-09-20 00:00+03'`;
      await asService(tx);
      expect((await tx`select an_amo_freeze_snapshots() as n`)[0].n).toBe(4);
      expect((await tx`select an_amo_freeze_snapshots() as n`)[0].n).toBe(0);
      await asServer(tx);
      const snaps = await tx`select brand, month, rows from an_amo_snapshots order by brand, month`;
      expect(snaps.map((s) => [s.brand, s.month, s.rows])).toEqual([
        ["Lady Jump", "2026-08", []],
        ["Lady Jump", "2026-09", []],
        ["Lady Stretch", "2026-08", []],
        [
          "Lady Stretch",
          "2026-09",
          [
            {
              city: "Абакан",
              partner_name: "ИП",
              source: "ВКонтакте ЛФ НК",
              leads: 1,
              qualified: 1,
              booked: 1,
              attended: 0,
              paid: 0,
            },
          ],
        ],
      ]);
      // Учёт начат после 01.10 — сентябрь разово по текущим сделкам.
      await tx`delete from an_amo_snapshots`;
      await tx`update an_amo_history_state set started_at = '2026-10-05 00:00+03'`;
      await asService(tx);
      await tx`select an_amo_freeze_snapshots()`;
      await asServer(tx);
      const [sep] =
        await tx`select rows from an_amo_snapshots where brand = 'Lady Stretch' and month = '2026-09'`;
      expect(sep.rows).toHaveLength(1);
      expect(
        (await tx`select reason from an_amo_snapshot_origins where month = '2026-09'`)[0].reason,
      ).toContain("September baseline");
      expect((await tx`select 1 from an_amo_snapshots where brand = 'Lady Jump'`).length).toBe(0);

      // Квалификация VK в реестре: источники VK, даты по UTC, только видимые города.
      for (const [vk, city] of [
        ["9301", "Абакан"],
        ["9302", ""],
      ]) {
        const [{ a }] = await tx`insert into an_vk_accounts (name, vk_account_id, city)
                                 values (${"Каб " + vk}, ${vk}, ${city}) returning id as a`;
        await tx`insert into an_vk_daily_stats (account_id, vk_plan_id, stat_date, spent)
                 values (${a}, 'p', '2026-10-10', 100)`;
      }
      await as(tx, admin);
      const [{ r }] = await tx`select an_vk_register('2026-10-01', '2026-10-31', '', '') as r`;
      const q = Object.fromEntries(
        r.rows.map((x: { city: string; qual_leads: number; qual_qualified: number }) => [
          x.city,
          [x.qual_leads, x.qual_qualified],
        ]),
      );
      expect(q).toEqual({ Абакан: [2, 1], "": [0, 0] });
    });
  });

  test("Авито: кабинеты и ключи — их проверки и тексты, обновление по ID, удаление; только администратору", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ Авито", ["an.admin"]);
      const staff = await person(tx, "Сотрудник Авито", ["an.avito.register"]);
      const key = "A".repeat(38) + "==";
      const save = (name: string, id: string, city: string, brand: string, cid = key, secret = key) =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_avito_account_save(${name}, ${id}, ${city}, ${brand}, ${cid}, ${secret})`;
        });
      expect(await save(" ", "1", "Абакан", "Lady Stretch")).toContain("Укажите название кабинета.");
      expect(await save("К", "  ", "Абакан", "Lady Stretch")).toContain("Укажите ID аккаунта.");
      expect(await save("К", "12a", "Абакан", "Lady Stretch")).toContain("ID аккаунта Авито должен состоять только из цифр.");
      expect(await save("К", "1", "Абакан", "Lady Bounce")).toContain("Направление указано некорректно.");
      expect(await save("К", "1", "г".repeat(201), "Lady Stretch")).toContain("Город слишком длинный.");
      expect(await save("К", "1", "Абакан", "Lady Stretch", "")).toContain("Укажите client_id.");
      expect(await save("К", "1", "Абакан", "Lady Stretch", key, "long")).toContain("Client_secret слишком длинный.");
      expect(await save("К", "1", "Абакан", "Lady Stretch", "plain")).toContain("Ключ не зашифрован");
      expect(await save(" Кабинет ", "9001", " Казань ", "Lady Jump")).toBeNull();
      expect(await save("Кабинет 2", "9001", "Абакан", "Lady Stretch")).toBeNull();
      await asServer(tx);
      const rows = await tx`select id, name, city, brand from an_avito_accounts where avito_account_id = '9001'`;
      expect(rows.map((r) => [r.name, r.city, r.brand])).toEqual([["Кабинет 2", "Абакан", "Lady Stretch"]]);
      const id = rows[0].id;
      expect((await tx`select count(*)::int as n from an_secrets where kind = 'avito' and ref = ${String(id)}`)[0].n).toBe(2);
      await asService(tx);
      await tx`select an_avito_check_store(${id}, 200, ${{ campaigns: { total: 2 } }}::jsonb)`;
      await as(tx, admin);
      await tx`select an_avito_set_credentials(${id}, ${key}, ${key})`;
      await asServer(tx);
      const [after] = await tx`select last_checked_at, last_check_status from an_avito_accounts where id = ${id}`;
      expect([after.last_checked_at, after.last_check_status]).toEqual([null, null]);
      expect(
        await failure(tx, async () => {
          await as(tx, staff);
          await tx`select an_avito_accounts()`;
        }),
      ).toContain("an_forbidden");
      expect(
        await failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_avito_set_credentials(${id}, '', ${key})`;
        }),
      ).toContain("Укажите client_id.");
      await as(tx, admin);
      await tx`select an_avito_account_delete(${id})`;
      expect(
        await failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_avito_account_delete(${id})`;
        }),
      ).toContain("Подключение уже удалено или не найдено.");
      await asServer(tx);
      expect((await tx`select count(*)::int as n from an_secrets where kind = 'avito' and ref = ${String(id)}`)[0].n).toBe(0);
      const events = await tx`select event from an_audit where user_id = ${admin} and event like 'avito%' order by id`;
      expect(events.map((e) => e.event)).toEqual([
        "avito_ads_account_saved",
        "avito_ads_account_saved",
        "avito_ads_credentials_updated",
        "avito_ads_account_deleted",
      ]);
    });
  });

  test("Авито: планы, структура и статистика сервера, реестр — период, заявки amoCRM, доступ", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_avito_accounts`;
      await tx`delete from an_avito_plans`;
      const admin = await person(tx, "Админ реестра Авито", ["an.admin"]);
      const viewer = await person(tx, "Реестр Авито", ["an.avito.register"]);
      const other = await person(tx, "Без реестра", ["an.vk.register"]);
      const key = "B".repeat(40);
      await as(tx, admin);
      const [{ id }] = await tx`select an_avito_account_save('Абакан', '1001', 'Абакан', 'Lady Stretch', ${key}, ${key}) as id`;
      const plan = (month: string, apps: number, cpl: number | null) =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_avito_plan_save(${month}, 'Lady Stretch', 'Абакан', ${apps}, ${cpl})`;
        });
      expect(await plan("2026-13", 1, 1)).toContain("Укажите месяц в формате ГГГГ-ММ.");
      expect(await plan("2026-10", -1, 1)).toContain("План заявок должен быть целым числом от нуля.");
      expect(await plan("2026-10", 1, 0)).toContain("Целевой CPL должен быть больше нуля.");
      expect(await plan("2026-10", 1, null)).toContain("Целевой CPL должен быть больше нуля.");
      expect(await plan("2026-10", 31, 400)).toBeNull();
      expect(await plan("2026-10", 62, 500)).toBeNull();
      expect(await plan("2026-09", 30, 300)).toBeNull();
      await as(tx, admin);
      const [{ p }] = await tx`select an_avito_plans('2026-10') as p`;
      expect(p.cities).toEqual([{ brand: "Lady Stretch", city: "Абакан" }]);
      expect(p.plans.map((x: { applications_plan: number; target_cpl: number }) => [x.applications_plan, x.target_cpl])).toEqual([[62, 500]]);

      // Сервер: структура одной записью, статистика — замена дня.
      await asService(tx);
      await tx`select an_avito_structure_store(${id}, ${[
        { entity_type: "campaigns", entity_id: "11", name: "РК", start_date: "2026-08-01" },
        { entity_type: "groups", entity_id: "21", parent_campaign_id: "11", name: "Группа" },
        { entity_type: "creatives", entity_id: "31", parent_group_id: "21", utm_medium: "cpc", utm_campaign: "rk", utm_content: "a" },
      ]}::jsonb)`;
      expect((await tx`select an_avito_stats_store(${id}, ${[
        { campaign_id: "11", stat_date: "2026-10-05", shows: 10, clicks: 3, spent: 100.25 },
        { campaign_id: "11", stat_date: "2026-10-06", shows: 5, clicks: 1, spent: 50 },
      ]}::jsonb) as n`)[0].n).toBe(2);
      await tx`select an_avito_stats_store(${id}, ${[{ campaign_id: "11", stat_date: "2026-10-06", shows: 6, clicks: 2, spent: 60 }]}::jsonb)`;
      expect(await failure(tx, async () => {
        await as(tx, admin);
        await tx`select an_avito_stats_store(${id}, '[]'::jsonb)`;
      })).toContain("permission denied");

      // Сделки amoCRM: UTM Авито (регистр — как их lower), источник, другой формат UTM — нет.
      await asServer(tx);
      const [{ cid }] = await tx`insert into an_amo_connections (name, base_url) values ('CRM', 'https://av.amocrm.ru') returning id as cid`;
      let n = 0;
      const lead = (at: string, source: string, utm: string, content = "a") =>
        tx`insert into an_amo_leads (connection_id, amo_lead_id, created_at, updated_at, pipeline_id, status_id, brand, city,
                                     effective_source, utm_source, utm_medium, utm_campaign, utm_content, is_qualified)
           values (${cid}, ${String(++n)}, ${at}::timestamptz, now(), '1', '1', 'Lady Stretch', 'Абакан', ${source}, ${utm},
                   ${utm ? "cpc" : ""}, ${utm ? "rk" : ""}, ${utm ? content : ""}, 1)`;
      await lead("2026-10-05 10:00+00", "Сайт", "AVITO_ADS");
      await lead("2026-10-05 23:59:59+00", "Сайт", "avito_ads");
      await lead("2026-10-06 00:00:00+00", "Сайт", "avito_ads");
      await lead("2026-10-05 12:00+00", "Авито Реклама", "");
      await lead("2026-10-05 12:00+00", "Сайт", "avito-ads");

      const register = async (user: string, from: string, to: string) => {
        await as(tx, user);
        const [{ r }] = await tx`select an_avito_register(${from}, ${to}) as r`;
        await asServer(tx);
        return r;
      };
      const r = await register(viewer, "2026-10-05", "2026-10-05");
      expect([r.from, r.to]).toEqual(["2026-10-05", "2026-10-05"]);
      expect(r.rows.map((x: { campaign_id: string; clicks: number; spent: number }) => [x.campaign_id, x.clicks, x.spent])).toEqual([["11", 3, 100.25]]);
      expect(r.entities.map((x: { entity_type: string }) => x.entity_type)).toEqual(["groups", "creatives"]);
      expect(r.leads.map((x: { attribution: string; leads: number; utm_content: string }) => [x.attribution, x.utm_content, x.leads])).toEqual([
        ["source", "", 1],
        ["utm", "a", 2],
      ]);
      expect(r.source_leads.map((x: { amo_lead_id: string }) => x.amo_lead_id)).toEqual(["1", "4", "2"]);
      expect(r.plans.map((x: { month: string }) => x.month)).toEqual(["2026-10"]);
      // Неверный период — с 1-го числа по сегодня (МСК).
      const d = await register(viewer, "2026-10-30", "2026-10-01");
      const today = (await tx`select (now() at time zone 'Europe/Moscow')::date::text as t`)[0].t;
      expect([d.from, d.to]).toEqual([`${today.slice(0, 8)}01`, today]);
      const wide = await register(admin, "2026-09-01", "2026-10-31");
      expect(wide.plans.map((x: { month: string }) => x.month)).toEqual(["2026-09", "2026-10"]);
      expect(await failure(tx, () => register(other, "2026-10-01", "2026-10-31"))).toContain("an_forbidden");
      const views = await tx`select user_id::text as u from an_audit where event = 'dashboard_view' and details = 'Реестр Авито'
                             and user_id in (${admin}, ${viewer})`;
      expect(views.map((v) => v.u)).toEqual([viewer, viewer]);
    });
  });

  test("amoCRM: маркетинговые отчёты — когорта месяца МСК, срез, города партнёра и таргетолога, права", async () => {
    await scenario(async (tx) => {
      await tx`delete from an_vk_accounts`;
      await tx`delete from an_amo_snapshots`;
      // Без начала учёта срезы не замораживаются — срез сентября задаём сами.
      await tx`delete from an_amo_history_state`;
      const admin = await person(tx, "Админ маркетинга", ["an.admin"]);
      const staff = await person(tx, "Сотрудник LJ", ["an.mkt.lj"]);
      const partner = await person(tx, "Партнёр маркетинга", ["an.partner", "an.mkt.ls"]);
      const target = await person(tx, "Таргет Маркетинга", ["an.targetologist"]);
      await asServer(tx);
      await tx`insert into an_partner_cities (user_id, city) values (${partner}, 'Абакан')`;
      await tx`insert into an_vk_targetologists (brand, city, targetologist_name)
               values ('Lady Stretch', 'Самара', 'Таргет Маркетинга')`;
      const [{ id }] =
        await tx`insert into an_amo_connections (name, base_url) values ('CRM', 'https://m.amocrm.ru') returning id`;
      await tx`insert into an_amo_pipeline_brands (connection_id, pipeline_id, brand) values (${id}, '111', 'Lady Stretch')`;
      await tx`insert into an_amo_responsibles (connection_id, amo_user_id, amo_user_name, brand, city, partner_name)
               values (${id}, '9', 'Анна', 'Lady Stretch', 'Абакан', 'ИП А')`;
      await tx`insert into an_amo_basis (connection_id, field_value_id, field_value_name, is_unqualified)
               values (${id}, '1', 'Спам', true), (${id}, '2', 'Дорого', false), (${id}, '3', 'Дубль', true)`;
      let n = 0;
      const lead = async (at: string, brand: string, city: string, partnerName: string, source: string, f = [1, 0, 0, 0]) =>
        tx`insert into an_amo_leads (connection_id, amo_lead_id, created_at, updated_at, pipeline_id, status_id,
                                     brand, city, partner_name, effective_source, is_qualified, is_booked, is_attended, is_paid)
           values (${id}, ${String(++n)}, ${at}::timestamptz, now(), '111', '1', ${brand}, ${city}, ${partnerName},
                   ${source}, ${f[0]}, ${f[1]}, ${f[2]}, ${f[3]})`;
      // 01.10 00:30 МСК — октябрь (их когорта по Москве).
      await lead("2026-09-30 21:30+00", "Lady Stretch", "Абакан", "ИП А", "ВКонтакте сообщения", [1, 1, 1, 1]);
      await lead("2026-10-10 12:00+03", "Lady Stretch", "Абакан", "ИП А", "ВКонтакте сообщения", [1, 1, 0, 0]);
      await lead("2026-10-11 12:00+03", "Lady Stretch", "Абакан", "ИП А", "Сайт", [0, 1, 1, 1]);
      await lead("2026-10-12 12:00+03", "Lady Stretch", "Самара", "", "Авито");
      await lead("2026-10-13 12:00+03", "Lady Stretch", "", "", "");
      await lead("2026-09-30 20:30+00", "Lady Stretch", "Пермь", "ИП Б", "Сайт");
      await lead("2026-10-14 12:00+03", "Lady Jump", "Казань · Вишневского", "ИП Д", "Сайт");
      await tx`insert into an_amo_snapshots (brand, month, cutoff_at, rows, budgets)
               values ('Lady Stretch', '2026-09', '2026-10-01 00:00+03',
                       ${[
                         { city: "Абакан", partner_name: "ИП Старый", source: "ВКонтакте ЛФ НК", leads: 3, qualified: 2, booked: 1, attended: 1, paid: 0 },
                         { city: "Город не сопоставлен", partner_name: "—", source: "Сайт", leads: 1, qualified: 1, booked: 0, attended: 0, paid: 0 },
                       ]}::jsonb,
                       ${{ Абакан: { lead_forms: 1220.5, community_messages: 0 }, Пермь: { lead_forms: 5, community_messages: 7 } }}::jsonb)`;

      const report = async (user: string, brand: string, month: string | null, city: string | null,
                            partnerName: string | null, result = "today") => {
        await as(tx, user);
        const [{ r }] =
          await tx`select an_amo_marketing(${brand}, ${month}, ${city}, ${partnerName}, ${result}) as r`;
        await asServer(tx);
        return r;
      };

      // Администратор: все города, «на сегодня», октябрь по умолчанию.
      const all = await report(admin, "Lady Stretch", null, null, null);
      expect([all.months, all.cities, all.partners, all.month, all.result]).toEqual([
        ["2026-10", "2026-09"],
        ["Абакан", "Пермь", "Самара"],
        ["ИП А", "ИП Б", "ИП Старый"],
        "2026-10",
        "today",
      ]);
      expect([all.is_partner, all.limited, all.snapshot]).toEqual([false, false, false]);
      expect(all.rows.map((r: { city: string; partner_name: string; source: string; leads: number; qualified: number; booked: number; paid: number }) =>
        [r.city, r.partner_name, r.source, r.leads, r.qualified, r.booked, r.paid])).toEqual([
        ["Абакан", "ИП А", "ВКонтакте сообщения", 2, 2, 2, 1],
        ["Абакан", "ИП А", "Сайт", 1, 0, 0, 0],
        ["Город не сопоставлен", "—", "Не присвоен источник", 1, 1, 0, 0],
        ["Самара", "—", "Авито", 1, 1, 0, 0],
      ]);
      expect(all.qualification).toEqual({ Абакан: ["Дубль", "Спам"], Самара: [], "Город не сопоставлен": [] });
      expect(all.budgets).toEqual({});
      // Город и партнёр не из списка — «все»; месяц не из списка — последний.
      const odd = await report(admin, "Lady Stretch", "2031-01", "Нет такого", "Нет такого");
      expect([odd.month, odd.city, odd.partner, odd.rows.length]).toEqual(["2026-10", "", "", 4]);
      const abakan = await report(admin, "Lady Stretch", "2026-10", "Абакан", "ИП А");
      expect(abakan.rows).toHaveLength(2);

      // Срез «на 1-е число»: строки и бюджеты среза, наружу — только города отчёта.
      const first = await report(admin, "Lady Stretch", "2026-09", null, null, "first");
      expect([first.snapshot, first.rows.length]).toEqual([true, 2]);
      expect(first.budgets).toEqual({ Абакан: { lead_forms: 1220.5, community_messages: 0 } });
      // «На сегодня» за месяц со срезом — сделки месяца, бюджеты — из среза (как у них).
      const sepToday = await report(admin, "Lady Stretch", "2026-09", null, null);
      expect(sepToday.rows.map((r: { city: string }) => r.city)).toEqual(["Пермь"]);
      expect(sepToday.budgets).toEqual({ Пермь: { lead_forms: 5, community_messages: 7 } });
      const octFirst = await report(admin, "Lady Stretch", "2026-10", null, null, "first");
      expect([octFirst.snapshot, octFirst.rows]).toEqual([false, []]);

      // Партнёр: только свои города, без выбора партнёра.
      const p = await report(partner, "Lady Stretch", null, null, "ИП А");
      expect([p.is_partner, p.limited, p.cities, p.partners, p.partner]).toEqual([
        true, true, ["Абакан"], ["ИП А", "ИП Старый"], "",
      ]);
      expect(p.rows.map((r: { city: string }) => r.city)).toEqual(["Абакан", "Абакан"]);
      const pFirst = await report(partner, "Lady Stretch", "2026-09", null, null, "first");
      expect(pFirst.rows.map((r: { city: string }) => r.city)).toEqual(["Абакан"]);
      expect(await failure(tx, () => report(partner, "Lady Jump", null, null, null))).toContain("an_forbidden");

      // Таргетолог: маркетинг всегда, города — его назначения бренда.
      const t = await report(target, "Lady Stretch", null, null, null);
      expect([t.is_partner, t.limited, t.cities, t.rows.map((r: { city: string }) => r.city)]).toEqual([
        false, true, ["Самара"], ["Самара"],
      ]);
      const tj = await report(target, "Lady Jump", null, null, null);
      expect([tj.months, tj.cities, tj.rows]).toEqual([[], [], []]);

      // Сотрудник с правом на Lady Jump — все города бренда; Lady Stretch закрыт.
      const j = await report(staff, "Lady Jump", null, null, null);
      expect(j.rows.map((r: { city: string }) => r.city)).toEqual(["Казань · Вишневского"]);
      expect(await failure(tx, () => report(staff, "Lady Stretch", null, null, null))).toContain("an_forbidden");
      expect(await failure(tx, () => report(admin, "Lady Bounce", null, null, null))).toContain("an_bad_brand");

      // Журнал: «открыл дашборд» — только не администратор.
      const views = await tx`select user_id::text as u, details from an_audit where event = 'dashboard_view'
                             and details like 'Маркетинг%' and user_id in (${admin}, ${staff}, ${partner}, ${target})`;
      expect(views.some((v) => v.u === admin)).toBe(false);
      expect(views.filter((v) => v.u === partner).map((v) => v.details)).toEqual([
        "Маркетинг Lady Stretch",
        "Маркетинг Lady Stretch",
      ]);
    });
  });

  // --- Квиз (db/migrations/2026-10-30_zzzzzzzzzzzz_analytics_quiz.sql) ---------------

  test("Квиз: города и лендинг без входа, приём сервером, очередь в таблицы, заявки — администратору", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ квиза", ["an.admin"]);
      const staff = await person(tx, "Сотрудник квиза", ["an.mkt.ls"]);
      await asServer(tx);
      await tx`delete from an_quiz_leads`;
      await tx`delete from an_quiz_cities`;
      const landing = async (slug: string | null) => {
        await asServer(tx);
        await tx`set local role anon`;
        const [{ l }] = await tx`select an_quiz_landing(${slug}) as l`;
        return l;
      };
      expect(await landing("x")).toBeNull();

      // Город: их и свои проверки, тексты.
      const save = (id: number | null, data: Record<string, unknown>) =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_quiz_city_save(${id}, ${data}::jsonb)`;
        });
      const base = {
        slug: " Test-City ",
        city: " Тестоград ",
        trial_price: "600",
        completed_count: "200+",
        locations: [{ address: " ул. Тестовая, 1 ", landmark: "", phone_display: "+7 900 000-00-00" }],
        operator_name: "",
        operator_inn: "",
        spreadsheet_id: "",
        sheet_name: "",
      };
      expect(await save(null, { ...base, slug: "тест" })).toContain("Адрес страницы — латинские буквы");
      expect(await save(null, { ...base, city: " " })).toContain("Укажите город.");
      expect(await save(null, { ...base, trial_price: "6.5" })).toContain("Цена пробного");
      expect(await save(null, { ...base, operator_inn: "123" })).toContain("ИНН — 10 или 12 цифр.");
      expect(await save(null, { ...base, spreadsheet_id: "a/b" })).toContain("Некорректный ID Google Таблицы.");
      expect(await save(null, { ...base, locations: [{ address: " " }] })).toContain("Укажите адрес студии.");
      expect(await save(null, base)).toBeNull();
      expect(await save(null, { ...base, slug: "other" })).toContain("Город «Тестоград» уже есть.");
      expect(await save(null, { ...base, city: "Другой" })).toContain("Адрес страницы «test-city» уже занят.");
      expect(
        await save(null, { ...base, slug: "second", city: "Второград", is_default: true, spreadsheet_id: "Sheet-Id_1" }),
      ).toBeNull();
      expect(
        await failure(tx, async () => {
          await as(tx, staff);
          await tx`select an_quiz_overview()`;
        }),
      ).toContain("an_forbidden");

      // Лендинг: город по адресу, иначе — по умолчанию; таблицы города не видно.
      const city = await landing("test-city");
      expect(city.city).toBe("Тестоград");
      expect(city.locations).toEqual([
        { address: "ул. Тестовая, 1", landmark: "", phone_display: "+7 900 000-00-00", phone_href: "" },
      ]);
      expect(city.sheet_name).toBeUndefined();
      expect((await landing("nope")).city).toBe("Второград");
      expect((await landing(null)).city).toBe("Второград");

      // Браузер (anon и сотрудник) не пишет заявки и не читает таблицы — только сервер.
      for (const run of [
        async () => {
          await asServer(tx);
          await tx`set local role anon`;
          await tx`select an_quiz_lead_add('Тестоград', 'Анна', '+79000000000', '', '', '', '', '{}', 'c')`;
        },
        async () => {
          await asServer(tx);
          await tx`set local role anon`;
          await tx`select * from an_quiz_leads`;
        },
        async () => {
          await as(tx, admin);
          await tx`select an_quiz_pending(10)`;
        },
        async () => {
          await as(tx, admin);
          await tx`select an_quiz_mark(1, null)`;
        },
      ]) {
        expect(await failure(tx, run)).toContain("permission denied");
      }

      // Приём (service_role): их проверки ещё раз.
      const add = (name: string, phone: string, consent = "2026-10-30T10:00:00Z") =>
        failure(tx, async () => {
          await asService(tx);
          await tx`select an_quiz_lead_add('Тестоград', ${name}, ${phone}, '', '', '', '', '{}', ${consent})`;
        });
      expect(await add("А", "+79000000000")).toContain("Проверьте имя и телефон.");
      expect(await add("Анна", "+790000000")).toContain("Проверьте имя и телефон.");
      expect(await add("Анна", "+79000000000", "")).toContain("Нужно согласие на обработку данных.");
      await asService(tx);
      const [{ a }] = await tx`select an_quiz_lead_add('Неизвестноград', 'Борис', '+79000000001', '', '', '', '',
                                                        '{}', 'c') as a`;
      const [{ b }] = await tx`select an_quiz_lead_add('Второград', 'Вера', '+79000000002', 'Рек', 'Боль', 'Давно',
                                                        'Время', ${{ utm_source: "vk" }}::jsonb, 'c') as b`;

      // Очередь: по порядку, с таблицей города (у неизвестного города — нет).
      type P = { id: number; city: string; spreadsheet_id: string | null; sheet_name: string | null; utm: unknown };
      const [{ q }] = await tx`select an_quiz_pending(100) as q`;
      expect((q as P[]).map((r) => [r.id, r.city, r.spreadsheet_id, r.sheet_name])).toEqual([
        [Number(a), "Неизвестноград", null, null],
        [Number(b), "Второград", "Sheet-Id_1", "Заявки квиза"],
      ]);
      expect((q as P[])[1].utm).toEqual({ utm_source: "vk" });
      await tx`select an_quiz_mark(${a}, ${"Для города «Неизвестноград» не настроена таблица заявок."})`;
      await tx`select an_quiz_mark(${b}, null)`;
      const [{ q2 }] = await tx`select an_quiz_pending(100) as q2`;
      expect((q2 as P[]).map((r) => r.id)).toEqual([Number(a)]);

      // Заявки и обзор — администратору.
      await as(tx, admin);
      type R = { name: string; sheet_error: string; sheet_synced_at: string | null };
      const leads = async (c: string, status: string) =>
        (await tx`select an_quiz_leads(${c}, ${status}, 50, 0) as r`)[0].r as {
          total: number;
          cities: string[];
          rows: R[];
        };
      const all = await leads("", "");
      expect([all.total, all.cities]).toEqual([2, ["Второград", "Неизвестноград"]]);
      expect((await leads("", "error")).rows.map((r) => r.sheet_error)).toEqual([
        "Для города «Неизвестноград» не настроена таблица заявок.",
      ]);
      expect((await leads("", "sent")).rows.map((r) => r.name)).toEqual(["Вера"]);
      expect((await leads("Второград", "pending")).total).toBe(0);
      // Новый город по умолчанию снимает отметку с прежнего.
      const [{ o }] = await tx`select an_quiz_overview() as o`;
      expect([o.total, o.pending, o.errors]).toEqual([2, 0, 1]);
      type C = { id: number; city: string; is_default: boolean; leads: number; pending: number };
      expect((o.cities as C[]).map((c) => [c.city, c.is_default, c.leads, c.pending])).toEqual([
        ["Второград", true, 1, 0],
        ["Тестоград", false, 0, 0],
      ]);
      const test = (o.cities as C[])[1];
      expect(await save(test.id, { ...base, is_default: true })).toBeNull();
      await asServer(tx);
      const defaults = await tx`select city from an_quiz_cities where is_default`;
      expect(defaults.map((d) => d.city)).toEqual(["Тестоград"]);

      await as(tx, admin);
      await tx`select an_quiz_lead_delete(${a})`;
      await tx`select an_quiz_city_delete(${test.id})`;
      await asServer(tx);
      expect((await tx`select count(*)::int as n from an_quiz_leads`)[0].n).toBe(1);
      const events = await tx`select event from an_audit where user_id = ${admin} and event like 'quiz%' order by id`;
      expect(events.map((e) => e.event)).toEqual([
        "quiz_city_saved",
        "quiz_city_saved",
        "quiz_city_saved",
        "quiz_lead_deleted",
        "quiz_city_deleted",
      ]);
    });
  });

  // --- FitBase, часть 1 (db/migrations/2026-10-30_zzzzzzzzzzzzz_analytics_fitbase.sql) ---

  test("FitBase: подключения, правила, коды статусов — их проверки; загрузка — только сервер", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ FitBase", ["an.admin"]);
      const staff = await person(tx, "Сотрудник FitBase", ["an.mkt.lj"]);
      const key = "A".repeat(38) + "==";
      const save = (id: number | null, name: string, brand: string, city: string, domain: string, cipher = key, partner = "") =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_connection_save(${id}, ${name}, ${brand}, ${city}, ${domain}, ${partner}, false, ${cipher})`;
        });
      expect(await save(null, "Студия", "Lady Stretch", "Самара", "Bad Domain")).toContain("Нужен поддомен клуба FitBase");
      expect(await save(null, "Студия", "Lady Stretch", "Самара", "club", key, "п".repeat(151))).toContain("Имя партнёра — не больше 150 символов.");
      expect(await save(null, " ", "Lady Stretch", "Самара", "club")).toContain("Заполните студию, направление и город.");
      expect(await save(null, "Студия", "Lady Bounce", "Самара", "club")).toContain("Заполните студию, направление и город.");
      expect(await save(null, "Студия", "Lady Stretch", "Самара", "club", "")).toContain("Введите API-ключ.");
      expect(await save(null, "Студия", "Lady Stretch", "Самара", "club", "plain")).toContain("Ключ не зашифрован");
      expect(await save(null, " Студия ", "Lady Jump", " Казань ", "club")).toBeNull();
      expect(await save(null, "Вторая", "Lady Stretch", "Самара", "club")).toContain("Студия с этим доменом FitBase уже подключена.");
      await asServer(tx);
      const [c] = await tx`select id, name, city, domain from an_fb_connections where domain = 'club'`;
      expect([c.name, c.city]).toEqual(["Студия", "Казань · Вишневского"]);
      const id = Number(c.id);
      expect((await tx`select count(*)::int as n from an_secrets where kind = 'fitbase' and ref = ${String(id)}`)[0].n).toBe(1);
      expect(
        await failure(tx, async () => {
          await as(tx, staff);
          await tx`select an_fb_connections()`;
        }),
      ).toContain("an_forbidden");
      for (const run of [
        async () => { await as(tx, admin); await tx`select an_fb_job_begin(${id}, 'all')`; },
        async () => { await as(tx, admin); await tx`select an_fb_incremental_open(${id}, 's', 'lead', '{}')`; },
        async () => { await as(tx, admin); await tx`select an_fb_commit(gen_random_uuid(), ${id}, 'leads', '{}', '[]')`; },
        async () => { await as(tx, admin); await tx`select * from an_fb_leads`; },
        async () => { await asServer(tx); await tx`set local role anon`; await tx`select an_fb_connections()`; },
      ]) {
        expect(await failure(tx, run)).toMatch(/permission denied/);
      }

      // Загрузка (service_role): одна на студию; «всё» — полная сверка.
      await asService(tx);
      const [{ b }] = await tx`select an_fb_job_begin(${id}, 'all') as b`;
      expect([b.sync_state, b.full_sync, b.job_progress]).toEqual(["Выполняется", true, "Подключаемся к FitBase…"]);
      expect(
        await failure(tx, async () => {
          await asService(tx);
          await tx`select an_fb_job_begin(${id}, 'sync')`;
        }),
      ).toContain("Для студии уже выполняется загрузка.");
      expect(await save(id, "Студия", "Lady Jump", "Казань", "club", "")).toContain("Дождитесь завершения загрузки");
      // Оборванная перезапуском (отметка старше 15 минут) — снова можно, в списке — их текст.
      await asServer(tx);
      await tx`update an_fb_connections set job_started_at = extract(epoch from now())::bigint - 3600 where id = ${id}`;
      await as(tx, admin);
      const [{ list }] = await tx`select an_fb_connections() as list`;
      const row = list.connections.find((x: { id: number }) => Number(x.id) === id);
      expect([row.busy, row.sync_state, row.has_key]).toEqual([false, "Загрузка прервана перезапуском. Повторите обновление.", true]);

      // Справочники после проверки (их verify пишет сервер).
      await asServer(tx);
      await tx`update an_fb_connections set sync_state = 'Доступ подтверждён', job_started_at = null,
               metadata = ${{ clubs: [{ id: 10, name: "Клуб" }, { id: 11, name: "Второй" }], steps: [{ id: 1, name: "Новая сделка" }, { id: 2, name: "Оплатили" }], sources: [{ id: 5, name: "VK" }] }}::jsonb
               where id = ${id}`;
      const rules = (club: string, steps: object, sources: object) =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_rules_save(${id}, ${club}, ${steps}::jsonb, ${sources}::jsonb)`;
        });
      const okSteps = { "1": "new", "2": "paid" };
      expect(await rules("99", okSteps, { "5": "none" })).toContain("Выберите клуб из FitBase.");
      expect(await rules("10", { "1": "new" }, { "5": "none" })).toContain("Обновите список этапов и проверьте правила.");
      expect(await rules("10", { "1": "new", "2": "bought" }, { "5": "none" })).toContain("Обновите список этапов и проверьте правила.");
      expect(await rules("10", okSteps, {})).toContain("Некорректное сопоставление бюджетов.");
      expect(await rules("10", okSteps, { "5": "tv" })).toContain("Некорректное сопоставление бюджетов.");
      expect(await rules("10", okSteps, { "5": "lead_forms" })).toBeNull();
      // Тот же домен — можно с другим клубом; тот же клуб — их UNIQUE(domain, club_id).
      expect(await save(null, "Вторая", "Lady Stretch", "Самара", "club")).toBeNull();
      await asServer(tx);
      const [second] = await tx`select id from an_fb_connections where name = 'Вторая'`;
      await tx`update an_fb_connections set metadata = (select metadata from an_fb_connections where id = ${id})
               where id = ${second.id}`;
      expect(
        await failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_rules_save(${second.id}, '10', ${okSteps}::jsonb, ${{ "5": "none" }}::jsonb)`;
        }),
      ).toContain("Этот клуб FitBase уже подключён другой студией с тем же доменом.");

      // Факты разделов: пачки и одна транзакция замены.
      const commit = async (phase: string, staged: Record<string, unknown[][]>, state: object, incremental: object[] = []) => {
        await asService(tx);
        const [{ run }] = await tx`select gen_random_uuid() as run`;
        for (const [kind, rows] of Object.entries(staged)) {
          await tx`select an_fb_stage(${run}, ${kind}, ${JSON.stringify(rows)}::text::jsonb)`;
        }
        const [{ r }] = await tx`select an_fb_commit(${run}, ${id}, ${phase}, ${state}::jsonb, ${JSON.stringify(incremental)}::text::jsonb) as r`;
        return r.removed_paths as string[];
      };
      await asService(tx);
      const [{ none }] = await tx`select an_fb_incremental_open(${id}, 'scope-lead', 'lead', '{}') as none`;
      expect(none).toBeNull();
      expect(
        await commit("leads", { leads: [["L1", "client:7", 1700000000, "1", "5"], ["L2", "lead:L2", 1700000100, "2", ""]] },
          { synced_at: 1700000200, job_progress: "Загружено сделок клуба: 2" },
          [{ scope: "scope-lead", endpoint: "lead", params: {}, path: "1/inc/a.bin", cursor_at: 100, full_at: 100 }]),
      ).toEqual([]);
      const [{ old }] = await tx`select an_fb_incremental_open(${id}, 'scope-lead', 'lead', '{}') as old`;
      expect([old.object_path, Number(old.cursor_at), old.pending_at]).toEqual(["1/inc/a.bin", 100, null]);
      expect(
        await commit("leads", { leads: [["L1", "client:7", 1700000000, "1", "5"]] }, {},
          [{ scope: "scope-lead", endpoint: "lead", params: {}, path: "1/inc/b.bin", cursor_at: 200, full_at: 100 }]),
      ).toEqual(["1/inc/a.bin"]);
      await commit("sales", { history: [["C1", "7", 1700000000, 500000], ["C2", "8", 1700000000, 0]], products: [["C1", "Абонемент", 0], ["C2", "Пробное", 1]], sales: [["C1", "7", 1700000000, 500000, 500000]] },
        { sales_synced_at: 1700000300, sales_state: "Продажи загружены" });
      await commit("refund", { audit: [["C1", 500000, 500000, 100000, 400000, 400000, "deducted"]], payments: [["purchase", "P1", "C1", "7", 1700000000, "2023-11-15", 500000], ["refund", "R1", "C1", "7", 1700000500, "2023-11-15", 100000]] },
        { sales_payments_at: 1700000400, refund_checked_at: 1700000400, refund_state: "Возвраты сверены: уже учтены — 0, вычтены — 1, требуют проверки — 0" });
      await commit("attendance", { events: [["E1", "2026-10-01", 1700000000, "T1", "Растяжка", false]], records: [["R1", "E1", "7", "3"], ["R2", "E1", "", "9"]], products: [["R1", "Пробное", 1], ["R2", "", -1]] },
        { trial_snapshot: true, attendance_synced_at: 1700000500, attendance_state: "Занятия загружены · сопоставьте статусы записей в настройках", attendance_from: "2025-10-01", attendance_to: "2026-10-30", attendance_rules: { "3": "visited" }, checks_path: "1/checks/x.bin" });
      expect(await commit("attendance", { events: [["E1", "2026-10-01", 1700000000, "T1", "Растяжка", false]], records: [["R1", "E1", "7", "3"], ["R2", "E1", "", "9"]], products: [["R1", "Пробное", 1], ["R2", "", -1]] },
        { trial_snapshot: false, checks_path: "1/checks/y.bin" })).toEqual(["1/checks/x.bin"]);
      await commit("revenue", { revenue: [["purchase", "P1", 1700000000, "2026-10-01", 30000, "contract"], ["purchase", "P2", 1700000000, "2026-10-01", 20000, "service"], ["refund", "R1", 1700000000, "2026-10-02", -5000, "contract"]] },
        { revenue_synced_at: 1700000600, revenue_state: "Выручка загружена", revenue_from: "2026-04-01", revenue_to: "2026-10-29" });
      await commit("trials", { products: [["R1", "Пробное", 1], ["R2", "Обычное", 0]], evidence: [["R1", "sig1", "Пробное", 1]] },
        { trial_snapshot: true, quality: { unknown: 0, received: 3, reported: 3, exhausted: true } });
      await asServer(tx);
      const facts = async (table: string) =>
        (await tx.unsafe(`select count(*)::int as n from ${table} where connection_id = ${id}`))[0].n;
      expect(await Promise.all(["an_fb_leads", "an_fb_history", "an_fb_sales", "an_fb_payments", "an_fb_refund_audit", "an_fb_events", "an_fb_records", "an_fb_revenue_payments", "an_fb_trial_evidence"].map(facts))).toEqual([1, 2, 1, 2, 1, 1, 2, 3, 1]);
      expect((await tx`select count(*)::int as n from an_fb_staging`)[0].n).toBe(0);
      const daily = await tx`select day, amount_cents::int as a from an_fb_revenue_daily where connection_id = ${id} order by day`;
      expect(daily.map((d) => [d.day, d.a])).toEqual([["2026-10-01", 50000], ["2026-10-02", -5000]]);
      const products = await tx`select kind, item_id, is_trial from an_fb_trial_products where connection_id = ${id} order by kind, item_id`;
      expect(products.map((p) => [p.kind, p.item_id, p.is_trial])).toEqual([["contract", "C1", 0], ["contract", "C2", 1], ["registration", "R1", 1], ["registration", "R2", 0]]);
      const snaps = await tx`select kind from an_fb_trial_snapshots where connection_id = ${id} order by kind`;
      expect(snaps.map((x) => x.kind)).toEqual(["contract", "registration"]);
      const [conn] = await tx`select synced_at::int as s, sales_state, refund_state, checks_path, revenue_to, club_id from an_fb_connections where id = ${id}`;
      expect([conn.s, conn.sales_state, conn.checks_path, conn.revenue_to, conn.club_id]).toEqual([1700000200, "Продажи загружены", "1/checks/y.bin", "2026-10-29", "10"]);

      // Коды статусов записей: ровно встреченные коды, их значения.
      const attendance = (status: string, map: object) =>
        failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_attendance_settings(${id}, ${status}, ${map}::jsonb)`;
        });
      expect(await attendance("closed", { "3": "visited", "9": "" })).toContain("Выберите статус студии.");
      expect(await attendance("active", { "3": "visited" })).toContain("Обновите страницу и проверьте статусы записей.");
      expect(await attendance("active", { "3": "visited", "9": "gone" })).toContain("Обновите страницу и проверьте статусы записей.");
      expect(await attendance("archived", { "3": "visited", "9": "late_cancel" })).toBeNull();
      await as(tx, admin);
      const [{ v }] = await tx`select an_fb_connection(${id}) as v`;
      expect([v.studio_status, v.attendance_state, v.status_details.map((d: { status: string; count: number }) => [d.status, d.count])]).toEqual([
        "archived", "Занятия загружены", [["3", 1], ["9", 1]],
      ]);
      expect(v.status_details[0].examples[0]).toEqual({ registration_id: "R1", client_key: "7", event_id: "E1", day: "2026-10-01", training_name: "Растяжка" });

      // Смена клуба и домена стирает загруженное и отдаёт пути файлов.
      const [{ moved }] = await tx`select an_fb_rules_save(${id}, '11', ${okSteps}::jsonb, ${{ "5": "none" }}::jsonb) as moved`;
      expect(moved.removed_paths).toEqual(["1/inc/b.bin", "1/checks/y.bin"]);
      await asServer(tx);
      expect(await Promise.all(["an_fb_leads", "an_fb_records", "an_fb_trial_products", "an_fb_incremental"].map(facts))).toEqual([0, 0, 0, 0]);
      expect(await save(id, "Студия", "Lady Jump", "Казань", "club2", "")).toContain("При изменении домена введите его API-ключ.");
      expect(await save(id, "Студия", "Lady Jump", "Казань", "club2")).toBeNull();
      await asServer(tx);
      const [after] = await tx`select club_id, metadata, sync_state from an_fb_connections where id = ${id}`;
      expect([after.club_id, after.metadata, after.sync_state]).toEqual(["", {}, "Не синхронизировано"]);

      // Общая загрузка — одна; оборванная (без отметки 30 минут) — снова можно.
      await asService(tx);
      expect((await tx`select an_fb_batch_begin('{"total": 1}') as ok`)[0].ok).toBe(true);
      expect((await tx`select an_fb_batch_begin('{"total": 1}') as ok`)[0].ok).toBe(false);
      await asServer(tx);
      await tx`update an_fb_batch set updated_at = now() - interval '1 hour' where id = 1`;
      await as(tx, admin);
      const [{ l2 }] = await tx`select an_fb_connections() as l2`;
      expect([l2.batch.active, l2.batch.interrupted]).toEqual([false, true]);
      await asService(tx);
      expect((await tx`select an_fb_batch_begin('{"total": 2}') as ok`)[0].ok).toBe(true);

      await asServer(tx);
      const events = await tx`select event from an_audit where user_id = ${admin} and event like 'fitbase%' order by id`;
      expect(events.map((e) => e.event)).toEqual([
        "fitbase_save",
        "fitbase_rules",
        "fitbase_save",
        "fitbase_attendance_rules",
        "fitbase_rules",
        "fitbase_save",
      ]);
    });
  });

  test("FitBase: данные отчётов — право отчёта (вся сеть), период, направление по умолчанию", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ отчётов FitBase", ["an.admin"]);
      const viewer = await person(tx, "Отчёты FitBase", ["an.fb.revenue", "an.fb.sales", "an.fb.marketing"]);
      const other = await person(tx, "Без отчётов FitBase", ["an.mkt.ls"]);
      await asServer(tx);
      const [{ id: a }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id, step_rules, source_rules, metadata, sales_payments_at)
        values ('С1', 'Lady Stretch', 'Самара', 'aaa', '1', '{"1": "paid"}', '{"11": "community_messages"}',
                '{"sources": [{"id": 11, "name": "VK", "extra": 1}]}', 100) returning id`;
      const [{ id: b }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id) values ('С2', 'Lady Jump', 'Уфа', 'bbb', '2') returning id`;
      const [{ id: c }] = await tx`
        insert into an_fb_connections (name, brand, city, domain) values ('С0', 'Lady Stretch', 'Самара', 'ccc') returning id`;
      await tx`insert into an_fb_revenue_daily values (${a}, '2026-10-01', 500), (${a}, '2026-09-30', 100), (${c}, '2026-10-01', 1)`;
      await tx`insert into an_fb_sales values (${a}, '10', 'k1', 1790900000, 5000, 0), (${c}, '11', 'k2', 1790900000, 5000, 0)`;
      await tx`insert into an_fb_history values (${a}, '10', 'k1', 1790900000, 5000), (${c}, '11', 'k2', 1790900000, 5000)`;
      await tx`insert into an_fb_payments values (${a}, 'purchase', 's1', '10', 'k1', 1790900100, '2026-10-02', 5000)`;
      // Границы суток — МСК: 2026-10-01 00:00 = 1790802000.
      await tx`insert into an_fb_leads values
        (${a}, 'L1', 'client:1', 1790802000, '1', '11'),
        (${a}, 'L0', 'client:1', 1790801999, '1', '11'),
        (${a}, 'L9', 'client:2', 1793394000, '1', '11'),
        (${b}, 'J1', 'client:3', 1790900000, '1', '')`;

      for (const call of [
        () => tx`select an_fb_revenue_data('2026-10-01', '2026-10-29')`,
        () => tx`select an_fb_sales_data()`,
        () => tx`select an_fb_marketing_data('Lady Stretch', '2026-10-01', '2026-10-30')`,
      ]) {
        expect(
          await failure(tx, async () => {
            await as(tx, other);
            await call();
          }),
        ).toContain("an_forbidden");
      }

      await as(tx, viewer);
      const [{ r }] = await tx`select an_fb_revenue_data('2026-10-01', '2026-10-29') as r`;
      expect(r.admin).toBe(false);
      expect(r.connections.map((x: { name: string }) => x.name)).toEqual(["С2", "С0", "С1"]);
      expect(r.connections[2]).not.toHaveProperty("metadata");
      expect(r.daily).toEqual([[Number(a), "2026-10-01", 500]]);
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_revenue_data('2026-10-02', '2026-10-01')`;
        }),
      ).toContain("Проверьте фильтры и период выручки.");

      await as(tx, viewer);
      const [{ s }] = await tx`select an_fb_sales_data() as s`;
      expect([s.sales, s.history, s.payments]).toEqual([
        [[Number(a), "10", "k1", 1790900000, 5000, 0]],
        [[Number(a), "10", "k1", 1790900000, 5000]],
        [[Number(a), "purchase", "s1", "10", "k1", 1790900100, "2026-10-02", 5000]],
      ]);

      await as(tx, viewer);
      const [{ m }] = await tx`select an_fb_marketing_data('', '2026-10-01', '2026-10-30') as m`;
      // Их направление по умолчанию — первой студии по ORDER BY brand.
      expect(m.brand).toBe("Lady Jump");
      expect(m.leads).toEqual([[Number(b), "J1", "client:3", 1790900000, "1", ""]]);
      const [{ m: ls }] = await tx`select an_fb_marketing_data('Lady Stretch', '2026-10-01', '2026-10-30') as m`;
      expect(ls.leads).toEqual([[Number(a), "L1", "client:1", 1790802000, "1", "11"]]);
      const first = ls.connections.find((x: { id: number }) => x.id === Number(a));
      expect([first.step_rules, first.source_rules, first.sources]).toEqual([
        { "1": "paid" },
        { "11": "community_messages" },
        [{ id: 11, name: "VK" }],
      ]);
      expect(ls.budgets).toEqual([]);
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_marketing_data('Lady Stretch', '2025-09-30', '2026-10-01')`;
        }),
      ).toContain("Выберите корректный период: начало не позже конца, не больше 366 дней.");

      await as(tx, admin);
      const [{ r: ar }] = await tx`select an_fb_revenue_data('2026-10-01', '2026-10-29') as r`;
      expect(ar.admin).toBe(true);
    });
  });

  test("FitBase: «Занятия и посещаемость» — группы как их attendance_report, коды, фильтры, право", async () => {
    await scenario(async (tx) => {
      const viewer = await person(tx, "Занятия FitBase", ["an.fb.attendance"]);
      const other = await person(tx, "Без занятий FitBase", ["an.fb.revenue"]);
      await asServer(tx);
      const [{ id: a }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id, attendance_rules,
                                       attendance_synced_at, attendance_from, attendance_to)
        values ('С1', 'Lady Stretch', 'Самара', 'aaa', '1', '{"9": "visited", "6": "bogus"}',
                200, '2025-01-01', '2026-10-29') returning id`;
      const [{ id: b }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id) values ('С2', 'Lady Jump', 'Уфа', 'bbb', '2') returning id`;
      await tx`insert into an_fb_connections (name, brand, city, domain) values ('С0', 'Lady Stretch', 'Самара', 'ccc')`;
      await tx`insert into an_fb_events values
        (${a}, 'e1', '2026-10-05', 1000, 't1', 'Стретчинг', false),
        (${a}, 'e2', '2026-10-06', 1000, 't1', 'Стретчинг', true),
        (${a}, 'e3', '2026-10-07', 99999999999, 't1', 'Стретчинг', false),
        (${a}, 'e4', '2026-09-05', 1000, 't2', 'Пилон', false),
        (${a}, 'e5', '2025-10-05', 1000, 't2', 'Пилон', false)`;
      await tx`insert into an_fb_records values
        (${a}, 'r1', 'e1', 'client:1', '3'), (${a}, 'r2', 'e1', 'client:2', '0'),
        (${a}, 'r3', 'e1', 'client:3', '2'), (${a}, 'r4', 'e1', 'client:4', '9'),
        (${a}, 'r5', 'e1', 'client:5', '6'), (${a}, 'r6', 'e2', 'client:1', '3'),
        (${a}, 'r7', 'e4', 'client:1', '3')`;

      expect(
        await failure(tx, async () => {
          await as(tx, other);
          await tx`select an_fb_attendance_data('2026-10-01', '2026-10-29', '', '', '', '')`;
        }),
      ).toContain("an_forbidden");

      await as(tx, viewer);
      const [{ d }] = await tx`select an_fb_attendance_data('2026-10-01', '2026-10-29', '', '', '', '') as d`;
      expect([d.admin, d.pm_from, d.pm_to, d.py_from]).toEqual([false, "2026-09-01", "2026-09-29", "2025-10-01"]);
      expect(d.connections.map((x: { name: string }) => x.name)).toEqual(["С2", "С0", "С1"]);
      // Без клуба FitBase студия в отчёт не попадает.
      expect(d.selected.map((x: { id: number }) => x.id)).toEqual([Number(b), Number(a)]);
      expect(d.selected[1]).toMatchObject({ attendance_synced_at: 200, attendance_from: "2025-01-01", busy: false });
      expect([...d.trainings].sort()).toEqual(["Пилон", "Стретчинг"]);
      const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
      // Отменённое и будущее не считаются; отказ — не запись; «9» — «посетил» по
      // сохранённому правилу, у «6» статус неизвестный — неизвестный код.
      expect(sorted(d.groups)).toEqual(
        sorted([
          ["current", null, null, null, 1, 3, 2, true],
          ["current", "Самара", null, null, 1, 3, 2, true],
          ["current", "Самара", Number(a), null, 1, 3, 2, true],
          ["current", "Самара", Number(a), "Стретчинг", 1, 3, 2, true],
          ["month", null, null, null, 1, 1, 1, false],
          ["month", "Самара", null, null, 1, 1, 1, false],
          ["month", "Самара", Number(a), null, 1, 1, 1, false],
          ["month", "Самара", Number(a), "Пилон", 1, 1, 1, false],
          ["year", null, null, null, 1, 0, 0, false],
          ["year", "Самара", null, null, 1, 0, 0, false],
          ["year", "Самара", Number(a), null, 1, 0, 0, false],
          ["year", "Самара", Number(a), "Пилон", 1, 0, 0, false],
        ]),
      );
      expect(d.unknown).toEqual([[Number(a), "6"]]);

      await as(tx, viewer);
      const [{ d: t }] = await tx`select an_fb_attendance_data('2026-10-01', '2026-10-29', '', '', 'Пилон', '') as d`;
      expect(sorted(t.groups)).toEqual(sorted(d.groups.filter((g: unknown[]) => g[0] !== "current")));
      await as(tx, viewer);
      const [{ d: u }] = await tx`select an_fb_attendance_data('2026-10-01', '2026-10-29', 'Уфа', '', '', 'active') as d`;
      expect([u.selected.map((x: { id: number }) => x.id), u.groups, u.unknown]).toEqual([[Number(b)], [], []]);

      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_attendance_data('2025-09-30', '2026-10-01', '', '', '', '')`;
        }),
      ).toContain("Выберите корректный период не больше 366 дней.");
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_attendance_data('2026-10-01', '2026-10-29', '', '', '', 'closed')`;
        }),
      ).toContain("Проверьте фильтры.");
    });
  });

  test("FitBase: пробные — выбор услуг, типы записей по владельцу, воронка и записи без услуги, право", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ пробных FitBase", ["an.admin"]);
      const viewer = await person(tx, "Воронка FitBase", ["an.fb.trials"]);
      const other = await person(tx, "Без воронки FitBase", ["an.fb.sales"]);
      await asServer(tx);
      const [{ id: a }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id, attendance_synced_at,
                                       attendance_from, attendance_to, sales_payments_at, sales_synced_at)
        values ('С1', 'Lady Stretch', 'Самара', 'trl', '1', 100, '2025-01-01', '2026-10-29', 200, 150)
        returning id`;
      const owner = '["trl", "1"]';
      await tx`insert into an_fb_events values
        (${a}, 'e1', '2026-10-05', 1000, 't', 'Стретчинг', false),
        (${a}, 'e2', '2026-10-06', 1000, 't', 'Стретчинг', true)`;
      await tx`insert into an_fb_records values
        (${a}, 'r1', 'e1', 'k1', '3'), (${a}, 'r2', 'e1', 'k2', '2'), (${a}, 'r3', 'e1', 'k3', '3'),
        (${a}, 'r4', 'e1', 'k4', '3'), (${a}, 'r5', 'e2', 'k1', '3')`;
      await tx`insert into an_fb_trial_products values
        (${a}, 'registration', 'r1', 'Пробное', 1), (${a}, 'registration', 'r3', 'Пробное', 1),
        (${a}, 'registration', 'r5', 'Пробное', 1), (${a}, 'contract', 's1', 'Абонемент', 0),
        (${a}, 'contract', 's2', 'Абонемент', 0)`;
      // r2 — пробная по выбранным услугам; r3 — обычная (тип прежнего владельца не действует).
      await tx`insert into an_fb_trial_overrides values
        (${a}, ${owner}, 'r2', 1), (${a}, ${owner}, 'r3', 0), (${a}, '["old", "1"]', 'r4', 1)`;
      await tx`insert into an_fb_sales values
        (${a}, 's1', 'k1', 1790900000, 500000, 0), (${a}, 's2', 'k9', 1790900000, 500000, 0)`;
      await tx`insert into an_fb_payments values
        (${a}, 'purchase', 'p1', 's1', 'k1', 1790900100, '2026-10-05', 500000),
        (${a}, 'purchase', 'p2', 's2', 'k9', 1790900100, '2026-10-05', 500000)`;

      expect(
        await failure(tx, async () => {
          await as(tx, other);
          await tx`select an_fb_trials_data('2026-10-01', '2026-10-29', '', '', '')`;
        }),
      ).toContain("an_forbidden");

      await as(tx, viewer);
      const [{ d }] = await tx`select an_fb_trials_data('2026-10-01', '2026-10-29', '', '', '') as d`;
      expect(d.admin).toBe(false);
      expect(d.selected.map((x: { id: number }) => x.id)).toEqual([Number(a)]);
      // Пробные — r1 и r2 (отказ тоже запись); r5 — на отменённое занятие.
      expect([...d.records].sort()).toEqual([
        [Number(a), "r1", "k1", true, "2026-10-05", 1000],
        [Number(a), "r2", "k2", false, "2026-10-05", 1000],
      ]);
      // Покупки — только клиентов с посещённым пробным.
      expect(d.sales).toEqual([[Number(a), "s1", "k1", 1790900000, 500000]]);
      expect(d.payments).toEqual([[Number(a), "s1", "purchase", 500000, 1790900100]]);
      // Неопределённый тип: r4 (тип прежнего владельца не действует).
      expect(d.review_count).toBe(1);
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_trials_data('2026-10-01', '2026-10-29', '', '', 'Lady Fit')`;
        }),
      ).toContain("Проверьте направление.");
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_trials_data('2025-09-30', '2026-10-01', '', '', '')`;
        }),
      ).toContain("Выберите период не больше 366 дней.");

      await as(tx, viewer);
      const [{ v }] = await tx`select an_fb_trials_review('2026-10-01', '2026-10-29', '', '', '', '') as v`;
      expect(v.rows).toEqual([["С1", "Самара", "Lady Stretch", "2026-10-05", 1000, "Стретчинг", "visited", "e1", "r4"]]);
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_trials_review('2026-10-01', '2026-10-29', '', '', '', 'odd')`;
        }),
      ).toContain("Проверьте направление и статус.");

      // Выбор услуг — администратору; их проверки и тексты.
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_trial_services(${a})`;
        }),
      ).toContain("an_forbidden");
      expect(
        await failure(tx, async () => {
          await as(tx, viewer);
          await tx`select an_fb_trial_catalog_store(${a}, ${owner}, '[]'::jsonb)`;
        }),
      ).toContain("permission denied");
      await asServer(tx);
      expect(
        await failure(tx, async () => {
          await asServer(tx);
          await tx`select an_fb_trial_catalog_store(${a}, '["other", "1"]', '[]'::jsonb)`;
        }),
      ).toContain("Подключение изменилось. Откройте настройки заново.");
      await asServer(tx);
      await tx`select an_fb_trial_catalog_store(${a}, ${owner},
        '[{"service_id": "7", "name": "Пробное", "is_trial": 1, "archived": 0},
          {"service_id": "8", "name": "Разовое", "is_trial": 0, "archived": 1}]'::jsonb)`;
      const save = (mode: string, ids: string[], rev: string, own = owner) => async () => {
        await as(tx, admin);
        await tx`select an_fb_trial_services_save(${a}, ${own}, ${mode}, ${ids}::jsonb, ${rev})`;
      };
      expect(await failure(tx, save("odd", [], "0"))).toContain("Проверьте режим.");
      expect(await failure(tx, save("selected", [], "0", '["x", "1"]'))).toContain(
        "Подключение изменилось. Откройте настройки заново.",
      );
      expect(await failure(tx, save("selected", ["9"], "0"))).toContain(
        "Услуга отсутствует в каталоге этого филиала.",
      );
      expect(await failure(tx, save("selected", [], "0"))).toContain(
        "Выберите хотя бы одну пробную услугу.",
      );
      expect(await failure(tx, save("selected", ["7"], "3"))).toContain(
        "Настройки уже изменены. Обновите страницу.",
      );
      await save("selected", ["7", "7"], "0")();
      await as(tx, admin);
      const [{ s }] = await tx`select an_fb_trial_services(${a}) as s`;
      expect(s.rule).toEqual({ mode: "selected", selected: ["7"], revision: 1 });
      expect(s.catalog.map((k: { service_id: string }) => k.service_id)).toEqual(["7", "8"]);
      expect(await failure(tx, save("auto", ["7"], "0"))).toContain(
        "Настройки уже изменены. Обновите страницу.",
      );
    });
  });

  test("FitBase: основания со страниц — очередь заданий их jobs(), сопоставление, обзор администратору", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ оснований FitBase", ["an.admin"]);
      const viewer = await person(tx, "Воронка без оснований", ["an.fb.trials"]);
      await asServer(tx);
      const [{ id: a }] = await tx`
        insert into an_fb_connections (name, brand, city, domain, club_id)
        values ('С1', 'Lady Stretch', 'Самара', 'bas', '7') returning id`;
      const owner = '["bas", "7"]';
      await tx`insert into an_fb_events values
        (${a}, 'e1', '2026-08-05', 1000, 't', 'Стретчинг', false),
        (${a}, 'e2', '2026-10-06', 1000, 't', 'Стретчинг', false)`;
      await tx`insert into an_fb_records values (${a}, 'r1', 'e1', 'k1', '3'), (${a}, 'r2', 'e2', 'k2', '2')`;
      const conns = [{ id: Number(a), owner }];
      const now = 1793000000; // 2026-10-26
      const plan = async (today: string, at = now, c = conns) => {
        await asServer(tx);
        const [{ p }] = await tx`select an_fb_basis_plan(${c}::jsonb, ${today}::date, ${at}) as p`;
        return (p as { month: string }[]).map((j) => j.month).sort();
      };
      // Месяцы занятий, текущий и «свежие»; старые месяцы — раз в неделю.
      expect(await plan("2026-10-26")).toEqual(["2026-08", "2026-10", "recent"]);
      const jobs = await tx`select month, lo, hi, interval_seconds, anchor from an_fb_basis_jobs
                            where connection_id = ${a} order by month`;
      expect(jobs.map((j) => [j.month, j.lo, j.hi, j.interval_seconds, j.anchor])).toEqual([
        ["2026-08", "2026-08-01", "2026-08-31", 604800, ""],
        ["2026-10", "2026-10-01", "2026-10-31", 86400, ""],
        ["recent", "2026-08-27", "2026-12-25", 900, "2026-10-26"],
      ]);
      // Сверенные ждут срока; задание с ошибкой — 15 минут.
      await tx`update an_fb_basis_jobs set finished_at = ${now - 100} where connection_id = ${a} and month <> '2026-10'`;
      await tx`update an_fb_basis_jobs set failed_at = ${now - 100}, error = 'http_503' where month = '2026-10'`;
      expect(await plan("2026-10-26")).toEqual([]);
      expect(await plan("2026-10-26", now + 1000)).toEqual(["2026-10", "recent"]);
      // Новый день — «свежие» заново, их прочитанные ID стираются.
      await tx`insert into an_fb_basis_seen values (${a}, 'recent', 'r2'), (${a}, '2026-08', 'r1')`;
      await tx`update an_fb_basis_jobs set page = 9, seen = 80 where month = 'recent'`;
      await plan("2026-10-27");
      const [rec] = await tx`select page, seen, anchor, lo, finished_at from an_fb_basis_jobs where month = 'recent'`;
      expect([rec.page, rec.seen, rec.anchor, rec.lo, Number(rec.finished_at)]).toEqual([1, 0, "2026-10-27", "2026-08-28", 0]);
      expect((await tx`select month from an_fb_basis_seen order by month`).map((r) => r.month)).toEqual(["2026-08"]);
      // Новый владелец подключения — месяцы начинаются заново.
      await plan("2026-10-27", now, [{ id: Number(a), owner: '["bas", "8"]' }]);
      const owners = await tx`select distinct owner from an_fb_basis_jobs where connection_id = ${a}`;
      expect(owners.map((r) => r.owner)).toEqual(['["bas", "8"]']);
      expect((await tx`select count(*)::int as n from an_fb_basis_seen`)[0].n).toBe(0);

      // Сопоставление: владелец, запись API с днём занятия, прежнее основание.
      await tx`insert into an_fb_trial_basis values (${a}, ${owner}, 'r2', 'e2', 'Пробное', 500, 600)`;
      const [{ l }] = await tx`select an_fb_basis_lookup(${a}, ${["r1", "r2", "r9"]}) as l`;
      expect(l).toEqual({
        owner,
        records: { r1: ["e1", "2026-08-05"], r2: ["e2", "2026-10-06"] },
        basis: { r2: 500 },
      });

      // Обзор — администратору аналитики; очередь и сессия — только сервер.
      await tx`insert into an_fb_basis_evidence values
        (${a}, ${owner}, 'r2', 'Пробное', '', '06.10.2026 10:00', 500),
        (${a}, ${owner}, 'r9', 'Пробное', '', '06.10.2026 10:00', 500)`;
      await as(tx, admin);
      const [{ o }] = await tx`select an_fb_basis_overview() as o`;
      expect(o.status.state).toBe("not_authorized");
      expect(o.session).toBeNull();
      expect(o.basis).toEqual({ [String(a)]: 1 });
      expect(o.pending).toBe(1);
      expect(o.jobs.length).toBe(3);
      for (const q of [
        () => tx`select an_fb_basis_overview()`,
        () => tx`select an_fb_basis_plan('[]'::jsonb, '2026-10-26'::date, 0)`,
        () => tx`select an_fb_basis_lookup(${a}, ${["r1"]})`,
        () => tx`select * from an_fb_basis_jobs`,
        () => tx`select * from an_fb_web_tokens`,
      ]) {
        expect(
          await failure(tx, async () => {
            await as(tx, viewer);
            await q();
          }),
        ).toMatch(/an_forbidden|permission denied/);
      }
    });
  });

  test("FitBase: «Мой город · FitBase» — студии человека, город и студия, точка 0, права", async () => {
    await scenario(async (tx) => {
      const admin = await person(tx, "Админ города FitBase", ["an.admin"]);
      const partner = await person(tx, "Партнёр города FitBase", ["an.reviews"]);
      const other = await person(tx, "Без студий FitBase", ["an.fb.sales"]);
      await asServer(tx);
      const ids: number[] = [];
      for (const [name, city, club] of [
        ["С1", "Самара", "1"],
        ["С2", "Самара", "2"],
        ["К1", "Казань", "3"],
      ]) {
        const [{ id }] = await tx`
          insert into an_fb_connections (name, brand, city, domain, club_id, revenue_synced_at,
                                         revenue_from, revenue_to)
          values (${name}, 'Lady Stretch', ${city}, 'myc', ${club}, 100, '2026-01-01', '2026-10-30')
          returning id`;
        ids.push(Number(id));
      }
      const [s1, s2, k1] = ids;
      await tx`insert into an_fb_revenue_daily values (${s1}, '2026-10-05', 1000), (${s2}, '2026-10-05', 2000),
        (${k1}, '2026-10-05', 3000), (${s1}, '2026-05-01', 7)`;
      const data = async (uid: string, city = "", studio = "", from = "2026-10-01", to = "2026-10-30") => {
        await as(tx, uid);
        const [{ d }] = await tx`select an_fb_mycity_data(${from}, ${to}, ${city}, ${studio}) as d`;
        return d;
      };
      const me = async (uid: string) => {
        await asServer(tx);
        const [{ m }] = await tx`select an_me_for(${uid}::uuid) as m`;
        return m.reports as string[];
      };

      // Без назначенных студий — нет отчёта.
      expect(await me(other)).not.toContain("fb.mycity");
      expect(await failure(tx, () => data(other))).toContain("Студии FitBase вам не назначены.");

      // Назначение — администратору аналитики; их проверки.
      expect(
        await failure(tx, async () => {
          await as(tx, partner);
          await tx`select an_fb_partner_access_save(${partner}::uuid, ${[s2]}::bigint[])`;
        }),
      ).toContain("an_forbidden");
      expect(
        await failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_partner_access_save(${partner}::uuid, ${[999999]}::bigint[])`;
        }),
      ).toContain("Подключение изменилось. Обновите страницу.");
      await as(tx, admin);
      await tx`select an_fb_partner_access_save(${partner}::uuid, ${[s2]}::bigint[])`;
      expect(await me(partner)).toContain("fb.mycity");

      // Партнёр: только своя студия, другой город и чужая студия — отказ.
      const d = await data(partner);
      expect([d.city, d.cities, d.admin]).toEqual(["Самара", ["Самара"], false]);
      expect(d.connections.map((c: { id: number }) => c.id)).toEqual([s2]);
      expect(d.daily).toEqual([[s2, "2026-10-05", 2000]]);
      // ID клиентов — псевдонимы запроса (равные ID — равные псевдонимы, пустой — пустой).
      await asServer(tx);
      await tx`insert into an_fb_sales values (${s2}, 'c1', 'client-7', 1790000000, 100, 0),
        (${s2}, 'c2', 'client-7', 1790000001, 100, 0)`;
      await tx`insert into an_fb_payments values (${s2}, 'purchase', 'p1', 'c1', '', 1790000000, '2026-09-21', 100)`;
      const pseudo = await data(partner);
      const clients = pseudo.sales.map((r: unknown[]) => r[2]);
      expect(clients[0]).toBe(clients[1]);
      expect(JSON.stringify(pseudo)).not.toContain("client-7");
      expect(pseudo.payments[0][4]).toBe("");
      expect(d.target).toBeNull();
      expect(await failure(tx, () => data(partner, "Казань"))).toContain("Этот город вам недоступен.");
      expect(await failure(tx, () => data(partner, "", String(s1)))).toContain(
        "Эта студия вам недоступна в выбранном городе.",
      );
      expect(await failure(tx, () => data(partner, "", "", "2026-10-31", "2026-10-01"))).toContain(
        "Выберите период до 366 дней, не старше шести лет.",
      );
      expect(await failure(tx, () => data(partner, "", "", "2026-13-01"))).toContain(
        "Выберите корректные даты.",
      );

      // Точка 0 — администратору; на доске — только когда выбран весь город.
      expect(
        await failure(tx, async () => {
          await as(tx, admin);
          await tx`select an_fb_city_target_save('Новосибирск', 100)`;
        }),
      ).toContain("Выберите город студий FitBase.");
      await as(tx, admin);
      await tx`select an_fb_city_target_save('Самара', 150000000)`;
      const all = await data(admin);
      expect(all.admin).toBe(true);
      expect(all.cities).toEqual(["Казань", "Самара"]);
      expect(all.city).toBe("Казань");
      const samara = await data(admin, "Самара");
      expect(samara.connections.map((c: { id: number }) => c.id).sort()).toEqual([s1, s2].sort());
      expect(Number(samara.target)).toBe(150000000);
      // Выручка — и пять прошлых месяцев доски (с мая).
      expect(samara.daily.length).toBe(3);
      expect((await data(admin, "Самара", String(s1))).target).toBeNull();
      expect((await data(partner)).target).toBeNull();

      // Смена клуба подключения закрывает назначение (их owner binding).
      await asServer(tx);
      await tx`update an_fb_connections set club_id = '22' where id = ${s2}`;
      expect(await me(partner)).not.toContain("fb.mycity");
      expect(await failure(tx, () => data(partner))).toContain("Студии FitBase вам не назначены.");

      // Обзор назначений и точки 0 — администратору.
      await as(tx, admin);
      const [{ o }] = await tx`select an_fb_partner_access() as o`;
      expect(o.targets).toEqual([{ city: "Самара", amount_cents: 150000000 }]);
      expect(
        await failure(tx, async () => {
          await as(tx, partner);
          await tx`select an_fb_partner_access()`;
        }),
      ).toContain("an_forbidden");
      for (const q of [() => tx`select * from an_fb_user_studios`, () => tx`select * from an_fb_city_targets`]) {
        expect(
          await failure(tx, async () => {
            await as(tx, partner);
            await q();
          }),
        ).toContain("permission denied");
      }
    });
  });
});
