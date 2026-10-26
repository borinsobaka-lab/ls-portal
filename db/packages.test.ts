/**
 * Тесты логики пакетных клубов в базе (правки 2026-10-13): роль «Старший
 * администратор», срок абонемента с первого посещения, «Посетил» без
 * абонемента, запись сверх остатка, возврат, замена тренера.
 *
 * Нужна база с полной схемой — её собирает db/test/build-schema.sh:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий — в своей транзакции,
 * которая откатывается: база после прогона та же.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;

class Rollback extends Error {}

describe.skipIf(!url)("пакетные клубы (база)", () => {
  let db: SQL;

  beforeAll(() => {
    db = new SQL(url!);
  });
  afterAll(async () => {
    await db.close();
  });

  /** Сценарий в транзакции, которая всегда откатывается. */
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

  /** Сообщение ошибки запроса или null, если запрос прошёл (в точке сохранения). */
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

  type Seed = {
    studio: string;
    client: string;
    workout: string;
    pack: string;
    personalPack: string;
  };

  /** Клуб, клиент, тренировка, пакет на 2 тренировки (30 дней) и пакет 1 персональной. */
  async function seed(tx: Tx, format: "packages" | "subscription" = "packages"): Promise<Seed> {
    const [{ id: studio }] = await tx`
      insert into studios (name, format) values ('Тест', ${format}) returning id`;
    const [{ id: client }] = await tx`
      insert into clients (studio_id, first_name, last_name, email)
      values (${studio}, 'Анна', 'Тестова', ${`anna-${studio}@example.com`}) returning id`;
    const [{ id: workout }] = await tx`
      insert into workouts (studio_id, name) values (${studio}, 'Стретчинг') returning id`;
    const [{ id: pack }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
      values (${studio}, 'Пакет 2', 'package', 2, 30, 100) returning id`;
    const [{ id: personalPack }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price)
      values (${studio}, 'Персональные 1', 'personal', 0, 1, 30, 80) returning id`;
    return { studio, client, workout, pack, personalPack };
  }

  async function sell(
    tx: Tx,
    s: Seed,
    opts: {
      membership?: string;
      kind?: string;
      installments?: { amount: number; days: number; paid: boolean }[];
    } = {},
  ): Promise<string> {
    const [{ id }] = await tx`
      insert into sales (studio_id, client_id, membership_id, total_amount, sold_at, sale_kind)
      values (${s.studio}, ${s.client}, ${opts.membership ?? s.pack}, 100, current_date, ${opts.kind ?? "new"})
      returning id`;
    for (const i of opts.installments ?? [])
      await tx`
        insert into sale_installments (sale_id, amount, due_date, paid)
        values (${id}, ${i.amount}, current_date + ${i.days}::int, ${i.paid})`;
    return id;
  }

  /** Занятие через days дней (групповое, персональное или диагностика). */
  async function entry(
    tx: Tx,
    s: Seed,
    days: number,
    kind: "group" | "personal" | "diagnostic" = "group",
  ) {
    const [{ id }] = await tx`
      insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
      values (${s.studio}, ${kind === "group" ? s.workout : null}, ${kind},
              now() + make_interval(days => ${days}), now() + make_interval(days => ${days}, hours => 1))
      returning id`;
    return id as string;
  }

  /**
   * Действовать как администратор клуба (auth.uid() в RPC и триггерах):
   * персональные записи ставит только сотрудник. Учётная запись — в обход
   * handle_new_user: тот пускает в приложение только по карточке клиента.
   */
  async function asStaff(tx: Tx, s: Seed) {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`admin-${s.studio}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${s.studio}, 'admin')`;
    await tx`select set_config('request.jwt.claim.sub', ${id}::text, true)`;
  }

  async function book(tx: Tx, s: Seed, entryId: string) {
    const [{ id }] = await tx`
      insert into schedule_bookings (studio_id, entry_id, client_id, status)
      values (${s.studio}, ${entryId}, ${s.client}, 'booked') returning id`;
    return id as string;
  }

  async function membershipOf(tx: Tx, saleId: string) {
    const [row] = await tx`
      select status, started_at, ends_at, visits_left, personal_left, starts_on_first_visit
        from client_memberships where sale_id = ${saleId}`;
    return row as {
      status: string;
      started_at: Date | null;
      ends_at: Date | null;
      visits_left: number | null;
      personal_left: number;
      starts_on_first_visit: boolean;
    };
  }

  /** Дата начала занятия по Тбилиси (с неё считается срок). */
  async function tbilisiDate(tx: Tx, entryId: string) {
    const [{ d }] = await tx`
      select ((starts_at at time zone 'Asia/Tbilisi')::date)::text as d
        from schedule_entries where id = ${entryId}`;
    return d as string;
  }

  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  // ---- 5. Роль «Старший администратор» ----

  test("старший администратор — допустимая роль, выдуманная — нет", async () => {
    await scenario(async (tx) => {
      expect(
        await failure(
          tx,
          () => tx`insert into trainers (full_name, role) values ('Ольга', 'senior_admin')`,
        ),
      ).toBeNull();
      expect(
        await failure(
          tx,
          () => tx`insert into trainers (full_name, role) values ('Ольга', 'boss')`,
        ),
      ).toContain("trainers_role_check");
    });
  });

  // ---- 10. Срок с первого посещения ----

  test("новая продажа пакетного клуба ждёт первого посещения, подписочного — идёт со дня продажи", async () => {
    await scenario(async (tx) => {
      const p = await seed(tx);
      const m = await membershipOf(tx, await sell(tx, p));
      expect(m).toMatchObject({
        status: "active",
        started_at: null,
        ends_at: null,
        visits_left: 2,
      });
      expect(m.starts_on_first_visit).toBe(true);

      const s = await seed(tx, "subscription");
      const sub = await membershipOf(tx, await sell(tx, s));
      expect(sub.status).toBe("active");
      expect(sub.starts_on_first_visit).toBe(false);
      const [{ today }] = await tx`select current_date::text as today`;
      expect(iso(sub.started_at)).toBe(today);
      expect(sub.ends_at).not.toBeNull();
    });
  });

  test("первое посещение начинает срок, снятая отметка возвращает «ожидает посещения»", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s);
      const later = await entry(tx, s, 5);
      const earlier = await entry(tx, s, 2);
      const bLater = await book(tx, s, later);
      const bEarlier = await book(tx, s, earlier);

      await tx`update schedule_bookings set status = 'attended' where id = ${bLater}`;
      let m = await membershipOf(tx, sale);
      const laterDay = await tbilisiDate(tx, later);
      expect(iso(m.started_at)).toBe(laterDay);
      const [{ end }] = await tx`select (${laterDay}::date + 30)::text as end`;
      expect(iso(m.ends_at)).toBe(end);
      expect(m.visits_left).toBe(1);

      // Отметили и более раннее занятие — начало срока сдвигается на него,
      // конец — на столько же.
      await tx`update schedule_bookings set status = 'attended' where id = ${bEarlier}`;
      m = await membershipOf(tx, sale);
      const earlierDay = await tbilisiDate(tx, earlier);
      expect(iso(m.started_at)).toBe(earlierDay);
      const [{ end2 }] = await tx`select (${earlierDay}::date + 30)::text as end2`;
      expect(iso(m.ends_at)).toBe(end2);
      expect(m.visits_left).toBe(0);

      await tx`update schedule_bookings set status = 'booked' where id in (${bLater}, ${bEarlier})`;
      m = await membershipOf(tx, sale);
      expect(m).toMatchObject({
        status: "active",
        started_at: null,
        ends_at: null,
        visits_left: 2,
      });
    });
  });

  // ---- 16. «Посетил» без абонемента ----

  test("«Посетил» без остатка — ошибка; неуважительный пропуск — фиксируется без списания", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s);
      const bookings = [];
      for (const d of [1, 2, 3, 4]) bookings.push(await book(tx, s, await entry(tx, s, d)));

      await tx`update schedule_bookings set status = 'attended' where id in (${bookings[0]}, ${bookings[1]})`;
      expect((await membershipOf(tx, sale)).visits_left).toBe(0);

      const err = await failure(
        tx,
        () => tx`update schedule_bookings set status = 'attended' where id = ${bookings[2]}`,
      );
      expect(err).toContain("нет абонемента с остатком");

      await tx`
        update schedule_bookings set status = 'no_show', no_show_excused = false
         where id = ${bookings[3]}`;
      const [nb] = await tx`
        select status, charged_membership_id from schedule_bookings where id = ${bookings[3]}`;
      expect(nb).toMatchObject({ status: "no_show", charged_membership_id: null });

      // Продали абонемент — то же посещение отмечается и списывается с него.
      const sale2 = await sell(tx, s);
      expect(
        await failure(
          tx,
          () => tx`update schedule_bookings set status = 'attended' where id = ${bookings[2]}`,
        ),
      ).toBeNull();
      expect((await membershipOf(tx, sale2)).visits_left).toBe(1);
    });
  });

  test("без абонемента нельзя отметить и персональное, а в подписочном клубе — можно", async () => {
    await scenario(async (tx) => {
      const p = await seed(tx);
      await asStaff(tx, p);
      const personal = await book(tx, p, await entry(tx, p, 1, "personal"));
      expect(
        await failure(
          tx,
          () => tx`update schedule_bookings set status = 'attended' where id = ${personal}`,
        ),
      ).toContain("нет абонемента");

      const s = await seed(tx, "subscription");
      const b = await book(tx, s, await entry(tx, s, 1));
      expect(
        await failure(
          tx,
          () => tx`update schedule_bookings set status = 'attended' where id = ${b}`,
        ),
      ).toBeNull();
    });
  });

  // ---- 15. Запись сверх остатка ----

  test("с 2 тренировками на балансе клиент записывается из приложения на 4 занятия", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: user }] = await tx`
        insert into auth.users (email) select email from clients where id = ${s.client}
        returning id`;
      await tx`update clients set user_id = ${user} where id = ${s.client}`;
      await sell(tx, s);
      await tx`select set_config('request.jwt.claim.sub', ${user}::text, true)`;
      for (const d of [1, 2, 3, 4]) {
        const [{ r }] = await tx`select book_schedule_entry(${await entry(tx, s, d)}) as r`;
        expect(r).toMatchObject({ ok: true, waitlisted: false });
      }
      const [{ n }] = await tx`
        select count(*)::int as n from schedule_bookings
         where client_id = ${s.client} and status = 'booked'`;
      expect(n).toBe(4);
    });
  });

  // ---- 6. Возврат ----

  test("возврат: абонемент «Возврат», невнесённые платежи сняты, неотмеченные записи удалены с журналом", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s, {
        installments: [
          { amount: 50, days: 0, paid: true },
          { amount: 25, days: 30, paid: false },
          { amount: 25, days: 60, paid: false },
        ],
      });
      const attended = await book(tx, s, await entry(tx, s, 1));
      await tx`update schedule_bookings set status = 'attended' where id = ${attended}`;
      const future = await book(tx, s, await entry(tx, s, 3));
      await asStaff(tx, s);
      const personalEntry = await entry(tx, s, 4, "personal");
      const personal = await book(tx, s, personalEntry);
      const [{ logs }] = await tx`
        select count(*)::int as logs from bookings_log where booking_id = ${future}`;
      expect(logs).toBe(1);

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${sale}, 40)`;

      expect((await membershipOf(tx, sale)).status).toBe("refunded");
      const inst = await tx`
        select paid, refunded from sale_installments where sale_id = ${sale} order by due_date`;
      expect(inst).toEqual([
        { paid: true, refunded: false },
        { paid: false, refunded: true },
        { paid: false, refunded: true },
      ]);
      const left = await tx`
        select id, status from schedule_bookings where client_id = ${s.client} order by id`;
      // Отмеченное посещение остаётся; будущая групповая — удалена; персональная —
      // с другого вида баланса, её возврат пакета тренировок не трогает.
      expect(left.map((r: { id: string }) => r.id).sort()).toEqual([attended, personal].sort());
      const [{ logs2 }] = await tx`
        select count(*)::int as logs2 from bookings_log where booking_id = ${future}`;
      expect(logs2).toBe(0);

      const [row] = await tx`
        select membership_status, payment_state, next_due_date
          from client_packages_list where id = ${sale}`;
      expect(row).toMatchObject({
        membership_status: "refunded",
        payment_state: "refunded",
        next_due_date: null,
      });
      // С возвратом записаться уже нельзя.
      const [{ cnt }] = await tx`
        select count(*)::int as cnt from client_memberships
         where client_id = ${s.client} and status in ('active', 'frozen', 'pending')`;
      expect(cnt).toBe(0);
    });
  });

  test("возврат при ждущем продлении: записи остаются, продление становится текущим", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s);
      const renewal = await sell(tx, s, { kind: "renewal" });
      expect((await membershipOf(tx, renewal)).status).toBe("pending");
      const future = await book(tx, s, await entry(tx, s, 3));

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${sale}, 100)`;

      expect((await membershipOf(tx, sale)).status).toBe("refunded");
      expect((await membershipOf(tx, renewal)).status).toBe("active");
      const [{ n }] =
        await tx`select count(*)::int as n from schedule_bookings where id = ${future}`;
      expect(n).toBe(1);
    });
  });

  test("возврат пакета персональных удаляет только персональные записи", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await sell(tx, s);
      const personalSale = await sell(tx, s, { membership: s.personalPack });
      await asStaff(tx, s);
      const group = await book(tx, s, await entry(tx, s, 2));
      const personal = await book(tx, s, await entry(tx, s, 3, "personal"));

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${personalSale}, 80)`;

      expect((await membershipOf(tx, personalSale)).status).toBe("refunded");
      const ids = (await tx`select id from schedule_bookings where client_id = ${s.client}`).map(
        (r: { id: string }) => r.id,
      );
      expect(ids).toContain(group);
      expect(ids).not.toContain(personal);
    });
  });

  test("возврат по уже заменённому абонементу: строка «Возврат», а не «Оплачен полностью»", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const old = await sell(tx, s, {
        installments: [
          { amount: 50, days: 0, paid: true },
          { amount: 50, days: 30, paid: false },
        ],
      });
      await sell(tx, s); // новая продажа заменила прежний абонемент
      expect((await membershipOf(tx, old)).status).toBe("replaced");

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${old}, 50)`;

      const [row] = await tx`
        select membership_status, payment_state from client_packages_list where id = ${old}`;
      expect(row).toMatchObject({ membership_status: "replaced", payment_state: "refunded" });
    });
  });

  test("возврат в подписочном клубе абонемент и записи не трогает", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, "subscription");
      const sale = await sell(tx, s, {
        installments: [
          { amount: 50, days: 0, paid: true },
          { amount: 50, days: 30, paid: false },
        ],
      });
      const future = await book(tx, s, await entry(tx, s, 3));

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${sale}, 50)`;

      expect((await membershipOf(tx, sale)).status).toBe("active");
      const [{ refunded }] = await tx`
        select count(*) filter (where refunded)::int as refunded from sale_installments
         where sale_id = ${sale}`;
      expect(refunded).toBe(0);
      const [{ n }] =
        await tx`select count(*)::int as n from schedule_bookings where id = ${future}`;
      expect(n).toBe(1);
    });
  });

  // ---- 11. Замена тренера ----

  test("замена уходит вместе с тренером занятия; заменить тренера им же нельзя", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const e = await entry(tx, s, 2);
      const [{ id: anna }] = await tx`
        insert into trainers (full_name, role) values ('Анна', 'trainer') returning id`;
      const [{ id: olga }] = await tx`
        insert into trainers (full_name, role) values ('Ольга', 'trainer') returning id`;
      await tx`insert into schedule_entry_trainers (entry_id, trainer_id) values (${e}, ${olga})`;

      // Замена — только у тренера, который стоит на занятии.
      expect(
        await failure(
          tx,
          () => tx`
            insert into schedule_entry_substitutions (entry_id, trainer_id, replaced_trainer_id)
            values (${e}, ${anna}, ${olga})`,
        ),
      ).toContain("foreign key");
      expect(
        await failure(
          tx,
          () => tx`
            insert into schedule_entry_substitutions (entry_id, trainer_id, replaced_trainer_id)
            values (${e}, ${olga}, ${olga})`,
        ),
      ).toContain("schedule_entry_substitutions_not_self");

      await tx`
        insert into schedule_entry_substitutions (entry_id, trainer_id, replaced_trainer_id)
        values (${e}, ${olga}, ${anna})`;
      await tx`delete from schedule_entry_trainers where entry_id = ${e} and trainer_id = ${olga}`;
      const [{ n }] = await tx`
        select count(*)::int as n from schedule_entry_substitutions where entry_id = ${e}`;
      expect(n).toBe(0);
    });
  });

  test("у таблицы замен одна связь с trainers — прежние запросы тренеров однозначны", async () => {
    await scenario(async (tx) => {
      // PostgREST считает таблицу связкой «многие ко многим», только если обе
      // её связи входят в первичный ключ; replaced_trainer_id — не входит.
      const fks = await tx`
        select c.conname, c.confrelid::regclass::text as target,
               array(select a.attname from unnest(c.conkey) k
                     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)::text[] as cols
          from pg_constraint c
         where c.conrelid = 'public.schedule_entry_substitutions'::regclass and c.contype = 'f'
         order by c.conname`;
      const toTrainers = fks.filter((f: { target: string }) => f.target === "trainers");
      expect(toTrainers.map((f: { cols: string[] }) => f.cols)).toEqual([["replaced_trainer_id"]]);
      const [{ pk }] = await tx`
        select array(select a.attname from pg_index i
                     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                      where i.indrelid = 'public.schedule_entry_substitutions'::regclass
                        and i.indisprimary order by a.attname)::text[] as pk`;
      expect(pk).toEqual(["entry_id", "trainer_id"]);
    });
  });
  // ---- Общий каталог пакетных клубов (2026-10-13) ----

  test("сотрудник пакетного клуба видит и правит тренировки и номенклатуру другого пакетного, но не подписочного", async () => {
    await scenario(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      const c = await seed(tx, "subscription");
      await asStaff(tx, a);
      await tx`set local role authenticated`;

      const workouts = await tx`
        select id from workouts where id in (${b.workout}, ${c.workout})`;
      expect(workouts.map((w: { id: string }) => w.id)).toEqual([b.workout]);
      const renamed = await tx`
        update workouts set name = 'Растяжка' where id in (${b.workout}, ${c.workout}) returning id`;
      expect(renamed.map((w: { id: string }) => w.id)).toEqual([b.workout]);
      const hidden = await tx`
        update memberships set is_active = false where id in (${b.pack}, ${c.pack}) returning id`;
      expect(hidden.map((m: { id: string }) => m.id)).toEqual([b.pack]);
      // Новую тренировку можно завести в своём клубе, в чужом подписочном — нет.
      expect(
        await failure(
          tx,
          () => tx`insert into workouts (studio_id, name) values (${a.studio}, 'Пилатес')`,
        ),
      ).toBeNull();
      expect(
        await failure(
          tx,
          () => tx`insert into workouts (studio_id, name) values (${c.studio}, 'Пилатес')`,
        ),
      ).toContain("row-level security");
      await tx`reset role`;
    });
  });

  test("клиент не оформляет себе продажу в пакетном клубе; в подписочном — только из своего каталога", async () => {
    await scenario(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      const c = await seed(tx, "subscription");
      // Покупатель — не сотрудник: guard проверяет клуб и пакет.
      await tx`select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true)`;
      const buy = (s: Seed, membership: string) => () =>
        tx`insert into sales (studio_id, client_id, membership_id, total_amount)
           values (${s.studio}, ${s.client}, ${membership}, 100)`;
      // Пакетный клуб: оплаты в приложении нет — продажу вносит администратор (2026-10-16).
      expect(await failure(tx, buy(a, a.pack))).toContain("Покупка в приложении недоступна");
      expect(await failure(tx, buy(a, b.pack))).toContain("Покупка в приложении недоступна");
      // Подписочный — как раньше: свой каталог можно, пакетный — нет.
      expect(await failure(tx, buy(c, c.pack))).toBeNull();
      expect(await failure(tx, buy(c, b.pack))).toContain("Абонемент недоступен для покупки");
    });
  });

  test("слияние каталога: одинаковые тренировки и пакеты пакетных клубов — одна строка, ссылки переведены", async () => {
    await scenario(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      const c = await seed(tx, "subscription");
      await tx`update workouts set name = '  стретчинг ', color = '#ff0000' where id = ${b.workout}`;
      const [{ id: pricier }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
        values (${b.studio}, 'Пакет 2', 'package', 2, 30, 120) returning id`;
      const e = await entry(tx, b, 1);
      const sale = await sell(tx, b);

      await tx`select packages_merge_catalog()`;

      const workouts = await tx`
        select id, color from workouts where id in (${a.workout}, ${b.workout})`;
      expect(workouts.length).toBe(1);
      const kept = workouts[0] as { id: string; color: string | null };
      expect(kept.color).toBe("#ff0000");
      const [{ workout_id }] = await tx`select workout_id from schedule_entries where id = ${e}`;
      expect(workout_id).toBe(kept.id);
      // Подписочный клуб не трогается.
      const [{ n: subs }] =
        await tx`select count(*)::int as n from workouts where id = ${c.workout}`;
      expect(subs).toBe(1);

      const packs = await tx`select id from memberships where id in (${a.pack}, ${b.pack})`;
      expect(packs.length).toBe(1);
      const keptPack = (packs[0] as { id: string }).id;
      const [{ membership_id }] = await tx`select membership_id from sales where id = ${sale}`;
      expect(membership_id).toBe(keptPack);
      const [{ cm }] = await tx`
        select membership_id as cm from client_memberships where sale_id = ${sale}`;
      expect(cm).toBe(keptPack);
      // Другая цена — другой пакет.
      const [{ n: other }] =
        await tx`select count(*)::int as n from memberships where id = ${pricier}`;
      expect(other).toBe(1);

      // Повторный вызов ничего не меняет.
      await tx`select packages_merge_catalog()`;
      const [{ n: left }] = await tx`
        select count(*)::int as n from memberships where studio_id in (${a.studio}, ${b.studio})`;
      expect(left).toBe(3);
    });
  });

  test("удаление пакетного клуба переносит его каталог в другой пакетный клуб", async () => {
    await scenario(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      // Занятие клуба A по тренировке, заведённой в B.
      const [{ id: e }] = await tx`
        insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
        values (${a.studio}, ${b.workout}, 'group', now() + interval '1 day', now() + interval '1 day 1 hour')
        returning id`;
      await tx`delete from studios where id = ${b.studio}`;

      const [{ studio_id }] = await tx`select studio_id from workouts where id = ${b.workout}`;
      expect(studio_id).toBe(a.studio);
      const [{ n }] = await tx`select count(*)::int as n from schedule_entries where id = ${e}`;
      expect(n).toBe(1);
      const [{ m }] = await tx`select studio_id as m from memberships where id = ${b.pack}`;
      expect(m).toBe(a.studio);
    });
  });
  // ---- 2026-10-14: гостевые посещения, вместимость по клубам, статус без пробных ----

  /** Учётная запись клиента приложения, привязанная к карточке s.client; действовать от неё. */
  async function asClient(tx: Tx, s: Seed) {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`client-${s.studio}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`update clients set user_id = ${id} where id = ${s.client}`;
    await tx`select set_config('request.jwt.claim.sub', ${id}::text, true)`;
    return id as string;
  }

  test("клиент пакетного клуба записывается в другой пакетный клуб, посещение — с его абонемента", async () => {
    await scenario(async (tx) => {
      const home = await seed(tx);
      const other = await seed(tx);
      const sale = await sell(tx, home);
      const e = await entry(tx, other, 1);

      const user = await asClient(tx, home);
      const [{ r }] = await tx`select book_schedule_entry(${e}) as r`;
      expect(r).toMatchObject({ ok: true, waitlisted: false });
      const [b] = await tx`
        select id, studio_id, client_id, user_id from schedule_bookings where entry_id = ${e}`;
      expect(b).toMatchObject({ studio_id: other.studio, client_id: home.client, user_id: user });

      // Администратор клуба занятия видит гостя: имя, клуб, остаток.
      await asStaff(tx, other);
      const [{ g }] = await tx`select entry_guest_clients(${e}) as g`;
      expect(g).toHaveLength(1);
      expect(g[0]).toMatchObject({ id: home.client, home_studio_name: "Тест", ahead: 0 });
      expect(g[0].memberships[0]).toMatchObject({ status: "active", visits_left: 2 });

      await tx`update schedule_bookings set status = 'attended' where id = ${b.id}`;
      const m = await membershipOf(tx, sale);
      expect(m.visits_left).toBe(1);
      expect(m.started_at).not.toBeNull();
    });
  });

  test("гостевая запись: администратор записывает клиента сети, подписочный клуб — не сеть", async () => {
    await scenario(async (tx) => {
      const home = await seed(tx);
      const other = await seed(tx);
      const sub = await seed(tx, "subscription");
      await sell(tx, home);
      await sell(tx, sub);
      const e = await entry(tx, other, 1);

      await asStaff(tx, other);
      const [{ r }] = await tx`select admin_book_client(${e}, ${home.client}) as r`;
      expect(r).toMatchObject({ ok: true });
      const [{ r: denied }] = await tx`select admin_book_client(${e}, ${sub.client}) as r`;
      expect(denied).toMatchObject({ ok: false, reason: "client_not_found" });

      // Клиент подписочного клуба в пакетный не записывается (2026-10-19:
      // абонемент в пакетном клубе не нужен — не пускает карточка не из сети).
      await asClient(tx, sub);
      const [{ r: own }] = await tx`select book_schedule_entry(${e}) as r`;
      expect(own).toMatchObject({ ok: false, reason: "no_client" });
    });
  });

  // ---- 2026-10-19: запись без абонемента в пакетном клубе ----

  test("без абонемента клиент пакетного клуба записывается, «Посетил» — только после продажи", async () => {
    await scenario(async (tx) => {
      const p = await seed(tx);
      const e = await entry(tx, p, 1);
      const uid = await asClient(tx, p);
      const [{ r }] = await tx`select book_schedule_entry(${e}) as r`;
      expect(r).toMatchObject({ ok: true, waitlisted: false, has_membership: false });
      const [b] = await tx`select id, client_id, status from schedule_bookings where entry_id = ${e}`;
      expect(b).toMatchObject({ client_id: p.client, status: "booked" });

      // Пакет персональных на групповую не в счёт.
      await tx`select set_config('request.jwt.claim.sub', '', true)`;
      await sell(tx, p, { membership: p.personalPack });
      await tx`select set_config('request.jwt.claim.sub', ${uid}::text, true)`;
      const [{ r: second }] = await tx`select book_schedule_entry(${await entry(tx, p, 2)}) as r`;
      expect(second).toMatchObject({ ok: true, has_membership: false });

      await asStaff(tx, p);
      expect(
        await failure(tx, () => tx`update schedule_bookings set status = 'attended' where id = ${b.id}`),
      ).toContain("нет абонемента");
      await sell(tx, p);
      expect(
        await failure(tx, () => tx`update schedule_bookings set status = 'attended' where id = ${b.id}`),
      ).toBeNull();

      // С действующим абонементом — has_membership.
      await tx`select set_config('request.jwt.claim.sub', ${uid}::text, true)`;
      const [{ r: third }] = await tx`select book_schedule_entry(${await entry(tx, p, 3)}) as r`;
      expect(third).toMatchObject({ ok: true, has_membership: true });
    });
  });

  test("подписочный клуб без абонемента по-прежнему не записывает", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, "subscription");
      const e = await entry(tx, s, 1);
      await asClient(tx, s);
      const [{ r }] = await tx`select book_schedule_entry(${e}) as r`;
      expect(r).toMatchObject({ ok: false, reason: "no_membership" });
      const [{ n }] = await tx`select count(*)::int as n from schedule_bookings where entry_id = ${e}`;
      expect(n).toBe(0);
    });
  });

  test("вместимость тренировки — своя в каждом клубе, занятие берёт её при создании", async () => {
    await scenario(async (tx) => {
      const a = await seed(tx);
      const b = await seed(tx);
      await tx`update workouts set capacity = 12 where id = ${a.workout}`;
      await tx`
        insert into workout_capacities (workout_id, studio_id, capacity)
        values (${a.workout}, ${a.studio}, 10), (${a.workout}, ${b.studio}, 6)
        on conflict (workout_id, studio_id) do update set capacity = excluded.capacity`;
      const add = async (studio: string, capacity: number | null) => {
        const [{ id, cap }] = await tx`
          insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at, capacity)
          values (${studio}, ${a.workout}, 'group', now() + interval '1 day',
                  now() + interval '1 day 1 hour', ${capacity})
          returning id, capacity as cap`;
        return { id: id as string, cap: cap as number | null };
      };
      expect((await add(a.studio, null)).cap).toBe(10);
      expect((await add(b.studio, null)).cap).toBe(6);
      // Вручную на один день — как указали.
      expect((await add(b.studio, 8)).cap).toBe(8);
      // Клуб без своей строки — вместимость по умолчанию.
      const c = await seed(tx);
      expect((await add(c.studio, null)).cap).toBe(12);

      // Запись видит вместимость занятия: 1 место — второй в лист ожидания.
      const one = await add(b.studio, 1);
      await sell(tx, a);
      await asStaff(tx, b);
      expect((await tx`select admin_book_client(${one.id}, ${a.client}) as r`)[0].r).toMatchObject({
        ok: true,
      });
      expect((await tx`select admin_book_client(${one.id}, ${b.client}) as r`)[0].r).toMatchObject({
        ok: false,
        reason: "full",
      });
    });
  });

  test("статус клуба: только пробный — ПЧК, после пакета — ЧК, без действующих — БЧК", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: trial }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
        values (${s.studio}, 'Пробное', 'trial', 1, 7, 0) returning id`;
      const status = async () =>
        (await tx`select club_status from clients_with_status where id = ${s.client}`)[0]
          .club_status as string;

      expect(await status()).toBe("pchk");
      await sell(tx, s, { membership: trial, kind: "trial" });
      expect(await status()).toBe("pchk");
      // Пробный закончился — по-прежнему ПЧК, а не БЧК.
      await tx`update client_memberships set status = 'expired' where client_id = ${s.client}`;
      expect(await status()).toBe("pchk");

      await sell(tx, s);
      expect(await status()).toBe("chk");
      await tx`update client_memberships set status = 'expired' where client_id = ${s.client}`;
      expect(await status()).toBe("bchk");
    });
  });

  // ---- 2026-10-14. Отхоженный абонемент — «Закончился» ----

  test("отхоженный пакет и пробное — expired, снятая отметка возвращает абонемент", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: trial }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
        values (${s.studio}, 'Пробное', 'trial', 1, 7, 0) returning id`;
      const trialSale = await sell(tx, s, { membership: trial, kind: "trial" });
      const b1 = await book(tx, s, await entry(tx, s, 1));
      await tx`update schedule_bookings set status = 'attended' where id = ${b1}`;
      expect(await membershipOf(tx, trialSale)).toMatchObject({
        status: "expired",
        visits_left: 0,
      });

      const sale = await sell(tx, s);
      const b2 = await book(tx, s, await entry(tx, s, 2));
      const b3 = await book(tx, s, await entry(tx, s, 3));
      await tx`update schedule_bookings set status = 'attended' where id in (${b2}, ${b3})`;
      expect(await membershipOf(tx, sale)).toMatchObject({ status: "expired", visits_left: 0 });

      // Ошиблись с отметкой — тренировка вернулась, абонемент снова действует.
      await tx`update schedule_bookings set status = 'booked' where id = ${b3}`;
      expect(await membershipOf(tx, sale)).toMatchObject({ status: "active", visits_left: 1 });
      // Пробное так и осталось закончившимся.
      expect((await membershipOf(tx, trialSale)).status).toBe("expired");
    });
  });

  test("пакет с подарочной персональной не кончается, пока её не отходили", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await asStaff(tx, s);
      const [{ id: gift }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price)
        values (${s.studio}, 'Пакет 1 + персональная', 'package', 1, 1, 30, 100) returning id`;
      const sale = await sell(tx, s, { membership: gift });
      const group = await book(tx, s, await entry(tx, s, 1));
      await tx`update schedule_bookings set status = 'attended' where id = ${group}`;
      expect(await membershipOf(tx, sale)).toMatchObject({
        status: "active",
        visits_left: 0,
        personal_left: 1,
      });
      const personal = await book(tx, s, await entry(tx, s, 2, "personal"));
      await tx`update schedule_bookings set status = 'attended' where id = ${personal}`;
      expect(await membershipOf(tx, sale)).toMatchObject({ status: "expired", personal_left: 0 });
    });
  });

  test("отхоженный абонемент уступает место продлению, разовая правка не трогает безлимит", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s);
      const renewal = await sell(tx, s, { kind: "renewal" });
      expect((await membershipOf(tx, renewal)).status).toBe("pending");
      for (const d of [1, 2]) {
        const b = await book(tx, s, await entry(tx, s, d));
        await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      }
      expect((await membershipOf(tx, sale)).status).toBe("expired");
      expect((await membershipOf(tx, renewal)).status).toBe("active");

      // Безлимит (visits_left null) не кончается.
      await tx`update client_memberships set visits_left = null where sale_id = ${renewal}`;
      await tx`select packages_settle(${s.client})`;
      expect((await membershipOf(tx, renewal)).status).toBe("active");
    });
  });

  // ---- 2026-10-14. «Редактировать платежи» ----

  test("правка графика: внесённые не трогаются, сумма не меньше стоимости, после возврата — нельзя", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s, {
        installments: [
          { amount: 50, days: 0, paid: true },
          { amount: 25, days: 30, paid: false },
          { amount: 25, days: 60, paid: false },
        ],
      });
      const rows = async () =>
        (await tx`
          select id, amount::float as amount, paid from sale_installments
           where sale_id = ${sale} order by due_date, created_at`) as {
          id: string;
          amount: number;
          paid: boolean;
        }[];
      const [paid, second, third] = await rows();
      const replace = (r: unknown) =>
        tx`select replace_sale_installments(${sale}, ${JSON.stringify(r)}::text::jsonb)`;

      // Клиент внёс 10 из 25 — остаток 15 новым платежом.
      await replace([
        { id: second.id, amount: 10, due_date: "2030-01-10" },
        { amount: 15, due_date: "2030-02-10" },
        { id: third.id, amount: 25, due_date: "2030-03-10" },
      ]);
      let now = await rows();
      expect(now.map((r) => r.amount)).toEqual([50, 10, 15, 25]);
      const [{ ri }] = await tx`select remaining_installments as ri from sales where id = ${sale}`;
      expect(ri).toBe(3);

      // Меньше стоимости — не сохраняется.
      expect(
        await failure(tx, () => replace([{ id: second.id, amount: 10, due_date: "2030-01-10" }])),
      ).toContain("меньше стоимости");
      expect((await rows()).length).toBe(4);

      // У внесённого платежа меняется только сумма (2026-10-18): отметка и
      // дата остаются, график в сумме по-прежнему покрывает стоимость.
      const [{ due: paidDue }] = await tx`
        select due_date::text as due from sale_installments where id = ${paid.id}`;
      now = await rows();
      await replace([
        { id: paid.id, amount: 40, due_date: "2030-01-10" },
        ...now
          .slice(1)
          .map((r, i) => ({
            id: r.id,
            amount: r.amount + (i === 0 ? 10 : 0),
            due_date: `2030-0${i + 1}-10`,
          })),
      ]);
      const [edited] = await tx`
        select amount::float as amount, paid, due_date::text as due from sale_installments where id = ${paid.id}`;
      expect(edited).toEqual({ amount: 40, paid: true, due: paidDue });
      // Внесённый, которого нет в списке, не удаляется.
      now = await rows();
      await replace([
        { id: now[1].id, amount: 20, due_date: "2030-01-10" },
        { id: now[2].id, amount: 15, due_date: "2030-02-10" },
        { id: now[3].id, amount: 25, due_date: "2030-03-10" },
      ]);
      expect((await rows()).map((r) => r.amount)).toEqual([40, 20, 15, 25]);
      // Новый платёж сразу внесённым не становится.
      expect(await failure(tx, () => replace([{ amount: 10, paid: true }]))).toContain("внесённым");

      // Убрали платёж и добавили сумму в другой — всего снова 100.
      now = await rows();
      await replace([
        { id: now[1].id, amount: 20, due_date: "2030-01-10" },
        { id: now[2].id, amount: 40, due_date: "2030-02-10" },
      ]);
      expect((await rows()).map((r) => r.amount)).toEqual([40, 20, 40]);

      await tx`insert into refunds (studio_id, sale_id, amount) values (${s.studio}, ${sale}, 10)`;
      expect(await failure(tx, () => replace([{ amount: 50, due_date: "2030-01-10" }]))).toContain(
        "возврат",
      );
    });
  });

  test("правка графика у оплаченного сразу: оплата при продаже становится внесённым платежом", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const sale = await sell(tx, s);
      await tx`update sales set payment_method = 'card' where id = ${sale}`;
      const replace = (r: unknown) =>
        tx`select replace_sale_installments(${sale}, ${JSON.stringify(r)}::text::jsonb)`;

      // Внесли не 100, а 70 — остаток 30 новым платежом.
      await replace([
        { id: null, amount: 70, paid: true },
        { amount: 30, due_date: "2030-01-10" },
      ]);
      const rows = await tx`
        select amount::float as amount, paid, paid_at::text as paid_at, payment_method::text as method,
               (due_date = current_date) as sold_day
          from sale_installments where sale_id = ${sale} order by due_date`;
      expect(rows.map((r: { amount: number; paid: boolean }) => [r.amount, r.paid])).toEqual([
        [70, true],
        [30, false],
      ]);
      expect(rows[0].method).toBe("card");
      expect(rows[0].sold_day).toBe(true);
      expect(rows[0].paid_at).not.toBeNull();
      const [{ ri }] = await tx`select remaining_installments as ri from sales where id = ${sale}`;
      expect(ri).toBe(1);
      const [view] = await tx`
        select paid_amount::float as paid_amount, payment_state from client_packages_list where id = ${sale}`;
      expect(view.paid_amount).toBe(70);
      expect(view.payment_state).not.toBe("paid");

      // График уже есть — второй «оплаты при продаже» не будет.
      expect(await failure(tx, () => replace([{ id: null, amount: 100, paid: true }]))).toContain(
        "внесённым",
      );
    });
  });

  // ---- Диагностика тела (2026-10-15) ----

  test("диагностика списывается с абонемента и возвращается", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update memberships set diagnostics_count = 2 where id = ${s.pack}`;
      const sale = await sell(tx, s);
      const [{ diagnostics_left: left0 }] = await tx`
        select diagnostics_left from client_memberships where sale_id = ${sale}`;
      expect(left0).toBe(2);

      // Клиент сам на диагностику не записывается — только сотрудник.
      const diag = await entry(tx, s, 1, "diagnostic");
      expect(await failure(tx, () => book(tx, s, diag))).toContain("не групповое");

      await asStaff(tx, s);
      const b = await book(tx, s, diag);
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      const [after] = await tx`
        select cm.diagnostics_left, cm.visits_left, cm.started_at, b.charged_balance
          from client_memberships cm, schedule_bookings b
         where cm.sale_id = ${sale} and b.id = ${b}`;
      expect(after).toMatchObject({
        diagnostics_left: 1,
        visits_left: 2,
        charged_balance: "diagnostic",
      });
      // Диагностика — посещение: срок пошёл.
      expect(iso(after.started_at)).toBe(await tbilisiDate(tx, diag));

      await tx`update schedule_bookings set status = 'booked' where id = ${b}`;
      const [back] =
        await tx`select diagnostics_left from client_memberships where sale_id = ${sale}`;
      expect(back.diagnostics_left).toBe(2);

      // Удалённая запись тоже возвращает диагностику.
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      await tx`delete from schedule_bookings where id = ${b}`;
      const [del] =
        await tx`select diagnostics_left from client_memberships where sale_id = ${sale}`;
      expect(del.diagnostics_left).toBe(2);
    });
  });

  test("без диагностик на абонементе «Посетил» на диагностике не сохраняется", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await sell(tx, s);
      await asStaff(tx, s);
      const b = await book(tx, s, await entry(tx, s, 1, "diagnostic"));
      expect(
        await failure(
          tx,
          () => tx`update schedule_bookings set status = 'attended' where id = ${b}`,
        ),
      ).toContain("нет абонемента с диагностиками");
    });
  });

  test("отхоженный абонемент с диагностиками не заканчивается, пока их не пройдут", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update memberships set diagnostics_count = 1 where id = ${s.pack}`;
      const sale = await sell(tx, s);
      await asStaff(tx, s);
      const visits = [
        await book(tx, s, await entry(tx, s, 1)),
        await book(tx, s, await entry(tx, s, 2)),
      ];
      await tx`update schedule_bookings set status = 'attended' where id in (${visits[0]}, ${visits[1]})`;
      expect((await membershipOf(tx, sale)).status).toBe("active");

      const d = await book(tx, s, await entry(tx, s, 3, "diagnostic"));
      await tx`update schedule_bookings set status = 'attended' where id = ${d}`;
      expect((await membershipOf(tx, sale)).status).toBe("expired");

      // Сняли отметку с диагностики — абонемент снова действующий.
      await tx`update schedule_bookings set status = 'booked' where id = ${d}`;
      expect((await membershipOf(tx, sale)).status).toBe("active");
    });
  });

  // ---- Заявки клиентов (2026-10-15) ----

  test("заявка клиента: одна неотработанная на вид, «Отработано» ставит база", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`set local session_replication_role = replica`;
      const [{ id: uid }] = await tx`
        insert into auth.users (email) values (${`client-${s.studio}@example.com`}) returning id`;
      await tx`set local session_replication_role = origin`;
      await tx`update clients set user_id = ${uid} where id = ${s.client}`;
      await tx`select set_config('request.jwt.claim.sub', ${uid}::text, true)`;

      const [{ r: first }] = await tx`
        select create_client_request('personal', array['flexibility', 'flexibility', 'other'],
                                     'Осанка', 'Удобно вечером') as r`;
      expect(first.ok).toBe(true);
      const [{ r: again }] = await tx`select create_client_request('personal') as r`;
      expect(again).toMatchObject({ ok: false, reason: "pending" });
      const [{ r: diag }] = await tx`select create_client_request('diagnostic') as r`;
      expect(diag.ok).toBe(true);

      const [row] = await tx`
        select studio_id, goals, goal_other, comment from client_requests where id = ${first.id}`;
      expect(row.studio_id).toBe(s.studio);
      expect([...row.goals].sort()).toEqual(["flexibility", "other"]);
      expect(row).toMatchObject({ goal_other: "Осанка", comment: "Удобно вечером" });

      await asStaff(tx, s);
      await tx`
        update client_requests set processed_at = '2000-01-01', comment = 'подмена'
         where id = ${first.id}`;
      const [done] = await tx`
        select processed_at, processed_by, comment from client_requests where id = ${first.id}`;
      expect(done.comment).toBe("Удобно вечером");
      expect(done.processed_by).not.toBeNull();
      expect(new Date(done.processed_at).getFullYear()).toBeGreaterThan(2000);
    });
  });

  // ---- 2026-10-15. Разовое посещение ----

  test("разовое посещение: условия постоянные, 1 групповая, в приложении не покупается", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      // Миграция заводит одну строку в общем каталоге; повторный прогон — не дублирует.
      const migration = await Bun.file(
        new URL("./migrations/2026-10-15_zz_packages_single_visit.sql", import.meta.url),
      ).text();
      await tx.unsafe(migration);
      await tx.unsafe(migration);
      // Повторный прогон вернул прежний guard покупки — актуальный (2026-10-16) поверх.
      await tx.unsafe(
        await Bun.file(
          new URL("./migrations/2026-10-16_packages_no_app_purchase.sql", import.meta.url),
        ).text(),
      );
      const singles = await tx`
        select id, name, visits_count, personal_count, duration_days, max_payments, price, is_active
          from memberships where kind = 'single'`;
      expect(singles.length).toBe(1);
      expect(singles[0]).toMatchObject({
        name: "Разовое посещение",
        visits_count: 1,
        personal_count: 0,
        duration_days: 30,
        max_payments: 1,
        is_active: true,
      });
      const single = singles[0].id as string;

      // Другие условия база не сохраняет; стоимость — любая.
      expect(
        await failure(tx, () => tx`update memberships set visits_count = 2 where id = ${single}`),
      ).toContain("memberships_single_terms_check");
      expect(
        await failure(tx, () => tx`update memberships set max_payments = 3 where id = ${single}`),
      ).toContain("memberships_single_terms_check");
      await tx`update memberships set price = 35 where id = ${single}`;

      // Администратор продаёт: 1 групповая, посещение списывает её — «Закончился».
      const sale = await sell(tx, s, { membership: single });
      const [cm] = await tx`
        select visits_left, personal_left, balance_kind from client_memberships where sale_id = ${sale}`;
      expect(cm).toMatchObject({ visits_left: 1, personal_left: 0, balance_kind: "group" });
      const b = await book(tx, s, await entry(tx, s, 1));
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      expect(await membershipOf(tx, sale)).toMatchObject({ status: "expired", visits_left: 0 });

      // Клиент в приложении ничего не оформляет: покупка в пакетном клубе закрыта (2026-10-16).
      await tx`select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true)`;
      const buy = (membership: string) => () =>
        tx`insert into sales (studio_id, client_id, membership_id, total_amount)
           values (${s.studio}, ${s.client}, ${membership}, 35)`;
      expect(await failure(tx, buy(single))).toContain("Покупка в приложении недоступна");
      expect(await failure(tx, buy(s.pack))).toContain("Покупка в приложении недоступна");
    });
  });
  test("разовое посещение не вытесняет пакет и не вытесняется им — встаёт в очередь", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await asStaff(tx, s);
      const [{ id: single }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price, max_payments)
        values (${s.studio}, 'Разовое', 'single', 1, 0, 30, 30, 1) returning id`;

      // Живой пакет (2 тренировки, одна отхожена) — разовое продано как «Новая».
      const pack = await sell(tx, s);
      const b = await book(tx, s, await entry(tx, s, -1));
      await tx`update schedule_bookings set status = 'attended' where id = ${b}`;
      const one = await sell(tx, s, { membership: single, kind: "new" });
      expect(await membershipOf(tx, pack)).toMatchObject({ status: "active", visits_left: 1 });
      expect(await membershipOf(tx, one)).toMatchObject({ status: "pending", visits_left: 1 });

      // Последняя тренировка пакета — дальше списывается разовое.
      const b2 = await book(tx, s, await entry(tx, s, 1));
      await tx`update schedule_bookings set status = 'attended' where id = ${b2}`;
      expect(await membershipOf(tx, pack)).toMatchObject({ status: "expired", visits_left: 0 });
      expect(await membershipOf(tx, one)).toMatchObject({ status: "active", visits_left: 1 });

      // Пакет при неиспользованном разовом — тоже в очередь, разовое остаётся.
      const next = await sell(tx, s, { kind: "new" });
      expect(await membershipOf(tx, one)).toMatchObject({ status: "active", visits_left: 1 });
      expect(await membershipOf(tx, next)).toMatchObject({ status: "pending", visits_left: 2 });

      // Пакет при живом пакете — как раньше, заменяет.
      const b3 = await book(tx, s, await entry(tx, s, 2));
      await tx`update schedule_bookings set status = 'attended' where id = ${b3}`;
      expect(await membershipOf(tx, one)).toMatchObject({ status: "expired", visits_left: 0 });
      expect(await membershipOf(tx, next)).toMatchObject({ status: "active" });
      const upsell = await sell(tx, s, { kind: "upsell" });
      expect(await membershipOf(tx, next)).toMatchObject({ status: "replaced" });
      expect(await membershipOf(tx, upsell)).toMatchObject({ status: "active" });
    });
  });

  test("сравнение со студией: диагностика — не посещение", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await tx`update memberships set diagnostics_count = 1 where id = ${s.pack}`;
      await sell(tx, s);
      await asStaff(tx, s);
      const d = await book(tx, s, await entry(tx, s, -1, "diagnostic"));
      await tx`update schedule_bookings set status = 'attended' where id = ${d}`;
      const g = await book(tx, s, await entry(tx, s, -2));
      await tx`update schedule_bookings set status = 'attended' where id = ${g}`;

      // Ещё 4 клиента студии — по 2 посещения в журнале.
      await tx`
        insert into bookings_log (studio_id, client_id, status, starts_at, ends_at)
        select ${s.studio}, c.id, 'attended', now() - interval '3 days', now() - interval '3 days'
          from (select gen_random_uuid() as id from generate_series(1, 4)) c
          cross join generate_series(1, 2) n`;

      await tx`set local session_replication_role = replica`;
      const [{ id: uid }] = await tx`
        insert into auth.users (email) values (${`anna-${s.studio}@example.com`}) returning id`;
      await tx`set local session_replication_role = origin`;
      await tx`update clients set user_id = ${uid} where id = ${s.client}`;
      await tx`select set_config('request.jwt.claim.sub', ${uid}::text, true)`;
      const [{ total }] = await tx`
        select count(*)::int as total from bookings_log l
         where l.client_id = ${s.client} and l.status = 'attended'`;
      expect(total).toBe(2);
      const [{ stats }] = await tx`select my_studio_visit_stats() as stats`;
      // Своё посещение одно (диагностика не в счёт), у остальных по два — все выше.
      expect(stats.total_cohort).toBe(5);
      expect(stats.total_top_pct).toBe(100);
    });
  });

  // ---- 2026-10-18. Фильтры «Абонементов» ----

  test("вью абонементов: продавец, остаток баланса и статус как у бейджа", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      const [{ id: seller }] = await tx`
        insert into trainers (full_name, role) values ('Ольга', 'admin') returning id`;
      const pack = await sell(tx, s);
      await tx`update sales set seller_id = ${seller} where id = ${pack}`;
      const personal = await sell(tx, s, { membership: s.personalPack, kind: "upsell" });

      const row = async (id: string) => {
        const [r] = await tx`
          select seller_id, balance_left, membership_state
            from client_packages_list where id = ${id}`;
        return r;
      };
      // Без первого посещения — «Ожидает посещения»; баланс — групповые.
      expect(await row(pack)).toEqual({
        seller_id: seller,
        balance_left: 2,
        membership_state: "awaiting",
      });
      // Пакет персональных: баланс — персональные.
      expect(await row(personal)).toMatchObject({ seller_id: null, balance_left: 1 });

      // Действующий с прошедшим сроком — «Истёк», как у бейджа.
      await tx`set local session_replication_role = replica`;
      await tx`
        update client_memberships
           set status = 'active', started_at = current_date - 40, ends_at = current_date - 10
         where sale_id = ${pack}`;
      await tx`set local session_replication_role = origin`;
      expect((await row(pack)).membership_state).toBe("expired");
      await tx`update client_memberships set status = 'frozen' where sale_id = ${pack}`;
      expect((await row(pack)).membership_state).toBe("frozen");
    });
  });
});
