/**
 * Тесты уведомлений портала, пушей сотрудникам, «в сети» и справочника
 * «Компания» (db/migrations/2026-11-07_zz_portal_notifications.sql).
 *
 * Нужна база с полной схемой — как для db/knowledge-base.test.ts:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;

class Rollback extends Error {}

const KEY_P256 = "B" + "A".repeat(86);
const KEY_AUTH = "A".repeat(22);

describe.skipIf(!url)("уведомления портала (база)", () => {
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
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function staff(tx: Tx, name = "Сотрудник", city: string | null = null): Promise<string> {
    const [{ id: studioId }] =
      await tx`insert into studios (name, format, city) values ('Тест', 'packages', ${city}) returning id`;
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studioId}, ${name}, 'staff@example.com')
             on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
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

  async function device(tx: Tx, userId: string, n = 1) {
    await as(tx, userId);
    await tx`select portal_push_register(${`https://fcm.googleapis.com/fcm/send/dev-${n}-${userId}`},
             ${KEY_P256}, ${KEY_AUTH}, 'Chrome')`;
    await asServer(tx);
  }

  const send = (tx: Tx, to: string, kind = "chat.direct", group: string | null = null) =>
    tx`select notif_send(${to}, ${kind}, 'Анна', 'Привет', '/chats/1', null, ${group}) as id`;

  const queued = async (tx: Tx, to: string) =>
    Number(
      (await tx`select count(*) as n from portal_push_deliveries where user_id = ${to}`)[0].n,
    );

  test("уведомление: лента и пуш на устройства", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx, "Иванова Анна");
      await device(tx, a, 1);
      await device(tx, a, 2);
      const [{ id }] = await send(tx, a);
      expect(id).toBeTruthy();
      expect(await queued(tx, a)).toBe(2);

      await as(tx, a);
      const [{ n }] = await tx`select notif_unread_count() as n`;
      expect(n).toBe(1);
      const list = await tx`select * from notif_list()`;
      expect(list.length).toBe(1);
      expect(list[0].title).toBe("Анна");
      expect(list[0].url).toBe("/chats/1");
      const [{ notif_mark_read: marked }] = await tx`select notif_mark_read(null)`;
      expect(marked).toBe(1);
      expect((await tx`select notif_unread_count() as n`)[0].n).toBe(0);
      // «Отметить непрочитанным» (2026-11-09) — только своё.
      const [{ notif_mark_unread: back }] = await tx`select notif_mark_unread(${[id]}::uuid[])`;
      expect(back).toBe(1);
      expect((await tx`select notif_unread_count() as n`)[0].n).toBe(1);
      await asServer(tx);
      const b = await staff(tx, "Петрова Вера");
      await as(tx, b);
      await tx`select notif_mark_read(null)`;
      await as(tx, a);
      await tx`select notif_mark_read(null)`;
      await as(tx, b);
      const [{ notif_mark_unread: other }] = await tx`select notif_mark_unread(${[id]}::uuid[])`;
      expect(other).toBe(0);
    });
  });

  test("себе, не человеку портала и без адреса — не шлётся; ссылка только внутренняя", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      const stranger = await user(tx);
      const [{ id: self }] =
        await tx`select notif_send(${a}, 'chat.direct', 'Я', null, null, ${a}) as id`;
      expect(self).toBeNull();
      const [{ id: none }] = await send(tx, stranger);
      expect(none).toBeNull();
      const [{ id }] =
        await tx`select notif_send(${a}, 'chat.direct', 'Ссылка', null, 'https://evil.example') as id`;
      const [row] = await tx`select url from notif_items where id = ${id}`;
      expect(row.url).toBeNull();
    });
  });

  test("группировка: одно непрочитанное на ключ со счётчиком", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      const [{ id: first }] = await send(tx, a, "chat.direct", "chat:1");
      const [{ id: second }] = await send(tx, a, "chat.direct", "chat:1");
      expect(second).toBe(first);
      const [row] = await tx`select count from notif_items where id = ${first}`;
      expect(row.count).toBe(2);
      await tx`update notif_items set read_at = now() where id = ${first}`;
      const [{ id: third }] = await send(tx, a, "chat.direct", "chat:1");
      expect(third).not.toBe(first);
    });
  });

  test("пуш не ставится: выключен вид, «Не беспокоить», тихие часы, человек на портале", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await device(tx, a);

      // Вид выключен.
      await as(tx, a);
      await tx`select portal_settings_save(${{ prefs: { "chat.direct": { push: false } } }}::jsonb)`;
      await asServer(tx);
      await send(tx, a);
      expect(await queued(tx, a)).toBe(0);
      // Вид по умолчанию без пуша.
      await send(tx, a, "chat.group");
      expect(await queued(tx, a)).toBe(0);
      // Другой вид — с пушем.
      await send(tx, a, "chat.mention");
      expect(await queued(tx, a)).toBe(1);

      // «Не беспокоить» на час.
      await as(tx, a);
      await tx`select portal_settings_save(${{ prefs: {}, dnd_until: new Date(Date.now() + 3600_000).toISOString() }}::jsonb)`;
      await asServer(tx);
      await send(tx, a, "chat.mention");
      expect(await queued(tx, a)).toBe(1);

      // Тихие часы круглые сутки (с 00:00 до 23:59).
      await as(tx, a);
      await tx`select portal_settings_save(${{ dnd_until: "", quiet_enabled: true, quiet_from: "00:00", quiet_to: "23:59" }}::jsonb)`;
      await asServer(tx);
      await send(tx, a, "chat.mention");
      expect(await queued(tx, a)).toBe(1);

      // Тихие часы выключены, но человек смотрит на портал.
      await as(tx, a);
      await tx`select portal_settings_save(${{ quiet_enabled: false }}::jsonb)`;
      await tx`select portal_ping(true)`;
      await asServer(tx);
      await send(tx, a, "chat.mention");
      expect(await queued(tx, a)).toBe(1);

      // Вкладка в фоне — пуш есть.
      await tx`update portal_presence set last_active_at = now() - interval '5 minutes' where user_id = ${a}`;
      await send(tx, a, "chat.mention");
      expect(await queued(tx, a)).toBe(2);
    });
  });

  test("тихие часы через полночь в поясе человека", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      // Пояс, где сейчас ровно «тихо»: тихие часы — текущий час ± 1 через полночь.
      await as(tx, a);
      const [{ h }] =
        await tx`select extract(hour from now() at time zone 'Asia/Novosibirsk')::int as h`;
      const from = `${String((h + 23) % 24).padStart(2, "0")}:00`;
      const to = `${String((h + 1) % 24).padStart(2, "0")}:00`;
      await tx`select portal_settings_save(${{ timezone: "Asia/Novosibirsk", quiet_enabled: true, quiet_from: from, quiet_to: to }}::jsonb)`;
      await asServer(tx);
      const [{ allowed }] = await tx`select notif_push_allowed(${a}, 'chat.mention') as allowed`;
      expect(allowed).toBe(false);
    });
  });

  test("настройки: свои, проверка пояса, чужим и посторонним — нет", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await as(tx, a);
      const [{ portal_settings_get: s0 }] = await tx`select portal_settings_get()`;
      expect(s0.timezone).toBe("Europe/Moscow");
      expect(s0.quiet_from).toBe("21:00");
      expect(
        await failure(tx, () => tx`select portal_settings_save(${{ timezone: "Mars/Olympus" }}::jsonb)`),
      ).toContain("bad_timezone");
      const [{ portal_settings_save: s1 }] =
        await tx`select portal_settings_save(${{ timezone: "Asia/Yekaterinburg", workday_end: "19:30", prefs: { "chat.direct": { push: false }, bad: 1 } }}::jsonb)`;
      expect(s1.timezone).toBe("Asia/Yekaterinburg");
      expect(s1.workday_end).toBe("19:30");
      expect(s1.prefs).toEqual({ "chat.direct": { push: false } });

      await asServer(tx);
      const stranger = await user(tx);
      await as(tx, stranger);
      expect(await failure(tx, () => tx`select portal_settings_get()`)).toContain("forbidden");
    });
  });

  test("таблицы закрыты браузеру; notif_send браузеру не выдан", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await as(tx, a);
      for (const t of [
        "notif_items",
        "portal_user_settings",
        "portal_push_subscriptions",
        "portal_push_deliveries",
        "portal_presence",
      ]) {
        expect(await failure(tx, () => tx.unsafe(`select * from ${t}`))).toContain(
          "permission denied",
        );
      }
      expect(
        await failure(tx, () => tx`select notif_send(${a}, 'x', 'y')`),
      ).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from portal_push_claim(10)`)).toContain(
        "permission denied",
      );
    });
  });

  test("устройства: проверка адреса и ключей, до 10, удаление своего", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await as(tx, a);
      expect(
        await failure(
          tx,
          () => tx`select portal_push_register('https://evil.example/push', ${KEY_P256}, ${KEY_AUTH})`,
        ),
      ).toContain("push_endpoint_unknown");
      expect(
        await failure(
          tx,
          () =>
            tx`select portal_push_register('https://fcm.googleapis.com/fcm/send/x', 'short', ${KEY_AUTH})`,
        ),
      ).toContain("push_keys_invalid");
      await asServer(tx);
      for (let i = 0; i < 12; i++) await device(tx, a, i);
      await as(tx, a);
      const devices = await tx`select * from portal_push_devices()`;
      expect(devices.length).toBe(10);
      await tx`select portal_push_device_delete(${devices[0].id})`;
      expect((await tx`select * from portal_push_devices()`).length).toBe(9);
    });
  });

  test("очередь: пачка серверу, итог, «устройства больше нет» удаляет подписку", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await device(tx, a, 1);
      await device(tx, a, 2);
      await send(tx, a, "chat.direct", "chat:9");
      await send(tx, a, "chat.direct", "chat:9");
      // Вторая отправка в ту же группу — ещё две доставки той же строки.
      const claimed = await tx`select * from portal_push_claim(100)`;
      expect(claimed.length).toBe(4);
      expect(claimed[0].title).toBe("Анна (2)");
      expect(claimed[0].tag).toBe("chat:9");
      expect(claimed[0].unread).toBe(1);
      expect((await tx`select * from portal_push_claim(100)`).length).toBe(0);

      const gone = claimed.find((c: { endpoint: string }) => c.endpoint.includes("dev-1"));
      const results = claimed.map((c: { delivery_id: string; endpoint: string }) => ({
        id: c.delivery_id,
        result: c.endpoint.includes("dev-1") ? "gone" : "sent",
      }));
      await tx`select portal_push_finish(${results}::jsonb)`;
      const subs = await tx`select endpoint, last_sent_at from portal_push_subscriptions where user_id = ${a}`;
      expect(subs.length).toBe(1);
      expect(subs[0].endpoint).not.toBe(gone.endpoint);
      expect(subs[0].last_sent_at).not.toBeNull();
    });
  });

  test("проверочный пуш — без учёта настроек, не чаще раза в 10 секунд", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await device(tx, a);
      await as(tx, a);
      await tx`select portal_settings_save(${{ dnd_until: new Date(Date.now() + 3600_000).toISOString() }}::jsonb)`;
      await tx`select portal_ping(true)`;
      const [{ notif_test: n }] = await tx`select notif_test()`;
      expect(n).toBe(1);
      expect(await failure(tx, () => tx`select notif_test()`)).toContain("notif_test_rate_limit");
    });
  });

  test("справочник: люди портала с клубами, городами и «в сети»; посторонним — нет", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx, "Анна Партнёр", "Казань");
      const b = await staff(tx, "Борис Партнёр", "Самара");
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел развития') returning id`;
      await tx`insert into portal_users (user_id) values (${a}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${a}, 'head')`;

      await as(tx, b);
      await tx`select portal_ping(false)`;
      const people = await tx`select * from company_people()`;
      const anna = people.find((p: { user_id: string }) => p.user_id === a);
      const boris = people.find((p: { user_id: string }) => p.user_id === b);
      expect(anna.full_name).toBe("Анна Партнёр");
      expect(anna.cities).toEqual(["Казань"]);
      expect(anna.units[0]).toMatchObject({ name: "Отдел развития", role: "head" });
      expect(boris.last_seen_at).not.toBeNull();

      const structure = await tx`select * from company_structure()`;
      const dept = structure.find((u: { id: string }) => u.id === unit);
      expect(dept.members).toEqual([{ user_id: a, role: "head" }]);

      await asServer(tx);
      const stranger = await user(tx);
      await as(tx, stranger);
      expect(await failure(tx, () => tx`select * from company_people()`)).toContain("forbidden");
      // Пульс постороннего ничего не пишет.
      await tx`select portal_ping(true)`;
      await asServer(tx);
      expect((await tx`select * from portal_presence where user_id = ${stranger}`).length).toBe(0);
    });
  });

  test("уборка: лента старше 90 дней уходит", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      const [{ id }] = await send(tx, a);
      await tx`update notif_items set updated_at = now() - interval '91 days' where id = ${id}`;
      await tx`select notif_housekeeping()`;
      expect((await tx`select * from notif_items where id = ${id}`).length).toBe(0);
    });
  });
  // Уведомления на почту (2026-11-08_zzzzzzzzzzzz_notif_email.sql).
  const mails = async (tx: Tx, to: string) =>
    await tx`select * from portal_email_deliveries where user_id = ${to} order by created_at`;

  test("почта: по умолчанию выключена, включается по виду, пуш и почта независимы", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await device(tx, a);
      await send(tx, a);
      expect((await mails(tx, a)).length).toBe(0);
      expect(await queued(tx, a)).toBe(1);

      // Только почта.
      await as(tx, a);
      const [{ portal_settings_save: saved }] =
        await tx`select portal_settings_save(${{ prefs: { "chat.direct": { push: false, email: true }, "chat.mention": { email: false } } }}::jsonb)`;
      // Отличие от умолчания хранится, совпадение — тоже без вреда.
      expect(saved.prefs["chat.direct"]).toEqual({ push: false, email: true });
      expect(saved.email).toMatch(/@example\.com$/);
      await asServer(tx);
      await send(tx, a, "chat.direct");
      expect(await queued(tx, a)).toBe(1);
      const list = await mails(tx, a);
      expect(list.length).toBe(1);
      expect(list[0]).toMatchObject({ kind: "chat.direct", title: "Анна", body: "Привет", url: "/chats/1" });

      // И то и другое.
      await as(tx, a);
      await tx`select portal_settings_save(${{ prefs: { "chat.direct": { email: true } } }}::jsonb)`;
      await asServer(tx);
      await send(tx, a, "chat.direct");
      expect(await queued(tx, a)).toBe(2);
      expect((await mails(tx, a)).length).toBe(2);

      // Ничего: в ленте — есть, пуша и письма нет.
      await as(tx, a);
      await tx`select portal_settings_save(${{ prefs: { "chat.direct": { push: false } } }}::jsonb)`;
      await asServer(tx);
      const [{ id }] = await send(tx, a, "chat.direct");
      expect(id).toBeTruthy();
      expect(await queued(tx, a)).toBe(2);
      expect((await mails(tx, a)).length).toBe(2);
    });
  });

  test("почта: одно письмо на непрочитанную пачку, не тому, кто на портале, не без почты", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx);
      await as(tx, a);
      await tx`select portal_settings_save(${{ prefs: { "chat.direct": { email: true } } }}::jsonb)`;
      await asServer(tx);
      // Скрытая строка чата (как у личных сообщений) — письмо есть, продолжение пачки — нет.
      const direct = () =>
        tx`select notif_send_ex(${a}, 'chat.direct', 'Анна', 'Привет', '/chats/1', null, 'chat:1', false, false) as id`;
      const [{ id: first }] = await direct();
      await direct();
      expect((await mails(tx, a)).length).toBe(1);
      await tx`update notif_items set read_at = now() where id = ${first}`;
      await direct();
      expect((await mails(tx, a)).length).toBe(2);

      // Смотрит на портал — письма нет.
      await as(tx, a);
      await tx`select portal_ping(true)`;
      await asServer(tx);
      await send(tx, a, "chat.direct");
      expect((await mails(tx, a)).length).toBe(2);
      await tx`update portal_presence set last_active_at = now() - interval '5 minutes' where user_id = ${a}`;

      // «Не беспокоить» письма не держит.
      await as(tx, a);
      await tx`select portal_settings_save(${{ dnd_until: new Date(Date.now() + 3600_000).toISOString() }}::jsonb)`;
      await asServer(tx);
      await send(tx, a, "chat.direct");
      expect((await mails(tx, a)).length).toBe(3);

      // Без настоящей почты — нет.
      await tx`update auth.users set email = ${`nomail-${a}@no-email.invalid`} where id = ${a}`;
      await tx`update profiles set email = null where id = ${a}`;
      await send(tx, a, "chat.direct");
      expect((await mails(tx, a)).length).toBe(3);
      await as(tx, a);
      expect(await failure(tx, () => tx`select notif_test_email()`)).toContain("notif_no_email");
    });
  });

  test("почта: очередь серверу, итог, повторы, проверочное письмо", async () => {
    await scenario(async (tx) => {
      const a = await staff(tx, "Иванова Анна");
      await as(tx, a);
      const [{ notif_test_email: addr }] = await tx`select notif_test_email()`;
      expect(addr).toMatch(/@example\.com$/);
      expect(await failure(tx, () => tx`select notif_test_email()`)).toContain("rate_limit");
      // Браузеру очередь закрыта.
      expect(await failure(tx, () => tx`select * from portal_email_claim(10)`)).toContain("permission");
      expect(await failure(tx, () => tx`select * from portal_email_deliveries`)).toContain("permission");
      await asServer(tx);

      const batch = await tx`select * from portal_email_claim(10)`;
      expect(batch.length).toBe(1);
      expect(batch[0]).toMatchObject({ email: addr, kind: "test", user_name: "Иванова Анна" });
      expect((await tx`select * from portal_email_claim(10)`).length).toBe(0);
      await tx`select portal_email_finish(${[{ id: batch[0].delivery_id, result: "retry", error: "421" }]}::jsonb)`;
      const again = await tx`select * from portal_email_claim(10)`;
      expect(again.length).toBe(1);
      await tx`select portal_email_finish(${[{ id: again[0].delivery_id, result: "sent" }]}::jsonb)`;
      const [row] = await tx`select status, attempts, sent_at, error from portal_email_deliveries where id = ${again[0].delivery_id}`;
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(2);
      expect(row.error).toBeNull();

      // Письмо старше суток не уходит — уборка отмечает его неудачным.
      await tx`insert into portal_email_deliveries (user_id, email, kind, title, created_at)
               values (${a}, 'x@example.com', 'test', 'Старое', now() - interval '2 days')`;
      expect((await tx`select * from portal_email_claim(10)`).length).toBe(0);
      await tx`select notif_housekeeping()`;
      const [old] = await tx`select status from portal_email_deliveries where title = 'Старое'`;
      expect(old.status).toBe("failed");
    });
  });
});
