/**
 * Тесты дней рождения и отсутствий
 * (db/migrations/2026-11-08_zzzzzzzz_people_birthdays_absences.sql): кто
 * правит, год виден только с разрешения, ближайшие дни рождения (и 29
 * февраля), отсутствия за период, поздравление коллегам по подразделению
 * один раз.
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

type Brief = { id: string; number: number; title: string; status: string; assignee_id: string | null };
type TaskJson = {
  id: string;
  number: number;
  title: string;
  status: string;
  urgent: boolean;
  my_roles: string[];
  parent_id: string | null;
  parent_number: number | null;
  subtasks_total: number;
  subtasks_done: number;
  result_required: boolean;
  has_result: boolean;
  result?: { text: string; by: string; at: string } | null;
  parent?: (Brief & { hidden?: boolean }) | { number: number; hidden: true } | null;
  subtasks?: Brief[];
  source?: { chat_id: string; seq: number } | null;
};

describe.skipIf(!url)("дни рождения и отсутствия (база)", () => {
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

  let studio: string | null = null;
  async function staff(tx: Tx, name: string): Promise<string> {
    if (!studio) {
      const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
      studio = id;
    }
    await tx`set local session_replication_role = replica`;
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studio}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studio}, ${name}, 'x@example.com')
             on conflict (id) do update set full_name = excluded.full_name`;
    return id as string;
  }

  async function as(tx: Tx, userId: string) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function people(tx: Tx) {
    studio = null;
    const a = await staff(tx, "Анна Постановщик");
    const b = await staff(tx, "Борис Исполнитель");
    const c = await staff(tx, "Вера Соисполнитель");
    const d = await staff(tx, "Глеб Посторонний");
    return { a, b, c, d };
  }

  const create = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ r }] = await tx`select task_create(${p}::jsonb) as r`;
    return r as { tasks: { id: string; number: number }[]; batch_id: string | null };
  };
  const get = async (tx: Tx, n: number) => {
    const [{ r }] = await tx`select task_get(${n}) as r`;
    return r as TaskJson;
  };
  const list = async (tx: Tx, p: Record<string, unknown> = {}) => {
    const [{ r }] = await tx`select task_list(${p}::jsonb) as r`;
    return (r as { rows: TaskJson[] }).rows;
  };

  test("день рождения: правит сам или руководитель, год — с разрешения", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел') returning id`;
      for (const u of [a, b, c]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${a}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${b}, 'member')`;

      await as(tx, b);
      await tx`select people_birthday_save(${b}, '1990-03-15', false)`;
      expect(await failure(tx, () => tx`select people_birthday_save(${b}, '2099-01-01', false)`)).toContain(
        "people_birthday_invalid",
      );
      await as(tx, c);
      expect(await failure(tx, () => tx`select people_birthday_save(${b}, '1991-01-01', false)`)).toContain(
        "people_forbidden",
      );
      const [{ g }] = await tx`select people_birthday_get(${b}) as g`;
      expect(g).toEqual({ day: "03-15", year: null, show_year: false, can_edit: false });
      // Руководитель подразделения правит и видит год.
      await as(tx, a);
      const [{ g: ga }] = await tx`select people_birthday_get(${b}) as g`;
      expect(ga).toMatchObject({ year: 1990, can_edit: true });
    });
  });

  test("ближайшие дни рождения и 29 февраля", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await asServer(tx);
      const [{ d }] = await tx`select people_next_birthday('1996-02-29', '2027-02-10') as d`;
      expect(String(d instanceof Date ? d.toISOString().slice(0, 10) : d)).toBe("2027-02-28");
      // Дни рождения: завтра и через 40 дней.
      await tx`insert into people_birthdays (user_id, birth_date, show_year)
               values (${b}, (current_date + 1) - interval '30 years', true),
                      (${c}, (current_date + 40) - interval '25 years', false)`;
      await as(tx, a);
      const [{ l }] = await tx`select people_birthdays_upcoming(30) as l`;
      const list = l as { user_id: string; age: number | null }[];
      expect(list.map((x) => x.user_id)).toEqual([b]);
      expect(list[0].age).toBe(30);
      const [{ l: l60 }] = await tx`select people_birthdays_upcoming(60) as l`;
      expect((l60 as { user_id: string; age: number | null }[]).find((x) => x.user_id === c)?.age).toBeNull();
    });
  });

  test("отсутствия: свои и сотрудника, заметка — только тем, кто правит", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, b);
      const [{ id }] = await tx`select people_absence_save(null, ${b}, 'vacation', '2026-11-10', '2026-11-20', 'Сочи') as id`;
      expect(
        await failure(tx, () => tx`select people_absence_save(null, ${b}, 'vacation', '2026-11-20', '2026-11-10')`),
      ).toContain("people_absence_invalid");
      await as(tx, c);
      expect(
        await failure(tx, () => tx`select people_absence_save(null, ${b}, 'sick', '2026-11-01', '2026-11-02')`),
      ).toContain("people_forbidden");
      expect(await failure(tx, () => tx`select people_absence_delete(${id})`)).toContain("people_forbidden");
      const [{ l }] = await tx`select people_absences_list('2026-11-15', '2026-11-30') as l`;
      expect(l).toEqual([
        { id, user_id: b, kind: "vacation", starts_on: "2026-11-10", ends_on: "2026-11-20", note: null, can_edit: false },
      ]);
      const [{ l: before }] = await tx`select people_absences_list('2026-10-01', '2026-11-09') as l`;
      expect(before).toEqual([]);
      void a;
    });
  });

  test("поздравление коллегам по подразделению — один раз, с 9:00 их пояса", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел') returning id`;
      for (const u of [a, b, c]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id) values (${unit}, ${a}), (${unit}, ${b})`;
      await tx`insert into people_birthdays (user_id, birth_date) values (${b}, '1990-11-12')`;
      // 12 ноября, 08:30 по Москве — рано; 09:05 — пора.
      const [{ n: early }] = await tx`select people_birthday_tick('2026-11-12T05:30:00Z') as n`;
      expect(early).toBe(0);
      const [{ n }] = await tx`select people_birthday_tick('2026-11-12T06:05:00Z') as n`;
      expect(n).toBe(1);
      const [{ n: again }] = await tx`select people_birthday_tick('2026-11-12T07:00:00Z') as n`;
      expect(again).toBe(0);
      const notes = await tx`select user_id, kind from notif_items where kind = 'company.birthday'`;
      expect(notes.map((x: { user_id: string }) => x.user_id)).toEqual([a]);
    });
  });
});
