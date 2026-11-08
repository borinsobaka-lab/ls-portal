/**
 * Тесты вехи 4 задач (db/migrations/2026-11-08_zzz_task_projects.sql):
 * проекты (участники, открытый и закрытый, состав из подразделения,
 * стадии, чат, правило срока, проверка по умолчанию), «Подчинённые»,
 * шаблоны, регулярные задачи.
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

type TaskJson = {
  id: string;
  number: number;
  title: string;
  status: string;
  deadline: string | null;
  batch_id: string | null;
  chat_id: string | null;
  my_roles: string[];
  members: { user_id: string; role: string }[];
  checklists?: { id: string; title: string; items: { id: string; text: string; assignee_id: string | null; done_at: string | null }[] }[];
  batch?: { total: number; done: number; overdue: number };
  unseen: boolean;
};

describe.skipIf(!url)("проекты, шаблоны, регулярные задачи (база)", () => {
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

  let studio: string | null = null;
  async function staff(tx: Tx, name: string): Promise<string> {
    if (!studio) {
      const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
      studio = id;
    }
    await tx`set local session_replication_role = replica`;
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studio}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studio}, ${name}, 'x@example.com')
             on conflict (id) do update set full_name = excluded.full_name`;
    return id as string;
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

  async function people(tx: Tx) {
    studio = null;
    const a = await staff(tx, "Анна Постановщик");
    const b = await staff(tx, "Борис Исполнитель");
    const c = await staff(tx, "Вера Соисполнитель");
    const d = await staff(tx, "Глеб Посторонний");
    return { a, b, c, d };
  }

  const create = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ r }] = await tx`select task_create(${p}::jsonb) as r`;
    return r as { tasks: { id: string; number: number }[]; batch_id: string | null };
  };
  const get = async (tx: Tx, n: number) => {
    const [{ r }] = await tx`select task_get(${n}) as r`;
    return r as TaskJson;
  };
  const list = async (tx: Tx, p: Record<string, unknown> = {}) => {
    const [{ r }] = await tx`select task_list(${p}::jsonb) as r`;
    return (r as { rows: TaskJson[] }).rows;
  };
  const notifs = async (tx: Tx, user: string) => {
    await asServer(tx);
    return (await tx`select kind, title from notif_items where user_id = ${user} order by created_at`) as {
      kind: string;
      title: string;
    }[];
  };

  const project = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ id }] = await tx`select task_project_save(null, ${p}::jsonb) as id`;
    return id as string;
  };
  const projectGet = async (tx: Tx, id: string) => {
    const [{ r }] = await tx`select task_project_get(${id}) as r`;
    return r as {
      my_role: string | null;
      chat_id: string;
      members: { user_id: string; role: string; source: string }[];
      stages: { id: string; title: string }[];
    };
  };

  test("проект: владелец, стадии, чат, закрытый и открытый, задачи видят участники", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const pr = await project(tx, { title: "Казань", kind: "city", members: [b] });
      const info = await projectGet(tx, pr);
      expect(info.my_role).toBe("owner");
      expect(info.stages.map((s) => s.title)).toEqual(["Новые", "В работе", "Готово"]);
      const chat = (await tx`select * from chat_list()`).find((x: { id: string }) => x.id === info.chat_id);
      expect(chat.kind).toBe("project");
      const r = await create(tx, { title: "Афиша на декабрь", assignees: [c], project_id: pr });
      const t = await get(tx, r.tasks[0].number);
      expect((t as unknown as { stage_id: string }).stage_id).toBe(info.stages[0].id);

      // Участник проекта (не участник задачи) видит её; посторонний — нет.
      await as(tx, b);
      const rows = await list(tx, { project: pr });
      expect(rows.map((x) => x.id)).toEqual([r.tasks[0].id]);
      expect((await get(tx, r.tasks[0].number)).my_roles).toEqual(["project"]);
      await as(tx, d);
      expect(await failure(tx, () => list(tx, { project: pr }))).toContain("project_forbidden");
      expect(await failure(tx, () => get(tx, r.tasks[0].number))).toContain("task_not_found");
      expect(await failure(tx, () => tx`select task_project_join(${pr})`)).toContain("project_forbidden");
      const [{ l }] = await tx`select task_projects_list() as l`;
      expect(l).toEqual([]);

      // Открытый — в каталоге, вступить может любой.
      await as(tx, a);
      await tx`select task_project_save(${pr}, ${{ title: "Казань", visibility: "open" }}::jsonb)`;
      await as(tx, d);
      const [{ l: open }] = await tx`select task_projects_list() as l`;
      expect(open.map((x: { id: string }) => x.id)).toEqual([pr]);
      await tx`select task_project_join(${pr})`;
      expect((await list(tx, { project: pr })).length).toBe(1);
      await asServer(tx);
      const [{ n }] = await tx`select count(*)::int as n from chat_members where chat_id = ${info.chat_id}`;
      expect(n).toBe(3);
    });
  });

  test("проект: модератор правит задачи, правило срока и проверка по умолчанию", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const pr = await project(tx, { title: "Отдел развития", deadline_rule: "forbid", requires_review: true, members: [b, c] });
      await tx`select task_project_member_set_role(${pr}, ${b}, 'moderator')`;
      const r = await create(tx, { title: "Сводка по франшизе", assignees: [c], project_id: pr, deadline: "2030-01-10T15:00:00Z" });
      const id = r.tasks[0].id;
      // «Требует проверки» — по умолчанию проекта.
      expect(((await get(tx, r.tasks[0].number)) as unknown as { requires_review: boolean }).requires_review).toBe(
        true,
      );
      await as(tx, c);
      expect(
        await failure(tx, () => tx`select task_update(${id}, '{"deadline": "2030-01-11T15:00:00Z"}'::jsonb, 'причина')`),
      ).toContain("task_forbidden");
      const [{ s }] = await tx`select task_set_status(${id}, 'complete') as s`;
      expect(s.status).toBe("review");
      await as(tx, b);
      expect((await get(tx, r.tasks[0].number)).my_roles).toEqual(["manager", "project"]);
      await tx`select task_update(${id}, '{"deadline": "2030-01-12T15:00:00Z"}'::jsonb)`;
      await tx`select task_set_status(${id}, 'accept')`;
      // Последнего владельца не снять.
      await as(tx, a);
      expect(await failure(tx, () => tx`select task_project_member_set_role(${pr}, ${a}, 'member')`)).toContain(
        "project_last_owner",
      );
      expect(await failure(tx, () => tx`select task_project_member_remove(${pr}, ${a})`)).toContain(
        "project_last_owner",
      );
    });
  });

  test("проект из подразделения: состав следует за оргструктурой", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел развития') returning id`;
      const [{ id: sub }] = await tx`insert into org_units (name, parent_id) values ('Казань', ${unit}) returning id`;
      for (const u of [a, b, c, d]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${b}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${sub}, ${c}, 'member')`;
      await as(tx, a);
      const pr = await project(tx, { title: "Отдел развития", kind: "department", unit_id: unit });
      let m = (await projectGet(tx, pr)).members;
      expect(m.filter((x) => x.source === "unit").map((x) => x.user_id).sort()).toEqual([b, c].sort());
      await asServer(tx);
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${sub}, ${d}, 'member')`;
      await tx`delete from org_unit_members where unit_id = ${sub} and user_id = ${c}`;
      await as(tx, a);
      m = (await projectGet(tx, pr)).members;
      expect(m.map((x) => x.user_id).sort()).toEqual([a, b, d].sort());
      expect(await failure(tx, () => tx`select task_project_member_remove(${pr}, ${d})`)).toContain(
        "project_unit_member",
      );
      // Только руководители, без подразделений ниже.
      await tx`select task_project_save(${pr}, ${{ title: "Отдел развития", unit_scope: "heads", with_subunits: false }}::jsonb)`;
      m = (await projectGet(tx, pr)).members;
      expect(m.map((x) => x.user_id).sort()).toEqual([a, b].sort());
    });
  });

  test("стадии канбана и перенос задачи в проект", async () => {
    await scenario(async (tx) => {
      const { a, b, d } = await people(tx);
      await as(tx, a);
      const pr = await project(tx, { title: "Сайт", members: [b] });
      const info = await projectGet(tx, pr);
      const own = await create(tx, { title: "Без проекта", assignees: [b] });
      await tx`select task_update(${own.tasks[0].id}, ${{ project_id: pr }}::jsonb)`;
      let t = (await get(tx, own.tasks[0].number)) as unknown as { project_id: string; stage_id: string };
      expect(t.project_id).toBe(pr);
      expect(t.stage_id).toBe(info.stages[0].id);
      await as(tx, b);
      await tx`select task_set_stage(${own.tasks[0].id}, ${info.stages[1].id})`;
      await as(tx, a);
      await tx`select task_stage_delete(${info.stages[1].id})`;
      t = (await get(tx, own.tasks[0].number)) as unknown as { project_id: string; stage_id: string };
      expect(t.stage_id).toBe(info.stages[0].id);
      // В чужой проект не перенести.
      await as(tx, d);
      const other = await project(tx, { title: "Чужой" });
      await as(tx, a);
      expect(
        await failure(tx, () => tx`select task_update(${own.tasks[0].id}, ${{ project_id: other }}::jsonb)`),
      ).toContain("project_forbidden");
    });
  });

  test("«Подчинённые»: счётчики и задачи людей подразделения", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел') returning id`;
      for (const u of [a, b]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${a}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${b}, 'member')`;
      await as(tx, c);
      const r = await create(tx, { title: "Просроченная", assignees: [b], deadline: "2020-01-01T10:00:00Z" });
      await as(tx, a);
      const rows = await tx`select * from task_subordinates()`;
      expect(rows).toEqual([{ user_id: b, open_count: 1, overdue_count: 1, review_count: 0, done_week: 0 }]);
      expect((await list(tx, { scope: "team" })).map((x) => x.id)).toEqual([r.tasks[0].id]);
      const [{ c: counters }] = await tx`select task_counters() as c`;
      expect(counters.leader).toBe(true);
    });
  });

  test("шаблоны: личный, проекта, общий — по правам", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const pr = await project(tx, { title: "Казань", members: [b] });
      const task = { title: "Еженедельный отчёт", deadline_days: 2, checklists: [{ title: "Шаги", items: [{ text: "Выгрузить" }] }] };
      const [{ id: personal }] = await tx`select task_template_save(null, ${{ name: "Мой отчёт", task }}::jsonb) as id`;
      await tx`select task_template_save(null, ${{ name: "Отчёт Казани", scope: "project", project_id: pr, task }}::jsonb)`;
      expect(
        await failure(tx, () => tx`select task_template_save(null, ${{ name: "Всем", scope: "shared", task }}::jsonb)`),
      ).toContain("template_forbidden");
      await as(tx, b);
      const [{ l }] = await tx`select task_templates_list() as l`;
      expect(l.map((x: { name: string }) => x.name)).toEqual(["Отчёт Казани"]);
      expect(l[0].can_edit).toBe(false);
      expect(await failure(tx, () => tx`select task_template_delete(${personal})`)).toContain("template_forbidden");
    });
  });

  test("регулярные: по расписанию, не копятся, «пропустить», после закрытия", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const task = { title: "Отчёт за день", assignees: [b], deadline_days: 0, deadline_time: "18:00" };
      const [{ tpl }] = await tx`select task_template_save(null, ${{ name: "Отчёт", task }}::jsonb) as tpl`;
      expect(
        await failure(tx, () =>
          tx`select task_recurrence_save(null, ${{ template_id: tpl, rule: { freq: "weekly", weekdays: [] } }}::jsonb)`,
        ),
      ).toContain("recurrence_invalid");
      const [{ rid }] = await tx`select task_recurrence_save(null, ${{
        template_id: tpl,
        rule: { freq: "daily" },
        at_time: "09:00",
      }}::jsonb) as rid`;
      await asServer(tx);
      // Первый запуск — понедельник 2030-03-04, 09:00 МСК.
      await tx`update task_recurrences set next_run_at = '2030-03-04T06:00:00Z' where id = ${rid}`;
      const [{ t1 }] = await tx`select task_tick('2030-03-04T06:00:30Z') as t1`;
      expect(t1.recurring).toBe(1);
      const [rec] = await tx`select next_run_at, last_task_id from task_recurrences where id = ${rid}`;
      expect(new Date(rec.next_run_at).toISOString()).toBe("2030-03-05T06:00:00.000Z");
      const [first] = await tx`select deadline, recurrence_id, created_by from tasks where id = ${rec.last_task_id}`;
      expect(new Date(first.deadline).toISOString()).toBe("2030-03-04T15:00:00.000Z");
      expect(first.created_by).toBe(a);
      // Прежняя открыта — не копится.
      const [{ t2 }] = await tx`select task_tick('2030-03-05T06:00:30Z') as t2`;
      expect(t2.recurring).toBe(0);
      // Закрыли — следующая сразу.
      await tx`update tasks set status = 'done', completed_at = now() where id = ${rec.last_task_id}`;
      const [{ t3 }] = await tx`select task_tick('2030-03-05T07:00:00Z') as t3`;
      expect(t3.recurring).toBe(1);
      // «Пропустить»: прежняя закрывается как отменённая.
      await tx`update task_recurrences set mode = 'skip', next_run_at = '2030-03-06T06:00:00Z' where id = ${rid}`;
      const [prev] = await tx`select last_task_id from task_recurrences where id = ${rid}`;
      await tx`select task_tick('2030-03-06T06:00:30Z')`;
      const [old] = await tx`select status from tasks where id = ${prev.last_task_id}`;
      expect(old.status).toBe("cancelled");
      // «Через 2 дня после закрытия».
      await tx`update task_recurrences set rule = '{"freq": "after_close", "after_days": 2}', mode = 'wait',
               next_run_at = null where id = ${rid}`;
      const [cur] = await tx`select last_task_id from task_recurrences where id = ${rid}`;
      await tx`update tasks set status = 'done', completed_at = '2030-03-06T12:00:00Z' where id = ${cur.last_task_id}`;
      await tx`select task_tick('2030-03-06T13:00:00Z')`;
      const [after] = await tx`select next_run_at from task_recurrences where id = ${rid}`;
      expect(new Date(after.next_run_at).toISOString()).toBe("2030-03-08T06:00:00.000Z");
      // Исполнитель ушёл с портала — регулярная выключается с причиной.
      await tx`delete from user_roles where user_id = ${b}`;
      await tx`update task_recurrences set next_run_at = '2030-03-08T06:00:00Z' where id = ${rid}`;
      await tx`select task_tick('2030-03-08T06:00:30Z')`;
      const [off] = await tx`select active, last_error from task_recurrences where id = ${rid}`;
      expect(off.active).toBe(false);
      expect(off.last_error).toContain("task_bad_assignee");
    });
  });

  test("рабочие дни и правило повтора", async () => {
    await scenario(async (tx) => {
      await asServer(tx);
      const [{ d }] = await tx`select work_add_days('2030-03-08', 1)::text as d`; // пт → пн
      expect(d).toBe("2030-03-11");
      const [{ w }] = await tx`select task_rec_next('{"freq": "workdays"}', '2030-03-08')::text as w`;
      expect(w).toBe("2030-03-11");
      const [{ m }] = await tx`select task_rec_next('{"freq": "monthly", "monthday": 31}', '2030-04-01')::text as m`;
      expect(m).toBe("2030-04-30");
      const [{ wk }] = await tx`select task_rec_next('{"freq": "weekly", "weekdays": [3]}', '2030-03-08')::text as wk`;
      expect(wk).toBe("2030-03-13");
    });
  });
});
