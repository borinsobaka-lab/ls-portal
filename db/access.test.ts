/**
 * Тесты пользователей, ролей и доступов
 * (db/migrations/2026-10-25_zzzzzzzzzzzz_access_roles.sql, ACCESS.md):
 * перенос прежних «Доступов» без изменений, роли по подразделению (с
 * подчинёнными, только руководители), по должности, клубы брендов и новые
 * клубы, сроки и блокировка, сотрудник УК без клуба (база знаний, Академия),
 * выдача ролей не больше своих прав, защита последнего суперадминистратора.
 *
 * Нужна база с полной схемой:
 *   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
 *   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
 * Без переменной тесты пропускаются. Каждый сценарий откатывается.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_SCHEMA_DATABASE_URL;

type Tx = SQL;
type Row = Record<string, unknown>;

class Rollback extends Error {}

describe.skipIf(!url)("доступы и роли (база)", () => {
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

  async function account(tx: Tx, name: string, studioId: string): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`
      insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${studioId}, ${name})
             on conflict (id) do update set full_name = excluded.full_name`;
    return id as string;
  }

  async function studio(tx: Tx, format = "packages", brand: string | null = null): Promise<string> {
    const [{ id }] = await tx`
      insert into studios (name, format, brand_id)
      values (${`Клуб ${crypto.randomUUID().slice(0, 4)}`}, ${format}, ${brand})
      returning id`;
    return id as string;
  }

  /** Человек портала с ролями (по системному ключу) — как сервер. */
  async function portal(
    tx: Tx,
    name: string,
    home: string,
    roles: { key: string; scope?: "all" | "studios" | "brands"; ids?: string[] }[] = [],
  ): Promise<string> {
    const id = await account(tx, name, home);
    await tx`insert into portal_users (user_id) values (${id})`;
    for (const r of roles) {
      await tx`
        insert into access_assignments (role_id, subject_type, user_id, scope_type, scope_ids)
        values ((select id from access_roles where system_key = ${r.key}), 'user', ${id},
                ${r.scope ?? "all"}, ${r.ids ?? []}::uuid[])`;
    }
    await tx`select access_flush()`;
    return id;
  }

  async function roleId(tx: Tx, key: string): Promise<string> {
    const [{ id }] = await tx`select id from access_roles where system_key = ${key}`;
    return id as string;
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

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function staffRoles(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx`
      select studio_id::text || ':' || role::text as r from user_roles
       where user_id = ${userId} and role::text in ('owner', 'admin', 'trainer') order by 1`;
    return rows.map((r: Row) => r.r as string);
  }

  async function snapshot(tx: Tx, ids: string[]) {
    return plain({
      roles: await tx`select user_id, studio_id, role::text from user_roles
                       where user_id = any(${ids}::uuid[]) order by 1, 2, 3`,
      rail: await tx`select user_id, sections from admin_permissions
                      where user_id = any(${ids}::uuid[]) order by 1`,
      sections: await tx`select user_id, studio_id, (select array_agg(x order by x) from unnest(sections) x) s
                          from admin_studio_permissions where user_id = any(${ids}::uuid[]) order by 1, 2`,
      kb: await tx`select subject_id, base_id, level from kb_grants
                    where subject_id = any(${ids}::uuid[]) order by 1, 2`,
      academy: await tx`select user_id, can_create, can_review from acad_staff
                         where user_id = any(${ids}::uuid[]) order by 1`,
    });
  }

  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  test("перенос прежних «Доступов»: права те же, владелец всех клубов — суперадминистратор", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const s2 = await studio(tx, "subscription");
      const owner = await account(tx, "Владелец", s1);
      const partner = await account(tx, "Партнёр", s1);
      const admin = await account(tx, "Админ", s1);
      const trainer = await account(tx, "Тренер", s2);
      await tx`insert into user_roles (user_id, studio_id, role) values
        (${owner}, ${s1}, 'owner'), (${owner}, ${s2}, 'owner'),
        (${partner}, ${s1}, 'owner'), (${partner}, ${s2}, 'admin'),
        (${admin}, ${s1}, 'admin'), (${trainer}, ${s2}, 'trainer')`;
      await tx`insert into admin_permissions (user_id, sections) values (${admin}, '{club,scripts}')`;
      await tx`insert into admin_studio_permissions (user_id, studio_id, sections)
               values (${admin}, ${s1}, '{schedule,clients}'), (${partner}, ${s2}, '{cash}')`;
      const [{ id: base }] = await tx`insert into kb_bases (title, rail_title) values ('Стандарты', 'База') returning id`;
      await tx`insert into kb_grants (base_id, subject_type, subject_id, level)
               values (${base}, 'user', ${admin}, 'view'), (${base}, 'user', ${trainer}, 'edit')`;
      await tx`insert into acad_staff (user_id, can_review) values (${trainer}, true)`;

      const ids = [owner, partner, admin, trainer];
      const before = await snapshot(tx, ids);
      const legacyKbAdmin = await tx`select kb_is_admin(${partner}) a`;
      expect(legacyKbAdmin[0].a).toBe(true);

      const [{ n }] = await tx`select access_import_legacy() n`;
      expect(n).toBe(4);
      const after = await snapshot(tx, ids);
      expect(after).toEqual(before);

      const [o] = await tx`select rights, portal from access_user_rights where user_id = ${owner}`;
      expect(o.portal).toBe(true);
      expect(o.rights).toContain("portal.admin");
      // Владелец части клубов — как раньше: администратор баз знаний и Академии.
      const [p] = await tx`select kb_is_admin(${partner}) kb, acad_is_admin(${partner}) acad,
                                  access_has_right(${partner}, 'portal.admin') sa`;
      expect(p).toEqual({ kb: true, acad: true, sa: false });
      const [a] = await tx`select has_admin_section(${admin}, 'scripts') scripts,
                                  has_admin_section(${admin}, 'staff') staff,
                                  kb_is_admin(${admin}) kb`;
      expect(a).toEqual({ scripts: true, staff: false, kb: false });

      // Повторный перенос никого не трогает.
      const [{ n: again }] = await tx`select access_import_legacy() n`;
      expect(again).toBe(0);
    });
  });

  test("подразделение с подчинёнными и только руководители; перенос ветки", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const sonya = await portal(tx, "Соня", s1);
      const vera = await portal(tx, "Вера", s1);
      const [{ id: hq }] = await tx`insert into org_units (name) values ('УК') returning id`;
      const [{ id: dev }] = await tx`insert into org_units (name, parent_id) values ('Отдел развития', ${hq}) returning id`;
      const [{ id: partners }] = await tx`insert into org_units (name, parent_id) values ('Партнёры', ${dev}) returning id`;
      const [{ path }] = await tx`select path from org_units where id = ${partners}`;
      expect(path).toEqual([hq, dev]);
      await tx`insert into org_unit_members (unit_id, user_id, member_role)
               values (${partners}, ${sonya}, 'deputy'), (${partners}, ${vera}, 'member')`;
      await tx`insert into access_assignments (role_id, subject_type, unit_id, unit_members, with_subunits,
                                               scope_type, scope_ids)
               values (${await roleId(tx, "curator")}, 'unit', ${hq}, 'heads', true, 'studios', ${[s1]}::uuid[])`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, sonya)).toEqual([`${s1}:admin`]);
      expect(await staffRoles(tx, vera)).toEqual([]);
      const [{ s }] = await tx`select sections s from admin_studio_permissions
                                where user_id = ${sonya} and studio_id = ${s1}`;
      expect((s as string[]).sort()).toEqual(
        ["client-memberships", "clients", "dashboard", "feedback", "nps", "requests", "sales", "schedule"],
      );

      // Цикл в дереве не даёт база.
      const cycle = await failure(tx, () => tx`update org_units set parent_id = ${partners} where id = ${hq}`);
      expect(cycle).toContain("org_unit_cycle");

      // Ветку «Партнёры» вынесли из УК — у Сони роль пропала.
      await tx`update org_units set parent_id = null where id = ${partners}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, sonya)).toEqual([]);
      const [{ path: moved }] = await tx`select path from org_units where id = ${partners}`;
      expect(moved).toEqual([]);

      // Обратно под «Отдел развития» — путь потомков пересчитан, роль вернулась.
      await tx`update org_units set parent_id = ${dev} where id = ${partners}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, sonya)).toEqual([`${s1}:admin`]);
    });
  });

  test("должность: все базы знаний, в том числе новая; сотрудник УК без клуба", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const [{ id: pos }] = await tx`insert into org_positions (name) values ('Эксперт ОР') returning id`;
      const [{ id: b1 }] = await tx`insert into kb_bases (title, rail_title) values ('База 1', 'База') returning id`;
      const role = await newRole(tx, "Читатель всех баз", ["kb.base=view", "academy.create"]);
      await tx`insert into access_assignments (role_id, subject_type, position_id) values (${role}, 'position', ${pos})`;
      const hq = await portal(tx, "Кристина", s1);
      await tx`update portal_users set position_id = ${pos} where user_id = ${hq}`;
      await tx`select access_flush()`;

      const [r] = await tx`select is_staff(${hq}) staff, is_portal_user(${hq}) portal,
                                  kb_base_level(${hq}, ${b1}) lvl, acad_can_create(${hq}) acad,
                                  has_admin_section(${hq}, 'app') app`;
      expect(r).toEqual({ staff: false, portal: true, lvl: "view", acad: true, app: false });

      // Новая база — сразу видна (право «на все базы»).
      const [{ id: b2 }] = await tx`insert into kb_bases (title, rail_title) values ('База 2', 'База') returning id`;
      await tx`select access_flush()`;
      const [{ lvl: l2 }] = await tx`select kb_base_level(${hq}, ${b2}) lvl`;
      expect(l2).toBe("view");

      await as(tx, hq);
      const [{ ids }] = await tx`select auth_kb_view_base_ids() ids`;
      expect((ids as string[]).sort()).toEqual([b1, b2].sort());
      await asServer(tx);

      // Сменили должность — права пропали.
      await tx`update portal_users set position_id = null where user_id = ${hq}`;
      await tx`select access_flush()`;
      const [after] = await tx`select is_portal_user(${hq}) portal, kb_base_level(${hq}, ${b1}) lvl`;
      expect(after).toEqual({ portal: false, lvl: null });
    });
  });

  test("клубы бренда: новый клуб бренда — сразу, чужого бренда — нет", async () => {
    await scenario(async (tx) => {
      const [{ id: ls }] = await tx`insert into org_brands (name) values ('LS тест') returning id`;
      const [{ id: lj }] = await tx`insert into org_brands (name) values ('LJ тест') returning id`;
      const s1 = await studio(tx, "packages", ls);
      const partner = await portal(tx, "Партнёр", s1, [{ key: "studio_owner", scope: "brands", ids: [ls] }]);
      expect(await staffRoles(tx, partner)).toEqual([`${s1}:owner`]);
      const s2 = await studio(tx, "packages", ls);
      const s3 = await studio(tx, "packages", lj);
      await tx`select access_flush()`;
      expect((await staffRoles(tx, partner)).sort()).toEqual([`${s1}:owner`, `${s2}:owner`].sort());
      // Клуб перевели в другой бренд — доступ ушёл.
      await tx`update studios set brand_id = ${lj} where id = ${s2}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, partner)).toEqual([`${s1}:owner`]);
      expect(s3).toBeTruthy();
    });
  });

  test("сроки, блокировка и отложенный пересчёт без RPC", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const u = await portal(tx, "Демо", s1);
      await tx`insert into access_assignments (role_id, subject_type, user_id, scope_type, scope_ids, valid_until)
               values (${await roleId(tx, "trainer")}, 'user', ${u}, 'studios', ${[s1]}::uuid[], now() - interval '1 hour')`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, u)).toEqual([]);
      await tx`update access_assignments set valid_until = now() + interval '1 day' where user_id = ${u}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, u)).toEqual([`${s1}:trainer`]);

      // «Доступ до» вчера — как заблокирован.
      await tx`update portal_users set access_until = access_today() - 1 where user_id = ${u}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, u)).toEqual([]);
      const [{ p }] = await tx`select is_portal_user(${u}) p`;
      expect(p).toBe(false);

      await tx`update portal_users set access_until = null, status = 'blocked' where user_id = ${u}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, u)).toEqual([]);

      // Запись в обход RPC: пересчёт при фиксации (здесь — SET CONSTRAINTS).
      await tx`update portal_users set status = 'active' where user_id = ${u}`;
      expect(await staffRoles(tx, u)).toEqual([]);
      await tx`set constraints access_dirty_flush_aiu immediate`;
      expect(await staffRoles(tx, u)).toEqual([`${s1}:trainer`]);
      await tx`set constraints access_dirty_flush_aiu deferred`;

      // Убран из портала — сняты и роли, и строка прав.
      await tx`delete from portal_users where user_id = ${u}`;
      await tx`select access_flush()`;
      expect(await staffRoles(tx, u)).toEqual([]);
      const rights = await tx`select 1 from access_user_rights where user_id = ${u}`;
      expect(rights.length).toBe(0);

      const [{ n }] = await tx`select access_sync_due() n`;
      expect(n).toBeGreaterThanOrEqual(0);
    });
  });

  test("управляющий клубом выдаёт роли только в своих клубах и не больше своих прав", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const s2 = await studio(tx);
      const sa = await portal(tx, "Суперадмин", s1, [{ key: "superadmin" }]);
      const partner = await portal(tx, "Партнёр", s1, [{ key: "studio_owner", scope: "studios", ids: [s1] }]);
      const hq = await portal(tx, "Сотрудник УК", s1);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Бухгалтерия') returning id`;
      await tx`insert into org_unit_members (unit_id, user_id) values (${unit}, ${hq})`;
      await tx`insert into access_assignments (role_id, subject_type, unit_id) values (${await roleId(tx, "kb_admin")}, 'unit', ${unit})`;
      await tx`select access_flush()`;
      const newbie = await account(tx, "Новенькая", s1);
      expect(sa).toBeTruthy();

      await as(tx, partner);
      await tx`select access_user_save(${newbie}, ${JSON.stringify({ first_name: "Анна", last_name: "Новикова" })}::text::jsonb)`;
      await tx`select access_assignment_save(${JSON.stringify({
        role_id: await roleId(tx, "studio_admin"), subject_type: "user", user_id: newbie,
        scope_type: "studios", scope_ids: [s1],
      })}::text::jsonb)`;
      expect(await staffRoles(tx, newbie)).toEqual([`${s1}:admin`]);
      const [{ full_name }] = await tx`select full_name from profiles where id = ${newbie}`;
      expect(full_name).toBe("Новикова Анна");

      const foreign = await failure(tx, async () =>
        tx`select access_assignment_save(${JSON.stringify({
          role_id: await roleId(tx, "trainer"), subject_type: "user", user_id: newbie,
          scope_type: "studios", scope_ids: [s2],
        })}::text::jsonb)`);
      expect(foreign).toContain("access_grant_denied");
      const everywhere = await failure(tx, async () =>
        tx`select access_assignment_save(${JSON.stringify({
          role_id: await roleId(tx, "trainer"), subject_type: "user", user_id: newbie, scope_type: "all",
        })}::text::jsonb)`);
      expect(everywhere).toContain("access_grant_denied");
      const kbAdmin = await failure(tx, async () =>
        tx`select access_assignment_save(${JSON.stringify({
          role_id: await roleId(tx, "kb_admin"), subject_type: "user", user_id: newbie,
          scope_type: "studios", scope_ids: [s1],
        })}::text::jsonb)`);
      expect(kbAdmin).toContain("access_grant_denied");
      const superadmin = await failure(tx, async () =>
        tx`select access_assignment_save(${JSON.stringify({
          role_id: await roleId(tx, "superadmin"), subject_type: "user", user_id: newbie,
          scope_type: "studios", scope_ids: [s1],
        })}::text::jsonb)`);
      expect(superadmin).toContain("access_grant_denied");
      const self = await failure(tx, async () =>
        tx`select access_assignment_save(${JSON.stringify({
          role_id: await roleId(tx, "trainer"), subject_type: "user", user_id: partner,
          scope_type: "studios", scope_ids: [s1],
        })}::text::jsonb)`);
      expect(self).not.toBeNull();
      // Личные права — тоже не больше своих.
      const personal = await failure(tx, () =>
        tx`select access_personal_save(${newbie}, ${JSON.stringify([{ perm_key: "kb.admin" }])}::text::jsonb)`);
      expect(personal).toContain("access_grant_denied");

      // Человек УК (роль от подразделения) — не его.
      const [{ can }] = await tx`select access_can_manage(${hq}) can`;
      expect(can).toBe(false);
      const block = await failure(tx, () => tx`select access_user_status(${hq}, 'blocked')`);
      expect(block).toContain("access_forbidden");
      await tx`select access_user_status(${newbie}, 'blocked', 'Уволилась')`;
      await asServer(tx);
      expect(await staffRoles(tx, newbie)).toEqual([]);

      // Видит в списке своих, а не всех.
      await as(tx, partner);
      const list = await tx`select user_id, can_manage from access_users()`;
      const seen = new Map(list.map((r: Row) => [r.user_id, r.can_manage]));
      expect(seen.get(newbie)).toBe(true);
      expect(seen.has(hq)).toBe(false);
      await asServer(tx);
    });
  });

  test("суперадминистратор: роли меняются сразу, последнего не убрать, роли с portal.admin — только ему", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const sa = await portal(tx, "Суперадмин", s1, [{ key: "superadmin" }]);
      const pa = await portal(tx, "Админ портала", s1, [{ key: "portal_admin" }]);
      const t = await portal(tx, "Тренер", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);

      await as(tx, sa);
      const trainerRole = await roleId(tx, "trainer");
      await tx`select access_role_save(${JSON.stringify({
        id: trainerRole, name: "Тренер",
        permissions: [
          { perm_key: "studio.tier", level: "trainer" },
          { perm_key: "club.schedule" },
          { perm_key: "club.clients" },
        ],
      })}::text::jsonb)`;
      await asServer(tx);
      const [{ s }] = await tx`select sections s from admin_studio_permissions where user_id = ${t}`;
      expect((s as string[]).sort()).toEqual(["clients", "schedule"]);
      await as(tx, sa);

      const noTier = await failure(tx, () =>
        tx`select access_role_save(${JSON.stringify({ name: "Без уровня", permissions: [{ perm_key: "club.cash" }] })}::text::jsonb)`);
      expect(noTier).toContain("access_sections_need_tier");

      const [{ id: own }] = await tx`select id from access_assignments where user_id = ${sa}`;
      const last = await failure(tx, () => tx`select access_assignment_delete(${own})`);
      expect(last).toContain("access_last_superadmin");
      const selfBlock = await failure(tx, () => tx`select access_user_status(${sa}, 'blocked')`);
      expect(selfBlock).toContain("access_self");
      await asServer(tx);

      // Администратор портала: роли — да, суперадмин — нет.
      await as(tx, pa);
      const escalate = await failure(tx, () =>
        tx`select access_role_save(${JSON.stringify({ name: "Почти всё", permissions: [{ perm_key: "portal.admin" }] })}::text::jsonb)`);
      expect(escalate).toContain("access_superadmin_only");
      const locked = await failure(tx, async () =>
        tx`select access_role_save(${JSON.stringify({ id: await roleId(tx, "superadmin"), name: "Суперадминистратор", permissions: [] })}::text::jsonb)`);
      expect(locked).toContain("access_superadmin_only");
      const [{ can }] = await tx`select access_can_manage(${sa}) can`;
      expect(can).toBe(false);
      await asServer(tx);

      // Журнал записал изменения.
      const log = await tx`select action from access_log where target_role = ${trainerRole}`;
      expect(log.map((r: Row) => r.action)).toContain("role.update");
    });
  });

  test("Академия: курс по подразделению и по роли портала", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const creator = await portal(tx, "Создатель", s1, [{ key: "kb_admin" }]);
      const learner = await portal(tx, "Ученица", s1);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел контента') returning id`;
      await tx`insert into org_unit_members (unit_id, user_id) values (${unit}, ${learner})`;
      // Без назначений человек не в портале — подразделение даёт пустую роль.
      const empty = await newRole(tx, "Сотрудник УК", []);
      await tx`insert into access_assignments (role_id, subject_type, unit_id) values (${empty}, 'unit', ${unit})`;
      await tx`select access_flush()`;
      const [{ p }] = await tx`select is_portal_user(${learner}) p`;
      expect(p).toBe(true);

      await as(tx, creator);
      const [{ id: course }] = await tx`insert into acad_courses (title, status) values ('Стандарты', 'published') returning id`;
      await tx`insert into acad_assignments (course_id, subject_type, unit_id) values (${course}, 'unit', ${unit})`;
      const [{ id: course2 }] = await tx`insert into acad_courses (title, status) values ('Роль', 'published') returning id`;
      await tx`insert into acad_assignments (course_id, subject_type, access_role_id) values (${course2}, 'access_role', ${empty})`;
      await asServer(tx);

      const [{ ids }] = await tx`select acad_user_course_ids(${learner}) ids`;
      expect((ids as string[]).sort()).toEqual([course, course2].sort());
      const del = await failure(tx, () => tx`delete from access_roles where id = ${empty}`);
      expect(del).toBeNull();
    });
  });

  test("отчёт чтения: партнёр-владелец клуба — читатель, администратор баз — нет", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const [{ id: base }] = await tx`insert into kb_bases (title, rail_title) values ('Для партнёров', 'База') returning id`;
      const reader = await newRole(tx, "Читатель базы", []);
      await tx`insert into access_role_permissions (role_id, perm_key, target_id, level)
               values (${reader}, 'kb.base', ${base}, 'view')`;
      const partner = await portal(tx, "Партнёр", s1, [{ key: "studio_owner", scope: "studios", ids: [s1] }]);
      const kbAdmin = await portal(tx, "Администратор знаний", s1, [{ key: "kb_admin" }]);
      for (const u of [partner, kbAdmin]) {
        await tx`insert into access_assignments (role_id, subject_type, user_id) values (${reader}, 'user', ${u})`;
      }
      await tx`select access_flush()`;
      const people = await tx`select user_id from kb_base_people(${base})`;
      expect(people.map((r: Row) => r.user_id)).toEqual([partner]);
      const [{ admin }] = await tx`select kb_is_admin(${partner}) admin`;
      expect(admin).toBe(false);
    });
  });

  test("создать клуб: право «Создаёт клубы», создатель получает «Владельца клуба»", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const creator = await portal(tx, "Открытие", s1, [{ key: "portal_admin" }]);
      const plain = await portal(tx, "Тренер", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);
      await as(tx, plain);
      const denied = await failure(tx, () => tx`select create_studio('Новый', 'packages', '#e5007e')`);
      expect(denied).not.toBeNull();
      await asServer(tx);
      await as(tx, creator);
      const [{ id }] = await tx`select create_studio('Новый', 'packages', '#e5007e') id`;
      await asServer(tx);
      expect(await staffRoles(tx, creator)).toEqual([`${id}:owner`]);
    });
  });

  test("RPC интерфейса: списки, карточка, откуда права, журнал, структура", async () => {
    await scenario(async (tx) => {
      const [{ id: brand }] = await tx`insert into org_brands (name) values ('Бренд RPC') returning id`;
      const s1 = await studio(tx, "packages", brand);
      const sa = await portal(tx, "Суперадмин", s1, [{ key: "superadmin" }]);
      const t = await portal(tx, "Тренер", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);
      await as(tx, sa);
      const [{ id: unit }] = await tx`select org_unit_save(${JSON.stringify({ name: "Отдел развития" })}::text::jsonb) id`;
      const [{ id: child }] = await tx`select org_unit_save(${JSON.stringify({ name: "Кураторы", parent_id: unit })}::text::jsonb) id`;
      await tx`select org_member_set(${child}, ${t}, 'head')`;
      const [{ id: pos }] = await tx`select org_position_save(${JSON.stringify({ name: "Эксперт" })}::text::jsonb) id`;
      await tx`select access_user_save(${t}, ${JSON.stringify({ position_id: pos, user_type: "hq", phone: "+995 555" })}::text::jsonb)`;
      await tx`select org_studio_save(${s1}, ${JSON.stringify({ ownership: "franchise", city: "Тбилиси" })}::text::jsonb)`;
      await tx`select access_assignment_save(${JSON.stringify({
        role_id: await roleId(tx, "curator"), subject_type: "unit", unit_id: unit, unit_members: "heads",
        with_subunits: true, scope_type: "brands", scope_ids: [brand],
      })}::text::jsonb)`;
      await tx`select access_personal_save(${t}, ${JSON.stringify([{ perm_key: "academy.review" }])}::text::jsonb)`;

      const users = await tx`select * from access_users()`;
      const row = users.find((r: Row) => r.user_id === t) as Row;
      expect(row.can_manage).toBe(true);
      expect((row.roles as unknown[]).length).toBe(3);
      const [{ card }] = await tx`select access_user(${t}) card`;
      const c = card as { effective: { studios: Record<string, { tier: string }> }; personal: unknown[]; units: unknown[] };
      expect(c.effective.studios[s1].tier).toBe("admin");
      expect(c.personal.length).toBe(1);
      expect(c.units.length).toBe(1);
      const why = await tx`select via, perm_key from access_explain(${t}) where perm_key = 'studio.tier'`;
      expect(why.map((r: Row) => r.via).sort()).toEqual(["Лично", "Подразделение «Отдел развития» (руководители) и ниже"]);
      const roles = await tx`select * from access_roles_list()`;
      expect(roles.find((r: Row) => r.system_key === "curator")?.users).toBe(1);
      const log = await tx`select * from access_log_list(null, 50)`;
      expect(log.length).toBeGreaterThan(3);
      const [{ me }] = await tx`select access_me() me`;
      expect((me as { rights: string[] }).rights).toContain("portal.admin");

      const busy = await failure(tx, () => tx`select org_unit_delete(${unit})`);
      expect(busy).toContain("org_unit_has_children");
      await tx`select org_unit_delete(${child})`;
      await asServer(tx);
      expect(await staffRoles(tx, t)).toEqual([`${s1}:trainer`]);
    });
  });

  test("RLS: обычный пользователь не видит чужих людей и назначений", async () => {
    await scenario(async (tx) => {
      const s1 = await studio(tx);
      const a = await portal(tx, "А", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);
      const b = await portal(tx, "Б", s1, [{ key: "trainer", scope: "studios", ids: [s1] }]);
      await as(tx, a);
      const users = await tx`select user_id from portal_users`;
      expect(users.map((r: Row) => r.user_id)).toEqual([a]);
      const assignments = await tx`select user_id from access_assignments`;
      expect(assignments.map((r: Row) => r.user_id)).toEqual([a]);
      const list = await failure(tx, () => tx`select * from access_users()`);
      expect(list).toContain("access_forbidden");
      const write = await failure(tx, () => tx`insert into org_units (name) values ('X')`);
      expect(write).not.toBeNull();
      const roleWrite = await failure(tx, () => tx`insert into user_roles (user_id, studio_id, role) values (${a}, ${s1}, 'owner')`);
      expect(roleWrite).not.toBeNull();
      const [me] = await tx`select access_me() me`;
      expect((me.me as { rights: string[] }).rights).toEqual([]);
      expect(b).toBeTruthy();
    });
  });
});
