/**
 * Тесты устройств и активности клиентского приложения в базе
 * (db/migrations/2026-10-15_zzzzz_client_app_activity.sql): app_ping
 * (открытия, разделы, проверки), сводка карточки client_app_overview (кто
 * видит, приложение формата клуба, уведомления и действия), уборка при
 * удалении последней карточки, «последний раз в приложении» и цель в
 * «Клиентах» (db/migrations/2026-10-18_zzzzzzz_clients_goal_app_seen.sql).
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

const P256DH = "B" + "A".repeat(86);
const AUTH = "A".repeat(22);

type Overview = {
  has_account: boolean;
  app_format: string;
  is_staff?: boolean;
  account?: { created_at: string; last_sign_in_at: string | null; privacy_accepted_at: string | null };
  latest_app_version?: string | null;
  devices?: Array<Record<string, unknown>>;
  activity?: {
    first_day: string | null;
    days: Array<{ day: string; sessions: number }>;
    screens_30d: Record<string, number>;
    memberships_last_day: string | null;
  };
  push?: Record<string, number | string | null>;
  actions?: Record<string, unknown>;
};

describe.skipIf(!url)("устройства и активность приложения (база)", () => {
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
    opts: { app?: boolean; userId?: string } = {},
  ): Promise<{ client: string; user: string | null }> {
    const email = `c-${crypto.randomUUID()}@example.com`;
    const userId = opts.userId ?? (opts.app === false ? null : await user(tx, email));
    const [{ id }] = await tx`
      insert into clients (studio_id, full_name, email, user_id)
      values (${studioId}, 'Клиент', ${email}, ${userId}) returning id`;
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

  const DEVICE = {
    platform: "ios",
    os_name: "iOS",
    os_version: "18.6",
    device_model: "iPhone 15",
    browser: "Safari",
    app_version: "1.9",
    standalone: true,
    push_permission: "granted",
    push_subscribed: true,
    locale: "ru",
    device_language: "ru-RU",
    timezone: "Asia/Tbilisi",
    screen: "393×852@3",
    dark_mode: false,
    user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)",
  };

  async function ping(
    tx: Tx,
    userId: string,
    opts: {
      device?: string;
      format?: string;
      info?: Record<string, unknown>;
      screens?: Record<string, unknown>;
    } = {},
  ) {
    await as(tx, userId);
    await tx`select app_ping(${opts.device ?? "device-0001"}, ${opts.format ?? "packages"},
                             ${opts.info ?? DEVICE}::jsonb, ${opts.screens ?? {}}::jsonb)`;
    await asServer(tx);
  }

  async function overview(tx: Tx, as_: string, clientId: string): Promise<Overview> {
    await as(tx, as_);
    const [{ v }] = await tx`select client_app_overview(${clientId}) as v`;
    await asServer(tx);
    return v as Overview;
  }

  /** Сдвинуть «последний раз в приложении» устройства в прошлое на n минут. */
  async function idle(tx: Tx, userId: string, minutes: number) {
    await tx`
      update app_devices set last_seen_at = last_seen_at - make_interval(mins => ${minutes})
       where user_id = ${userId}`;
  }

  test("пинг: открытия после 30 минут простоя, разделы складываются, мусор отбрасывается", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const c = await client(tx, s);

      await ping(tx, c.user!, { screens: { home: 2, schedule: 1 } });
      let [dev] = await tx`select sessions_count, os_version, push_permission, standalone
                             from app_devices where user_id = ${c.user}`;
      expect(dev).toEqual({ sessions_count: 1, os_version: "18.6", push_permission: "granted", standalone: true });
      let [day] = await tx`select sessions, screens from app_activity_days where user_id = ${c.user}`;
      expect(day).toEqual({ sessions: 1, screens: { home: 2, schedule: 1 } });

      // Через 10 минут — то же открытие; разделы прибавились; новое разрешение.
      await idle(tx, c.user!, 10);
      await ping(tx, c.user!, {
        info: { ...DEVICE, push_permission: "denied", os_version: "" },
        screens: { home: 1, memberships: 2, "Bad Key": 5, profile: -1, news: "3", club: 5000 },
      });
      [dev] = await tx`select sessions_count, os_version, push_permission from app_devices where user_id = ${c.user}`;
      // Пустое поле не стирает известное.
      expect(dev).toEqual({ sessions_count: 1, os_version: "18.6", push_permission: "denied" });
      [day] = await tx`select sessions, screens from app_activity_days where user_id = ${c.user}`;
      expect(day).toEqual({ sessions: 1, screens: { home: 3, schedule: 1, memberships: 2, club: 1000 } });

      // Через 31 минуту без активности — новое открытие.
      await idle(tx, c.user!, 31);
      await ping(tx, c.user!);
      [dev] = await tx`select sessions_count from app_devices where user_id = ${c.user}`;
      expect(dev.sessions_count).toBe(2);
      [day] = await tx`select sessions from app_activity_days where user_id = ${c.user}`;
      expect(day.sessions).toBe(2);
    });
  });

  test("пинг: только вошедший, проверка id и приложения, таблицы напрямую закрыты, до 10 устройств", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const c = await client(tx, s);

      await tx`set local role anon`;
      expect(
        await failure(tx, () => tx`select app_ping('device-0001', 'packages', '{}'::jsonb, '{}'::jsonb)`),
      ).toBeTruthy();
      await asServer(tx);

      await as(tx, c.user!);
      expect(await failure(tx, () => tx`select app_ping('x', 'packages', '{}'::jsonb, '{}'::jsonb)`)).toContain(
        "Неверный id устройства",
      );
      expect(
        await failure(tx, () => tx`select app_ping('device-0001', 'other', '{}'::jsonb, '{}'::jsonb)`),
      ).toContain("Неизвестное приложение");
      expect(await failure(tx, () => tx`select * from app_devices`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from app_activity_days`)).toContain("permission denied");
      // Неизвестные значения перечислений — пусто, а не ошибка.
      await tx`select app_ping('device-0001', 'packages',
                               '{"platform": "windows", "push_permission": "maybe", "locale": "de", "standalone": "yes"}'::jsonb,
                               '[1, 2]'::jsonb)`;
      await asServer(tx);
      const [dev] = await tx`select platform, push_permission, locale, standalone from app_devices where user_id = ${c.user}`;
      expect(dev).toEqual({ platform: null, push_permission: null, locale: null, standalone: null });

      for (let i = 0; i < 12; i++) {
        await idle(tx, c.user!, 1);
        await ping(tx, c.user!, { device: `device-${String(i).padStart(4, "x")}` });
      }
      const [{ count }] = await tx`select count(*)::int as count from app_devices where user_id = ${c.user}`;
      expect(count).toBe(10);
    });
  });

  test("сводка: только сотрудник сети клуба карточки, приложение формата клуба", async () => {
    await scenario(async (tx) => {
      const pack = await studio(tx, "packages");
      const sub = await studio(tx, "subscription");
      const c = await client(tx, pack);
      // Тот же человек — клиент и подписочного клуба (своё приложение).
      const c2 = await client(tx, sub, { userId: c.user! });
      const admin = await staff(tx, pack);
      const subAdmin = await staff(tx, sub);
      // Сотрудник другого подписочного клуба — чужой; другого пакетного — свой:
      // база клиентов пакетных клубов общая (2026-10-17).
      const stranger = await staff(tx, await studio(tx, "subscription"));
      const networkAdmin = await staff(tx, await studio(tx, "packages"));
      const noApp = await client(tx, pack, { app: false });

      await ping(tx, c.user!, { device: "phone-pack", screens: { memberships: 1 } });
      await ping(tx, c.user!, { device: "phone-sub", format: "subscription", info: { ...DEVICE, app_version: "1.10" } });

      await as(tx, stranger);
      expect(await failure(tx, () => tx`select client_app_overview(${c.client})`)).toContain(
        "Нет доступа",
      );
      // Клиент свою сводку не читает — это инструмент сотрудников.
      await as(tx, c.user!);
      expect(await failure(tx, () => tx`select client_app_overview(${c.client})`)).toContain(
        "Нет доступа",
      );
      await asServer(tx);

      const o = await overview(tx, admin, c.client);
      expect(o.has_account).toBe(true);
      expect(o.app_format).toBe("packages");
      expect(o.devices?.map((d) => d.device_id)).toEqual(["phone-pack"]);
      expect(o.devices?.[0].device_model).toBe("iPhone 15");
      expect(o.activity?.screens_30d).toEqual({ memberships: 1 });
      expect(o.activity?.memberships_last_day).toBeTruthy();
      expect(o.activity?.days).toHaveLength(1);
      // Самая новая версия — по числам, а не по строке («1.10» новее «1.9»).
      expect(o.latest_app_version).toBe("1.10");

      const o2 = await overview(tx, subAdmin, c2.client);
      expect(o2.devices?.map((d) => d.device_id)).toEqual(["phone-sub"]);
      expect(o2.activity?.screens_30d).toEqual({});
      // Подписочную карточку того же человека сотрудник пакетной сети не видит.
      expect(await failure(tx, () => overview(tx, networkAdmin, c2.client))).toContain("Нет доступа");
      await asServer(tx);
      expect((await overview(tx, networkAdmin, c.client)).devices?.map((d) => d.device_id)).toEqual([
        "phone-pack",
      ]);

      expect(await overview(tx, admin, noApp.client)).toEqual({ has_account: false, app_format: "packages" });
    });
  });

  test("сводка: уведомления и действия за 30 дней", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const c = await client(tx, s);
      const admin = await staff(tx, s);

      await as(tx, c.user!);
      await tx`select register_push_subscription(${`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`},
                                                 ${P256DH}, ${AUTH}, 'ru', 'packages', 'test')`;
      await asServer(tx);
      const [{ id: sub }] = await tx`select id from push_subscriptions where user_id = ${c.user}`;
      const [{ id: n1 }] = await tx`
        insert into push_notifications (title, message, studio_ids, segments, status)
        values ('А', 'Б', array[${s}]::uuid[], array['all'], 'draft') returning id`;
      const [{ id: n2 }] = await tx`
        insert into push_notifications (title, message, studio_ids, segments, status)
        values ('В', 'Г', array[${s}]::uuid[], array['all'], 'draft') returning id`;
      await tx`insert into push_recipients (notification_id, user_id, read_at) values (${n1}, ${c.user}, now())`;
      await tx`insert into push_recipients (notification_id, user_id) values (${n2}, ${c.user})`;
      await tx`
        insert into push_deliveries (notification_id, subscription_id, user_id, status, sent_at, delivered_at, clicked_at)
        values (${n1}, ${sub}, ${c.user}, 'sent', now(), now(), now()),
               (${n2}, ${sub}, ${c.user}, 'sent', now(), null, null)`;

      // Записи: одну сделал сам клиент, одну — администратор.
      await tx`set local session_replication_role = replica`;
      const [{ id: w }] = await tx`insert into workouts (studio_id, name) values (${s}, 'Стретчинг') returning id`;
      const [{ id: e }] = await tx`
        insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
        values (${s}, ${w}, 'group', now() + interval '1 day', now() + interval '25 hours') returning id`;
      const [{ id: e2 }] = await tx`
        insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
        values (${s}, ${w}, 'group', now() + interval '2 days', now() + interval '49 hours') returning id`;
      await tx`
        insert into schedule_bookings (studio_id, entry_id, user_id, client_id, status, booked_by, booked_at)
        values (${s}, ${e}, ${c.user}, ${c.client}, 'booked', ${c.user}, now()),
               (${s}, ${e2}, ${c.user}, ${c.client}, 'booked', ${admin}, now())`;
      await tx`set local session_replication_role = origin`;

      const o = await overview(tx, admin, c.client);
      expect(o.push).toMatchObject({
        subscriptions: 1,
        received_30d: 2,
        read_30d: 1,
        sent_30d: 2,
        delivered_30d: 1,
        clicked_30d: 1,
      });
      expect(o.actions).toMatchObject({ bookings_self_30d: 1, bookings_staff_30d: 1, purchases_app: 0 });
      expect(o.devices).toEqual([]);
    });
  });

  test("фильтры «Клиентов»: последний раз в приложении формата клуба и цель из анкеты", async () => {
    await scenario(async (tx) => {
      const pack = await studio(tx, "packages");
      const sub = await studio(tx, "subscription");
      const c = await client(tx, pack);
      const c2 = await client(tx, sub, { userId: c.user! });
      const networkAdmin = await staff(tx, await studio(tx, "packages"));
      const stranger = await staff(tx, await studio(tx, "subscription"));

      const seen = async (id: string) =>
        (await tx`select app_last_seen_at = now() as now_, app_last_seen_at from clients where id = ${id}`)[0];

      // Пакетное приложение — только карточка пакетного клуба.
      await ping(tx, c.user!);
      expect((await seen(c.client)).now_).toBe(true);
      expect((await seen(c2.client)).app_last_seen_at).toBeNull();

      // Пинг каждые 5 минут карточку не трогает — только через 15 минут или
      // в новый день (по Тбилиси).
      await tx`update clients set app_last_seen_at = now() - interval '10 minutes' where id = ${c.client}`;
      await ping(tx, c.user!);
      const [{ moved }] = await tx`
        select ((now() - interval '10 minutes') at time zone 'Asia/Tbilisi')::date
               <> (now() at time zone 'Asia/Tbilisi')::date as moved`;
      expect((await seen(c.client)).now_).toBe(moved);
      await tx`update clients set app_last_seen_at = now() - interval '20 minutes' where id = ${c.client}`;
      await ping(tx, c.user!);
      expect((await seen(c.client)).now_).toBe(true);

      // Подписочное приложение — своя карточка.
      await ping(tx, c.user!, { device: "phone-sub", format: "subscription" });
      expect((await seen(c2.client)).now_).toBe(true);

      // Из админки и приложения колонку не подделать.
      await as(tx, networkAdmin);
      await tx`update clients set app_last_seen_at = '2020-01-01', notes = 'x' where id = ${c.client}`;
      await as(tx, c.user!);
      await tx`update clients set app_last_seen_at = '2020-01-01' where id = ${c.client}`;
      await asServer(tx);
      expect((await seen(c.client)).now_).toBe(true);

      // Цель — из анкеты приложения, видна сотрудникам сети карточки.
      await tx`insert into member_profiles (user_id, primary_goal) values (${c.user}, 'flexibility')`;
      await as(tx, networkAdmin);
      const rows = await tx`select primary_goal, app_last_seen_at is not null as seen
                              from clients_with_status where id = ${c.client}`;
      expect(rows).toEqual([{ primary_goal: "flexibility", seen: true }]);
      await as(tx, stranger);
      expect((await tx`select 1 from clients_with_status where id = ${c.client}`).length).toBe(0);
      expect((await tx`select 1 from member_profiles where user_id = ${c.user}`).length).toBe(0);
      await asServer(tx);
    });
  });

  test("удалена последняя карточка — устройства и активность уходят", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      // Вторая карточка того же человека — в клубе другого формата: в пакетных
      // клубах карточка на человека одна (2026-10-17).
      const b = await studio(tx, "subscription");
      const c = await client(tx, a);
      const c2 = await client(tx, b, { userId: c.user! });
      await ping(tx, c.user!, { screens: { home: 1 } });

      // Учётная запись остаётся (у сотрудника) — проверяем саму уборку.
      await tx`insert into user_roles (user_id, studio_id, role) values (${c.user}, ${b}, 'trainer')`;

      await tx`delete from clients where id = ${c.client}`;
      expect((await tx`select 1 from app_devices where user_id = ${c.user}`).length).toBe(1);
      await tx`delete from clients where id = ${c2.client}`;
      expect((await tx`select 1 from app_devices where user_id = ${c.user}`).length).toBe(0);
      expect((await tx`select 1 from app_activity_days where user_id = ${c.user}`).length).toBe(0);
    });
  });
});
