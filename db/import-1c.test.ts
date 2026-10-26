/**
 * Тесты переноса клиентов из 1С (2026-10-18,
 * db/migrations/2026-10-18_import_1c.sql): import_1c_chunk заводит карточки,
 * продажи с рассрочкой и абонементы в состоянии из 1С (остаток, срок,
 * очередь, перенос подарочной персональной), историю «Закончился»; повтор
 * ничего не задваивает; заливает только владелец; import_1c_rollback удаляет
 * перенесённое, пока клиенты не вошли в приложение. «Добавлен» (clients.source,
 * 2026-10-18_zz_clients_source.sql) у перенесённых — import.
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

describe.skipIf(!url)("перенос клиентов из 1С (база)", () => {
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

  /** Клубы Lady Stretch, владелец обоих, номенклатура как в проде. */
  async function setup(tx: Tx) {
    const [{ id: vake }] = await tx`
      insert into studios (name, format) values ('LS Vake', 'packages') returning id`;
    const [{ id: sab }] = await tx`
      insert into studios (name, format) values ('LS Saburtalo', 'packages') returning id`;
    const owner = await user(tx, `owner-${crypto.randomUUID()}@example.com`);
    await tx`insert into user_roles (user_id, studio_id, role)
             values (${owner}, ${vake}, 'owner'), (${owner}, ${sab}, 'owner')`;
    await tx`
      insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, price, is_active)
      values (${vake}, 'Premium 50', 'package', 50, 1, 365, 990, true),
             (${vake}, 'Premium 24', 'package', 24, 0, 120, 540, true),
             (${vake}, 'Пакет 16', 'package', 16, 0, 90, 410, true),
             (${vake}, 'Остаток из 1С', 'package', 1, 0, 30, 0, false)`;
    return { vake: vake as string, sab: sab as string, owner };
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }

  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  const studios = { vake: "LS Vake", saburtalo: "LS Saburtalo" };

  /** Клиентка с действующим Premium 24 в долг, старым Premium 50 с остатком 1,
   *  непроданным Пакетом 16 и историей; вторая — только с почтой. */
  const chunk = {
    studios,
    clients: [
      {
        ref: "1c-000001",
        studio: "saburtalo",
        last_name: "Иванова",
        first_name: "Анна",
        gender: "female",
        birthday: "1990-05-01",
        registration_date: "2024-01-10",
        email: "anna.1c@example.com",
        phone: "+995555123456",
        phone2: "+79161234567",
        notes: "Сотрудник",
        memberships: [
          {
            ref: "1-1/24/1",
            kind: "history",
            catalog: "Premium 24",
            sold_at: "2024-02-01",
            order: 0,
            started_at: "2024-02-02",
            ends_at: "2024-06-01",
          },
          {
            ref: "1-2/50/1",
            kind: "sale",
            catalog: "Premium 50",
            sold_at: "2025-12-01",
            order: 1,
            status: "expired",
            starts_on_first_visit: false,
            started_at: "2025-12-02",
            ends_at: "2026-12-01",
            visits_left: 0,
            personal_left: 0,
            total: 740,
            debt: 0,
          },
          {
            ref: "1-3/24/1",
            kind: "sale",
            catalog: "Premium 24",
            sold_at: "2026-09-16",
            order: 2,
            status: "active",
            starts_on_first_visit: false,
            started_at: "2026-09-17",
            ends_at: "2099-01-30",
            visits_left: 20,
            personal_left: 1,
            total: 540,
            debt: 270,
          },
          {
            ref: "1-4/16/1",
            kind: "sale",
            catalog: "Пакет 16",
            sold_at: "2026-10-10",
            order: 3,
            status: "pending",
            starts_on_first_visit: true,
            started_at: null,
            ends_at: null,
            visits_left: 16,
            personal_left: 0,
            total: null,
            debt: 0,
          },
        ],
      },
      {
        ref: "1c-000002",
        studio: "vake",
        last_name: null,
        first_name: "Sara",
        gender: "female",
        email: "sara.1c@example.com",
        phone: null,
        memberships: [
          {
            ref: "1-5/rest/2",
            kind: "sale",
            catalog: "Остаток из 1С",
            sold_at: "2026-05-01",
            order: 0,
            status: "active",
            starts_on_first_visit: false,
            started_at: "2026-05-02",
            ends_at: "2099-01-01",
            visits_left: 3,
            personal_left: 0,
            total: null,
            debt: 0,
          },
        ],
      },
    ],
  };

  test("перенос: карточки, продажи с рассрочкой, состояние из 1С, история", async () => {
    await scenario(async (tx) => {
      const s = await setup(tx);
      await as(tx, s.owner);
      const [{ r }] = await tx`select import_1c_chunk(${chunk}::jsonb) as r`;
      expect(r).toMatchObject({ clients_created: 2, sales_created: 4, history_created: 1 });
      await asServer(tx);

      const [anna] = await tx`select * from clients where onec_ref = '1c-000001'`;
      expect(anna).toMatchObject({
        studio_id: s.sab,
        full_name: "Анна Иванова",
        email: "anna.1c@example.com",
        phone: "+995555123456",
        phone2: "+79161234567",
        gender: "female",
        source: "import",
      });

      const rows = await tx`
        select m.name, cm.status, cm.starts_on_first_visit as sofv, cm.visits_left, cm.personal_left,
               cm.started_at::text, cm.ends_at::text, cm.sale_id is not null as sold, cm.onec_ref
          from client_memberships cm join memberships m on m.id = cm.membership_id
         where cm.client_id = ${anna.id} order by cm.created_at`;
      expect(rows.map((x: { name: string; status: string }) => `${x.name}:${x.status}`)).toEqual([
        "Premium 24:expired",
        "Premium 50:expired",
        "Premium 24:active",
        "Пакет 16:pending",
      ]);
      // История — без продажи и без остатка (иначе packages_settle вернул бы её).
      expect(rows[0]).toMatchObject({
        sold: false,
        visits_left: 0,
        personal_left: 0,
        onec_ref: "1-1/24/1",
      });
      expect(rows[2]).toMatchObject({
        sofv: false,
        visits_left: 20,
        personal_left: 1,
        ends_at: "2099-01-30",
      });
      expect(rows[3]).toMatchObject({ sofv: true, started_at: null, visits_left: 16 });

      // Долг — рассрочка: внесённое первым платежом, остаток — через месяц.
      const [sale] = await tx`select * from sales where onec_ref = '1-3/24/1'`;
      expect(Number(sale.total_amount)).toBe(540);
      expect(Number(sale.down_payment_amount)).toBe(270);
      expect(sale.remaining_installments).toBe(1);
      expect(sale.admin_name).toBe("Перенос из 1С");
      expect(sale.sale_kind).toBeNull();
      const inst = await tx`
        select due_date::text, amount::numeric::int as amount, paid from sale_installments
         where sale_id = ${sale.id} order by due_date`;
      expect(inst).toEqual([
        { due_date: "2026-09-16", amount: 270, paid: true },
        { due_date: "2026-10-16", amount: 270, paid: false },
      ]);
      // Цены в 1С нет — сумма и «цена по прайсу» из номенклатуры.
      const [p16] =
        await tx`select total_amount, list_price, discount_amount from sales where onec_ref = '1-4/16/1'`;
      expect([
        Number(p16.total_amount),
        Number(p16.list_price),
        Number(p16.discount_amount),
      ]).toEqual([410, 410, 0]);

      // «Добавлен» в «Абонементах»: перенесённые — «Импорт», внесённые в
      // админке — «Админка» (2026-10-18_zzz_client_packages_added_via.sql).
      const [m24] =
        await tx`select id from memberships where name = 'Premium 24' and studio_id = ${s.vake}`;
      const [{ id: manual }] = await tx`
        insert into sales (studio_id, client_id, membership_id, total_amount, sale_kind)
        values (${s.sab}, ${anna.id}, ${m24.id}, 540, 'renewal') returning id`;
      const added = await tx`
        select l.id = ${manual} as manual, l.added_via from client_packages_list l
         where l.client_id = ${anna.id}`;
      const viaOf = (manualRow: boolean) =>
        added
          .filter((x: { manual: boolean }) => x.manual === manualRow)
          .map((x: { added_via: string }) => x.added_via);
      expect(viaOf(true)).toEqual(["admin"]);
      expect(new Set(viaOf(false))).toEqual(new Set(["import"]));
      await tx`delete from sales where id = ${manual}`;

      // Повтор — ничего нового.
      await as(tx, s.owner);
      const [{ r: again }] = await tx`select import_1c_chunk(${chunk}::jsonb) as r`;
      expect(again).toMatchObject({
        clients_created: 0,
        clients_existing: 2,
        sales_created: 0,
        sales_skipped: 4,
        history_skipped: 1,
      });
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from sales where onec_ref is not null`;
      expect(n).toBe(4);

      // Вход клиентки по почте привязывает карточку.
      const uid = await (async () => {
        const [{ id }] =
          await tx`insert into auth.users (email) values ('anna.1c@example.com') returning id`;
        return id as string;
      })();
      const [{ user_id }] = await tx`select user_id from clients where id = ${anna.id}`;
      expect(user_id).toBe(uid);
    });
  });

  test("карточка с той же почтой уже есть — абонементы добавляются к ней", async () => {
    await scenario(async (tx) => {
      const s = await setup(tx);
      const [{ id: existing }] = await tx`
        insert into clients (studio_id, first_name, last_name, email)
        values (${s.vake}, 'Сара', 'Заведена', 'SARA.1c@example.com') returning id`;
      await as(tx, s.owner);
      const [{ r }] =
        await tx`select import_1c_chunk(${{ studios, clients: [chunk.clients[1]] }}::jsonb) as r`;
      expect(r).toMatchObject({ clients_created: 0, clients_reused: 1, sales_created: 1 });
      await asServer(tx);
      const [{ n }] =
        await tx`select count(*)::int as n from clients where email ilike 'sara.1c@example.com'`;
      expect(n).toBe(1);
      const [cm] =
        await tx`select client_id, visits_left, status from client_memberships where onec_ref = '1-5/rest/2'`;
      expect(cm).toMatchObject({ client_id: existing, visits_left: 3, status: "active" });
      // Карточку завёл сотрудник — «Добавлен» остаётся «Сотрудником».
      const [{ source }] = await tx`select source from clients where id = ${existing}`;
      expect(source).toBe("admin");
    });
  });

  test("«Добавлен»: из админки «Импорт» и ключ 1С не подделать", async () => {
    await scenario(async (tx) => {
      const s = await setup(tx);
      await as(tx, s.owner);
      await tx`select import_1c_chunk(${chunk}::jsonb)`;
      const [created] = await tx`
        insert into clients (studio_id, first_name, source, onec_ref)
        values (${s.vake}, 'Новая', 'import', '1c-fake') returning source, onec_ref`;
      expect(created).toEqual({ source: "admin", onec_ref: null });
      const [edited] = await tx`
        update clients set source = 'admin', onec_ref = null, first_name = 'Анюта'
         where onec_ref = '1c-000001' returning source, onec_ref, first_name`;
      expect(edited).toEqual({ source: "import", onec_ref: "1c-000001", first_name: "Анюта" });
      const [{ source }] =
        await tx`select source from clients_with_status where onec_ref = '1c-000002'`;
      expect(source).toBe("import");
    });
  });

  test("заливает и удаляет только владелец; удалить можно до входа клиентов", async () => {
    await scenario(async (tx) => {
      const s = await setup(tx);
      const admin = await user(tx, `admin-${crypto.randomUUID()}@example.com`);
      await tx`insert into user_roles (user_id, studio_id, role) values (${admin}, ${s.vake}, 'admin')`;
      await as(tx, admin);
      expect(await failure(tx, () => tx`select import_1c_chunk(${chunk}::jsonb)`)).toContain(
        "только владелец",
      );
      await as(tx, s.owner);
      expect(
        await failure(
          tx,
          () => tx`select import_1c_chunk(${{ studios: { x: "Нет такого" }, clients: [] }}::jsonb)`,
        ),
      ).toContain("не найден");
      expect(
        await failure(
          tx,
          () =>
            tx`select import_1c_chunk(${{ studios, catalog: ["Пакет 16", "Пакет 99"], clients: [] }}::jsonb)`,
        ),
      ).toContain("нет абонемента «Пакет 99»");
      await tx`select import_1c_chunk(${chunk}::jsonb)`;
      expect(await failure(tx, () => tx`select import_1c_rollback('да')`)).toContain("УДАЛИТЬ");
      const [{ r }] = await tx`select import_1c_rollback('УДАЛИТЬ') as r`;
      expect(r).toMatchObject({ clients: 2, sales: 4, history: 1 });
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from clients where onec_ref is not null`;
      expect(n).toBe(0);

      await as(tx, s.owner);
      await tx`select import_1c_chunk(${chunk}::jsonb)`;
      await asServer(tx);
      await tx`insert into auth.users (email) values ('sara.1c@example.com')`;
      await as(tx, s.owner);
      expect(await failure(tx, () => tx`select import_1c_rollback('УДАЛИТЬ')`)).toContain(
        "уже входили",
      );
    });
  });
});
