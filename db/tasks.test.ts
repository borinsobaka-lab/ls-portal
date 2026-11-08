/**
 * Тесты задач портала (db/migrations/2026-11-08_zz_tasks.sql): постановка
 * (себе, общая на нескольких, отдельная каждому), права ролей, срок с
 * причиной, статусы и проверка, делегирование, чек-листы, список и
 * фильтры, руководитель подразделения, чат задачи, файлы, фоновый проход
 * (срок через час, просрочка один раз, напоминания, сводка), календарь.
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

describe.skipIf(!url)("задачи (база)", () => {
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

  test("постановка: себе, общая на нескольких, посторонний не видит", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const own = await create(tx, { title: "Себе" });
      const mine = await get(tx, own.tasks[0].number);
      expect(mine.my_roles.sort()).toEqual(["assignee", "creator"]);

      const shared = await create(tx, {
        title: "Подготовить отчёт по Казани",
        assignees: [b, c],
        watchers: [d],
        deadline: new Date(Date.now() + 86400_000).toISOString(),
      });
      expect(shared.tasks).toHaveLength(1);
      expect(shared.tasks[0].number).toBeGreaterThan(own.tasks[0].number);
      const t = await get(tx, shared.tasks[0].number);
      const role = (u: string) => t.members.filter((m) => m.user_id === u).map((m) => m.role);
      expect(role(b)).toEqual(["assignee"]);
      expect(role(c)).toEqual(["coassignee"]);
      expect(role(d)).toEqual(["watcher"]);
      expect(t.checklists!.map((l) => l.title)).toEqual(["Исполнители"]);
      expect(t.checklists![0].items.map((i) => i.assignee_id)).toEqual([b, c]);

      expect((await notifs(tx, b)).map((n) => n.title)).toEqual(["Вам поставили задачу"]);
      expect((await notifs(tx, c)).map((n) => n.title)).toEqual(["Вы соисполнитель задачи"]);
      expect(await notifs(tx, d)).toEqual([]);

      const stranger = await staff(tx, "Чужой");
      await as(tx, stranger);
      expect(await failure(tx, () => get(tx, shared.tasks[0].number))).toContain("task_not_found");
      expect(await list(tx)).toEqual([]);
    });
  });

  test("отдельная задача каждому: общий batch_id и сводка", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Сдать отчёт за месяц", assignees: [b, c, d], mode: "separate" });
      expect(r.tasks).toHaveLength(3);
      expect(r.batch_id).toBeTruthy();
      await as(tx, b);
      await tx`select task_set_status(${r.tasks[0].id}, 'complete')`;
      await as(tx, a);
      const rows = await list(tx, { role: "assigned", show_done: true });
      expect(rows).toHaveLength(3);
      expect(rows.every((x) => x.batch_id === r.batch_id)).toBe(true);
      expect(rows[0].batch).toMatchObject({ total: 3, done: 1 });
      // «Завершена» по задаче постановки — без отдельного уведомления.
      expect((await notifs(tx, a)).filter((n) => n.kind === "task.done")).toEqual([]);
    });
  });

  test("права: соисполнитель не правит, исполнитель переносит срок с причиной", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const r = await create(tx, {
        title: "Запустить рассылку",
        assignees: [b],
        coassignees: [c],
        deadline: "2030-01-10T15:00:00Z",
      });
      const id = r.tasks[0].id;
      await as(tx, c);
      expect(await failure(tx, () => tx`select task_update(${id}, '{"title": "Другое"}'::jsonb)`)).toContain(
        "task_forbidden",
      );
      expect(
        await failure(tx, () => tx`select task_update(${id}, '{"deadline": "2030-01-11T15:00:00Z"}'::jsonb)`),
      ).toContain("task_forbidden");
      await as(tx, b);
      expect(
        await failure(tx, () => tx`select task_update(${id}, '{"deadline": "2030-01-11T15:00:00Z"}'::jsonb)`),
      ).toContain("task_reason_required");
      await tx`select task_update(${id}, '{"deadline": "2030-01-11T15:00:00Z"}'::jsonb, 'Ждём макет')`;
      await asServer(tx);
      const [ev] = await tx`select kind, reason from task_events where task_id = ${id} and kind = 'deadline'`;
      expect(ev.reason).toBe("Ждём макет");
      expect((await notifs(tx, a)).map((n) => n.kind)).toContain("task.deadline");
      await as(tx, a);
      await tx`select task_update(${id}, '{"title": "Запустить рассылку по Казани", "urgent": true}'::jsonb)`;
      const t = await get(tx, r.tasks[0].number);
      expect(t.title).toBe("Запустить рассылку по Казани");
    });
  });

  test("статусы и проверка: на проверку, вернуть с комментарием, принять", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Макет баннера", assignees: [b], coassignees: [c], requires_review: true });
      const id = r.tasks[0].id;
      await as(tx, c);
      expect(await failure(tx, () => tx`select task_set_status(${id}, 'complete')`)).toContain("task_status_forbidden");
      await tx`select task_set_status(${id}, 'start')`;
      await as(tx, b);
      const [{ s }] = await tx`select task_set_status(${id}, 'complete') as s`;
      expect(s.status).toBe("review");
      expect((await notifs(tx, a)).map((n) => n.kind)).toContain("task.review");
      await as(tx, a);
      expect(await failure(tx, () => tx`select task_set_status(${id}, 'return')`)).toContain("task_comment_required");
      await tx`select task_set_status(${id}, 'return', 'Поменяйте шрифт')`;
      expect((await notifs(tx, b)).map((n) => n.kind)).toContain("task.returned");
      await as(tx, b);
      await tx`select task_set_status(${id}, 'complete')`;
      await as(tx, a);
      const [{ s: done }] = await tx`select task_set_status(${id}, 'accept') as s`;
      expect(done.status).toBe("done");
      expect((await list(tx, { role: "assigned" })).map((x) => x.id)).not.toContain(id);
      expect((await list(tx, { role: "assigned", show_done: true })).map((x) => x.id)).toContain(id);
    });
  });

  test("делегирование: прежний исполнитель — наблюдатель", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Сверить цифры", assignees: [b] });
      await as(tx, b);
      await tx`select task_delegate(${r.tasks[0].id}, ${c}, 'В отпуске')`;
      await as(tx, a);
      const t = await get(tx, r.tasks[0].number);
      expect(t.members.find((m) => m.role === "assignee")!.user_id).toBe(c);
      expect(t.members.find((m) => m.user_id === b)!.role).toBe("watcher");
      expect((await notifs(tx, c)).map((n) => n.title)).toContain("Вам передали задачу");
    });
  });

  test("чек-листы: исполнитель пункта становится соисполнителем и отмечает", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Открытие клуба", assignees: [b], watchers: [d] });
      const id = r.tasks[0].id;
      const [{ l }] = await tx`select task_checklist_save(${id}, null, 'Подготовка') as l`;
      const [{ i }] = await tx`select task_check_item_save(${l}, null, 'Закупить коврики', ${c}) as i`;
      await tx`select task_checklist_save(null, ${l}, 'Подготовка к открытию')`;
      let t = await get(tx, r.tasks[0].number);
      expect(t.members.find((m) => m.user_id === c)!.role).toBe("coassignee");
      await as(tx, d);
      expect(await failure(tx, () => tx`select task_check_item_save(${l}, null, 'Ещё')`)).toContain("task_forbidden");
      expect(await failure(tx, () => tx`select task_check_item_toggle(${i}, true)`)).toContain("task_forbidden");
      await as(tx, c);
      await tx`select task_check_item_toggle(${i}, true)`;
      expect((await list(tx, { checklist_mine: true })).map((x) => x.id)).toEqual([]);
      await as(tx, a);
      t = await get(tx, r.tasks[0].number);
      expect(t.checklists![0].title).toBe("Подготовка к открытию");
      expect(t.checklists![0].items[0].done_at).toBeTruthy();
    });
  });

  test("список: роли, сроки, поиск, порядок по сроку", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const late = await create(tx, { title: "Старая просрочка", assignees: [b], deadline: "2020-01-01T10:00:00Z" });
      const soon = await create(tx, { title: "Рассылка партнёрам", assignees: [b], deadline: "2030-05-01T10:00:00Z" });
      const none = await create(tx, {
        title: "Без срока",
        assignees: [b],
        description: [{ type: "paragraph", content: [{ type: "text", text: "Проверить брендбук" }] }],
      });
      await as(tx, b);
      const doing = await list(tx, { role: "do" });
      expect(doing.map((x) => x.id)).toEqual([late.tasks[0].id, soon.tasks[0].id, none.tasks[0].id]);
      expect((await list(tx, { role: "do", deadline: "overdue" })).map((x) => x.id)).toEqual([late.tasks[0].id]);
      expect((await list(tx, { role: "do", deadline: "none" })).map((x) => x.id)).toEqual([none.tasks[0].id]);
      expect((await list(tx, { q: "рассылк" })).map((x) => x.id)).toEqual([soon.tasks[0].id]);
      expect((await list(tx, { q: "брендбук" })).map((x) => x.id)).toEqual([none.tasks[0].id]);
      expect((await list(tx, { q: `#${late.tasks[0].number}` })).map((x) => x.id)).toEqual([late.tasks[0].id]);
      expect(await list(tx, { role: "assigned" })).toEqual([]);
      const [{ c }] = await tx`select task_counters() as c`;
      expect(c).toMatchObject({ overdue: 1, unseen: 3 });
      await get(tx, late.tasks[0].number);
      const [{ c: c2 }] = await tx`select task_counters() as c`;
      expect(c2.unseen).toBe(2);
    });
  });

  test("руководитель подразделения видит задачи сотрудников, посторонний — нет", async () => {
    await scenario(async (tx) => {
      const { a, b, d } = await people(tx);
      const lead = await staff(tx, "Руководитель");
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел развития') returning id`;
      const [{ id: sub }] = await tx`insert into org_units (name, parent_id) values ('Казань', ${unit}) returning id`;
      for (const u of [lead, b]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${lead}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${sub}, ${b}, 'member')`;
      await as(tx, a);
      const r = await create(tx, { title: "Отчёт Казани", assignees: [b] });
      await as(tx, lead);
      const t = await get(tx, r.tasks[0].number);
      expect(t.my_roles).toEqual(["manager"]);
      await tx`select task_update(${r.tasks[0].id}, '{"deadline": "2030-02-01T10:00:00Z"}'::jsonb)`;
      await as(tx, d);
      expect(await failure(tx, () => get(tx, r.tasks[0].number))).toContain("task_not_found");
    });
  });

  test("чат задачи: по кнопке, состав = участники, статус — строкой", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Обсудить акцию", assignees: [b] });
      const id = r.tasks[0].id;
      expect((await get(tx, r.tasks[0].number)).chat_id).toBeNull();
      await as(tx, d);
      expect(await failure(tx, () => tx`select task_chat_open(${id})`)).toContain("task_forbidden");
      await as(tx, b);
      const [{ chat }] = await tx`select task_chat_open(${id}) as chat`;
      const [{ again }] = await tx`select task_chat_open(${id}) as again`;
      expect(again).toBe(chat);
      const row = (await tx`select * from chat_list()`).find((x: { id: string }) => x.id === chat);
      expect(row.kind).toBe("task");
      expect(row.title).toBe(`#${r.tasks[0].number} Обсудить акцию`);
      await tx`select chat_send(${chat}, null, 'Начинаю')`;
      await as(tx, a);
      await tx`select task_set_members(${id}, ${b}, ${[c]}::uuid[], '{}'::uuid[])`;
      await asServer(tx);
      const members = (await tx`select user_id from chat_members where chat_id = ${chat}`).map(
        (x: { user_id: string }) => x.user_id,
      );
      expect(members.sort()).toEqual([a, b, c].sort());
      // Участник не выходит из чата задачи сам — состав ведёт задача.
      await as(tx, c);
      expect(await failure(tx, () => tx`select chat_member_remove(${chat}, ${c})`)).toContain("chat_not_group");
      await as(tx, b);
      await tx`select task_set_status(${id}, 'complete')`;
      await asServer(tx);
      const [last] = await tx`select kind, content from chat_messages where chat_id = ${chat} order by seq desc limit 1`;
      expect(last.kind).toBe("system");
      expect(last.content.system).toMatchObject({ type: "task_status", title: "done" });
    });
  });

  test("файлы: своя папка постановки, папка задачи, общий файл постановки", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await as(tx, a);
      const path = `new/${a}/f1.pdf`;
      const [{ ok }] = await tx`select task_file_allowed(${path}, true) as ok`;
      expect(ok).toBe(true);
      const [{ no }] = await tx`select task_file_allowed(${`new/${b}/x.pdf`}, true) as no`;
      expect(no).toBe(false);
      const r = await create(tx, {
        title: "Брендбук",
        assignees: [b, c],
        mode: "separate",
        files: [{ path, name: "Брендбук.pdf", mime: "application/pdf", size: 1000 }],
      });
      await as(tx, c);
      const [{ read }] = await tx`select task_file_allowed(${path}) as read`;
      expect(read).toBe(true);
      const [{ write }] = await tx`select task_file_allowed(${`${r.tasks[1].id}/x.png`}, true) as write`;
      expect(write).toBe(true);
      await as(tx, d);
      const [{ stranger }] = await tx`select task_file_allowed(${path}) as stranger`;
      expect(stranger).toBe(false);
      await as(tx, c);
      expect(
        await failure(tx, () =>
          tx`select task_file_add(${r.tasks[1].id}, ${[{ path: `new/${a}/f1.pdf`, name: "x" }]}::jsonb)`,
        ),
      ).toContain("task_bad_file");
    });
  });

  test("фоновый проход: срок через час, просрочка один раз, напоминание, сводка", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const now = new Date("2030-03-04T12:00:00Z");
      const r = await create(tx, { title: "Звонок партнёру", assignees: [b], deadline: "2030-03-04T12:30:00Z" });
      const id = r.tasks[0].id;
      await asServer(tx);
      await tx`update tasks set created_at = '2030-03-01T00:00:00Z' where id = ${id}`;
      await as(tx, b);
      await tx`select task_reminder_set(${id}, null, 15)`;
      await asServer(tx);
      const [{ t1 }] = await tx`select task_tick(${now}) as t1`;
      expect(t1).toMatchObject({ soon: 1, overdue: 0 });
      const [{ t2 }] = await tx`select task_tick(${new Date("2030-03-04T12:20:00Z")}) as t2`;
      expect(t2).toMatchObject({ soon: 0, reminders: 1 });
      const late = new Date("2030-03-04T13:00:00Z");
      const [{ t3 }] = await tx`select task_tick(${late}) as t3`;
      expect(t3).toMatchObject({ overdue: 1 });
      const [{ t4 }] = await tx`select task_tick(${new Date("2030-03-04T13:01:00Z")}) as t4`;
      expect(t4).toMatchObject({ overdue: 0 });
      // Одна строка ленты на задачу — с последним событием; пуши — на каждое.
      expect((await notifs(tx, b)).map((n) => n.kind)).toEqual(["task.overdue"]);
      await asServer(tx);
      const [{ count }] = await tx`select count from notif_items where user_id = ${b}`;
      expect(count).toBe(4);
      const [{ n }] = await tx`select count(*)::int as n from task_events where task_id = ${id}`;
      expect(n).toBeGreaterThan(0);
      // Сводка постановщику — один раз в день, с 9:00 его времени (Москва).
      const [{ d1 }] = await tx`select task_tick(${new Date("2030-03-05T05:00:00Z")}) as d1`;
      expect(d1.digests).toBe(0);
      const [{ d2 }] = await tx`select task_tick(${new Date("2030-03-05T06:30:00Z")}) as d2`;
      expect(d2.digests).toBe(1);
      const [{ d3 }] = await tx`select task_tick(${new Date("2030-03-05T09:30:00Z")}) as d3`;
      expect(d3.digests).toBe(0);
      const digest = (await tx`select title, body from notif_items where user_id = ${a} and kind = 'task.digest'`) as {
        body: string;
      }[];
      expect(digest[0].body).toBe("1 задача просрочена");
    });
  });

  test("уведомления задачи: «ничего» и «только моё»", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const r = await create(tx, { title: "Тихая задача", assignees: [b] });
      const id = r.tasks[0].id;
      await tx`select task_set_notify(${id}, 'mine')`;
      await as(tx, b);
      await tx`select task_set_status(${id}, 'complete')`;
      expect((await notifs(tx, a)).map((n) => n.kind)).not.toContain("task.done");
    });
  });

  test("производственный календарь: год строкой, проверка длины", async () => {
    await scenario(async (tx) => {
      const { a } = await people(tx);
      await asServer(tx);
      const days = Array.from({ length: 365 }, (_, i) => (i < 8 ? "1" : i === 8 ? "2" : "0")).join("");
      expect(await failure(tx, () => tx`select work_calendar_store(2031, '0101')`)).toContain("work_calendar_invalid");
      await tx`select work_calendar_store(2031, ${days})`;
      const [{ y }] = await tx`select work_calendar_years_loaded() as y`;
      expect(y).toContain(2031);
      await as(tx, a);
      const rows = await tx`select day::text, kind from work_calendar_range('2031-01-07', '2031-01-10')`;
      expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["off", "off", "short", "work"]);
    });
  });
});
