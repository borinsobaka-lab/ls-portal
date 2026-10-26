/**
 * Тесты «Переоформить» абонемент пакетного клуба (2026-10-20,
 * db/migrations/2026-10-20_packages_membership_transfer.sql): владелец
 * продажи и абонемента меняется, остальное — нет; только оплаченный
 * полностью, живой или ждущий; без двух живых абонементов одного вида у
 * нового владельца; только сотрудник клуба продажи и клиент той же сети.
 * Платежи и комментарии продажи — сотруднику любого клуба сети
 * (db/migrations/2026-10-20_zz_packages_network_payments.sql).
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

describe.skipIf(!url)("переоформление абонемента (база)", () => {
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
    const [{ id }] =
      await tx`insert into studios (name, format) values (${name}, ${format}) returning id`;
    return id as string;
  }

  /** Сотрудник клуба (учётная запись в обход handle_new_user). */
  async function staff(tx: Tx, studioId: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`staff-${crypto.randomUUID()}@example.com`})
      returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin')`;
    return id as string;
  }

  async function client(tx: Tx, studioId: string, last = "Тестова"): Promise<string> {
    const [{ id }] = await tx`
      insert into clients (studio_id, first_name, last_name, email)
      values (${studioId}, 'Анна', ${last}, ${`c-${crypto.randomUUID()}@example.com`})
      returning id`;
    return id as string;
  }

  async function pack(tx: Tx, studioId: string, kind = "package"): Promise<string> {
    const [{ id }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price)
      values (${studioId}, ${kind === "personal" ? "Персональные" : "Пакет 8"}, ${kind},
              ${kind === "personal" ? 0 : 8}, ${kind === "personal" ? 4 : 0}, 30, 100)
      returning id`;
    return id as string;
  }

  /** Продажа (от сервера, без RLS); unpaid — график из двух платежей, второй не внесён. */
  async function sell(
    tx: Tx,
    studioId: string,
    clientId: string,
    membershipId: string,
    opts: { kind?: string; unpaid?: boolean } = {},
  ): Promise<string> {
    const [{ id }] = await tx`
      insert into sales (studio_id, client_id, membership_id, total_amount, sold_at, sale_kind)
      values (${studioId}, ${clientId}, ${membershipId}, 100, current_date, ${opts.kind ?? "new"})
      returning id`;
    if (opts.unpaid) {
      await tx`
        insert into sale_installments (sale_id, due_date, amount, paid, paid_at)
        values (${id}, current_date, 50, true, current_date),
               (${id}, current_date + 30, 50, false, null)`;
    }
    return id as string;
  }

  async function membershipOfSale(tx: Tx, saleId: string) {
    const [row] = await tx`
      select id, client_id, status, visits_left, personal_left, ends_at, starts_on_first_visit
        from client_memberships where sale_id = ${saleId}`;
    return row as {
      id: string;
      client_id: string;
      status: string;
      visits_left: number | null;
      personal_left: number;
      ends_at: string | null;
      starts_on_first_visit: boolean;
    };
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }

  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  const transfer = (tx: Tx, saleId: string, clientId: string) =>
    tx`select transfer_client_membership(${saleId}, ${clientId}) as r`;

  test("меняется только владелец: статус, остаток и срок — как были", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx, "packages", "Ваке");
      const admin = await staff(tx, s);
      const anna = await client(tx, s, "Прежняя");
      const olga = await client(tx, s, "Новая");
      const sale = await sell(tx, s, anna, await pack(tx, s));
      await tx`update client_memberships set visits_left = 5, started_at = current_date - 3,
                 ends_at = current_date + 27 where sale_id = ${sale}`;
      const before = await membershipOfSale(tx, sale);

      await as(tx, admin);
      const [{ r }] = await transfer(tx, sale, olga);
      expect(r.status).toBe("active");
      const [row] = await tx`
        select client_id, studio_name, transferred_from_name, transferred_at
          from client_packages_list where id = ${sale}`;
      await asServer(tx);

      expect(row.client_id).toBe(olga);
      expect(row.studio_name).toBe("Ваке");
      expect(row.transferred_from_name).toBe("Прежняя Анна");
      expect(row.transferred_at).not.toBeNull();
      const after = await membershipOfSale(tx, sale);
      expect(after).toEqual({ ...before, client_id: olga });
      const [{ client_id }] = await tx`select client_id from sales where id = ${sale}`;
      expect(client_id).toBe(olga);
    });
  });

  test("не оплаченный полностью — нельзя", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const anna = await client(tx, s);
      const olga = await client(tx, s);
      const sale = await sell(tx, s, anna, await pack(tx, s), { unpaid: true });

      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, sale, olga))).toContain("не оплачен полностью");
      await tx`update sale_installments set paid = true, paid_at = current_date where sale_id = ${sale}`;
      expect(await failure(tx, () => transfer(tx, sale, olga))).toBeNull();
    });
  });

  test("у нового владельца живой абонемент того же вида — нельзя, другого вида — можно", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const anna = await client(tx, s);
      const olga = await client(tx, s);
      const group = await pack(tx, s);
      const personal = await pack(tx, s, "personal");
      const annaGroup = await sell(tx, s, anna, group);
      const annaPersonal = await sell(tx, s, anna, personal);
      await sell(tx, s, olga, group);

      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, annaGroup, olga))).toContain(
        "уже есть действующий абонемент «Пакет 8»",
      );
      expect(await failure(tx, () => transfer(tx, annaPersonal, olga))).toBeNull();
      await asServer(tx);
      expect((await membershipOfSale(tx, annaPersonal)).client_id).toBe(olga);
    });
  });

  test("ждущий в очереди встаёт в очередь нового владельца; у прежнего продление становится текущим", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const anna = await client(tx, s);
      const olga = await client(tx, s);
      const misha = await client(tx, s);
      const group = await pack(tx, s);
      const annaCurrent = await sell(tx, s, anna, group);
      const annaRenewal = await sell(tx, s, anna, group, { kind: "renewal" });
      const olgaCurrent = await sell(tx, s, olga, group);
      expect((await membershipOfSale(tx, annaRenewal)).status).toBe("pending");

      await as(tx, admin);
      // Продление Анны — Ольге: у неё действующий, продление ждёт за ним.
      const [{ r }] = await transfer(tx, annaRenewal, olga);
      expect(r.status).toBe("pending");
      await asServer(tx);
      expect((await membershipOfSale(tx, annaRenewal)).client_id).toBe(olga);
      expect((await membershipOfSale(tx, olgaCurrent)).status).toBe("active");

      // Текущий Ольги — Мише (у него ничего нет): у Ольги текущим становится
      // ждавшее продление.
      await as(tx, admin);
      await transfer(tx, olgaCurrent, misha);
      await asServer(tx);
      expect(await membershipOfSale(tx, olgaCurrent)).toMatchObject({
        client_id: misha,
        status: "active",
      });
      expect((await membershipOfSale(tx, annaRenewal)).status).toBe("active");
      expect((await membershipOfSale(tx, annaCurrent)).client_id).toBe(anna);
    });
  });

  test("истёкший, с возвратом и уже на этом клиенте — нельзя", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const admin = await staff(tx, s);
      const anna = await client(tx, s);
      const olga = await client(tx, s);
      const sale = await sell(tx, s, anna, await pack(tx, s));

      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, sale, anna))).toContain("уже оформлен");
      await asServer(tx);
      // Действующий с прошедшим сроком — истёкший, как на бейдже.
      await tx`update client_memberships set started_at = current_date - 40,
                 ends_at = current_date - 10 where sale_id = ${sale}`;
      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, sale, olga))).toContain(
        "только действующий, замороженный или ожидающий",
      );
      await asServer(tx);
      await tx`update client_memberships set status = 'expired' where sale_id = ${sale}`;
      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, sale, olga))).toContain(
        "только действующий, замороженный или ожидающий",
      );
      await asServer(tx);
      await tx`update client_memberships set status = 'refunded' where sale_id = ${sale}`;
      await as(tx, admin);
      expect(await failure(tx, () => transfer(tx, sale, olga))).toContain(
        "только действующий, замороженный или ожидающий",
      );
    });
  });

  test("права: только сотрудник клуба продажи, клиент — из той же сети", async () => {
    await scenario(async (tx) => {
      const vake = await studio(tx, "packages", "Ваке");
      const saburtalo = await studio(tx, "packages", "Сабуртало");
      const sub = await studio(tx, "subscription", "Base40");
      const vakeAdmin = await staff(tx, vake);
      const saburtaloAdmin = await staff(tx, saburtalo);
      const anna = await client(tx, vake);
      const olga = await client(tx, saburtalo);
      const subClient = await client(tx, sub);
      const sale = await sell(tx, vake, anna, await pack(tx, vake));

      // Сотрудник другого клуба сети видит продажу в «Абонементах», но
      // переоформить не может — как править и удалять.
      await as(tx, saburtaloAdmin);
      const [{ n }] =
        await tx`select count(*)::int as n from client_packages_list where id = ${sale}`;
      expect(n).toBe(1);
      expect(await failure(tx, () => transfer(tx, sale, olga))).toContain("только сотрудник клуба");

      await as(tx, vakeAdmin);
      expect(await failure(tx, () => transfer(tx, sale, subClient))).toContain("не найден");
      // Клиент другого пакетного клуба — та же база: можно.
      expect(await failure(tx, () => transfer(tx, sale, olga))).toBeNull();
    });
  });
  test("платежи и комментарии продажи другого клуба сети — можно, остальное — нет", async () => {
    await scenario(async (tx) => {
      const vake = await studio(tx, "packages", "Ваке");
      const saburtalo = await studio(tx, "packages", "Сабуртало");
      const sub = await studio(tx, "subscription", "Base40");
      const saburtaloAdmin = await staff(tx, saburtalo);
      const subAdmin = await staff(tx, sub);
      const anna = await client(tx, vake);
      const sale = await sell(tx, vake, anna, await pack(tx, vake), { unpaid: true });
      const [{ id: unpaid }] = await tx`
        select id from sale_installments where sale_id = ${sale} and not paid`;

      // Сотрудник подписочного клуба продажи пакетного не видит и не правит.
      await as(tx, subAdmin);
      const subRows = await tx`
        update sale_installments set paid = true where id = ${unpaid} returning id`;
      expect(subRows.length).toBe(0);

      await as(tx, saburtaloAdmin);
      const marked = await tx`
        update sale_installments set paid = true, payment_method = 'cash'
         where id = ${unpaid} returning paid_at`;
      expect(marked.length).toBe(1);
      expect(marked[0].paid_at).not.toBeNull();
      await tx`update sales set comment = 'внесла в Сабуртало', membership_note = 'ок'
                where id = ${sale}`;
      // «Редактировать платежи»: внесённым — новые суммы, плюс ещё платёж.
      const paid = await tx`select id, amount from sale_installments where sale_id = ${sale}`;
      await tx`select replace_sale_installments(${sale}, ${JSON.stringify([
        ...paid.map((p: { id: string }) => ({ id: p.id, amount: 40 })),
        { amount: 20, due_date: "2030-01-01" },
      ])}::text::jsonb)`;

      expect(
        await failure(tx, () => tx`update sales set total_amount = 1 where id = ${sale}`),
      ).toContain("только платежи и комментарии");
      expect(
        await failure(
          tx,
          () =>
            tx`update sales set client_id = client_id, sold_at = sold_at - 1 where id = ${sale}`,
        ),
      ).toContain("только платежи и комментарии");
      // Удалить продажу другого клуба нельзя (RLS — строка не видна для delete).
      const deleted = await tx`delete from sales where id = ${sale} returning id`;
      expect(deleted.length).toBe(0);

      await asServer(tx);
      const [row] = await tx`
        select comment, membership_note, remaining_installments, total_amount
          from sales where id = ${sale}`;
      expect(row).toMatchObject({
        comment: "внесла в Сабуртало",
        membership_note: "ок",
        remaining_installments: 2,
      });
      expect(Number(row.total_amount)).toBe(100);
    });
  });
});
