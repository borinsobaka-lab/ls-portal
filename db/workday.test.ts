/**
 * Тесты «Рабочего дня» (db/migrations/2026-10-26_workday_checklist.sql):
 * кто видит, правит и отмечает пункты, отметка только за сегодня, клуб пункта
 * — клуб блока, порядок и копия из другого клуба, стартовый набор Lady Stretch.
 *
 * Нужна база с полной схемой — как для db/knowledge-base.test.ts:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;

class Rollback extends Error {}

describe.skipIf(!url)("рабочий день (база)", () => {
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

  async function studio(tx: Tx, name = "Тест"): Promise<string> {
    const [{ id }] = await tx`insert into studios (name, format) values (${name}, 'packages') returning id`;
    return id as string;
  }

  async function staff(tx: Tx, studioId: string, role = "admin", name = "Сотрудник"): Promise<string> {
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, ${role}::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${studioId}, ${name})
             on conflict (id) do update set full_name = excluded.full_name`;
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

  async function setup(tx: Tx) {
    const s = await studio(tx);
    const s2 = await studio(tx);
    const owner = await staff(tx, s, "owner", "Владелец");
    const admin = await staff(tx, s, "admin", "Анна Админ");
    const trainer = await staff(tx, s, "trainer", "Тренер");
    const other = await staff(tx, s2, "owner", "Чужой");
    const client = await user(tx);
    await as(tx, owner);
    const [{ id: sec }] = await tx`
      insert into workday_sections (studio_id, title, sort_order) values (${s}, 'Начало рабочего дня', 1) returning id`;
    const [{ id: item }] = await tx`
      insert into workday_items (section_id, title, due_time, sort_order)
      values (${sec}, '  Включить свет  ', '10:00', 1) returning id, studio_id, title`.then((r) => {
      expect(r[0].studio_id).toBe(s);
      expect(r[0].title).toBe("Включить свет");
      return r;
    });
    await asServer(tx);
    return { s, s2, owner, admin, trainer, other, client, sec, item: item as string };
  }

  test("права: читают сотрудники клуба, правит только владелец клуба", () =>
    scenario(async (tx) => {
      const { s, admin, trainer, other, client, sec, item } = await setup(tx);

      for (const who of [admin, trainer]) {
        await as(tx, who);
        expect((await tx`select id from workday_items where studio_id = ${s}`).length).toBe(1);
        expect((await tx`select id from workday_sections where studio_id = ${s}`).length).toBe(1);
        expect(
          await failure(tx, () => tx`insert into workday_items (section_id, title) values (${sec}, 'Ещё')`),
        ).toContain("row-level security");
        await tx`update workday_items set title = 'Взлом' where id = ${item}`;
        await asServer(tx);
        expect((await tx`select title from workday_items where id = ${item}`)[0].title).toBe("Включить свет");
      }

      for (const who of [other, client]) {
        await as(tx, who);
        expect((await tx`select id from workday_items where studio_id = ${s}`).length).toBe(0);
        expect(
          await failure(tx, () => tx`insert into workday_checks (item_id) values (${item})`),
        ).toContain("row-level security");
        await asServer(tx);
      }
    }));

  test("отметка: кто и когда ставит база, только сегодня, снять — только сегодняшнюю", () =>
    scenario(async (tx) => {
      const { s, admin, trainer, item } = await setup(tx);
      await as(tx, admin);
      const [check] = await tx`
        insert into workday_checks (item_id, studio_id, checked_by, checked_by_name)
        values (${item}, ${crypto.randomUUID()}, ${trainer}, 'Подделка')
        returning studio_id, day, checked_by, checked_by_name, (day = workday_today()) as today`;
      expect(check.studio_id).toBe(s);
      expect(check.checked_by).toBe(admin);
      expect(check.checked_by_name).toBe("Анна Админ");
      expect(check.today).toBe(true);

      // Повторная отметка того же пункта — дубль, клиент её пропускает.
      expect(await failure(tx, () => tx`insert into workday_checks (item_id) values (${item})`)).toContain(
        "duplicate key",
      );
      // Вчерашним днём не отметить.
      expect(
        await failure(
          tx,
          () => tx`insert into workday_checks (item_id, day) values (${item}, workday_today() - 1)`,
        ),
      ).toContain("workday_not_today");
      await asServer(tx);

      // Вчерашняя отметка (история) не снимается, сегодняшнюю снимает любой сотрудник.
      await tx`alter table workday_checks disable trigger workday_checks_bi`;
      await tx`insert into workday_checks (item_id, day, studio_id) values (${item}, workday_today() - 1, ${s})`;
      await tx`alter table workday_checks enable trigger workday_checks_bi`;
      await as(tx, trainer);
      await tx`delete from workday_checks where item_id = ${item}`;
      await asServer(tx);
      const left = await tx`select (day = workday_today() - 1) as yesterday from workday_checks where item_id = ${item}`;
      expect(left.map((r) => r.yesterday)).toEqual([true]);
    }));

  test("пункт не переезжает в блок другого клуба", () =>
    scenario(async (tx) => {
      const { s2, owner, other, item } = await setup(tx);
      await as(tx, other);
      const [{ id: foreign }] = await tx`
        insert into workday_sections (studio_id, title) values (${s2}, 'Чужой блок') returning id`;
      await asServer(tx);
      await as(tx, owner);
      expect(
        await failure(tx, () => tx`update workday_items set section_id = ${foreign} where id = ${item}`),
      ).toContain("workday_other_studio");
      await asServer(tx);
    }));

  test("порядок одним запросом и копия из другого клуба", () =>
    scenario(async (tx) => {
      const { s, s2, owner, other, admin, sec, item } = await setup(tx);
      await as(tx, owner);
      const [{ id: item2 }] = await tx`
        insert into workday_items (section_id, title, sort_order) values (${sec}, 'Включить музыку', 2) returning id`;
      await tx`select workday_reorder('item', ${[item2, item]}::uuid[])`;
      const order = await tx`select id from workday_items where section_id = ${sec} order by sort_order`;
      expect(order.map((r) => r.id)).toEqual([item2, item]);
      await tx`insert into workday_checks (item_id) values (${item})`;
      await asServer(tx);

      // Владелец другого клуба копирует набор себе — но в чужой клуб не может.
      await tx`insert into user_roles (user_id, studio_id, role) values (${other}, ${s}, 'admin')`;
      await as(tx, other);
      expect(await failure(tx, () => tx`select workday_copy(${s2}, ${s})`)).toContain("workday_forbidden");
      const [{ workday_copy: copied }] = await tx`select workday_copy(${s}, ${s2})`;
      expect(copied).toBe(2);
      const items = await tx`
        select i.title, i.due_time, i.studio_id from workday_items i
          join workday_sections ws on ws.id = i.section_id
         where ws.studio_id = ${s2} order by i.sort_order`;
      expect(items.map((r) => r.title)).toEqual(["Включить музыку", "Включить свет"]);
      expect(items.every((r) => r.studio_id === s2)).toBe(true);
      await asServer(tx);

      // Администратор клуба копировать в свой клуб не может.
      await as(tx, admin);
      expect(await failure(tx, () => tx`select workday_copy(${s2}, ${s})`)).toContain("workday_forbidden");
      await asServer(tx);
    }));

  test("стартовый набор Lady Stretch: Сабуртало и Ваке, повтор не задваивает", () =>
    scenario(async (tx) => {
      const sab = await studio(tx, "Lady Stretch Сабуртало");
      const vake = await studio(tx, "Ваке");
      const sql = readFileSync(
        new URL("./migrations/2026-10-26_workday_checklist.sql", import.meta.url),
        "utf8",
      );
      await tx.unsafe(sql);
      await tx.unsafe(sql);
      const rows = await tx`
        select ws.studio_id, ws.title as section, count(i.id)::int as items,
               bool_or(i.title like 'Открыть дверь в массажный кабинет%') as massage
          from workday_sections ws
          join workday_items i on i.section_id = ws.id
         where ws.studio_id in (${sab}, ${vake})
         group by ws.studio_id, ws.title, ws.sort_order
         order by ws.studio_id = ${sab} desc, ws.sort_order`;
      expect(rows.map((r) => [r.section, r.items, r.massage])).toEqual([
        ["Начало рабочего дня", 11, true],
        ["Рабочий день", 11, false],
        ["Конец рабочего дня", 10, false],
        ["Начало рабочего дня", 11, false],
        ["Рабочий день", 11, false],
        ["Конец рабочего дня", 10, false],
      ]);
      const [report] = await tx`
        select details from workday_items
         where studio_id = ${vake} and title like 'Написать утренний отчет%'`;
      expect(report.details).toContain("Ваке 25.07");
    }));
});
