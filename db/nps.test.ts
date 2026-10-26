/**
 * Тесты NPS-опросов приложения в базе (db/migrations/2026-10-15_zz_nps_surveys.sql):
 * когда какой опрос положен клиенту, частота, закрытие крестиком, ответ.
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

type Survey = { survey_type: string; occasion: string } | null;

describe.skipIf(!url)("NPS-опросы (база)", () => {
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
        // «Сегодня» базы (current_date) — по Тбилиси, как в nps_pending_survey:
        // иначе поздним вечером по UTC даты сценариев сдвигались на день.
        await tx`set local timezone = 'Asia/Tbilisi'`;
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

  type Seed = {
    studio: string;
    workout: string;
    pack: string;
    trial: string;
    client: string;
    user: string;
  };

  /**
   * Клуб, тренировка, пакет и пробное, клиент с приложением. registeredDaysAgo —
   * дата регистрации карточки (давний клиент — не новичок).
   */
  async function seed(
    tx: Tx,
    opts: { format?: "packages" | "subscription"; registeredDaysAgo?: number } = {},
  ): Promise<Seed> {
    const [{ id: studio }] = await tx`
      insert into studios (name, format) values ('Тест', ${opts.format ?? "packages"}) returning id`;
    const [{ id: workout }] = await tx`
      insert into workouts (studio_id, name) values (${studio}, 'Стретчинг') returning id`;
    const [{ id: pack }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
      values (${studio}, 'Пакет 8', 'package', 8, 30, 100) returning id`;
    const [{ id: trial }] = await tx`
      insert into memberships (studio_id, name, kind, visits_count, duration_days, price)
      values (${studio}, 'Пробное', 'trial', 1, 7, 10) returning id`;
    const email = `c-${crypto.randomUUID()}@example.com`;
    await tx`set local session_replication_role = replica`;
    const [{ id: user }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
    const [{ id: client }] = await tx`
      insert into clients (studio_id, first_name, last_name, email, user_id, registration_date)
      values (${studio}, 'Анна', 'Тестова', ${email}, ${user},
              current_date - ${opts.registeredDaysAgo ?? 0}::int)
      returning id`;
    return { studio, workout, pack, trial, client, user };
  }

  /**
   * Посещение («Посетил») занятия, начавшегося hoursAgo часов назад и шедшего
   * час. Напрямую, без триггеров списания: здесь важна только история.
   */
  async function visit(tx: Tx, s: Seed, hoursAgo: number) {
    await tx`set local session_replication_role = replica`;
    const [{ id: entry }] = await tx`
      insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
      values (${s.studio}, ${s.workout}, 'group',
              now() - make_interval(hours => ${hoursAgo}),
              now() - make_interval(hours => ${hoursAgo - 1}))
      returning id`;
    await tx`
      insert into schedule_bookings (studio_id, entry_id, user_id, client_id, status)
      values (${s.studio}, ${entry}, ${s.user}, ${s.client}, 'attended')`;
    await tx`set local session_replication_role = origin`;
  }

  const days = (n: number) => n * 24;

  /** Абонемент клиента с заданными датами (дни от сегодня; null — без даты). */
  async function membership(
    tx: Tx,
    s: Seed,
    opts: {
      membership?: string;
      status?: string;
      startedDaysAgo?: number | null;
      endsInDays?: number | null;
      createdDaysAgo?: number;
      visitsLeft?: number | null;
    },
  ): Promise<string> {
    const started = opts.startedDaysAgo ?? null;
    const ends = opts.endsInDays ?? null;
    const created = opts.createdDaysAgo ?? started ?? 0;
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into client_memberships (
        studio_id, client_id, membership_id, status, started_at, ends_at,
        visits_left, balance_kind, created_at
      ) values (
        ${s.studio}, ${s.client}, ${opts.membership ?? s.pack}, ${opts.status ?? "active"},
        case when ${started}::int is null then null else current_date - ${started}::int end,
        case when ${ends}::int is null then null else current_date + ${ends}::int end,
        ${opts.visitsLeft === undefined ? 5 : opts.visitsLeft}, 'group',
        now() - make_interval(days => ${created})
      ) returning id`;
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

  /** Какой опрос приложение покажет клиенту сейчас. */
  async function survey(tx: Tx, s: Seed): Promise<Survey> {
    await as(tx, s.user);
    const [{ v }] = await tx`select my_nps_survey() as v`;
    await asServer(tx);
    return v as Survey;
  }

  async function shown(tx: Tx, s: Seed, sv: NonNullable<Survey>) {
    await as(tx, s.user);
    await tx`select nps_survey_shown(${sv.survey_type}, ${sv.occasion})`;
    await asServer(tx);
  }

  async function close(tx: Tx, s: Seed, sv: NonNullable<Survey>) {
    await as(tx, s.user);
    await tx`select nps_survey_close(${sv.survey_type}, ${sv.occasion})`;
    await asServer(tx);
  }

  /** Сдвинуть все показы клиента в прошлое на n дней. */
  async function ageShows(tx: Tx, s: Seed, n: number) {
    await tx`
      update nps_survey_prompts set shown_at = shown_at - make_interval(days => ${n})
       where user_id = ${s.user}`;
  }

  test("первые занятия: после 4-го посещения, когда оно закончилось", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      for (const h of [days(10), days(7), days(4)]) await visit(tx, s, h);
      expect(await survey(tx, s)).toBeNull();

      // 4-е занятие ещё идёт (началось 30 минут назад).
      await tx`set local session_replication_role = replica`;
      const [{ id: entry }] = await tx`
        insert into schedule_entries (studio_id, workout_id, kind, starts_at, ends_at)
        values (${s.studio}, ${s.workout}, 'group', now() - interval '30 minutes', now() + interval '30 minutes')
        returning id`;
      const [{ id: booking }] = await tx`
        insert into schedule_bookings (studio_id, entry_id, user_id, client_id, status)
        values (${s.studio}, ${entry}, ${s.user}, ${s.client}, 'attended') returning id`;
      await tx`set local session_replication_role = origin`;
      expect(await survey(tx, s)).toBeNull();

      // Закончилось час назад.
      await tx`
        update schedule_entries set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
         where id = ${entry}`;
      expect(await survey(tx, s)).toEqual({ survey_type: "first_lessons", occasion: "once" });

      // «Не посетил» — не посещение.
      await tx`set local session_replication_role = replica`;
      await tx`update schedule_bookings set status = 'no_show' where id = ${booking}`;
      await tx`set local session_replication_role = origin`;
      expect(await survey(tx, s)).toBeNull();
    });
  });

  test("первые занятия: через 14 дней не показываются, давнему клиенту — никогда", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      for (const h of [days(30), days(25), days(20), days(16)]) await visit(tx, s, h);
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      // Перенесён из прежней системы: зарегистрирован год назад, истории посещений нет.
      const s = await seed(tx, { registeredDaysAgo: 365 });
      for (const h of [days(7), days(5), days(3), 3]) await visit(tx, s, h);
      expect(await survey(tx, s)).toBeNull();
    });
  });

  test("закрыт крестиком — больше не показывается, следующий опрос — через 14 дней", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 40 });
      // Первый абонемент начался 31 день назад — положен и «Первый месяц».
      await membership(tx, s, { startedDaysAgo: 31, endsInDays: 5 });
      for (const h of [days(9), days(6), days(3), 3]) await visit(tx, s, h);

      const first = await survey(tx, s);
      expect(first).toEqual({ survey_type: "first_lessons", occasion: "once" });
      await shown(tx, s, first!);
      // Показанный, но не закрытый (закрыли приложение) — снова тот же.
      expect(await survey(tx, s)).toEqual(first);

      await close(tx, s, first!);
      const [row] = await tx`
        select closed_at, answered_at from nps_survey_prompts where user_id = ${s.user}`;
      expect(row.closed_at).not.toBeNull();
      expect(row.answered_at).toBeNull();
      expect(await survey(tx, s)).toBeNull();

      await ageShows(tx, s, 15);
      expect(await survey(tx, s)).toEqual({ survey_type: "first_month", occasion: "once" });
    });
  });

  test("ответ: имя и клуб из карточки, комментарий обязателен, второй раз нельзя", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      for (const h of [days(9), days(6), days(3), 3]) await visit(tx, s, h);
      const sv = (await survey(tx, s))!;
      await shown(tx, s, sv);

      await as(tx, s.user);
      const submit = (score: number, comment: string) =>
        tx`select submit_nps_response(${sv.survey_type}, ${sv.occasion}, ${score}::int, ${comment}, 'ka') as id`;
      expect(await failure(tx, () => submit(9, "   "))).toContain("Ответьте на вопрос");
      expect(await failure(tx, () => submit(11, "Всё нравится"))).toContain("от 0 до 10");
      const [{ id }] = await submit(9, "  Тренеры  ");
      expect(await failure(tx, () => submit(10, "Ещё раз"))).toContain("уже ответили");
      await asServer(tx);

      const [resp] = await tx`select * from nps_responses where id = ${id}`;
      expect(resp.score).toBe(9);
      expect(resp.comment).toBe("Тренеры");
      expect(resp.client_name).toBe("Тестова Анна");
      expect(resp.language).toBe("ka");
      expect(resp.survey_type).toBe("first_lessons");
      expect(resp.studio_id).toBe(s.studio);
      expect(resp.client_id).toBe(s.client);
      expect(resp.user_id).toBe(s.user);
      const [prompt] = await tx`select answered_at, response_id from nps_survey_prompts where user_id = ${s.user}`;
      expect(prompt.response_id).toBe(id);
      expect(await survey(tx, s)).toBeNull();

      // Счётчики показов в админке — сотруднику; клиенту — пусто (RLS).
      await as(tx, s.user);
      expect((await tx`select * from nps_prompt_stats(${s.studio}::uuid)`).length).toBe(0);
      await tx`reset role`;
      await tx`set local session_replication_role = replica`;
      const [{ id: staff }] = await tx`
        insert into auth.users (email) values (${`staff-${s.studio}@example.com`}) returning id`;
      await tx`set local session_replication_role = origin`;
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;
      await as(tx, staff);
      const stats = await tx`select * from nps_prompt_stats(${s.studio}::uuid)`;
      await asServer(tx);
      expect(stats.map((r: Record<string, unknown>) => ({ ...r }))).toEqual([
        { survey_type: "first_lessons", shown: "1", answered: "1", closed: "0" },
      ]);

      // Карточку удалили — ответ в статистике остаётся, без имени и связи с клиентом.
      await tx`delete from clients where id = ${s.client}`;
      const [left] = await tx`select score, client_name, client_id, user_id from nps_responses where id = ${id}`;
      expect({ ...left }).toEqual({ score: 9, client_name: null, client_id: null, user_id: null });
    });
  });

  test("прочитано: ответ из приложения — новый, сотрудник отмечает, кто и когда — база", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      for (const h of [days(9), days(6), days(3), 3]) await visit(tx, s, h);
      const sv = (await survey(tx, s))!;
      await shown(tx, s, sv);
      await as(tx, s.user);
      const [{ id }] = await tx`
        select submit_nps_response(${sv.survey_type}, ${sv.occasion}, 4, 'Душно в зале', 'ru') as id`;
      await asServer(tx);

      const unread = async () =>
        Number(
          (
            await tx`select count(*) as n from nps_responses
                      where studio_id = ${s.studio} and read_at is null`
          )[0].n,
        );
      expect(await unread()).toBe(1);

      await tx`set local session_replication_role = replica`;
      const [{ id: staff }] = await tx`
        insert into auth.users (email) values (${`staff-${s.studio}@example.com`}) returning id`;
      await tx`set local session_replication_role = origin`;
      await tx`insert into user_roles (user_id, studio_id, role) values (${staff}, ${s.studio}, 'admin')`;
      await tx`
        insert into profiles (id, full_name, studio_id) values (${staff}, 'Админ Тестовый', ${s.studio})
        on conflict (id) do update set full_name = excluded.full_name`;
      await as(tx, staff);
      // «Обработан» у критика не трогает «прочитано».
      await tx`update nps_responses set handled = true where id = ${id}`;
      await asServer(tx);
      expect(await unread()).toBe(1);

      // Прочитано: время и имя ставит база, а не браузер.
      await as(tx, staff);
      await tx`update nps_responses set read_at = '2000-01-01', read_by_name = 'Кто-то' where id = ${id}`;
      await asServer(tx);
      const [row] = await tx`select read_at, read_by, read_by_name from nps_responses where id = ${id}`;
      expect(row.read_at.getFullYear()).toBeGreaterThan(2000);
      expect(row.read_by).toBe(staff);
      expect(row.read_by_name).toBe("Админ Тестовый");
      expect(await unread()).toBe(0);

      // Внесённый сотрудником вручную — сразу прочитан.
      await as(tx, staff);
      const [{ id: manual }] = await tx`
        insert into nps_responses (studio_id, score, survey_type, client_name)
        values (${s.studio}, 10, 'general', 'Клиентка') returning id`;
      await asServer(tx);
      const [m] = await tx`select read_at, read_by from nps_responses where id = ${manual}`;
      expect(m.read_at).not.toBeNull();
      expect(m.read_by).toBe(staff);
      expect(await unread()).toBe(0);
    });
  });

  test("ответить можно только на положенный опрос; напрямую в ответы клиент не пишет", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx);
      await as(tx, s.user);
      expect(
        await failure(tx, () => tx`select submit_nps_response('first_month', 'once', 10, 'Супер', 'ru')`),
      ).toContain("недоступен");
      expect(
        await failure(
          tx,
          () => tx`insert into nps_responses (score, survey_type, comment) values (10, 'general', 'Спам')`,
        ),
      ).toContain("row-level security");
      // Чужие показы и ответы клиент не читает.
      expect((await tx`select * from nps_survey_prompts`).length).toBe(0);
      await asServer(tx);
    });
  });

  test("первый месяц: 30 дней с начала первого абонемента, пробный не в счёт", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 40 });
      await membership(tx, s, {
        membership: s.trial,
        status: "expired",
        startedDaysAgo: 40,
        endsInDays: -33,
      });
      const cm = await membership(tx, s, { startedDaysAgo: 20, endsInDays: 25 });
      expect(await survey(tx, s)).toBeNull();

      await tx`update client_memberships set started_at = current_date - 30 where id = ${cm}`;
      expect(await survey(tx, s)).toEqual({ survey_type: "first_month", occasion: "once" });

      // Окно — 21 день.
      await tx`update client_memberships set started_at = current_date - 51 where id = ${cm}`;
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      // Ушёл: абонемент закончился 20 дней назад, другого нет.
      const s = await seed(tx, { registeredDaysAgo: 40 });
      await membership(tx, s, { status: "expired", startedDaysAgo: 32, endsInDays: -20 });
      expect(await survey(tx, s)).toBeNull();
    });
  });

  test("перед продлением: за 10 дней до окончания, в пакетном — и по остатку", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 400 });
      const cm = await membership(tx, s, { startedDaysAgo: 20, endsInDays: 11 });
      expect(await survey(tx, s)).toBeNull();
      await tx`update client_memberships set ends_at = current_date + 10 where id = ${cm}`;
      expect(await survey(tx, s)).toEqual({ survey_type: "before_renewal", occasion: cm });
      // Ещё не начался (ждёт первого посещения) — не в счёт.
      await tx`update client_memberships set started_at = null, ends_at = null, visits_left = 1 where id = ${cm}`;
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 400 });
      const cm = await membership(tx, s, { startedDaysAgo: 5, endsInDays: 25, visitsLeft: 3 });
      expect(await survey(tx, s)).toBeNull();
      await tx`update client_memberships set visits_left = 2 where id = ${cm}`;
      expect(await survey(tx, s)).toEqual({ survey_type: "before_renewal", occasion: cm });
      // Показали и закрыли приложение, а потом клиент купил продление — опрос
      // больше не показывается: возражения отрабатывать не нужно.
      await shown(tx, s, { survey_type: "before_renewal", occasion: cm });
      await membership(tx, s, { status: "pending", startedDaysAgo: null, createdDaysAgo: 0 });
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      // Продление пакета персональных не отменяет опрос по групповому.
      const s = await seed(tx, { registeredDaysAgo: 400 });
      const cm = await membership(tx, s, { startedDaysAgo: 20, endsInDays: 5 });
      const next = await membership(tx, s, { status: "pending", startedDaysAgo: null, createdDaysAgo: 0 });
      await tx`update client_memberships set balance_kind = 'personal' where id = ${next}`;
      expect(await survey(tx, s)).toEqual({ survey_type: "before_renewal", occasion: cm });
    });
    await scenario(async (tx) => {
      // Разовое посещение (1 тренировка) — не абонемент, как пробное.
      const s = await seed(tx, { registeredDaysAgo: 400 });
      const [{ id: single }] = await tx`
        insert into memberships (studio_id, name, kind, visits_count, personal_count, duration_days, max_payments, price)
        values (${s.studio}, 'Разовое', 'single', 1, 0, 30, 1, 20) returning id`;
      await membership(tx, s, { membership: single, startedDaysAgo: 1, endsInDays: 29, visitsLeft: 1 });
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      // В подписочном остаток не списывается — по нему не смотрим.
      const s = await seed(tx, { format: "subscription", registeredDaysAgo: 400 });
      await membership(tx, s, { startedDaysAgo: 5, endsInDays: 25, visitsLeft: 1 });
      expect(await survey(tx, s)).toBeNull();
    });
  });

  test("перед продлением: через 30 дней после другого опроса и не чаще раза в 90 дней", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 400 });
      const old = await membership(tx, s, { status: "replaced", startedDaysAgo: 80, endsInDays: -50 });
      await tx`
        insert into nps_survey_prompts (user_id, survey_type, occasion, shown_at, answered_at)
        values (${s.user}, 'after_return', ${old}, now() - interval '20 days', now() - interval '20 days')`;
      const cm = await membership(tx, s, { startedDaysAgo: 25, endsInDays: 5 });
      expect(await survey(tx, s)).toBeNull();

      await ageShows(tx, s, 11);
      expect(await survey(tx, s)).toEqual({ survey_type: "before_renewal", occasion: cm });

      await tx`
        insert into nps_survey_prompts (user_id, survey_type, occasion, shown_at, closed_at)
        values (${s.user}, 'before_renewal', ${old}, now() - interval '60 days', now() - interval '60 days')`;
      expect(await survey(tx, s)).toBeNull();
      await ageShows(tx, s, 31);
      expect(await survey(tx, s)).toEqual({ survey_type: "before_renewal", occasion: cm });
    });
  });

  test("после возобновления: перерыв дольше 14 дней, после 2-го посещения", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 400 });
      await membership(tx, s, { status: "expired", startedDaysAgo: 90, endsInDays: -40 });
      const back = await membership(tx, s, { startedDaysAgo: 8, endsInDays: 22, createdDaysAgo: 9 });
      await visit(tx, s, days(8));
      expect(await survey(tx, s)).toBeNull();
      await visit(tx, s, days(2));
      expect(await survey(tx, s)).toEqual({ survey_type: "after_return", occasion: back });
    });
    await scenario(async (tx) => {
      // Перерыв 10 дней — продление, не возвращение.
      const s = await seed(tx, { registeredDaysAgo: 400 });
      await membership(tx, s, { status: "expired", startedDaysAgo: 49, endsInDays: -19 });
      await membership(tx, s, { startedDaysAgo: 8, endsInDays: 22, createdDaysAgo: 9 });
      await visit(tx, s, days(8));
      await visit(tx, s, days(2));
      expect(await survey(tx, s)).toBeNull();
    });
    await scenario(async (tx) => {
      // Заменённый без даты (ждал первого посещения) кончился покупкой нового — не перерыв.
      const s = await seed(tx, { registeredDaysAgo: 400 });
      await membership(tx, s, { status: "replaced", startedDaysAgo: null, createdDaysAgo: 60 });
      await membership(tx, s, { startedDaysAgo: 8, endsInDays: 22, createdDaysAgo: 9 });
      await visit(tx, s, days(8));
      await visit(tx, s, days(2));
      expect(await survey(tx, s)).toBeNull();
    });
  });

  test("приоритет: после возобновления раньше первых занятий", async () => {
    await scenario(async (tx) => {
      const s = await seed(tx, { registeredDaysAgo: 70 });
      await membership(tx, s, { status: "expired", startedDaysAgo: 70, endsInDays: -40 });
      await visit(tx, s, days(70));
      await visit(tx, s, days(65));
      const back = await membership(tx, s, { startedDaysAgo: 8, endsInDays: 22, createdDaysAgo: 9 });
      await visit(tx, s, days(8));
      await visit(tx, s, days(2));
      // Положены оба (4-е посещение и 2-е по возвращении) — показывается один.
      const sv = await survey(tx, s);
      expect(sv).toEqual({ survey_type: "after_return", occasion: back });
      await shown(tx, s, sv!);
      await close(tx, s, sv!);
      expect(await survey(tx, s)).toBeNull();
    });
  });
});
