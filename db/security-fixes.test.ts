/**
 * Тесты исправлений безопасности по код-ревью 2026-11-08
 * (db/migrations/2026-11-08_zzzzzzzzzz_security_fixes.sql): управление чужой
 * учётной записью, роли в чатах и проектах (проверки с NULL), перенос задачи
 * в проект, ФИО профиля, «Аналитика» и чаты заблокированного, права через
 * оргструктуру, обратная связь и NPS по клубам, «свои» сотрудники.
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

describe.skipIf(!url)("исправления безопасности 2026-11-08 (база)", () => {
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

  async function as(tx: Tx, userId: string) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function account(tx: Tx, name: string, studioId: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studioId}, ${name}, 'x@example.com')
             on conflict (id) do update set full_name = excluded.full_name`;
    return id as string;
  }

  async function studio(tx: Tx): Promise<string> {
    await asServer(tx);
    const [{ id }] = await tx`
      insert into studios (name, format) values (${`Клуб ${crypto.randomUUID().slice(0, 4)}`}, 'packages')
      returning id`;
    return id as string;
  }

  /** Человек портала с ролями (системный ключ или id роли) — как сервер. */
  async function portal(
    tx: Tx,
    name: string,
    home: string,
    roles: { key?: string; role?: string; scope?: "all" | "studios"; ids?: string[] }[] = [],
    createdBy: string | null = null,
  ): Promise<string> {
    await asServer(tx);
    const id = await account(tx, name, home);
    await tx`insert into portal_users (user_id, created_by) values (${id}, ${createdBy})`;
    for (const r of roles) {
      await tx`
        insert into access_assignments (role_id, subject_type, user_id, scope_type, scope_ids)
        values (coalesce(${r.role ?? null}::uuid, (select id from access_roles where system_key = ${r.key ?? ""})),
                'user', ${id}, ${r.scope ?? "all"}, ${r.ids ?? []}::uuid[])`;
    }
    await tx`select access_flush()`;
    return id;
  }

  async function newRole(tx: Tx, name: string, perms: string[]): Promise<string> {
    const [{ id }] = await tx`insert into access_roles (name) values (${name}) returning id`;
    for (const p of perms) {
      const [key, level] = p.split("=");
      await tx`insert into access_role_permissions (role_id, perm_key, level)
               values (${id}, ${key}, ${level ?? "on"})`;
    }
    return id as string;
  }

  /** Сотрудник клуба без модели доступа (как в тестах чатов и задач). */
  async function staff(tx: Tx, name: string, studioId: string): Promise<string> {
    await asServer(tx);
    const id = await account(tx, name, studioId);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, 'admin'::app_role)`;
    return id;
  }

  test("чужая учётная запись: «кого завёл» не даёт входа в обход прав; права цели — не шире своих", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      await portal(tx, "Суперадмин", s1, [{ key: "superadmin" }]);
      const hr = await portal(tx, "Кадры", s1, [{ key: "portal_admin" }]);
      const owner = await portal(tx, "Партнёр", s1, [{ key: "studio_owner", scope: "studios", ids: [s1] }]);
      // Партнёр завёл человека, потом тому выдали «Администратора портала».
      const victim = await portal(tx, "Цель", s1, [{ key: "portal_admin" }], owner);
      await as(tx, owner);
      expect((await tx`select access_can_manage(${victim}) as ok`)[0].ok).toBe(false);
      // Кадры (все пользователи) — не к человеку с правами шире своих.
      const kb = await portal(tx, "Админ знаний", s1, [{ key: "kb_admin" }]);
      await as(tx, hr);
      expect((await tx`select access_can_manage(${kb}) as ok`)[0].ok).toBe(false);
      const plain = await portal(tx, "Сотрудник УК", s1, [{ key: "trainer_academy" }]);
      expect((await tx`select access_can_manage(${plain}) as ok`)[0].ok).toBe(false);
      const clerk = await portal(tx, "Сотрудник клуба", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);
      await as(tx, hr);
      expect((await tx`select access_can_manage(${clerk}) as ok`)[0].ok).toBe(true);
      // Партнёр — своего сотрудника да, клиента чужого клуба нет.
      await as(tx, owner);
      expect((await tx`select access_can_manage(${clerk}) as ok`)[0].ok).toBe(true);
      const s2 = await studio(tx);
      await asServer(tx);
      await tx`insert into clients (studio_id, full_name, user_id) values (${s2}, 'Клиент Б', ${clerk})`;
      await as(tx, owner);
      expect((await tx`select access_can_manage(${clerk}) as ok`)[0].ok).toBe(false);
    });
  });

  test("чат: роли меняет только владелец группы; не участник — нет", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await staff(tx, "Анна", s);
      const b = await staff(tx, "Борис", s);
      const x = await staff(tx, "Посторонний", s);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b]}::uuid[]) as id`;
      await as(tx, x);
      expect(await failure(tx, () => tx`select chat_member_set_role(${g}, ${b}, 'admin')`)).toContain(
        "chat_owner_only",
      );
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_member_set_role(${g}, ${b}, 'admin')`)).toContain(
        "chat_owner_only",
      );
      await as(tx, a);
      expect(await failure(tx, () => tx`select chat_member_set_role(${g}, ${x}, 'admin')`)).toContain(
        "chat_role_invalid",
      );
      await tx`select chat_member_set_role(${g}, ${b}, 'admin')`;
      await asServer(tx);
      expect((await tx`select role from chat_members where chat_id = ${g} and user_id = ${b}`)[0].role).toBe("admin");
    });
  });

  test("проекты: не участник не удаляет, не меняет роли, не убирает; чужую задачу в свой проект не перенести", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await staff(tx, "Анна", s);
      const b = await staff(tx, "Борис", s);
      const x = await staff(tx, "Посторонний", s);
      await as(tx, a);
      const [{ id: pr }] = await tx`select task_project_save(null, ${{ title: "Проект А" }}::jsonb) as id`;
      await tx`select task_project_members_add(${pr}, ${[b]}::uuid[])`;
      await as(tx, x);
      expect(await failure(tx, () => tx`select task_project_delete(${pr})`)).toContain("project_forbidden");
      expect(await failure(tx, () => tx`select task_project_member_set_role(${pr}, ${b}, 'owner')`)).toContain(
        "project_forbidden",
      );
      expect(await failure(tx, () => tx`select task_project_member_remove(${pr}, ${b})`)).toContain(
        "project_forbidden",
      );
      await asServer(tx);
      expect((await tx`select count(*)::int as n from task_projects where id = ${pr}`)[0].n).toBe(1);
      expect((await tx`select role from task_project_members where project_id = ${pr} and user_id = ${b}`)[0].role).toBe(
        "member",
      );

      // Задача Анны, Посторонний — наблюдатель; его проект.
      await as(tx, a);
      const [{ r }] = await tx`select task_create(${{ title: "Задача Анны", assignee_id: b, watcher_ids: [x] }}::jsonb) as r`;
      const task = (r as { tasks: { id: string }[] }).tasks[0].id;
      await as(tx, x);
      const [{ id: mine }] = await tx`select task_project_save(null, ${{ title: "Свой" }}::jsonb) as id`;
      await asServer(tx);
      await tx`select set_config('request.jwt.claim.sub', ${x}::text, true)`;
      expect(await failure(tx, () => tx`update tasks set project_id = ${mine} where id = ${task}`)).toContain(
        "task_project_move_forbidden",
      );
      // Постановщик — может (в проект, где он участник).
      await as(tx, a);
      await tx`select task_update(${task}, ${{ project_id: pr }}::jsonb)`;
      await asServer(tx);
      expect((await tx`select project_id from tasks where id = ${task}`)[0].project_id).toBe(pr);
    });
  });

  test("профиль: ФИО и почту из браузера не изменить, сервер — может", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await staff(tx, "Анна Таргет", s);
      await as(tx, a);
      await tx`update profiles set full_name = 'Петрова Мария', email = 'y@example.com' where id = ${a}`;
      await asServer(tx);
      expect((await tx`select full_name, email from profiles where id = ${a}`)[0]).toEqual({
        full_name: "Анна Таргет",
        email: "x@example.com",
      });
      await tx`set local role service_role`;
      await tx`update profiles set full_name = 'Анна Новая' where id = ${a}`;
      await asServer(tx);
      expect((await tx`select full_name from profiles where id = ${a}`)[0].full_name).toBe("Анна Новая");
    });
  });

  test("«Аналитика»: заблокированный партнёр не видит «Мой город»", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const partnerRole = await newRole(tx, "Партнёр аналитики", ["an.partner"]);
      const p = await portal(tx, "Партнёр", s, [{ role: partnerRole }]);
      await tx`insert into an_partner_cities (user_id, city) values (${p}, 'Тверь')`;
      await tx`set local role service_role`;
      const [{ m: before }] = await tx`select an_me_for(${p}) as m`;
      expect(before.visible).toBe(true);
      expect(before.reports).toContain("onec.mycity");
      await asServer(tx);
      await tx`update portal_users set status = 'blocked' where user_id = ${p}`;
      await tx`select access_flush()`;
      await tx`set local role service_role`;
      const [{ m: after }] = await tx`select an_me_for(${p}) as m`;
      expect(after).toMatchObject({ visible: false, reports: [], partner_cities: null });
      await asServer(tx);
      const [{ ids }] = await tx`select an_fb_mycity_ids(${p}) as ids`;
      expect(ids).toEqual([]);
    });
  });

  test("чаты: вне портала — ни сообщений, ни файлов, ни «печатает…»", async () => {
    await scenario(async (tx) => {
      const s = await studio(tx);
      const a = await staff(tx, "Анна", s);
      const b = await staff(tx, "Борис", s);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b]}::uuid[]) as id`;
      await as(tx, b);
      expect((await tx`select * from chat_messages_page(${g})`).length).toBeGreaterThanOrEqual(0);
      expect((await tx`select chat_file_allowed(${`${g}/f.png`}) as ok`)[0].ok).toBe(true);
      expect((await tx`select chat_topic_member(${`chat:${g}`}) as ok`)[0].ok).toBe(true);
      // Уволили: ролей нет, строка участника чата осталась.
      await asServer(tx);
      await tx`delete from user_roles where user_id = ${b}`;
      await as(tx, b);
      expect(await failure(tx, () => tx`select * from chat_messages_page(${g})`)).not.toBeNull();
      expect((await tx`select chat_file_allowed(${`${g}/f.png`}) as ok`)[0].ok).toBe(false);
      expect((await tx`select chat_topic_member(${`chat:${g}`}) as ok`)[0].ok).toBe(false);
      // Роль другого человека видна как раньше (его можно убрать из чата).
      await as(tx, a);
      await tx`select chat_member_remove(${g}, ${b})`;
    });
  });

  test("оргструктура: права через подразделение — не себе и не больше своих", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const sa = await portal(tx, "Суперадмин", s1, [{ key: "superadmin" }]);
      const structRole = await newRole(tx, "Оргструктура", ["structure.manage"]);
      const st = await portal(tx, "Структура", s1, [{ role: structRole }]);
      const other = await portal(tx, "Сотрудник", s1);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел развития') returning id`;
      const [{ id: empty }] = await tx`insert into org_units (name) values ('Без ролей') returning id`;
      await tx`insert into access_assignments (role_id, subject_type, unit_id, unit_members, with_subunits,
                                               scope_type, scope_ids)
               values ((select id from access_roles where system_key = 'curator'), 'unit', ${unit}, 'all', true,
                       'studios', ${[s1]}::uuid[])`;
      await tx`select access_flush()`;

      await as(tx, st);
      expect(await failure(tx, () => tx`select org_member_set(${unit}, ${st}, 'member')`)).toContain(
        "access_structure_self",
      );
      expect(await failure(tx, () => tx`select org_member_set(${unit}, ${other}, 'member')`)).toContain(
        "access_structure_grant",
      );
      // Подразделение без ролей — можно: права ни у кого не меняются.
      await tx`select org_member_set(${empty}, ${other}, 'member')`;
      await tx`select org_member_set(${empty}, ${st}, 'member')`;
      // Собственник клуба без ролей «Клубы собственника» — права не меняются, можно.
      expect(await failure(tx, () => tx`select org_user_studios_set(${st}, ${[s1]}::uuid[])`)).toBeNull();
      // Суперадминистратору — как раньше.
      await as(tx, sa);
      await tx`select org_member_set(${unit}, ${other}, 'member')`;
      await asServer(tx);
      expect(
        (await tx`select count(*)::int as n from user_roles where user_id = ${other} and studio_id = ${s1}`)[0].n,
      ).toBeGreaterThan(0);
    });
  });

  test("обратная связь и NPS: сотрудник видит и удаляет только свои клубы", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const s2 = await studio(tx);
      const a = await staff(tx, "Анна А", s1);
      await asServer(tx);
      await tx`insert into feedback (studio_id, topic, message) values (${s1}, 'idea', 'Свой'), (${s2}, 'idea', 'Чужой')`;
      await tx`insert into nps_responses (studio_id, score) values (${s1}, 9), (${s2}, 3)`;
      await as(tx, a);
      expect((await tx`select message from feedback order by message`).map((r: { message: string }) => r.message)).toEqual([
        "Свой",
      ]);
      expect((await tx`select score from nps_responses`).map((r: { score: number }) => r.score)).toEqual([9]);
      await tx`delete from feedback where studio_id = ${s2}`;
      expect(
        await failure(tx, () => tx`insert into feedback (studio_id, topic, message, source) values (${s2}, 'idea', 'x', 'portal')`),
      ).not.toBeNull();
      await asServer(tx);
      expect((await tx`select count(*)::int as n from feedback where studio_id = ${s2}`)[0].n).toBe(1);
    });
  });

  test("сотрудники: чужого тренера не привязать к своему клубу, не изменить, реквизиты не видны", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const s2 = await studio(tx);
      const o1 = await portal(tx, "Владелец А", s1, [{ key: "studio_owner", scope: "studios", ids: [s1] }]);
      const o2 = await portal(tx, "Владелец Б", s2, [{ key: "studio_owner", scope: "studios", ids: [s2] }]);
      // Тренер клуба Б с реквизитами.
      await as(tx, o2);
      const [{ id: t2 }] = await tx`insert into trainers (full_name, role) values ('Тренер Б', 'trainer') returning id`;
      await tx`insert into trainer_studios (trainer_id, studio_id) values (${t2}, ${s2})`;
      await tx`insert into trainer_bank_details (trainer_id, account_holder) values (${t2}, 'Тренер Б')`;
      expect((await tx`select count(*)::int as n from trainer_bank_details where trainer_id = ${t2}`)[0].n).toBe(1);

      await as(tx, o1);
      expect(
        await failure(tx, () => tx`insert into trainer_studios (trainer_id, studio_id) values (${t2}, ${s1})`),
      ).not.toBeNull();
      await tx`update trainers set tip_url = 'https://evil.example' where id = ${t2}`;
      await tx`delete from trainers where id = ${t2}`;
      expect((await tx`select count(*)::int as n from trainer_bank_details where trainer_id = ${t2}`)[0].n).toBe(0);
      await asServer(tx);
      expect((await tx`select tip_url from trainers where id = ${t2}`)[0].tip_url).toBeNull();

      // Свой — как раньше: завёл, привязал, правит.
      await as(tx, o1);
      const [{ id: t1 }] = await tx`insert into trainers (full_name, role) values ('Тренер А', 'trainer') returning id`;
      await tx`insert into trainer_studios (trainer_id, studio_id) values (${t1}, ${s1})`;
      await tx`update trainers set bio = 'Растяжка' where id = ${t1}`;
      await asServer(tx);
      expect((await tx`select bio from trainers where id = ${t1}`)[0].bio).toBe("Растяжка");
    });
  });
});
