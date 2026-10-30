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
});
