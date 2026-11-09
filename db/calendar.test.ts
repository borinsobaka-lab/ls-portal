/**
 * Тесты календаря (db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql): личный
 * и общие календари с правами, приглашения и ответы, повторы в поясе
 * события, одно повторение и вся серия, напоминания, чат события, слои.
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

type Occ = {
  id: string;
  occ: string;
  start: string;
  end: string;
  title: string;
  all_day: boolean;
  day_from: string;
  day_to: string;
  my_response: string | null;
  can_edit: boolean;
  recurring: boolean;
  calendar_id: string;
};
type Cal = { id: string; kind: string; name: string; level: string };

describe.skipIf(!url)("календарь (база)", () => {
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
      const [{ id }] =
        await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
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
    const a = await staff(tx, "Анна Организатор");
    const b = await staff(tx, "Борис Участник");
    const c = await staff(tx, "Вера Коллега");
    const d = await staff(tx, "Глеб Посторонний");
    await asServer(tx);
    for (const u of [a, b, c, d]) {
      await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into portal_user_settings (user_id, timezone) values (${u}, 'Europe/Moscow')
               on conflict (user_id) do update set timezone = excluded.timezone`;
    }
    return { a, b, c, d };
  }

  const calendars = async (tx: Tx) => {
    const [{ r }] = await tx`select cal_calendars_list() as r`;
    return r as Cal[];
  };
  const save = async (tx: Tx, id: string | null, p: Record<string, unknown>) => {
    const [{ r }] = await tx`select cal_event_save(${id}, ${p}::jsonb) as r`;
    return r as string;
  };
  const range = async (tx: Tx, from: string, to: string, cals: string[]) => {
    const [{ r }] =
      await tx`select cal_events_range(${from}::timestamptz, ${to}::timestamptz, ${cals}::uuid[]) as r`;
    return r as Occ[];
  };
  const notifs = async (tx: Tx, user: string, kind: string) => {
    await asServer(tx);
    return (await tx`select title, body, url from notif_items where user_id = ${user} and kind = ${kind}
                     order by created_at`) as { title: string; body: string; url: string }[];
  };

  test("личный календарь, приглашение, ответ и права участника", async () => {
    await scenario(async (tx) => {
      const { a, b, d } = await people(tx);
      await as(tx, a);
      const [mine] = await calendars(tx);
      expect(mine).toMatchObject({ kind: "personal", name: "Мой календарь", level: "manage" });
      // Повторный вызов не заводит второй.
      expect((await calendars(tx)).filter((c) => c.kind === "personal")).toHaveLength(1);

      const ev = await save(tx, null, {
        title: "Планёрка",
        starts_at: "2026-11-10T07:00:00Z",
        ends_at: "2026-11-10T08:00:00Z",
        attendees: [b],
        location: "Переговорная",
      });
      const list = await range(tx, "2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z", [mine.id]);
      expect(list.map((x) => [x.title, x.my_response, x.can_edit])).toEqual([
        ["Планёрка", "accepted", true],
      ]);

      // Приглашение — уведомление с временем по Москве.
      const inv = await notifs(tx, b, "cal.invite");
      expect(inv).toHaveLength(1);
      expect(inv[0].title).toBe("Приглашение: Планёрка");
      expect(inv[0].body).toContain("10.11, 10:00–11:00");
      expect(inv[0].url).toBe(`/calendar?event=${ev}`);

      // Участник видит встречу в своём календаре, но не правит её.
      await as(tx, b);
      const [bMine] = await calendars(tx);
      const bl = await range(tx, "2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z", [bMine.id]);
      expect(bl.map((x) => [x.title, x.my_response, x.can_edit])).toEqual([
        ["Планёрка", "pending", false],
      ]);
      expect(await failure(tx, () => save(tx, ev, { title: "Моя" }))).toContain("cal_forbidden");
      const [{ c: cnt }] = await tx`select cal_counters() as c`;
      expect(cnt).toEqual({ invites: 1 });
      await tx`select cal_event_respond(${ev}, 'declined')`;
      // Отказ — встреча уходит из календаря участника.
      expect(await range(tx, "2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z", [bMine.id])).toEqual(
        [],
      );
      const reply = await notifs(tx, a, "cal.reply");
      expect(reply.map((x) => x.title)).toEqual(["Борис Участник не придёт"]);

      // Посторонний не видит ни события, ни чужого личного календаря.
      await as(tx, d);
      expect(await failure(tx, () => tx`select cal_event_get(${ev}, null)`)).toContain(
        "cal_forbidden",
      );
      expect(await range(tx, "2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z", [mine.id])).toEqual(
        [],
      );
      expect(
        await failure(tx, () =>
          save(tx, null, { calendar_id: mine.id, title: "x", starts_at: "2026-11-10T07:00:00Z" }),
        ),
      ).toContain("cal_forbidden");

      // Перенос — уведомление участникам, кроме отказавшихся; убранный — своё.
      await asServer(tx);
      await tx`update cal_attendees set response = 'accepted' where event_id = ${ev} and user_id = ${b}`;
      await as(tx, a);
      await save(tx, ev, { starts_at: "2026-11-10T09:00:00Z", ends_at: "2026-11-10T10:00:00Z" });
      expect((await notifs(tx, b, "cal.change")).map((x) => x.title)).toEqual([
        "Встреча перенесена: Планёрка",
      ]);
      await as(tx, a);
      await save(tx, ev, { attendees: [] });
      const change = await notifs(tx, b, "cal.change");
      expect(change.at(-1)?.title).toBe("Вас убрали из встречи");
      await as(tx, a);
      const [{ e }] = await tx`select cal_event_get(${ev}, null) as e`;
      expect((e as { attendees: { user_id: string }[] }).attendees.map((x) => x.user_id)).toEqual([
        a,
      ]);
    });
  });

  test("общий календарь: компания — с правом, подразделение — руководителю, уровни", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] =
        await tx`insert into org_units (name) values ('Маркетинг') returning id`;
      const [{ id: sub }] =
        await tx`insert into org_units (name, parent_id) values ('SMM', ${unit}) returning id`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${a}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${sub}, ${b}, 'member')`;

      // Всей компании — только с правом calendar.company.
      await as(tx, a);
      expect(
        await failure(
          tx,
          () =>
            tx`select cal_calendar_save(null, ${{ name: "Компания", access: [{ subject: "all" }] }}::jsonb)`,
        ),
      ).toContain("cal_access_forbidden");
      // Своё подразделение (и ниже) — руководитель может.
      const [{ id: cal }] = await tx`select cal_calendar_save(null, ${{
        name: "Акции",
        color: "pink",
        access: [
          { subject: "unit", unit_id: unit, with_subunits: true, level: "view" },
          { subject: "user", user_id: c, level: "edit" },
        ],
      }}::jsonb) as id`;
      await as(tx, b);
      expect(await failure(tx, () => tx`select cal_level(${cal}, ${b})`)).toContain(
        "permission denied",
      );
      const bCals = await calendars(tx);
      expect(bCals.find((x) => x.id === cal)).toMatchObject({ name: "Акции", level: "view" });
      expect(
        await failure(tx, () =>
          save(tx, null, {
            calendar_id: cal,
            title: "Акция",
            starts_at: "2026-11-12T00:00:00Z",
            all_day: true,
          }),
        ),
      ).toContain("cal_forbidden");
      // Редактор добавляет событие на весь день.
      await as(tx, c);
      const ev = await save(tx, null, {
        calendar_id: cal,
        title: "Чёрная пятница",
        all_day: true,
        starts_at: "2026-11-27T10:00:00Z",
        ends_at: "2026-11-29T21:00:00Z",
      });
      expect(await failure(tx, () => tx`select cal_calendar_get(${cal})`)).toBeNull();
      const [{ g }] = await tx`select cal_calendar_get(${cal}) as g`;
      expect((g as { access: unknown }).access).toBeNull();
      await as(tx, b);
      const list = await range(tx, "2026-11-20T00:00:00Z", "2026-12-05T00:00:00Z", [cal]);
      expect(list.map((x) => [x.title, x.all_day, x.day_from, x.day_to, x.can_edit])).toEqual([
        ["Чёрная пятница", true, "2026-11-27", "2026-11-29", false],
      ]);
      // Посторонний не видит календарь.
      await as(tx, d);
      expect((await calendars(tx)).map((x) => x.id)).not.toContain(cal);
      expect(await range(tx, "2026-11-20T00:00:00Z", "2026-12-05T00:00:00Z", [cal])).toEqual([]);
      // С правом — всей компании.
      await asServer(tx);
      await tx`insert into access_user_rights (user_id, portal, rights) values (${d}, true, '{calendar.company}')
               on conflict (user_id) do update set rights = excluded.rights`;
      await as(tx, d);
      const [{ id: comp }] =
        await tx`select cal_calendar_save(null, ${{ name: "Компания", access: [{ subject: "all" }] }}::jsonb) as id`;
      await as(tx, b);
      expect((await calendars(tx)).find((x) => x.id === comp)?.level).toBe("view");
      // Удалить общий может только тот, кто им управляет.
      expect(await failure(tx, () => tx`select cal_calendar_delete(${cal})`)).toContain(
        "cal_forbidden",
      );
      await as(tx, a);
      await tx`select cal_calendar_delete(${cal})`;
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from cal_events where id = ${ev}`;
      expect(n).toBe(0);
    });
  });

  test("повтор по дням недели в поясе события, одно повторение и вся серия", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const [mine] = await calendars(tx);
      // Пн и ср в 10:00 по Москве, с 2 ноября до 30 ноября.
      const ev = await save(tx, null, {
        title: "Летучка",
        starts_at: "2026-11-02T07:00:00Z",
        ends_at: "2026-11-02T07:30:00Z",
        tz: "Europe/Moscow",
        rrule: { freq: "weekly", weekdays: [1, 3], until: "2026-11-30" },
        attendees: [b],
      });
      const all = await range(tx, "2026-11-01T00:00:00Z", "2026-12-15T00:00:00Z", [mine.id]);
      expect(all.map((x) => x.start)).toEqual([
        "2026-11-02T07:00:00+00:00",
        "2026-11-04T07:00:00+00:00",
        "2026-11-09T07:00:00+00:00",
        "2026-11-11T07:00:00+00:00",
        "2026-11-16T07:00:00+00:00",
        "2026-11-18T07:00:00+00:00",
        "2026-11-23T07:00:00+00:00",
        "2026-11-25T07:00:00+00:00",
        "2026-11-30T07:00:00+00:00",
      ]);
      expect(all.every((x) => x.recurring)).toBe(true);

      // Отменить одно повторение.
      await tx`select cal_event_delete(${ev}, '2026-11-04T07:00:00Z')`;
      expect((await notifs(tx, b, "cal.change")).map((x) => x.title)).toEqual([
        "Отменено: Летучка",
      ]);
      await as(tx, a);
      // Перенести одно повторение на час позже.
      const [{ id: one }] = await tx`select cal_event_occurrence_save(${ev}, '2026-11-09T07:00:00Z',
        ${{ starts_at: "2026-11-09T08:00:00Z", ends_at: "2026-11-09T08:30:00Z" }}::jsonb) as id`;
      expect(one).not.toBe(ev);
      const after = await range(tx, "2026-11-01T00:00:00Z", "2026-11-12T00:00:00Z", [mine.id]);
      expect(after.map((x) => [x.id === one, x.start])).toEqual([
        [false, "2026-11-02T07:00:00+00:00"],
        [true, "2026-11-09T08:00:00+00:00"],
        [false, "2026-11-11T07:00:00+00:00"],
      ]);
      // Участник изменённого повторения — тот же.
      await as(tx, b);
      const [bMine] = await calendars(tx);
      const bl = await range(tx, "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z", [bMine.id]);
      expect(bl.map((x) => x.id)).toEqual([one]);
      // Несуществующее повторение не меняется.
      await as(tx, a);
      expect(
        await failure(
          tx,
          () => tx`select cal_event_occurrence_save(${ev}, '2026-11-05T07:00:00Z', '{}'::jsonb)`,
        ),
      ).toContain("cal_occurrence_not_found");

      // Смена времени серии сбрасывает изменённые и отменённые повторения.
      await save(tx, ev, { starts_at: "2026-11-02T08:00:00Z", ends_at: "2026-11-02T08:30:00Z" });
      const reset = await range(tx, "2026-11-01T00:00:00Z", "2026-11-12T00:00:00Z", [mine.id]);
      expect(reset.map((x) => x.start)).toEqual([
        "2026-11-02T08:00:00+00:00",
        "2026-11-04T08:00:00+00:00",
        "2026-11-09T08:00:00+00:00",
        "2026-11-11T08:00:00+00:00",
      ]);
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from cal_events where series_id = ${ev}`;
      expect(n).toBe(0);

      // Ежемесячно 31-го — в коротких месяцах последний день; по будням — без выходных.
      await as(tx, a);
      const monthly = await save(tx, null, {
        title: "Отчёт",
        starts_at: "2027-01-31T06:00:00Z",
        ends_at: "2027-01-31T07:00:00Z",
        rrule: { freq: "monthly" },
      });
      const m = (await range(tx, "2027-01-01T00:00:00Z", "2027-05-01T00:00:00Z", [mine.id])).filter(
        (x) => x.id === monthly,
      );
      expect(m.map((x) => x.start.slice(0, 10))).toEqual([
        "2027-01-31",
        "2027-02-28",
        "2027-03-31",
        "2027-04-30",
      ]);
      const work = await save(tx, null, {
        title: "Созвон",
        starts_at: "2027-03-05T06:00:00Z",
        ends_at: "2027-03-05T06:15:00Z",
        rrule: { freq: "workdays" },
      });
      const w = (await range(tx, "2027-03-05T00:00:00Z", "2027-03-10T00:00:00Z", [mine.id])).filter(
        (x) => x.id === work,
      );
      expect(w.map((x) => x.start.slice(0, 10))).toEqual([
        "2027-03-05",
        "2027-03-08",
        "2027-03-09",
      ]);
      expect(
        await failure(tx, () =>
          save(tx, null, {
            title: "x",
            starts_at: "2027-03-05T06:00:00Z",
            rrule: { freq: "weekly" },
          }),
        ),
      ).toContain("cal_rrule_invalid");
    });
  });

  test("напоминания: один раз, без отказавшихся, весь день — в 9:00", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const ev = await save(tx, null, {
        title: "Встреча",
        starts_at: "2026-11-10T07:00:00Z",
        ends_at: "2026-11-10T08:00:00Z",
        reminders: [15],
        attendees: [b, c],
      });
      await as(tx, c);
      await tx`select cal_event_respond(${ev}, 'declined')`;
      await as(tx, b);
      await tx`select cal_event_my_reminders(${ev}, ${[60, 15]}::jsonb)`;
      await asServer(tx);
      expect((await tx`select cal_tick('2026-11-10T05:59:00Z') as n`)[0].n).toBe(0);
      expect((await tx`select cal_tick('2026-11-10T06:00:30Z') as n`)[0].n).toBe(1); // Борис, за час
      expect((await tx`select cal_tick('2026-11-10T06:46:00Z') as n`)[0].n).toBe(2); // Анна и Борис, за 15 минут
      expect((await tx`select cal_tick('2026-11-10T06:47:00Z') as n`)[0].n).toBe(0);
      expect((await notifs(tx, c, "cal.remind")).length).toBe(0);
      const rb = await notifs(tx, b, "cal.remind");
      // Одна строка ленты на событие: второе напоминание обновляет её (пуш — каждое).
      expect(rb.map((x) => x.title)).toEqual(["Через 15 мин: Встреча"]);
      const [{ pushes }] = await tx`select count(*)::int as pushes from notif_items n
        join portal_push_deliveries pd on pd.notif_id = n.id where n.user_id = ${b} and n.kind = 'cal.remind'`;
      expect(pushes).toBe(0); // устройств нет — доставок нет
      expect(rb[0].url).toBe(`/calendar?event=${ev}&at=2026-11-10T07:00:00Z`);

      // Весь день, «в день события в 9:00» по поясу события.
      await as(tx, a);
      await save(tx, null, {
        title: "Отпуск Бориса",
        all_day: true,
        starts_at: "2026-11-20T00:00:00+03:00",
        reminders: [-540],
      });
      await asServer(tx);
      expect((await tx`select cal_tick('2026-11-20T05:00:00Z') as n`)[0].n).toBe(0);
      expect((await tx`select cal_tick('2026-11-20T06:00:00Z') as n`)[0].n).toBe(1);
      const ra = await notifs(tx, a, "cal.remind");
      // Строки одной транзакции — с одним временем: порядок не гарантирован.
      expect(ra.map((r) => r.body)).toContain("20.11, весь день");
    });
  });

  test("чат события: только участникам, состав — участники, удаление уносит чат", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const ev = await save(tx, null, {
        title: "Созвон с партнёрами",
        starts_at: "2026-11-10T07:00:00Z",
        ends_at: "2026-11-10T08:00:00Z",
        video: true,
        attendees: [b],
      });
      await as(tx, d);
      expect(await failure(tx, () => tx`select cal_event_chat_open(${ev})`)).toContain("cal_");
      await as(tx, b);
      const [{ id: chat }] = await tx`select cal_event_chat_open(${ev}) as id`;
      const [{ id: again }] = await tx`select cal_event_chat_open(${ev}) as id`;
      expect(again).toBe(chat);
      await asServer(tx);
      const members = async () =>
        (
          (await tx`select user_id from chat_members where chat_id = ${chat} order by user_id`) as {
            user_id: string;
          }[]
        )
          .map((x) => x.user_id)
          .sort();
      expect(await members()).toEqual([a, b].sort());
      const [{ kind }] = await tx`select kind from chat_chats where id = ${chat}`;
      expect(kind).toBe("event");
      await as(tx, a);
      await save(tx, ev, { attendees: [c] });
      await asServer(tx);
      expect(await members()).toEqual([a, c].sort());
      // Звонок в чате события.
      await as(tx, a);
      const [{ r }] = await tx`select chat_call_start(${chat}) as r`;
      expect((r as { needs_room: boolean }).needs_room).toBe(true);
      await tx`select cal_event_delete(${ev}, null)`;
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from chat_chats where id = ${chat}`;
      expect(n).toBe(0);
    });
  });

  test("слои: сроки моих задач, дни рождения и отсутствия коллег", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел') returning id`;
      await tx`insert into org_unit_members (unit_id, user_id) values (${unit}, ${a}), (${unit}, ${b})`;
      await tx`insert into people_birthdays (user_id, birth_date) values (${b}, '1990-11-15'), (${d}, '1990-11-16')`;
      await tx`insert into people_absences (user_id, kind, starts_on, ends_on) values (${b}, 'vacation', '2026-11-12', '2026-11-20'),
               (${d}, 'sick', '2026-11-12', '2026-11-13')`;
      await as(tx, c);
      await tx`select task_create(${{ title: "Отчёт", assignees: [a], deadline: "2026-11-14T15:00:00Z" }}::jsonb)`;
      await tx`select task_create(${{ title: "Чужая", assignees: [c], deadline: "2026-11-14T15:00:00Z" }}::jsonb)`;
      await as(tx, a);
      const [{ o }] =
        await tx`select cal_overlays('2026-11-09T00:00:00Z', '2026-11-23T00:00:00Z') as o`;
      const ov = o as {
        tasks: { title: string }[];
        birthdays: { user_id: string; day: string }[];
        absences: { user_id: string; kind: string }[];
      };
      expect(ov.tasks.map((x) => x.title)).toEqual(["Отчёт"]);
      expect(ov.birthdays).toEqual([{ user_id: b, day: "2026-11-15" }]);
      expect(ov.absences.map((x) => [x.user_id, x.kind])).toEqual([[b, "vacation"]]);
    });
  });
});
