/**
 * Тесты общей базы клиентов пакетных клубов (2026-10-17,
 * db/migrations/2026-10-17_packages_shared_clients.sql): карточку клиента
 * видят и ведут сотрудники любого пакетного клуба, продажа — клуба, где её
 * внесли; запись и списание во всех клубах сети; одна карточка на человека;
 * слияние дублей; удаление клуба; подписочные клубы — как раньше.
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
type Format = "packages" | "subscription";

class Rollback extends Error {}

describe.skipIf(!url)("общая база клиентов пакетных клубов (база)", () => {
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

  async function studio(tx: Tx, format: Format = "packages", name = "Клуб"): Promise<string> {
    const [{ id }] = await tx`insert into studios (name, format) values (${name}, ${format}) returning id`;
    return id as string;
  }

  /** Учётная запись в обход handle_new_user (тот пускает только по карточке). */
  async function user(tx: Tx, email = `u-${crypto.randomUUID()}@example.com`): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function staff(tx: Tx, studioId: string, role = "admin"): Promise<string> {
    const id = await user(tx, `staff-${crypto.randomUUID()}@example.com`);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, ${role})`;
    return id;
  }

  async function client(
    tx: Tx,
    studioId: string,
    opts: { email?: string | null; userId?: string | null; first?: string; last?: string } = {},
  ): Promise<string> {
    const email = opts.email === undefined ? `c-${crypto.randomUUID()}@example.com` : opts.email;
    const [{ id }] = await tx`
      insert into clients (studio_id, first_name, last_name, email, user_id)
      values (${studioId}, ${opts.first ?? "Анна"}, ${opts.last ?? "Тестова"}, ${email},
              ${opts.userId ?? null})
      returning id`;
    return id as string;
  }

  /** Действовать от учётной записи (auth.uid() и роль authenticated — RLS действует). */
  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }

  /** Обратно — от владельца базы (как мигратор и сервер): RLS не действует. */
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  /** Пакет каталога (каталог пакетных клубов общий — заводим в любом). */
  async function pack(
    tx: Tx,
    studioId: string,
    opts: { kind?: string; visits?: number; personal?: number; freezeDays?: number } = {},
  ): Promise<string> {
    const kind = opts.kind ?? "package";
    const [{ id }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days,
                               price, freeze_days_allowed)
      values (${studioId}, ${kind === "personal" ? "Персональные" : "Пакет"}, ${kind},
              ${kind === "personal" ? 0 : (opts.visits ?? 2)}, ${opts.personal ?? (kind === "personal" ? 1 : 0)},
              30, 100, ${opts.freezeDays ?? 0})
      returning id`;
    return id as string;
  }

  /** Продажа от имени текущего вызывающего (сотрудник — с RLS, сервер — без). */
  async function sell(
    tx: Tx,
    studioId: string,
    clientId: string,
    membershipId: string,
    kind = "new",
  ): Promise<string> {
    const [{ id }] = await tx`
      insert into sales (studio_id, client_id, membership_id, total_amount, sold_at, sale_kind)
      values (${studioId}, ${clientId}, ${membershipId}, 100, current_date, ${kind})
      returning id`;
    return id as string;
  }

  async function membershipOfSale(tx: Tx, saleId: string) {
    const [row] = await tx`
      select id, studio_id, client_id, status, visits_left, personal_left
        from client_memberships where sale_id = ${saleId}`;
    return row as {
      id: string;
      studio_id: string;
      client_id: string;
      status: string;
      visits_left: number | null;
      personal_left: number;
    };
  }

  async function workout(tx: Tx, studioId: string): Promise<string> {
    const [{ id }] = await tx`insert into workouts (studio_id, name) values (${studioId}, 'Стретчинг') returning id`;
    return id as string;
  }

  /** Занятие через days дней (групповое — по тренировке, персональное — без). */
  async function entry(
    tx: Tx,
    studioId: string,
    days: number,
    kind: "group" | "personal" = "group",
  ): Promise<string> {
    const w = kind === "group" ? await workout(tx, studioId) : null;
    const [{ id }] = await tx`
      insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
      values (${studioId}, ${w}, ${kind},
              now() + make_interval(days => ${days}), now() + make_interval(days => ${days}, hours => 1))
      returning id`;
    return id as string;
  }

  async function book(tx: Tx, studioId: string, entryId: string, clientId: string): Promise<string> {
    const [{ id }] = await tx`
      insert into schedule_bookings (studio_id, entry_id, client_id, status)
      values (${studioId}, ${entryId}, ${clientId}, 'booked') returning id`;
    return id as string;
  }

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  // ---- Доступ к карточкам ----

  test("сотрудник пакетного клуба видит и правит карточки всех пакетных клубов, подписочных — нет", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const cA = await client(tx, a);
      const cB = await client(tx, b);
      const cS = await client(tx, s);
      const staffA = await staff(tx, a);
      const staffS = await staff(tx, s);

      await as(tx, staffA);
      const seen = await tx`select id from clients where id in (${cA}, ${cB}, ${cS})`;
      expect(ids(seen)).toEqual([cA, cB].sort());
      // Заметка и amoCRM, сохранённые из другого клуба сети, не откатываются
      // (clients_guard_self_update пускает сотрудника сети).
      const [edited] = await tx`
        update clients set notes = 'Ходит по вечерам', crm_link = 'https://crm.example/1',
                           phone = '+995555000111'
         where id = ${cB} returning notes, crm_link, phone`;
      expect(edited).toEqual({
        notes: "Ходит по вечерам",
        crm_link: "https://crm.example/1",
        phone: "+995555000111",
      });
      expect((await tx`update clients set notes = 'x' where id = ${cS} returning id`).length).toBe(0);
      // Новая карточка — в своём клубе; в чужом подписочном — нет.
      expect(await failure(tx, () => client(tx, a))).toBeNull();
      expect(await failure(tx, () => client(tx, s))).toContain("row-level security");
      expect((await tx`delete from clients where id = ${cB} returning id`).length).toBe(1);

      await as(tx, staffS);
      const subSeen = await tx`select id from clients where id in (${cA}, ${cB}, ${cS})`;
      expect(ids(subSeen)).toEqual([cS]);
      await asServer(tx);
    });
  });

  test("клиент приложения правит только личные поля своей карточки", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const u = await user(tx);
      const c = await client(tx, a, { userId: u });
      await tx`update clients set notes = 'Служебная' where id = ${c}`;

      await as(tx, u);
      expect(ids(await tx`select id from clients`)).toEqual([c]);
      await tx`update clients set notes = 'Моя', phone = '+995555000222' where id = ${c}`;
      await asServer(tx);
      const [row] = await tx`select notes, phone from clients where id = ${c}`;
      expect(row).toEqual({ notes: "Служебная", phone: "+995555000222" });
    });
  });

  test("сеть сотрудника: пакетный — все пакетные клубы, подписочный — только свой", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s1 = await studio(tx, "subscription");
      const s2 = await studio(tx, "subscription");
      const staffA = await staff(tx, a, "trainer");
      const staffS = await staff(tx, s1, "owner");
      const member = await user(tx);
      await tx`insert into user_roles (user_id, studio_id, role) values (${member}, ${a}, 'member')`;

      const [r] = await tx`
        select is_network_staff(${staffA}, ${b}) as ab, is_network_staff(${staffA}, ${s1}) as as1,
               is_network_staff(${staffS}, ${s1}) as s1s1, is_network_staff(${staffS}, ${s2}) as s1s2,
               is_network_staff(${staffS}, ${a}) as s1a, is_network_staff(${member}, ${a}) as member`;
      expect(r).toEqual({ ab: true, as1: false, s1s1: true, s1s2: false, s1a: false, member: false });

      const network = async () =>
        (await tx`select unnest(auth_network_studio_ids()) as id`).map((r: { id: string }) => r.id);
      await as(tx, staffA);
      const net = await network();
      expect(net).toContain(a);
      expect(net).toContain(b);
      expect(net).not.toContain(s1);
      await as(tx, staffS);
      expect(await network()).toEqual([s1]);
      await asServer(tx);
    });
  });

  // ---- Абонементы и продажи ----

  test("покупка в другом клубе сети: абонемент и статус ЧК видны в карточке, абонемент — клуба продажи", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const c = await client(tx, a);
      const p = await pack(tx, b);
      const staffA = await staff(tx, a);
      const staffB = await staff(tx, b);
      const staffS = await staff(tx, s);

      // Продаёт администратор B клиенту, чью карточку завели в A.
      await as(tx, staffB);
      const sale = await sell(tx, b, c, p);
      await asServer(tx);
      const cm = await membershipOfSale(tx, sale);
      expect(cm).toMatchObject({ studio_id: b, client_id: c, status: "active", visits_left: 2 });

      await as(tx, staffA);
      const [st] = await tx`select club_status from clients_with_status where id = ${c}`;
      expect(st.club_status).toBe("chk");
      expect(ids(await tx`select id from client_memberships where client_id = ${c}`)).toEqual([cm.id]);
      await as(tx, staffS);
      expect((await tx`select id from client_memberships where client_id = ${c}`).length).toBe(0);
      expect((await tx`select id from clients_with_status where id = ${c}`).length).toBe(0);
      await asServer(tx);
    });
  });

  // С 2026-10-20 платежи и комментарии продажи правит и другой клуб сети
  // (2026-10-20_zz_packages_network_payments.sql; подробно —
  // db/membership-transfer.test.ts).
  test("продажа привязана к клубу продажи: другой клуб сети отмечает платежи и пишет комментарии, но не удаляет", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const c = await client(tx, a);
      const p = await pack(tx, b);
      const staffA = await staff(tx, a);
      const staffB = await staff(tx, b);

      await as(tx, staffB);
      const sale = await sell(tx, b, c, p);
      await tx`
        insert into sale_installments (sale_id, amount, due_date, paid)
        values (${sale}, 50, current_date, true), (${sale}, 50, current_date + 30, false)`;

      await as(tx, staffA);
      expect(ids(await tx`select id from sales where client_id = ${c}`)).toEqual([sale]);
      expect((await tx`select id from sale_installments where sale_id = ${sale}`).length).toBe(2);
      expect((await tx`update sales set comment = 'правка' where id = ${sale} returning id`).length).toBe(1);
      expect(
        (await tx`update sale_installments set paid = true where sale_id = ${sale} returning id`).length,
      ).toBe(2);
      expect((await tx`delete from sales where id = ${sale} returning id`).length).toBe(0);
      expect((await tx`delete from client_memberships where sale_id = ${sale} returning id`).length).toBe(0);
      // Внести продажу за чужой клуб нельзя (не сотрудник клуба — как покупка
      // из приложения, её база не принимает).
      expect(await failure(tx, () => sell(tx, b, c, p))).not.toBeNull();
      // Продажи клуба — с его studio_id (раздел «Абонементы» общий, фильтр «Клуб»).
      expect((await tx`select id from client_packages_list where studio_id = ${a}`).length).toBe(0);
      expect(ids(await tx`select id from client_packages_list where studio_id = ${b}`)).toEqual([sale]);
      await asServer(tx);

      const [row] = await tx`select studio_id, comment from sales where id = ${sale}`;
      expect(row).toEqual({ studio_id: b, comment: "правка" });
      expect((await tx`select id from sales where client_id = ${c}`).length).toBe(1);
      const [{ unpaid }] = await tx`
        select count(*)::int as unpaid from sale_installments where sale_id = ${sale} and not paid`;
      expect(unpaid).toBe(0);
    });
  });

  test("один живой абонемент на клиента во всей сети: новая продажа в другом клубе заменяет, продление ждёт", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const c = await client(tx, a);
      const p = await pack(tx, a);
      const staffA = await staff(tx, a);
      const staffB = await staff(tx, b);

      await as(tx, staffA);
      const first = await sell(tx, a, c, p);
      await as(tx, staffB);
      // Вопрос «Заменить абонемент?» в окне продажи — по живому абонементу,
      // проданному в другом клубе.
      const live = await tx`
        select id from client_memberships where client_id = ${c} and status in ('active', 'frozen')`;
      expect(live.length).toBe(1);
      const renewal = await sell(tx, b, c, p, "renewal");
      await asServer(tx);
      expect((await membershipOfSale(tx, renewal)).status).toBe("pending");
      expect((await membershipOfSale(tx, first)).status).toBe("active");

      await as(tx, staffB);
      const replacing = await sell(tx, b, c, p, "new");
      await asServer(tx);
      expect((await membershipOfSale(tx, first)).status).toBe("replaced");
      expect(await membershipOfSale(tx, replacing)).toMatchObject({ status: "active", studio_id: b });
    });
  });

  test("абонемент другого клуба сети: остаток, срок и заморозку правит любой клуб сети", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const c = await client(tx, a);
      const p = await pack(tx, b, { freezeDays: 14 });
      const staffA = await staff(tx, a);
      const staffS = await staff(tx, s);
      const cm = await membershipOfSale(tx, await sell(tx, b, c, p));

      await as(tx, staffA);
      const updated = await tx`
        update client_memberships set visits_left = 5, ends_at = current_date + 40
         where id = ${cm.id} returning visits_left`;
      expect(updated).toEqual([{ visits_left: 5 }]);
      const [{ f }] = await tx`select (freeze_membership(${cm.id}, 7, 'Отпуск')).status as f`;
      expect(f).toBe("frozen");
      const [{ u }] = await tx`select (unfreeze_membership(${cm.id})).status as u`;
      expect(u).toBe("active");

      await as(tx, staffS);
      expect(await failure(tx, () => tx`select freeze_membership(${cm.id}, 7, null)`)).toContain(
        "forbidden",
      );
      expect(
        (await tx`update client_memberships set visits_left = 9 where id = ${cm.id} returning id`).length,
      ).toBe(0);
      await asServer(tx);
      const [row] = await tx`select visits_left, status from client_memberships where id = ${cm.id}`;
      expect(row).toEqual({ visits_left: 5, status: "active" });
    });
  });

  // ---- Запись и списание ----

  test("клиент одной карточкой записывается в оба клуба, списание и очередь продления — по всей сети", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const u = await user(tx);
      const c = await client(tx, a, { userId: u });
      const p = await pack(tx, a);
      const staffA = await staff(tx, a);
      const staffB = await staff(tx, b);
      const first = await sell(tx, a, c, p);
      const eB = await entry(tx, b, 1);
      const eA = await entry(tx, a, 2);

      // Сам — в клуб B (не клуб карточки и не клуб продажи).
      await as(tx, u);
      const [{ r }] = await tx`select book_schedule_entry(${eB}) as r`;
      expect(r).toMatchObject({ ok: true, waitlisted: false });
      // Администратор A записывает в A.
      await as(tx, staffA);
      const [{ r: byAdmin }] = await tx`select admin_book_client(${eA}, ${c}) as r`;
      expect(byAdmin).toMatchObject({ ok: true });

      // Продление в B ждёт, пока не кончится абонемент из A.
      await as(tx, staffB);
      const renewal = await sell(tx, b, c, p, "renewal");
      await tx`update schedule_bookings set status = 'attended' where entry_id = ${eB}`;
      await asServer(tx);
      const [bookedB] = await tx`select client_id, charged_membership_id from schedule_bookings where entry_id = ${eB}`;
      expect(bookedB.client_id).toBe(c);
      expect(bookedB.charged_membership_id).toBe((await membershipOfSale(tx, first)).id);
      expect((await membershipOfSale(tx, first)).visits_left).toBe(1);
      expect((await membershipOfSale(tx, renewal)).status).toBe("pending");

      await as(tx, staffA);
      await tx`update schedule_bookings set status = 'attended' where entry_id = ${eA}`;
      await asServer(tx);
      expect((await membershipOfSale(tx, first)).status).toBe("expired");
      expect((await membershipOfSale(tx, renewal)).status).toBe("active");

      // В приложении — все свои абонементы, из какого бы клуба они ни были.
      await as(tx, u);
      const mine = await tx`select studio_id from client_memberships`;
      expect(mine.map((m: { studio_id: string }) => m.studio_id).sort()).toEqual([a, b].sort());
      await asServer(tx);
    });
  });

  test("главная приложения: записи клиента во всех клубах сети видны, кто бы ни записал", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const u = await user(tx);
      const c = await client(tx, a, { userId: u });
      await sell(tx, a, c, await pack(tx, a, { visits: 5 }));
      const staffB = await staff(tx, b);
      const ownA = await entry(tx, a, 1);
      const ownB = await entry(tx, b, 2);
      const byAdminB = await entry(tx, b, 3);
      const [{ id: diagB }] = await tx`
        insert into schedule_entries (studio_id, kind, starts_at, ends_at)
        values (${b}, 'diagnostic', now() + interval '4 days', now() + interval '4 days 1 hour')
        returning id`;

      await as(tx, u);
      for (const e of [ownA, ownB]) {
        const [{ r }] = await tx`select book_schedule_entry(${e}) as r`;
        expect(r).toMatchObject({ ok: true });
      }
      await as(tx, staffB);
      const [{ r: byAdmin }] = await tx`select admin_book_client(${byAdminB}, ${c}) as r`;
      expect(byAdmin).toMatchObject({ ok: true });
      await book(tx, b, diagB, c);

      // Запрос главной (homeBookingsQuery): свои записи с занятием через inner join.
      await as(tx, u);
      const rows = await tx`
        select sb.entry_id from schedule_bookings sb
          join schedule_entries e on e.id = sb.entry_id
         where sb.user_id = ${u} and sb.status = 'booked'
           and e.starts_at >= now() and e.kind in ('group', 'diagnostic')
           and e.cancelled_at is null`;
      expect(rows.map((r: { entry_id: string }) => r.entry_id).sort()).toEqual(
        [ownA, ownB, byAdminB, diagB].sort(),
      );
      await asServer(tx);
    });
  });

  test("остаток на занятии: entry_bookings_ahead считает неотмеченные записи клиента во всех клубах сети", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const c = await client(tx, a);
      const other = await client(tx, b);
      await sell(tx, a, c, await pack(tx, a, { visits: 5 }));
      const staffA = await staff(tx, a);
      const staffB = await staff(tx, b);

      const earlierB = await entry(tx, b, 1);
      const earlierPersonal = await entry(tx, a, 1, "personal");
      const cancelledB = await entry(tx, b, 1);
      const later = await entry(tx, a, 3);
      await book(tx, b, earlierB, c);
      // Персональное записывает только сотрудник.
      await as(tx, staffA);
      await book(tx, a, earlierPersonal, c);
      await asServer(tx);
      await book(tx, b, cancelledB, c);
      await tx`update schedule_bookings set status = 'cancelled' where entry_id = ${cancelledB}`;
      await book(tx, a, later, c);
      await book(tx, a, later, other);

      await as(tx, staffA);
      // Запись клиента в клуб B сотруднику A не видна (RLS записей — клуб записи)…
      expect((await tx`select id from schedule_bookings where entry_id = ${earlierB}`).length).toBe(0);
      // …а в остатке она есть: персональное и отменённая — не в счёт.
      const ahead = await tx`select client_id, ahead from entry_bookings_ahead(${later})`;
      expect(ahead).toEqual([{ client_id: c, ahead: 1 }]);
      // Только сотрудник клуба занятия.
      await as(tx, staffB);
      expect((await tx`select * from entry_bookings_ahead(${later})`).length).toBe(0);
      await asServer(tx);
    });
  });

  // ---- Посещения, анкета, вес ----

  test("посещения, анкета и вес клиента сети видны сотрудникам всех пакетных клубов", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const u = await user(tx);
      const c = await client(tx, b, { userId: u });
      await sell(tx, b, c, await pack(tx, b));
      const e = await entry(tx, b, 1);
      await book(tx, b, e, c);
      await tx`insert into member_profiles (user_id) values (${u})`;
      await tx`insert into client_weights (user_id, weight_kg, source) values (${u}, 60, 'manual')`;
      const staffA = await staff(tx, a);
      const staffS = await staff(tx, s);

      await as(tx, staffA);
      expect((await tx`select id from bookings_log where client_id = ${c}`).length).toBe(1);
      expect((await tx`select user_id from member_profiles where user_id = ${u}`).length).toBe(1);
      expect((await tx`select id from client_weights where user_id = ${u}`).length).toBe(1);
      await as(tx, staffS);
      expect((await tx`select id from bookings_log where client_id = ${c}`).length).toBe(0);
      expect((await tx`select user_id from member_profiles where user_id = ${u}`).length).toBe(0);
      expect((await tx`select id from client_weights where user_id = ${u}`).length).toBe(0);
      await asServer(tx);
    });
  });

  // ---- Одна карточка на человека ----

  test("почта карточки — одна во всех пакетных клубах (без учёта регистра и пробелов), в подписочных — как раньше", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const anna = await client(tx, a, { email: "Anna@Example.com " });
      const taken = "уже есть в базе клубов";

      expect(await failure(tx, () => client(tx, b, { email: "anna@example.com" }))).toContain(taken);
      expect(await failure(tx, () => client(tx, a, { email: " ANNA@example.com" }))).toContain(taken);
      // Подписочный клуб — своя база, пустая почта — не дубль.
      expect(await failure(tx, () => client(tx, s, { email: "anna@example.com" }))).toBeNull();
      expect(await failure(tx, () => client(tx, b, { email: null }))).toBeNull();
      expect(await failure(tx, () => client(tx, b, { email: null }))).toBeNull();
      expect(await failure(tx, () => client(tx, b, { email: "" }))).toBeNull();
      expect(await failure(tx, () => client(tx, a, { email: "" }))).toBeNull();

      const other = await client(tx, b, { email: "olga@example.com" });
      expect(
        await failure(tx, () => tx`update clients set email = 'ANNA@example.com' where id = ${other}`),
      ).toContain(taken);
      // Сохранение карточки с той же почтой (форма шлёт все поля) — не дубль.
      expect(
        await failure(
          tx,
          () => tx`update clients set email = 'anna@example.com', notes = 'ok' where id = ${anna}`,
        ),
      ).toBeNull();
      // Подписочная карточка с этой почтой в пакетный клуб не переезжает.
      const subAnna = await tx`select id from clients where studio_id = ${s}`;
      expect(
        await failure(tx, () => tx`update clients set studio_id = ${b} where id = ${subAnna[0].id}`),
      ).toContain(taken);
    });
  });

  test("учётная запись приложения — у одной карточки сети; вход привязывает свободную карточку по почте", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const u = await user(tx, "maria@example.com");
      await client(tx, a, { userId: u, email: "maria@example.com" });
      const second = await client(tx, b, { email: null });
      expect(
        await failure(tx, () => tx`update clients set user_id = ${u} where id = ${second}`),
      ).toContain("уже привязана");
      // Тот же человек — клиент и подписочного клуба: там своя карточка.
      expect(await failure(tx, () => client(tx, s, { userId: u, email: null }))).toBeNull();

      const v = await user(tx, "nina@example.com");
      const free = await client(tx, b, { email: "Nina@example.com" });
      await as(tx, v);
      const [linked] = await tx`select * from ensure_client_profile()`;
      expect(linked.id).toBe(free);
      await asServer(tx);
      const [{ user_id }] = await tx`select user_id from clients where id = ${free}`;
      expect(user_id).toBe(v);
    });
  });

  // ---- Слияние дублей ----

  test("слияние дублей: продажи, абонементы, записи, журнал, заявки и NPS — на одну карточку, вход не теряется", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s = await studio(tx, "subscription");
      const u = await user(tx, "dina@example.com");
      // Дубли остались от модели «гостевых посещений»; новые защита не даёт.
      await tx`alter table clients disable trigger clients_network_unique_guard_biu`;
      const keep = await client(tx, a, { userId: u, email: "dina@example.com" });
      await tx`update clients set created_at = now() - interval '1 day', notes = 'Из Ваке',
                                  phone = null, birthday = null where id = ${keep}`;
      const dup = await client(tx, b, { email: " Dina@Example.com" });
      await tx`update clients set phone = '+995555000333', birthday = '1990-05-01',
                                  notes = 'Из Сабуртало', registration_date = '2024-01-01'
                where id = ${dup}`;
      // Одна учётная запись на двух карточках (так приложение ломалось).
      const w = await user(tx);
      const w1 = await client(tx, a, { userId: w, email: null, first: "Вера" });
      const w2 = await client(tx, b, { userId: w, email: null, first: "Вера" });
      // Остаётся самая старая (у обеих есть вход, живых абонементов нет).
      await tx`update clients set created_at = now() - interval '2 days' where id = ${w1}`;
      // Не сливаются: подписочные клубы и карточки разных учётных записей.
      await client(tx, s, { email: "sub@example.com" });
      await client(tx, s, { email: "sub@example.com" });
      const x = await user(tx);
      const y = await user(tx);
      await client(tx, a, { userId: x, email: "twins@example.com" });
      await client(tx, b, { userId: y, email: "twins@example.com" });
      await tx`alter table clients enable trigger clients_network_unique_guard_biu`;

      const p = await pack(tx, a, { visits: 3 });
      const pers = await pack(tx, a, { kind: "personal" });
      const keepSale = await sell(tx, a, keep, p);
      const dupSale = await sell(tx, b, dup, p);
      const dupPersonal = await sell(tx, b, dup, pers);
      const both = await entry(tx, b, 1);
      const onlyDup = await entry(tx, a, 2);
      await book(tx, b, both, keep);
      await book(tx, b, both, dup);
      await book(tx, a, onlyDup, dup);
      await tx`
        insert into client_requests (studio_id, client_id, user_id, kind)
        values (${b}, ${dup}, null, 'diagnostic')`;
      await tx`
        insert into nps_responses (score, survey_type, client_id, studio_id)
        values (9, 'general', ${dup}, ${b})`;
      await tx`insert into member_profiles (user_id) values (${u})`;

      const [{ n }] = await tx`select packages_merge_duplicate_clients() as n`;
      expect(n).toBe(2);

      expect((await tx`select id from clients where id in (${dup}, ${w2})`).length).toBe(0);
      expect((await tx`select id from clients where id = ${w1}`).length).toBe(1);
      const [k] = await tx`
        select user_id, email, phone, birthday::text as birthday, notes,
               registration_date::text as registration_date, studio_id
          from clients where id = ${keep}`;
      expect(k).toEqual({
        user_id: u,
        email: "dina@example.com",
        phone: "+995555000333",
        birthday: "1990-05-01",
        notes: "Из Ваке\n\nИз Сабуртало",
        registration_date: "2024-01-01",
        studio_id: a,
      });
      // Продажи остались в своих клубах, клиент — оставшаяся карточка.
      const sales = await tx`select studio_id, client_id from sales where id in (${keepSale}, ${dupSale}) order by studio_id = ${a} desc`;
      expect(sales).toEqual([
        { studio_id: a, client_id: keep },
        { studio_id: b, client_id: keep },
      ]);
      // Живой групповой дубля встал в очередь за живым оставшейся, персональный — живой.
      expect(await membershipOfSale(tx, keepSale)).toMatchObject({ client_id: keep, status: "active" });
      expect(await membershipOfSale(tx, dupSale)).toMatchObject({ client_id: keep, status: "pending" });
      expect(await membershipOfSale(tx, dupPersonal)).toMatchObject({ client_id: keep, status: "active" });
      // Запись дубля на то же занятие — удалена, остальные — у оставшейся, с её входом.
      expect(await tx`select client_id from schedule_bookings where entry_id = ${both}`).toEqual([
        { client_id: keep },
      ]);
      expect(await tx`select client_id, user_id from schedule_bookings where entry_id = ${onlyDup}`).toEqual([
        { client_id: keep, user_id: u },
      ]);
      const [{ logs }] = await tx`
        select count(*)::int as logs from bookings_log where client_id = ${keep} and user_id = ${u}`;
      expect(logs).toBe(2);
      expect(await tx`select client_id, studio_id from client_requests where client_id = ${keep}`).toEqual([
        { client_id: keep, studio_id: b },
      ]);
      expect((await tx`select id from nps_responses where client_id = ${keep}`).length).toBe(1);
      // Учётная запись приложения и анкета на месте (удаление дубля их не стёрло).
      expect((await tx`select id from auth.users where id = ${u}`).length).toBe(1);
      expect((await tx`select user_id from member_profiles where user_id = ${u}`).length).toBe(1);
      // Подписочные дубли и карточки разных учётных записей — как были.
      expect((await tx`select id from clients where studio_id = ${s}`).length).toBe(2);
      expect((await tx`select id from clients where lower(email) = 'twins@example.com'`).length).toBe(2);

      const [{ again }] = await tx`select packages_merge_duplicate_clients() as again`;
      expect(again).toBe(0);
    });
  });

  // ---- Удаление клуба ----

  test("удаление пакетного клуба переносит его клиентов в другой пакетный, подписочного — удаляет, как раньше", async () => {
    await scenario(async (tx) => {
      const a = await studio(tx);
      const b = await studio(tx);
      const s1 = await studio(tx, "subscription");
      await studio(tx, "subscription");
      const c = await client(tx, b);
      const sub = await client(tx, s1);
      // Клиент, заведённый в B, покупал в A: раньше каскад не дал бы удалить B.
      const sale = await sell(tx, a, c, await pack(tx, a));
      await tx`
        insert into client_requests (studio_id, client_id, kind) values (${b}, ${c}, 'personal')`;

      await tx`delete from studios where id = ${b}`;
      const [moved] = await tx`select studio_id from clients where id = ${c}`;
      expect(moved.studio_id).toBe(a);
      expect(await tx`select studio_id from sales where id = ${sale}`).toEqual([{ studio_id: a }]);
      expect(await tx`select studio_id from client_requests where client_id = ${c}`).toEqual([
        { studio_id: a },
      ]);

      await tx`delete from studios where id = ${s1}`;
      expect((await tx`select id from clients where id = ${sub}`).length).toBe(0);
    });
  });

  // ---- Подписочные клубы ----

  test("подписочные клубы — по-прежнему у каждого своя база и свои продажи", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx, "subscription");
      const s2 = await studio(tx, "subscription");
      const c1 = await client(tx, s1);
      const c2 = await client(tx, s2);
      const p = await pack(tx, s2);
      const sale = await sell(tx, s2, c2, p);
      const staff1 = await staff(tx, s1);

      await as(tx, staff1);
      expect(ids(await tx`select id from clients where id in (${c1}, ${c2})`)).toEqual([c1]);
      expect((await tx`select id from sales where id = ${sale}`).length).toBe(0);
      expect((await tx`select id from client_memberships where client_id = ${c2}`).length).toBe(0);
      expect((await tx`update clients set notes = 'x' where id = ${c2} returning id`).length).toBe(0);
      await asServer(tx);
    });
  });
});
