/**
 * Тесты триггерных уведомлений (db/migrations/2026-10-15_push_triggers.sql):
 * срабатывания по событиям, подстановка переменных на трёх языках, без
 * повторов, выключение, ночные часы, права админки и статистика.
 *
 * Нужна база с полной схемой — как для db/packages.test.ts:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 *
 * Время прохода — p_now: завтра в 12:00 по Тбилиси (позже любых now() в
 * транзакции, днём — ночные часы не мешают).
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;

class Rollback extends Error {}

const P256DH = "B" + "A".repeat(86);
const AUTH = "A".repeat(22);

/** Завтра, 12:00 по Тбилиси (SQL-выражение). */
const NOON = `(((now() at time zone 'Asia/Tbilisi')::date + 1 + time '12:00') at time zone 'Asia/Tbilisi')`;

describe.skipIf(!url)("триггерные уведомления (база)", () => {
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

  async function user(tx: Tx, email: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
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

  type Seed = {
    studio: string;
    client: string;
    user: string;
    workout: string;
    trainer: string;
    pack: string;
  };

  /** Клуб, клиент с приложением, тренировка с переводом, тренер, пакет на 4 тренировки. */
  async function seed(tx: Tx, format: "packages" | "subscription" = "packages"): Promise<Seed> {
    const [{ id: studio }] = await tx`
      insert into studios (name, format, translations)
      values ('Ваке', ${format}, ${{ en: { name: "Vake" } }}) returning id`;
    const email = `anna-${studio}@example.com`;
    const userId = await user(tx, email);
    const [{ id: client }] = await tx`
      insert into clients (studio_id, first_name, last_name, full_name, email, user_id)
      values (${studio}, 'Анна', 'Тестова', 'Тестова Анна', ${email}, ${userId}) returning id`;
    const [{ id: workout }] = await tx`
      insert into workouts (studio_id, name, translations)
      values (${studio}, 'Стретчинг', ${{ en: { name: "Stretching" }, ka: { name: "სტრეჩინგი" } }})
      returning id`;
    const [{ id: trainer }] = await tx`
      insert into trainers (full_name, role) values ('Ольга', 'trainer') returning id`;
    const [{ id: pack }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
      values (${studio}, 'Пакет 4', 'package', 4, 30, 100) returning id`;
    return { studio, client, user: userId, workout, trainer, pack };
  }

  async function subscribe(tx: Tx, userId: string, locale: string) {
    await as(tx, userId);
    await tx`select register_push_subscription(${`https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`}, ${P256DH}, ${AUTH}, ${locale}, 'packages', 'test')`;
    await asServer(tx);
  }

  /** Занятие: начало — NOON + startHours часов, длительность час. */
  async function entry(tx: Tx, s: Seed, startHours: number) {
    const [{ id }] = await tx.unsafe(
      `insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
       values ($1, $2, 'group', ${NOON} + make_interval(mins => ($3::numeric * 60)::int),
               ${NOON} + make_interval(mins => ($3::numeric * 60)::int + 60))
       returning id`,
      [s.studio, s.workout, startHours],
    );
    await tx`insert into schedule_entry_trainers (entry_id, trainer_id) values (${id}, ${s.trainer})`;
    return id as string;
  }

  async function book(tx: Tx, s: Seed, entryId: string) {
    const [{ id }] = await tx`
      insert into schedule_bookings (studio_id, entry_id, client_id, status)
      values (${s.studio}, ${entryId}, ${s.client}, 'booked') returning id`;
    return id as string;
  }

  async function run(tx: Tx, shiftMinutes = 0): Promise<number> {
    const [{ n }] = await tx.unsafe(
      `select push_triggers_run(${NOON} + make_interval(mins => $1::int)) as n`,
      [shiftMinutes],
    );
    return n as number;
  }

  type Sent = {
    trigger_key: string;
    title: string;
    message: string | null;
    translations: Record<string, Record<string, string>>;
    status: string;
    devices_count: number;
    action_url: string | null;
  };

  async function sent(tx: Tx, key: string): Promise<Sent[]> {
    return (await tx`
      select trigger_key, title, message, translations, status, devices_count, action_url
        from push_notifications where trigger_key = ${key} order by created_at`) as Sent[];
  }

  test("напоминание о занятии: переводы и переменные, телефон, без повтора", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await subscribe(tx, s.user, "ka");
      const soon = await entry(tx, s, 2);
      const later = await entry(tx, s, 5);
      await book(tx, s, soon);
      await book(tx, s, later);

      expect(await run(tx)).toBeGreaterThanOrEqual(1);
      const [n] = await sent(tx, "class_reminder");
      expect(n.title).toBe("Скоро тренировка");
      expect(n.message).toBe(
        "Анна, ждём вас на «Стретчинг» сегодня в 14:00. Если планы изменились — отмените запись в приложении.",
      );
      expect(n.translations.en.message).toContain("see you at Stretching today at 14:00");
      expect(n.translations.ka.message).toContain("„სტრეჩინგი“ ვარჯიშზე დღეს 14:00-ზე");
      expect(n.status).toBe("sending");
      expect(n.devices_count).toBe(1);
      expect(n.action_url).toBe("/");
      const [{ deliveries, recipients }] = await tx`
        select (select count(*)::int from push_deliveries d
                  join push_notifications pn on pn.id = d.notification_id
                 where pn.trigger_key = 'class_reminder') as deliveries,
               (select count(*)::int from push_recipients r
                  join push_notifications pn on pn.id = r.notification_id
                 where pn.trigger_key = 'class_reminder' and r.user_id = ${s.user}) as recipients`;
      expect({ deliveries, recipients }).toEqual({ deliveries: 1, recipients: 1 });

      // Повторный проход — без дублей; второе занятие — когда наступит его время.
      await run(tx);
      expect(await sent(tx, "class_reminder")).toHaveLength(1);
      await run(tx, 2 * 60 + 1);
      expect(await sent(tx, "class_reminder")).toHaveLength(2);
    });
  });

  test("напоминание: записавшимся позже не шлём, ночное — утром в 09:00 или накануне", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const e = await entry(tx, s, 2);
      const b = await book(tx, s, e);
      await tx.unsafe(`update schedule_bookings set booked_at = ${NOON} - interval '30 minutes' where id = $1`, [b]);
      await run(tx);
      expect(await sent(tx, "class_reminder")).toHaveLength(0);

      // Занятие в 10:00 (за 3 часа — 07:00, ночь) — напоминание в 09:00;
      // в 09:15 (раньше 09:00 + 30 минут нельзя) — накануне в 21:00.
      const [{ ten, quarter }] = await tx.unsafe(`
        select push_trigger_reminder_at(${NOON} - interval '2 hours', 3) - (${NOON} - interval '2 hours') as ten,
               push_trigger_reminder_at(${NOON} - interval '165 minutes', 3) - (${NOON} - interval '165 minutes') as quarter`);
      expect(ten).toBe("-01:00:00");
      expect(quarter).toBe("-12:15:00");
    });
  });

  test("выключенный триггер не шлёт; включение не рассылает старые события", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update push_triggers set enabled = false where key = 'class_cancelled'`;
      const e = await entry(tx, s, 24);
      await book(tx, s, e);
      await tx`update schedule_entries set cancelled_at = now() where id = ${e}`;
      await tx`update schedule_bookings set status = 'cancelled', cancelled_at = now() where entry_id = ${e}`;
      await run(tx);
      expect(await sent(tx, "class_cancelled")).toHaveLength(0);

      // Включение заново — события считаются с этого момента.
      await tx`update push_triggers set enabled = true where key = 'class_cancelled'`;
      const [{ moved }] = await tx`
        select bool_and(active_since = now()) as moved from push_triggers where key = 'class_cancelled'`;
      expect(moved).toBe(true);
    });
  });

  test("клуб отменил занятие — записанным, но не отменившим раньше", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const e = await entry(tx, s, 24);
      await book(tx, s, e);
      // Вторая клиентка отменила запись сама до отмены занятия.
      const email = `olga-${s.studio}@example.com`;
      const other = await user(tx, email);
      const [{ id: otherClient }] = await tx`
        insert into clients (studio_id, first_name, email, user_id)
        values (${s.studio}, 'Ольга', ${email}, ${other}) returning id`;
      await tx`
        insert into schedule_bookings (studio_id, entry_id, client_id, status, cancelled_at)
        values (${s.studio}, ${e}, ${otherClient}, 'cancelled', now())`;

      // Как cancel_schedule_entry: записи → «Отменено» тем же моментом, что и занятие.
      await tx.unsafe(
        `update schedule_entries set cancelled_at = ${NOON} - interval '1 hour' where id = $1`,
        [e],
      );
      await tx.unsafe(
        `update schedule_bookings set status = 'cancelled', cancelled_at = ${NOON} - interval '1 hour'
          where entry_id = $1 and status = 'booked'`,
        [e],
      );

      await run(tx);
      const list = await sent(tx, "class_cancelled");
      expect(list).toHaveLength(1);
      expect(list[0].message).toBe(
        "Анна, к сожалению, «Стретчинг» завтра в 12:00 отменена. Выберите другое время в расписании.",
      );
      const [{ user_id }] = await tx`
        select r.user_id from push_recipients r
          join push_notifications n on n.id = r.notification_id
         where n.trigger_key = 'class_cancelled'`;
      expect(user_id).toBe(s.user);
    });
  });

  test("запись от администратора — уведомление, своя запись — нет; замена тренера", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const mine = await entry(tx, s, 30);
      const byAdmin = await entry(tx, s, 48);

      await tx`select set_config('request.jwt.claim.sub', ${s.user}::text, true)`;
      await book(tx, s, mine);
      const staff = await user(tx, `staff-${s.studio}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;
      await tx`select set_config('request.jwt.claim.sub', ${staff}::text, true)`;
      const [{ r }] = await tx`select admin_book_client(${byAdmin}, ${s.client}) as r`;
      expect(r.ok).toBe(true);

      // Замена тренера на занятии, куда клиентка записалась сама.
      const [{ id: anna }] = await tx`
        insert into trainers (full_name, role, translations)
        values ('Анна Б.', 'trainer', ${{ en: { full_name: "Anna B." } }}) returning id`;
      await tx`delete from schedule_entry_trainers where entry_id = ${mine}`;
      await tx`insert into schedule_entry_trainers (entry_id, trainer_id) values (${mine}, ${anna})`;
      await tx`
        insert into schedule_entry_substitutions (entry_id, trainer_id, replaced_trainer_id, created_at)
        values (${mine}, ${anna}, ${s.trainer}, now() + interval '1 second')`;
      await asServer(tx);
      // События — за час до прохода (окно «недавних» — 6 часов).
      await tx.unsafe(
        `update schedule_bookings set booked_at = ${NOON} - interval '2 hours' where client_id = $1`,
        [s.client],
      );
      await tx.unsafe(
        `update schedule_entry_substitutions set created_at = ${NOON} - interval '1 hour' where entry_id = $1`,
        [mine],
      );

      await run(tx);
      const booked = await sent(tx, "booked_for_client");
      expect(booked).toHaveLength(1);
      expect(booked[0].message).toContain("вы записаны на «Стретчинг»");
      const sub = await sent(tx, "trainer_substitution");
      expect(sub).toHaveLength(1);
      expect(sub[0].message).toBe("Анна, на «Стретчинг» завтра в 18:00 вас встретит Анна Б..");
      expect(sub[0].translations.en.message).toBe("Анна, Anna B. will lead Stretching tomorrow at 18:00.");
    });
  });

  test("абонемент: оформлен, заканчивается (без продления), ежедневные — в свой час", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, "subscription");
      await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${s.pack}, 100, current_date)`;
      await tx.unsafe(
        `update client_memberships set created_at = ${NOON} - interval '1 hour' where client_id = $1`,
        [s.client],
      );
      await run(tx);
      const activated = await sent(tx, "membership_activated");
      expect(activated).toHaveLength(1);
      expect(activated[0].message).toBe("Анна, абонемент «Пакет 4» оформлен. До встречи на тренировке!");

      // Срок — через 2 дня от дня прохода.
      await tx.unsafe(
        `update client_memberships set ends_at = (${NOON} at time zone 'Asia/Tbilisi')::date + 2, auto_renew = false
          where client_id = $1`,
        [s.client],
      );
      await tx`update push_triggers set params = ${{ days: 3, send_hour: 13 }} where key = 'membership_expiring'`;
      await run(tx);
      expect(await sent(tx, "membership_expiring")).toHaveLength(0);
      await run(tx, 60);
      const expiring = await sent(tx, "membership_expiring");
      expect(expiring).toHaveLength(1);
      const [{ d }] = await tx.unsafe(
        `select to_char((${NOON} at time zone 'Asia/Tbilisi')::date + 2, 'DD.MM') as d`,
      );
      expect(expiring[0].message).toContain(`действует до ${d}.`);
    });
  });

  test("рассрочка: платёж скоро и просрочен, оплаченный — нет", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: sale }] = await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${s.pack}, 300, current_date) returning id`;
      const day = `(${NOON} at time zone 'Asia/Tbilisi')::date`;
      await tx.unsafe(
        `insert into sale_installments (sale_id, amount, due_date, paid) values
           ($1, 100, ${day} - 2, true),
           ($1, 150.50, ${day} + 1, false),
           ($1, 49.5, ${day} - 2, false)`,
        [sale],
      );
      await run(tx);
      const due = await sent(tx, "installment_due");
      expect(due).toHaveLength(1);
      expect(due[0].message).toContain("очередной платёж 150.5 ₾ за абонемент «Пакет 4»");
      const overdue = await sent(tx, "installment_overdue");
      expect(overdue).toHaveLength(1);
      expect(overdue[0].message).toContain("платёж 49.5 ₾");
    });
  });

  test("пакеты: мало тренировок после посещения и оценка тренера (пока не оценил)", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update memberships set visits_count = 3 where id = ${s.pack}`;
      await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${s.pack}, 100, current_date)`;
      // Занятие закончилось 2 часа назад.
      const e = await entry(tx, s, -3);
      const b = await book(tx, s, e);
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;

      await run(tx);
      const low = await sent(tx, "visits_low");
      expect(low).toHaveLength(1);
      expect(low[0].message).toContain("осталось тренировок: 2.");
      const rate = await sent(tx, "rate_trainer");
      expect(rate).toHaveLength(1);
      expect(rate[0].message).toContain("Оцените тренера — Ольга.");

      // Второе посещение того же тренера: уже спрашивали — нет.
      const e2 = await entry(tx, s, -4);
      const b2 = await book(tx, s, e2);
      await tx`update schedule_bookings set status = 'attended' where id = ${b2}`;
      await run(tx, 1);
      expect(await sent(tx, "rate_trainer")).toHaveLength(1);
      expect(await sent(tx, "visits_low")).toHaveLength(1);

      // Ночью «необязательные» ждут утра.
      await tx`delete from push_trigger_log where trigger_key = 'rate_trainer'`;
      await tx`delete from push_notifications where trigger_key = 'rate_trainer'`;
      await run(tx, 11 * 60);
      expect(await sent(tx, "rate_trainer")).toHaveLength(0);

      // Оценила — больше не спрашиваем.
      await tx`insert into trainer_reviews (trainer_id, user_id, rating) values (${s.trainer}, ${s.user}, 5)`;
      await run(tx, 2);
      expect(await sent(tx, "rate_trainer")).toHaveLength(0);
    });
  });

  test("диагностика — в напоминании; разовое посещение — без «Тренировки закончились»", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const staff = await user(tx, `staff-${s.studio}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;
      await tx`select set_config('request.jwt.claim.sub', ${staff}::text, true)`;
      const [{ id: diag }] = await tx.unsafe(
        `insert into schedule_entries (studio_id, kind, starts_at, ends_at)
         values ($1, 'diagnostic', ${NOON} + interval '2 hours', ${NOON} + interval '3 hours')
         returning id`,
        [s.studio],
      );
      await tx`
        insert into schedule_bookings (studio_id, entry_id, client_id, status, created_at)
        values (${s.studio}, ${diag}, ${s.client}, 'booked', now() - interval '1 day')`;

      const [{ id: single }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price, max_payments)
        values (${s.studio}, 'Разовое', 'single', 1, 0, 30, 30, 1) returning id`;
      await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${single}, 30, current_date)`;
      const e = await entry(tx, s, -3);
      const b = await book(tx, s, e);
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      await asServer(tx);

      await run(tx);
      const reminders = await sent(tx, "class_reminder");
      expect(reminders.map((n) => n.message)).toContainEqual(
        "Анна, ждём вас на «Диагностика тела» сегодня в 14:00. Если планы изменились — отмените запись в приложении.",
      );
      expect(reminders[0].translations.en.message).toContain("Body diagnostics");
      expect(await sent(tx, "visits_exhausted")).toHaveLength(0);
    });
  });

  test("больше 500 событий: следующий проход доходит до остальных", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const e = await entry(tx, s, 2);
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into auth.users (email)
        select 'bulk-' || g || '-' || ${s.studio}::text || '@example.com' from generate_series(1, 500) g`;
      await tx`set local session_replication_role = origin`;
      await tx`
        insert into clients (studio_id, first_name, email, user_id)
        select ${s.studio}, 'Клиент', u.email, u.id
          from auth.users u where u.email like 'bulk-%-' || ${s.studio}::text || '@example.com'`;
      await tx`
        insert into schedule_bookings (studio_id, entry_id, client_id, status)
        select ${s.studio}, ${e}, c.id, 'booked' from clients c where c.studio_id = ${s.studio}`;

      // 501 записанный: за проход — 500, остальной — в следующий.
      expect(await run(tx)).toBe(500);
      expect(await run(tx, 1)).toBe(1);
      expect(await run(tx, 2)).toBe(0);
      expect(await sent(tx, "class_reminder")).toHaveLength(501);
    });
  });

  test("оценка тренера через 48 часов после занятия — приходит", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${s.pack}, 100, current_date)`;
      await tx`update push_triggers set params = ${{ hours: 48 }} where format = 'packages' and key = 'rate_trainer'`;
      await tx`update push_triggers set active_since = now() - interval '10 days' where key = 'rate_trainer'`;
      // Закончилось 49 часов назад: срок наступил час назад.
      const e = await entry(tx, s, -50);
      const b = await book(tx, s, e);
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      await run(tx);
      expect(await sent(tx, "rate_trainer")).toHaveLength(1);
    });
  });

  test("давно не был: диагностика — не посещение; другой формат — не в счёт", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update memberships set diagnostics_count = 1 where id = ${s.pack}`;
      await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sold_at)
        values (${s.studio}, ${s.client}, ${s.pack}, 100, current_date - 20)`;
      await tx`update push_triggers set active_since = now() - interval '30 days' where key = 'no_visits'`;
      const staff = await user(tx, `staff-${s.studio}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;
      await tx`select set_config('request.jwt.claim.sub', ${staff}::text, true)`;

      // Тренировка 15 дней назад (параметр — 14 дней), диагностика — 2 дня назад.
      const old = await entry(tx, s, -15 * 24);
      const b = await book(tx, s, old);
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      const [{ id: diag }] = await tx.unsafe(
        `insert into schedule_entries (studio_id, kind, starts_at, ends_at)
         values ($1, 'diagnostic', ${NOON} - interval '48 hours', ${NOON} - interval '47 hours')
         returning id`,
        [s.studio],
      );
      const [{ id: db }] = await tx`
        insert into schedule_bookings (studio_id, entry_id, client_id, status)
        values (${s.studio}, ${diag}, ${s.client}, 'booked') returning id`;
      await tx`update schedule_bookings set status = 'attended' where id = ${db}`;

      // Свежее посещение в клубе другого формата «Мы скучаем» в этом приложении не отменяет.
      const [{ id: other }] = await tx`
        insert into studios (name, format) values ('Base40', 'subscription') returning id`;
      const [{ id: otherClient }] = await tx`
        insert into clients (studio_id, first_name, email, user_id)
        values (${other}, 'Анна', ${`anna2-${s.studio}@example.com`}, ${s.user}) returning id`;
      const [{ id: otherWorkout }] = await tx`
        insert into workouts (studio_id, name) values (${other}, 'Пилатес') returning id`;
      const [{ id: otherEntry }] = await tx.unsafe(
        `insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
         values ($1, $2, 'group', ${NOON} - interval '24 hours', ${NOON} - interval '23 hours') returning id`,
        [other, otherWorkout],
      );
      await tx`
        insert into schedule_bookings (studio_id, entry_id, client_id, status)
        values (${other}, ${otherEntry}, ${otherClient}, 'attended')`;
      await asServer(tx);

      await run(tx);
      const list = await sent(tx, "no_visits");
      expect(list).toHaveLength(1);
      const [{ d }] = await tx.unsafe(
        `select to_char((${NOON} at time zone 'Asia/Tbilisi')::date - 15, 'DD.MM') as d`,
      );
      expect(list[0].message).toContain(`Последняя тренировка была ${d}.`);
    });
  });

  test("день рождения — в каждом приложении, по разу", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: other }] = await tx`
        insert into studios (name, format) values ('Base40', 'subscription') returning id`;
      await tx`
        insert into clients (studio_id, first_name, email, user_id)
        values (${other}, 'Анна', ${`anna2-${s.studio}@example.com`}, ${s.user})`;
      await tx.unsafe(
        `update clients set birthday = (${NOON} at time zone 'Asia/Tbilisi')::date - interval '30 years'
          where user_id = $1`,
        [s.user],
      );
      await run(tx);
      await run(tx, 1);
      const list = await tx`
        select s.format from push_notifications n join studios s on s.id = n.studio_id
         where n.trigger_key = 'birthday' order by s.format`;
      expect(list.map((r: { format: string }) => r.format)).toEqual(["packages", "subscription"]);
    });
  });

  test("админка: правка своего формата, параметры в пределах, клиенту закрыто, статистика", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const staff = await user(tx, `staff-${s.studio}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;

      await as(tx, staff);
      const rows = await tx`select format from push_triggers`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { format: string }) => r.format === "packages")).toBe(true);

      await tx`
        update push_triggers
           set title = ' Привет ', message = '', params = ${{ hours: 5 }},
               translations = ${{ en: { title: "Hi" } }}
         where format = 'packages' and key = 'class_reminder'`;
      const [row] = await tx`
        select title, message, params, updated_by from push_triggers
         where format = 'packages' and key = 'class_reminder'`;
      expect(row).toEqual({ title: "Привет", message: null, params: { hours: 5 }, updated_by: staff });

      expect(
        await failure(
          tx,
          () => tx`update push_triggers set params = ${{ hours: 500 }} where key = 'class_reminder'`,
        ),
      ).toContain("Недопустимое значение");
      expect(
        await failure(
          tx,
          () => tx`update push_triggers set params = ${{ foo: 1 }} where key = 'class_reminder'`,
        ),
      ).toContain("Недопустимое значение");
      expect(
        await failure(tx, () => tx`update push_triggers set key = 'x' where key = 'class_reminder'`),
      ).toContain("permission denied");
      expect(
        await failure(tx, () => tx`delete from push_triggers where key = 'class_reminder'`),
      ).toContain("permission denied");

      // Клиент настроек не видит.
      await as(tx, s.user);
      expect(await tx`select 1 from push_triggers`).toHaveLength(0);

      // Статистика — по своим клубам.
      await asServer(tx);
      const e = await entry(tx, s, 2);
      await book(tx, s, e);
      await run(tx);
      await as(tx, staff);
      const stats = await tx`
        select trigger_key, notifications from push_trigger_stats('packages', now() - interval '1 day')`;
      expect(stats).toContainEqual({ trigger_key: "class_reminder", notifications: 1 });
      // В списке рассылок админки триггерных нет (фильтр trigger_key is null).
      const [{ n }] = await tx`
        select count(*)::int as n from push_notifications where trigger_key is null`;
      expect(n).toBe(0);
      await asServer(tx);
    });
  });
});
