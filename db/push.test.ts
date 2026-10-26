/**
 * Тесты рассылки пуш-уведомлений в базе (db/migrations/2026-10-15_push_delivery.sql):
 * подписки устройств, защита статусов от админки, выборка получателей,
 * очередь доставки, подтверждения с устройства, лента клиента.
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

describe.skipIf(!url)("пуш-уведомления (база)", () => {
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

  /** Карточка клиента с учётной записью приложения; active — с действующим абонементом (ЧК). */
  async function client(
    tx: Tx,
    studioId: string,
    opts: { active?: boolean; app?: boolean } = {},
  ): Promise<{ client: string; user: string | null }> {
    const email = `c-${crypto.randomUUID()}@example.com`;
    const userId = opts.app === false ? null : await user(tx, email);
    const [{ id }] = await tx`
      insert into clients (studio_id, full_name, email, user_id)
      values (${studioId}, 'Клиент', ${email}, ${userId}) returning id`;
    if (opts.active) {
      const [{ id: m }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
        values (${studioId}, 'Пакет', 'package', 8, 30, 100) returning id`;
      await tx`
        insert into client_memberships (studio_id, client_id, membership_id, status, ends_at)
        values (${studioId}, ${id}, ${m}, 'active', current_date + 10)`;
    }
    return { client: id as string, user: userId };
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }

  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function staff(tx: Tx, studioId: string): Promise<string> {
    const id = await user(tx, `staff-${crypto.randomUUID()}@example.com`);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin')`;
    return id;
  }

  async function subscribe(
    tx: Tx,
    userId: string,
    endpoint: string,
    locale = "ru",
    format: "packages" | "subscription" = "packages",
  ) {
    await as(tx, userId);
    await tx`select register_push_subscription(${endpoint}, ${P256DH}, ${AUTH}, ${locale}, ${format}, 'test')`;
    await asServer(tx);
  }

  /** Массив для параметра запроса (Bun SQL передаёт его строкой). */
  const arr = (xs: string[]) => `{${xs.join(",")}}`;

  const fcm = () => `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;

  async function scheduled(
    tx: Tx,
    studioIds: string[],
    segments: string[] = ["all"],
    when = "now() - interval '1 minute'",
  ): Promise<string> {
    const [{ id }] = await tx.unsafe(
      `insert into push_notifications (title, message, studio_ids, segments, status, scheduled_at)
       values ('Привет', 'Текст', $1::uuid[], $2::text[], 'scheduled', ${when}) returning id`,
      [arr(studioIds), arr(segments)],
    );
    return id as string;
  }

  test("подписка: только известные службы, устройство переходит к вошедшему, не больше 10", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await client(tx, s);
      const b = await client(tx, s);
      const endpoint = fcm();

      await as(tx, a.user!);
      expect(
        await failure(
          tx,
          () => tx`select register_push_subscription('https://evil.example.com/x', ${P256DH}, ${AUTH}, 'ru')`,
        ),
      ).toContain("Неизвестная служба");
      expect(
        await failure(
          tx,
          () =>
            tx`select register_push_subscription('https://fcm.googleapis.com.evil.com/x', ${P256DH}, ${AUTH}, 'ru')`,
        ),
      ).toContain("Неизвестная служба");
      expect(
        await failure(tx, () => tx`select register_push_subscription(${endpoint}, 'x', ${AUTH}, 'ru')`),
      ).toContain("Неверные ключи");
      // Таблицу напрямую клиент не читает и не пишет.
      expect(await failure(tx, () => tx`select * from push_subscriptions`)).toContain(
        "permission denied",
      );

      await tx`select register_push_subscription(${endpoint}, ${P256DH}, ${AUTH}, 'ka', 'packages', 'ua')`;
      await asServer(tx);
      let [row] = await tx`select user_id, locale from push_subscriptions where endpoint = ${endpoint}`;
      expect(row).toEqual({ user_id: a.user, locale: "ka" });

      // На том же телефоне вошёл другой клиент — устройство теперь его.
      await subscribe(tx, b.user!, endpoint, "xx");
      [row] = await tx`select user_id, locale from push_subscriptions where endpoint = ${endpoint}`;
      expect(row).toEqual({ user_id: b.user, locale: "en" });

      for (let i = 0; i < 12; i++) await subscribe(tx, a.user!, fcm());
      const [{ count }] = await tx`select count(*)::int as count from push_subscriptions where user_id = ${a.user}`;
      expect(count).toBe(10);

      // Выход: чужое устройство отписать нельзя, своё — да.
      await as(tx, a.user!);
      await tx`select unregister_push_subscription(${endpoint})`;
      await as(tx, b.user!);
      await asServer(tx);
      expect(
        (await tx`select 1 from push_subscriptions where endpoint = ${endpoint}`).length,
      ).toBe(1);
      await as(tx, b.user!);
      await tx`select unregister_push_subscription(${endpoint})`;
      await asServer(tx);
      expect(
        (await tx`select 1 from push_subscriptions where endpoint = ${endpoint}`).length,
      ).toBe(0);
    });
  });

  test("админка: только черновик или запланированное, счётчики не пишутся, отправленное не правится", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      await as(tx, admin);

      expect(
        await failure(
          tx,
          () => tx`insert into push_notifications (title, studio_ids, status) values ('A', ${arr([s])}::uuid[], 'sent')`,
        ),
      ).toContain("черновиком или запланированным");

      const [n] = await tx`
        insert into push_notifications (title, studio_ids, status, sent_count, read_count)
        values ('A', ${arr([s])}::uuid[], 'scheduled', 500, 7)
        returning id, sent_count, read_count, scheduled_at`;
      expect(n.sent_count).toBe(0);
      expect(n.read_count).toBe(0);
      // Запланировано без времени — на сейчас.
      expect(n.scheduled_at).not.toBeNull();

      expect(
        await failure(tx, () => tx`update push_notifications set status = 'sending' where id = ${n.id}`),
      ).toContain("сохраните уведомление запланированным");

      await asServer(tx);
      await tx`select push_start_due()`;
      await as(tx, admin);
      expect(
        await failure(tx, () => tx`update push_notifications set title = 'B' where id = ${n.id}`),
      ).toContain("уже отправлено");
      // Отправленное можно удалить.
      const deleted = await tx`delete from push_notifications where id = ${n.id} returning id`;
      expect(deleted.length).toBe(1);
    });
  });

  test("рассылка: выборка по клубам и сегментам, очередь, итог, подтверждения, лента", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const s2 = await studio(tx);
      const other = await studio(tx);
      const member = await client(tx, s1, { active: true }); // ЧК
      const potential = await client(tx, s2); // ПЧК
      await client(tx, s1, { app: false }); // без приложения
      const outsider = await client(tx, other, { active: true }); // чужой клуб

      const e1 = fcm();
      const e2 = "https://web.push.apple.com/QK";
      const e3 = fcm();
      await subscribe(tx, member.user!, e1, "ru");
      await subscribe(tx, member.user!, e2, "en");
      await subscribe(tx, potential.user!, e3, "ka");
      await subscribe(tx, outsider.user!, fcm());

      const all = await scheduled(tx, [s1, s2]);
      const onlyChk = await scheduled(tx, [s1, s2], ["chk"]);
      const future = await scheduled(tx, [s1], ["all"], "now() + interval '1 hour'");

      const [{ push_start_due: started }] = await tx`select push_start_due()`;
      expect(started).toBe(2);
      const rows = await tx`
        select id, status, recipients_count, devices_count from push_notifications
         where id in (${all}, ${onlyChk}, ${future}) order by recipients_count desc, status`;
      expect(rows).toEqual([
        { id: all, status: "sending", recipients_count: 2, devices_count: 3 },
        { id: onlyChk, status: "sending", recipients_count: 1, devices_count: 2 },
        { id: future, status: "scheduled", recipients_count: 0, devices_count: 0 },
      ]);
      // Повторный запуск ничего не начинает заново.
      expect((await tx`select push_start_due()`)[0].push_start_due).toBe(0);

      const batch = await tx`select * from push_claim_deliveries(100)`;
      expect(batch.length).toBe(5);
      expect(new Set(batch.map((b: { locale: string }) => b.locale))).toEqual(
        new Set(["ru", "en", "ka"]),
      );
      // Уже забранное второй сервер не получит.
      expect((await tx`select * from push_claim_deliveries(100)`).length).toBe(0);

      const of = (n: string, endpoint: string) =>
        batch.find(
          (b: { notification_id: string; endpoint: string }) =>
            b.notification_id === n && b.endpoint === endpoint,
        ).delivery_id as string;
      const results = [
        { id: of(all, e1), result: "sent" },
        { id: of(all, e2), result: "retry", error: "429" },
        { id: of(all, e3), result: "gone", error: "410" },
        { id: of(onlyChk, e1), result: "sent" },
        { id: of(onlyChk, e2), result: "failed", error: "400" },
      ];
      await tx`select push_finish_deliveries(${JSON.stringify(results)}::text::jsonb)`;

      // Устройства e3 больше нет; повтор e2 — снова в очереди.
      expect((await tx`select 1 from push_subscriptions where endpoint = ${e3}`).length).toBe(0);
      let [n1] = await tx`select status, sent_count, failed_count from push_notifications where id = ${all}`;
      expect(n1).toEqual({ status: "sending", sent_count: 1, failed_count: 1 });
      const [n2] = await tx`
        select status, sent_count, failed_count, finished_at is not null as finished
          from push_notifications where id = ${onlyChk}`;
      expect(n2).toEqual({ status: "sent", sent_count: 1, failed_count: 1, finished: true });

      const retry = await tx`select * from push_claim_deliveries(100)`;
      expect(retry.map((b: { endpoint: string }) => b.endpoint)).toEqual([e2]);
      await tx`select push_finish_deliveries(${JSON.stringify([{ id: retry[0].delivery_id, result: "sent" }])}::text::jsonb)`;
      [n1] = await tx`select status, sent_count, failed_count from push_notifications where id = ${all}`;
      expect(n1).toEqual({ status: "sent", sent_count: 2, failed_count: 1 });

      // Устройство показало пуш (дважды — считается один раз), потом нажали.
      const d = of(all, e1);
      await tx`set local role anon`;
      await tx`select push_delivery_ack(${d}, 'delivered')`;
      await tx`select push_delivery_ack(${d}, 'delivered')`;
      await tx`select push_delivery_ack(${d}, 'clicked')`;
      await tx`select push_delivery_ack(${d}, 'clicked')`;
      await tx`select push_delivery_ack(${crypto.randomUUID()}, 'clicked')`;
      await asServer(tx);
      [n1] = await tx`select delivered_count, read_count from push_notifications where id = ${all}`;
      expect(n1).toEqual({ delivered_count: 1, read_count: 1 });

      // Лента клиента: оба уведомления, прочитано — нажатое.
      await as(tx, member.user!);
      let inbox = await tx`select notification_id, read_at is not null as read from my_push_inbox(50)`;
      expect(inbox.length).toBe(2);
      expect(inbox.find((r: { notification_id: string }) => r.notification_id === all).read).toBe(true);
      expect(inbox.find((r: { notification_id: string }) => r.notification_id === onlyChk).read).toBe(
        false,
      );
      expect((await tx`select push_mark_read(null)`)[0].push_mark_read).toBe(1);
      expect((await tx`select push_mark_read(null)`)[0].push_mark_read).toBe(0);
      inbox = await tx`select read_at is not null as read from my_push_inbox(50)`;
      expect(inbox.every((r: { read: boolean }) => r.read)).toBe(true);
      // Чужой клуб — ни ленты, ни таблиц напрямую.
      await as(tx, outsider.user!);
      expect((await tx`select * from my_push_inbox(50)`).length).toBe(0);
      expect(await failure(tx, () => tx`select * from push_recipients`)).toContain(
        "permission denied",
      );
      await asServer(tx);
      const [{ read_count }] = await tx`select read_count from push_notifications where id = ${onlyChk}`;
      expect(read_count).toBe(1);
    });
  });

  test("два приложения: пуш и лента — своего формата клубов", async () => {
    await scenario(async (tx) => {
      const pkg = await studio(tx, "packages");
      const sub = await studio(tx, "subscription");
      // Один человек — карточки в клубах обоих форматов, оба приложения на телефоне.
      const a = await client(tx, pkg, { active: true });
      await tx`
        insert into clients (studio_id, full_name, email, user_id)
        values (${sub}, 'Клиент', ${`b-${crypto.randomUUID()}@example.com`}, ${a.user})`;
      const ePkg = fcm();
      const eSub = fcm();
      await subscribe(tx, a.user!, ePkg, "ru", "packages");
      await subscribe(tx, a.user!, eSub, "ru", "subscription");

      const nPkg = await scheduled(tx, [pkg]);
      const nSub = await scheduled(tx, [sub]);
      const nBoth = await scheduled(tx, [pkg, sub]);
      await tx`select push_start_due()`;
      const devices = await tx`
        select d.notification_id, s.endpoint from push_deliveries d
          join push_subscriptions s on s.id = d.subscription_id`;
      const to = (n: string) =>
        devices
          .filter((d: { notification_id: string }) => d.notification_id === n)
          .map((d: { endpoint: string }) => d.endpoint)
          .sort();
      expect(to(nPkg)).toEqual([ePkg]);
      expect(to(nSub)).toEqual([eSub]);
      expect(to(nBoth)).toEqual([ePkg, eSub].sort());

      // Триггер пакетного формата — только на телефон Lady Stretch.
      const [{ sent }] = await tx`
        select push_trigger_send(t, ${a.user}::uuid, ${pkg}::uuid, 'test-ref', '{}'::jsonb) as sent
          from push_triggers t where t.format = 'packages' and t.key = 'birthday'`;
      expect(sent).toBe(true);
      const [{ endpoints }] = await tx`
        select array_agg(s.endpoint) as endpoints from push_deliveries d
          join push_subscriptions s on s.id = d.subscription_id
          join push_notifications n on n.id = d.notification_id
         where n.trigger_key = 'birthday'`;
      expect(endpoints).toEqual([ePkg]);

      // Лента: у каждого приложения — свои; без формата — все (прежнее приложение).
      await as(tx, a.user!);
      const ids = async (format: string | null) =>
        (await tx`select notification_id from my_push_inbox(50, ${format})`)
          .map((r: { notification_id: string }) => r.notification_id)
          .sort();
      expect((await ids("subscription")).length).toBe(2);
      expect(await ids("subscription")).toEqual([nSub, nBoth].sort());
      expect((await ids("packages")).length).toBe(3);
      expect((await ids(null)).length).toBe(4);
      // «Прочитать все» в Base40 не трогает ленту Lady Stretch.
      expect((await tx`select push_mark_read(null, 'subscription')`)[0].push_mark_read).toBe(2);
      const unread = await tx`select notification_id from my_push_inbox(50, 'packages') where read_at is null`;
      expect(unread.length).toBe(2);
      await asServer(tx);

      // Охват формы: телефон приложения формата клуба.
      await tx`delete from push_subscriptions where endpoint = ${ePkg}`;
      const admin = await staff(tx, pkg);
      await as(tx, admin);
      const [stats] = await tx`select * from push_audience_stats(${arr([pkg])}::uuid[], ${arr(["all"])}::text[])`;
      expect(stats).toEqual({ clients: 1, app_users: 1, push_users: 0 });
      await asServer(tx);
    });
  });

  test("без устройств — сразу отправлено; охват для формы; удаление клиента чистит подписки", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const other = await studio(tx);
      const a = await client(tx, s, { active: true });
      await client(tx, s);
      await client(tx, s, { app: false });
      await client(tx, other);
      await subscribe(tx, a.user!, fcm());

      const admin = await staff(tx, s);
      await as(tx, admin);
      const [stats] = await tx`select * from push_audience_stats(${arr([s, other])}::uuid[], ${arr(["all"])}::text[])`;
      expect(stats).toEqual({ clients: 3, app_users: 2, push_users: 1 });
      const [chk] = await tx`select * from push_audience_stats(${arr([s])}::uuid[], ${arr(["chk"])}::text[])`;
      expect(chk).toEqual({ clients: 1, app_users: 1, push_users: 1 });
      await asServer(tx);

      const lonely = await client(tx, other);
      const n = await scheduled(tx, [other]);
      await tx`select push_start_due()`;
      const [row] = await tx`select status, recipients_count, devices_count from push_notifications where id = ${n}`;
      expect(row).toEqual({ status: "sent", recipients_count: 2, devices_count: 0 });

      await subscribe(tx, lonely.user!, fcm());
      await tx`delete from clients where id = ${lonely.client}`;
      expect((await tx`select 1 from push_subscriptions where user_id = ${lonely.user}`).length).toBe(0);
      expect((await tx`select 1 from push_recipients where user_id = ${lonely.user}`).length).toBe(0);
    });
  });
});
