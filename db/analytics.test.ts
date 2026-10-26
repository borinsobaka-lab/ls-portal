/**
 * Тесты «Аналитики сети» (db/migrations/2026-10-26_zzz_analytics_network.sql):
 * клубы сети на 1С, FitBase и других учётных системах — права (все клубы /
 * свои города / загрузка), загрузка выгрузок с заменой периода, выручка,
 * новые / продления / возвращённые, воронка пробных (покупка — последнему
 * пробному в окне 14 дней), занятия, нулевая номенклатура.
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

describe.skipIf(!url)("аналитика сети (база)", () => {
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
    const [{ id }] = await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  /** Человек модели прав с сетевыми правами (как после пересчёта ролей). */
  async function person(tx: Tx, rights: string[]): Promise<string> {
    const id = await user(tx);
    await tx`insert into access_user_rights (user_id, rights, portal) values (${id}, ${rights}, true)`;
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

  async function call<T>(tx: Tx, who: string, run: (t: Tx) => Promise<{ r: T }[]>): Promise<T> {
    await as(tx, who);
    const [{ r }] = await run(tx);
    await asServer(tx);
    return r;
  }

  type Imp = { import_id: string; studios: Record<string, string>; nomenclature: Record<string, string> };

  /** Загрузка целиком: начало, строки (студия — по названию, номенклатура — по коду), конец. */
  async function load(
    tx: Tx,
    who: string,
    kind: "revenue" | "sales" | "classes" | "visits",
    from: string,
    to: string,
    rows: unknown[][],
    nomenclature: { code: string; name: string }[] = [],
  ): Promise<Imp> {
    await as(tx, who);
    const studios = [...new Set(rows.map((r) => String(r[0])))];
    const [{ r: imp }] = await tx`
      select an_import_start(${kind}, '1c', 'test.xlsx', ${from}::date, ${to}::date,
                             ${studios}::text[], ${JSON.stringify(nomenclature)}::text::jsonb) as r`;
    const ready = (imp as Imp).studios;
    const nom = (imp as Imp).nomenclature;
    const mapped = rows.map((r) => {
      const out = [...r];
      out[0] = ready[String(r[0])];
      if (kind === "sales") out[4] = nom[String(r[4])];
      return out;
    });
    await tx`select an_import_rows(${(imp as Imp).import_id}::uuid, ${JSON.stringify(mapped)}::text::jsonb)`;
    await tx`select an_import_finish(${(imp as Imp).import_id}::uuid)`;
    await asServer(tx);
    return imp as Imp;
  }

  async function classify(tx: Tx, code: string, category: string) {
    await tx`update an_nomenclature set category = ${category} where code = ${code}`;
  }

  async function city(tx: Tx, name: string, cityName: string) {
    await tx`update an_studios set city = ${cityName}, needs_review = false where name = ${name}`;
  }

  test("права: все клубы, свои города, без права — ничего; загружает только manage", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      const viewer = await person(tx, ["analytics.view"]);
      const partner = await person(tx, ["analytics.cities"]);
      const nobody = await person(tx, ["kb.admin"]);
      await load(tx, admin, "revenue", "2026-09-01", "2026-09-30", [
        ["Барнаул, Ленина 1", "2026-09-02", "", 1000, 0],
        ["Смоленск, Мира 5", "2026-09-02", "", 500, 0],
      ]);
      await city(tx, "Барнаул, Ленина 1", "Барнаул");
      await city(tx, "Смоленск, Мира 5", "Смоленск");
      await tx`insert into an_user_cities (user_id, city) values (${partner}, 'Барнаул')`;

      const names = async (who: string) =>
        (await call<{ studios: { name: string }[] }>(tx, who, (t) => t`select an_scope() as r`)).studios
          .map((s) => s.name)
          .sort();
      expect(await names(viewer)).toEqual(["Барнаул, Ленина 1", "Смоленск, Мира 5"]);
      expect(await names(partner)).toEqual(["Барнаул, Ленина 1"]);
      expect(await names(nobody)).toEqual([]);

      // Партнёр не получает чужой город, даже запросив его студию.
      const all = await call<unknown[][]>(tx, partner, (t) =>
        t`select an_revenue_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      expect(all.map((r) => Number(r[2]))).toEqual([1000]);

      // Загружать и править справочники — только manage.
      for (const who of [viewer, partner]) {
        await as(tx, who);
        expect(
          await failure(
            tx,
            () => tx`select an_import_start('revenue', '1c', null, '2026-09-01', '2026-09-30', '{X}', '[]')`,
          ),
        ).toContain("Нет права");
        expect(await failure(tx, () => tx`select an_city_target_save('Барнаул', 1)`)).toContain("Нет права");
        // Факты напрямую закрыты.
        expect(await failure(tx, () => tx`select * from an_revenue`)).toContain("permission denied");
        await asServer(tx);
      }

      // Человек вне модели прав: владелец клуба — всё.
      const [{ id: studio }] = await tx`insert into studios (name, format) values ('Наш', 'packages') returning id`;
      const legacy = await user(tx);
      await tx`insert into user_roles (user_id, studio_id, role) values (${legacy}, ${studio}, 'owner')`;
      expect(await names(legacy)).toEqual(["Барнаул, Ленина 1", "Смоленск, Мира 5"]);
      const access = await call<{ manage: boolean }>(tx, legacy, (t) => t`select an_access() as r`);
      expect(access.manage).toBe(true);
    }));

  test("свои клубы: студии клубов из назначения роли; клуб — в справочнике студий", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      await load(tx, admin, "revenue", "2026-09-01", "2026-09-30", [
        ["Москва, Тверская 1", "2026-09-02", "", 1000, 0],
        ["Москва, Арбат 2", "2026-09-02", "", 700, 0],
        ["Казань, Баумана 3", "2026-09-02", "", 500, 0],
      ]);
      const [{ id: tverskaya }] = await tx`insert into studios (name, format) values ('Тверская', 'packages') returning id`;
      const [{ id: arbat }] = await tx`insert into studios (name, format) values ('Арбат', 'packages') returning id`;
      const [{ id: kazan }] = await tx`insert into studios (name, format) values ('Казань', 'packages') returning id`;
      const ids = Object.fromEntries(
        (await tx`select id, name from an_studios`).map((r: { id: string; name: string }) => [r.name, r.id]),
      );
      // Связь студии выгрузки с клубом — в справочнике, только manage.
      await as(tx, admin);
      await tx`select an_studio_save(${ids["Москва, Тверская 1"]}::uuid, 'Москва', null, null, null, null, ${tverskaya}::uuid)`;
      await tx`select an_studio_save(${ids["Москва, Арбат 2"]}::uuid, 'Москва', null, null, null, null, ${arbat}::uuid)`;
      await tx`select an_studio_save(${ids["Казань, Баумана 3"]}::uuid, 'Казань', null, null, null, null, ${kazan}::uuid)`;
      await asServer(tx);
      const list = await call<{ name: string; club_name: string }[]>(tx, admin, (t) => t`select an_studios_list() as r`);
      expect(list.find((x) => x.name === "Москва, Арбат 2")?.club_name).toBe("Арбат");

      // Собственник: роль «Владелец клуба — аналитика» в двух своих клубах.
      const owner = await user(tx);
      await tx`insert into portal_users (user_id) values (${owner})`;
      const [{ id: role }] = await tx`select id from access_roles where system_key = 'club_owner_analytics'`;
      await tx`insert into access_assignments (role_id, subject_type, user_id, scope_type, scope_ids)
               values (${role}, 'user', ${owner}, 'studios', ${[tverskaya, arbat]}::uuid[])`;
      await tx`select access_flush()`;
      // Франчайзи: «Аналитика сети» — все клубы.
      const franchise = await person(tx, ["analytics.view"]);

      const names = async (who: string) =>
        (await call<{ studios: { name: string }[] }>(tx, who, (t) => t`select an_scope() as r`)).studios
          .map((x) => x.name)
          .sort();
      expect(await names(owner)).toEqual(["Москва, Арбат 2", "Москва, Тверская 1"]);
      expect(await names(franchise)).toEqual(["Казань, Баумана 3", "Москва, Арбат 2", "Москва, Тверская 1"]);
      const access = await call<{ clubs: string[]; view: boolean }>(tx, owner, (t) => t`select an_access() as r`);
      expect(access.view).toBe(false);
      expect([...access.clubs].sort()).toEqual([tverskaya, arbat].sort());
      // Отчёт — только свои клубы, даже если запросить все студии.
      const rows = await call<unknown[][]>(tx, owner, (t) =>
        t`select an_revenue_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      expect(rows.map((r) => Number(r[2])).sort((a, b) => a - b)).toEqual([700, 1000]);

      // Собственность сама аналитику не открывает: роль на выбранные клубы —
      // только они, даже если человек собственник ещё одного клуба.
      await tx`insert into studio_owners (studio_id, user_id) values (${kazan}, ${owner})`;
      expect(await names(owner)).toEqual(["Москва, Арбат 2", "Москва, Тверская 1"]);
      // Область «Клубы собственника»: та же роль партнёрам — у каждого свои клубы.
      const partner = await user(tx);
      await tx`insert into portal_users (user_id) values (${partner})`;
      await tx`insert into access_assignments (role_id, subject_type, user_id, scope_type)
               values (${role}, 'user', ${partner}, 'owned')`;
      await tx`select access_flush()`;
      expect(await names(partner)).toEqual([]);
      await tx`insert into studio_owners (studio_id, user_id) values (${kazan}, ${partner})`;
      await tx`select access_flush()`;
      expect(await names(partner)).toEqual(["Казань, Баумана 3"]);
      await tx`delete from studio_owners where studio_id = ${kazan}`;
      await tx`select access_flush()`;
      expect(await names(partner)).toEqual([]);

      // Заблокирован — ничего.
      await tx`update portal_users set status = 'blocked' where user_id = ${owner}`;
      await tx`select access_flush()`;
      expect(await names(owner)).toEqual([]);

      // Клуб удалили — связь со студией снимается, данные студии остаются.
      await tx`delete from studios where id = ${kazan}`;
      const [{ club_id }] = await tx`select club_id from an_studios where id = ${ids["Казань, Баумана 3"]}`;
      expect(club_id).toBeNull();
    }));

  test("загрузка: новые студии и номенклатура «проверить», повтор заменяет период, удаление", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      const first = await load(tx, admin, "revenue", "2026-09-01", "2026-09-30", [
        ["Барнаул, Ленина 1 (удален)", "2026-09-02", "Продажи", 1000, 100],
        ["Барнаул, Ленина 1 (удален)", "2026-09-20", "Продажи", 500, 0],
      ]);
      const [studio] = await tx`select needs_review from an_studios where name = 'Барнаул, Ленина 1 (удален)'`;
      expect(studio.needs_review).toBe(true);

      // Новая выгрузка за 15–30 сентября заменяет только эти даты.
      await load(tx, admin, "revenue", "2026-09-15", "2026-09-30", [
        ["Барнаул, Ленина 1 (удален)", "2026-09-21", "Продажи", 700, 0],
      ]);
      const rows = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_revenue_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      expect(rows.map((r) => [r[1], Number(r[2]) - Number(r[3])])).toEqual([
        ["2026-09-02", 900],
        ["2026-09-21", 700],
      ]);
      const [{ rows_count }] = await tx`select rows_count from an_imports where id = ${first.import_id}`;
      expect(rows_count).toBe(1);

      // Строка вне периода загрузки не принимается.
      await as(tx, admin);
      const [{ r }] = await tx`
        select an_import_start('revenue', '1c', null, '2026-10-01', '2026-10-31',
                               '{Барнаул, Ленина 1 (удален)}', '[]') as r`;
      const imp = r as Imp;
      const sid = Object.values(imp.studios)[0];
      expect(
        await failure(
          tx,
          () => tx`select an_import_rows(${imp.import_id}::uuid,
                     ${JSON.stringify([[sid, "2026-09-05", "", 1, 0]])}::text::jsonb)`,
        ),
      ).toContain("вне студий или периода");
      // Незавершённая загрузка отчётам не видна, удаление убирает её данные.
      await tx`select an_import_rows(${imp.import_id}::uuid, ${JSON.stringify([[sid, "2026-10-05", "", 50, 0]])}::text::jsonb)`;
      await asServer(tx);
      const oct = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_revenue_report(null, '2026-10-01', '2026-10-31') as r`,
      );
      expect(oct).toEqual([]);
      await as(tx, admin);
      await tx`select an_import_delete(${first.import_id}::uuid)`;
      await asServer(tx);
      const after = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_revenue_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      expect(after.map((r) => r[1])).toEqual(["2026-09-21"]);
    }));

  test("продажи: только «Абонемент» с оплатой; новый — первая покупка клиента в истории; возвращённый — перерыв", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      const nom = [
        { code: "001", name: "Абонемент 8" },
        { code: "002", name: "Пробное" },
        { code: "003", name: "Новый товар" },
      ];
      // [студия, день, время, клиент, номенклатура, стоимость, оплата]
      await load(
        tx,
        admin,
        "sales",
        "2026-05-01",
        "2026-09-30",
        [
          ["Барнаул", "2026-05-10", null, "c1", "001", 5000, 5000], // c1 — новый (май)
          ["Барнаул", "2026-09-05", null, "c1", "001", 5000, 5000], // c1 — после 118 дней: возвращённый
          ["Смоленск", "2026-08-25", null, "c2", "001", 5000, 5000], // c2 — новый (август, другая студия)
          ["Барнаул", "2026-09-10", null, "c2", "001", 4000, 4000], // c2 — продление (16 дней)
          ["Барнаул", "2026-09-11", null, "c3", "001", 5000, 0], // не оплачен — не продажа
          ["Барнаул", "2026-09-12", null, "c4", "003", 900, 900], // не размечен — не абонемент
          ["Барнаул", "2026-09-13", null, "c5", "002", 0, 0],
        ],
        nom,
      );
      await classify(tx, "001", "subscription");
      await classify(tx, "002", "trial");

      const r = await call<{ sold: unknown[][]; names: Record<string, string> }>(tx, admin, (t) =>
        t`select an_sales_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      const byOrigin = Object.fromEntries(r.sold.map((s) => [s[3], [Number(s[4]), Number(s[5])]]));
      expect(byOrigin).toEqual({ return: [1, 5000], renewal: [1, 4000] });
      expect(Object.values(r.names)).toEqual(["Абонемент 8"]);
      const aug = await call<{ sold: unknown[][] }>(tx, admin, (t) =>
        t`select an_sales_report(null, '2026-08-01', '2026-08-31') as r`,
      );
      expect(aug.sold.map((s) => s[3])).toEqual(["new"]);

      // Нулевая номенклатура: стоимость 0 или пустая, кроме пробных.
      const zero = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_zero_report(null, '2026-09-01', '2026-09-30') as r`,
      );
      expect(zero).toEqual([]);
    }));

  test("воронка пробных: покупка в день и за 14 дней, последнему пробному в окне", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      // [студия, день, клиент, членство, пришёл]
      await load(tx, admin, "visits", "2026-09-01", "2026-09-30", [
        ["Барнаул", "2026-09-01", "a", "Пробное занятие", true], // a: купила в тот же день
        ["Барнаул", "2026-09-02", "b", "Пробное занятие", true], // b: два пробных — покупка уходит второму
        ["Барнаул", "2026-09-06", "b", "Пробное занятие", true],
        ["Барнаул", "2026-09-03", "c", "Пробное занятие", false], // c: не пришла
        ["Барнаул", "2026-09-04", "d", "Пробное занятие", true], // d: купила через 20 дней — не в счёт
        ["Барнаул", "2026-09-05", "e", "Абонемент 8", true], // не пробное
      ]);
      await load(
        tx,
        admin,
        "sales",
        "2026-09-01",
        "2026-09-30",
        [
          ["Барнаул", "2026-09-01", null, "a", "001", 5000, 5000],
          ["Смоленск", "2026-09-10", null, "b", "001", 5000, 5000],
          ["Барнаул", "2026-09-24", null, "d", "001", 5000, 5000],
        ],
        [
          { code: "001", name: "Абонемент 8" },
          { code: "name:пробное занятие", name: "Пробное занятие" },
        ],
      );
      await classify(tx, "001", "subscription");
      await classify(tx, "name:пробное занятие", "trial");

      const rows = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_trials_report(null, '2026-09-01', '2026-09-30', 'month') as r`,
      );
      expect(rows.length).toBe(1);
      const [, , membership, n, attended, day0, d14] = rows[0];
      expect(membership).toBe("Пробное занятие");
      expect([n, attended, day0, d14].map(Number)).toEqual([5, 4, 1, 2]);
    }));

  test("занятия: суммы по направлениям", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      await load(tx, admin, "classes", "2026-09-01", "2026-09-30", [
        ["Барнаул", "2026-09-01", "Стретчинг", 3, 30, 24],
        ["Барнаул", "2026-09-02", "Стретчинг", 2, 20, 18],
        ["Барнаул", "2026-09-02", "Пилатес", 1, 8, 6],
      ]);
      const rows = await call<unknown[][]>(tx, admin, (t) =>
        t`select an_classes_report(null, '2026-09-01', '2026-09-30', 'month') as r`,
      );
      const by = Object.fromEntries(rows.map((r) => [r[2], [r[3], r[4], r[5]].map(Number)]));
      expect(by).toEqual({ Стретчинг: [5, 50, 42], Пилатес: [1, 8, 6] });
      // Занятие без пришедших не принимается (как у Lady Stretch — не проведено).
      await as(tx, admin);
      const [{ r }] = await tx`
        select an_import_start('classes', '1c', null, '2026-10-01', '2026-10-31', '{Барнаул}', '[]') as r`;
      const imp = r as Imp;
      expect(
        await failure(
          tx,
          () => tx`select an_import_rows(${imp.import_id}::uuid,
                     ${JSON.stringify([[imp.studios["Барнаул"], "2026-10-01", "X", 1, 5, 0]])}::text::jsonb)`,
        ),
      ).toContain("check");
      await asServer(tx);
    }));

  test("справочники: студия, точка 0, города партнёра; прежний раздел клуба убран", () =>
    scenario(async (tx) => {
      const admin = await person(tx, ["analytics.manage"]);
      const partner = await person(tx, ["analytics.cities"]);
      await load(tx, admin, "revenue", "2026-09-01", "2026-09-30", [["Барнаул", "2026-09-02", "", 1, 0]]);
      const [{ id }] = await tx`select id from an_studios where name = 'Барнаул'`;
      await as(tx, admin);
      await tx`select an_studio_save(${id}, ' Барнаул ', 'ИП Иванова', null, null, null)`;
      await tx`select an_city_target_save('Барнаул', 850000)`;
      await tx`select an_partner_cities_save(${partner}, '{Барнаул}')`;
      const [{ r: partners }] = await tx`select an_partners_list() as r`;
      await asServer(tx);
      expect((partners as { cities: string[] }[]).map((p) => p.cities)).toEqual([["Барнаул"]]);
      const scope = await call<{ targets: Record<string, number>; studios: { city: string }[] }>(tx, partner, (t) =>
        t`select an_scope() as r`,
      );
      expect(scope.studios.map((s) => s.city)).toEqual(["Барнаул"]);
      expect(Number(scope.targets["Барнаул"])).toBe(850000);

      const [{ n }] = await tx`select count(*)::int as n from access_permissions where key = 'club.analytics'`;
      expect(n).toBe(0);
    }));
});
