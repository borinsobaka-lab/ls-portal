/**
 * Тесты базы знаний (db/migrations/2026-10-24_knowledge_base.sql): кто что
 * видит (владелец — всё, сотрудник — выданные базы, читатель — только
 * опубликованное), дерево (путь, перенос, порядок, копия), черновики и
 * публикация, поиск, отметка чтения и отчёт, файлы бакета kb-media.
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

type Row = Record<string, unknown>;

const doc = (text: string) => [
  { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] },
];

describe.skipIf(!url)("база знаний (база)", () => {
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

  async function user(tx: Tx, email = `u-${crypto.randomUUID()}@example.com`): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] = await tx`insert into auth.users (email) values (${email}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  async function studio(tx: Tx): Promise<string> {
    const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
    return id as string;
  }

  async function staff(tx: Tx, studioId: string, role = "admin"): Promise<string> {
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studioId}, ${role}::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name) values (${id}, ${studioId}, ${"Сотрудник " + id.slice(0, 4)})
             on conflict (id) do update set full_name = excluded.full_name`;
    return id;
  }

  async function as(tx: Tx, userId: string) {
    await tx`select set_config('request.jwt.claim.sub', ${userId}::text, true)`;
    await tx`set local role authenticated`;
  }
  async function asServer(tx: Tx) {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claim.sub', '', true)`;
  }

  async function base(tx: Tx, title = "Стандарты"): Promise<string> {
    const [{ id }] = await tx`insert into kb_bases (title, rail_title) values (${title}, 'БЗ') returning id`;
    return id as string;
  }

  async function grant(tx: Tx, baseId: string, userId: string, level: "view" | "edit") {
    await tx`insert into kb_grants (base_id, subject_id, level) values (${baseId}, ${userId}, ${level})`;
  }

  async function node(
    tx: Tx,
    baseId: string,
    opts: { parent?: string | null; kind?: "folder" | "article"; title?: string; status?: string; text?: string } = {},
  ): Promise<string> {
    const [{ id }] = await tx`
      insert into kb_nodes (base_id, parent_id, kind, title, status, content)
      values (${baseId}, ${opts.parent ?? null}, ${opts.kind ?? "article"}, ${opts.title ?? "Статья"},
              ${opts.status ?? "published"}, ${opts.text ? JSON.stringify(doc(opts.text)) : null}::text::jsonb)
      returning id`;
    return id as string;
  }

  /** Владелец, читатель, редактор, сотрудник без доступа и база с деревом. */
  async function setup(tx: Tx) {
    const s = await studio(tx);
    const owner = await staff(tx, s, "owner");
    const reader = await staff(tx, s);
    const editor = await staff(tx, s, "trainer");
    const stranger = await staff(tx, s);
    const b = await base(tx);
    await grant(tx, b, reader, "view");
    await grant(tx, b, editor, "edit");
    const folder = await node(tx, b, { kind: "folder", title: "Администратор" });
    const pub = await node(tx, b, { parent: folder, title: "Открытие смены", text: "Администраторы открывают кассу" });
    const draft = await node(tx, b, { parent: folder, title: "Черновик", status: "draft" });
    return { s, owner, reader, editor, stranger, b, folder, pub, draft };
  }

  async function visible(tx: Tx, userId: string, baseId: string): Promise<string[]> {
    await as(tx, userId);
    const rows = await tx`select title from kb_nodes where base_id = ${baseId} order by title`;
    await asServer(tx);
    return (rows as Row[]).map((r) => r.title as string);
  }

  test("по умолчанию не видно ничего; владелец — всё; читатель — опубликованное", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      expect(await visible(tx, t.stranger, t.b)).toEqual([]);
      expect(await visible(tx, t.owner, t.b)).toEqual(["Администратор", "Открытие смены", "Черновик"]);
      expect(await visible(tx, t.editor, t.b)).toEqual(["Администратор", "Открытие смены", "Черновик"]);
      expect(await visible(tx, t.reader, t.b)).toEqual(["Администратор", "Открытие смены"]);

      await as(tx, t.stranger);
      expect(await tx`select id from kb_bases where id = ${t.b}`).toHaveLength(0);
      await as(tx, t.reader);
      expect(await tx`select id from kb_bases where id = ${t.b}`).toHaveLength(1);
      await asServer(tx);
    }));

  test("папка в черновике прячет опубликованное внутри; вернули — снова видно", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const sub = await node(tx, t.b, { parent: t.folder, kind: "folder", title: "Вложенная" });
      await node(tx, t.b, { parent: sub, title: "Глубоко" });
      expect(await visible(tx, t.reader, t.b)).toContain("Глубоко");

      await tx`update kb_nodes set status = 'draft' where id = ${t.folder}`;
      expect(await visible(tx, t.reader, t.b)).toEqual([]);
      await tx`update kb_nodes set status = 'published' where id = ${t.folder}`;
      expect(await visible(tx, t.reader, t.b)).toEqual(["Администратор", "Вложенная", "Глубоко", "Открытие смены"]);
    }));

  test("доступ — только сотруднику; без роли сотрудника выданное не действует", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const member = await user(tx);
      await grant(tx, t.b, member, "edit");
      expect(await visible(tx, member, t.b)).toEqual([]);
    }));

  test("читатель не пишет; редактор пишет; базы и доступы — только владелец", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.reader);
      expect(
        await failure(tx, () => tx`insert into kb_nodes (base_id, kind, title) values (${t.b}, 'article', 'x')`),
      ).toContain("row-level security");
      const upd = await tx`update kb_nodes set title = 'взлом' where id = ${t.pub} returning id`;
      expect(upd).toHaveLength(0);

      await as(tx, t.editor);
      const [{ id }] = await tx`insert into kb_nodes (base_id, kind, title) values (${t.b}, 'article', 'Новая') returning id`;
      const [n] = await tx`select created_by, status, sort_order from kb_nodes where id = ${id}`;
      expect(n.created_by).toBe(t.editor);
      expect(n.status).toBe("draft");
      expect(n.sort_order).toBe(2);
      expect(
        await failure(tx, () => tx`insert into kb_bases (title, rail_title) values ('Своя', 'С')`),
      ).toContain("row-level security");
      expect(
        await failure(tx, () => tx`insert into kb_grants (base_id, subject_id, level) values (${t.b}, ${t.stranger}, 'view')`),
      ).toContain("row-level security");
      expect(await tx`select id from kb_grants`).toHaveLength(1);

      await as(tx, t.owner);
      await tx`insert into kb_bases (title, rail_title) values ('Своя', 'С')`;
      expect(await tx`select id from kb_grants where base_id = ${t.b}`).toHaveLength(2);
      await asServer(tx);
    }));

  test("перенос: путь детей пересчитывается, внутрь себя нельзя, порядок по месту", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const other = await node(tx, t.b, { kind: "folder", title: "Офис" });
      await as(tx, t.editor);
      await tx`select kb_move_node(${t.folder}, ${other}, 0)`;
      const [p] = await tx`select path from kb_nodes where id = ${t.pub}`;
      expect(p.path).toEqual([other, t.folder]);

      expect(await failure(tx, () => tx`select kb_move_node(${other}, ${t.folder}, 0)`)).toContain(
        "kb_move_into_self",
      );
      expect(await failure(tx, () => tx`select kb_move_node(${t.folder}, ${t.pub}, 0)`)).toContain(
        "kb_folder_in_article",
      );

      await tx`select kb_move_node(${t.draft}, ${t.folder}, 0)`;
      const order = await tx`select title from kb_nodes where parent_id = ${t.folder} order by sort_order`;
      expect((order as Row[]).map((r) => r.title)).toEqual(["Черновик", "Открытие смены"]);

      await as(tx, t.reader);
      expect(await failure(tx, () => tx`select kb_move_node(${t.pub}, null, 0)`)).toContain("kb_forbidden");
      await asServer(tx);
    }));

  test("вложенные статьи: статья в статье на любую глубину, папка — нет; черновик прячет вложенное", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      const [{ id: child }] = await tx`insert into kb_nodes (base_id, parent_id, kind, title, status)
                                       values (${t.b}, ${t.pub}, 'article', 'Шаг 1', 'published') returning id`;
      const [{ id: grand }] = await tx`insert into kb_nodes (base_id, parent_id, kind, title, status)
                                       values (${t.b}, ${child}, 'article', 'Шаг 1.1', 'published') returning id`;
      const [g] = await tx`select path, reader_visible from kb_nodes where id = ${grand}`;
      expect(g).toEqual({ path: [t.folder, t.pub, child], reader_visible: true });
      expect(
        await failure(
          tx,
          () => tx`insert into kb_nodes (base_id, parent_id, kind, title) values (${t.b}, ${t.pub}, 'folder', 'Папка')`,
        ),
      ).toContain("kb_folder_in_article");
      // Перенос статьи внутрь другой статьи и обратно.
      await tx`select kb_move_node(${t.draft}, ${grand}, 0)`;
      expect((await tx`select path from kb_nodes where id = ${t.draft}`)[0].path).toEqual([
        t.folder,
        t.pub,
        child,
        grand,
      ]);
      expect(await failure(tx, () => tx`select kb_move_node(${t.pub}, ${grand}, 0)`)).toContain(
        "kb_move_into_self",
      );
      await tx`select kb_move_node(${t.draft}, ${t.folder}, 0)`;

      // Статья-родитель снята с публикации — читатель не видит и вложенное.
      expect(await visible(tx, t.reader, t.b)).toEqual([
        "Администратор",
        "Открытие смены",
        "Шаг 1",
        "Шаг 1.1",
      ]);
      await as(tx, t.editor);
      await tx`update kb_nodes set status = 'draft' where id = ${t.pub}`;
      expect(await visible(tx, t.reader, t.b)).toEqual(["Администратор"]);
      await as(tx, t.editor);
      await tx`update kb_nodes set status = 'published' where id = ${t.pub}`;

      // В корзину — со всеми вложенными; вернуть — под прежнюю статью.
      const [{ id: trashId }] = await tx`select kb_trash_node(${child}) as id`;
      const [row] = (await tx`select kind, articles_count from kb_trash where id = ${trashId}`) as Row[];
      expect(row).toEqual({ kind: "article", articles_count: 2 });
      await tx`select kb_trash_restore(${trashId})`;
      const back = (await tx`select id, parent_id from kb_nodes where id in (${child}, ${grand}) order by title`) as Row[];
      expect(back).toEqual([
        { id: child, parent_id: t.pub },
        { id: grand, parent_id: child },
      ]);
      await asServer(tx);
    }));

  test("папку с содержимым не удалить; базу — вместе с деревом", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      expect(await failure(tx, () => tx`delete from kb_nodes where id = ${t.folder}`)).toContain(
        "foreign key",
      );
      await tx`delete from kb_nodes where id = ${t.draft}`;
      await as(tx, t.owner);
      await tx`delete from kb_bases where id = ${t.b}`;
      await asServer(tx);
      expect(await tx`select id from kb_nodes where base_id = ${t.b}`).toHaveLength(0);
    }));

  test("черновик правок виден только редактору; публикация — текст, история, поиск", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      const saved = await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Новый регламент кассы"))}::text::jsonb, null) as at`;
      const at = saved[0].at as Date;
      expect(
        await failure(tx, () => tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Чужая правка"))}::text::jsonb, null)`),
      ).toContain("kb_draft_conflict");
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Новый регламент кассы и сейфа"))}::text::jsonb, ${at})`;

      await as(tx, t.reader);
      expect(await tx`select node_id from kb_drafts`).toHaveLength(0);
      const [before] = await tx`select content_text from kb_nodes where id = ${t.pub}`;
      expect(before.content_text).toBe("Администраторы открывают кассу");
      expect(await failure(tx, () => tx`select kb_publish(${t.pub})`)).toContain("kb_forbidden");

      await as(tx, t.editor);
      await tx`select kb_publish(${t.pub})`;
      await asServer(tx);
      const [after] = await tx`select content_text, published_by, status from kb_nodes where id = ${t.pub}`;
      expect(after.content_text).toBe("Новый регламент кассы и сейфа");
      expect(after.published_by).toBe(t.editor);
      expect(await tx`select node_id from kb_drafts where node_id = ${t.pub}`).toHaveLength(0);
      const revs = await tx`select title from kb_revisions where node_id = ${t.pub}`;
      expect(revs).toHaveLength(1);

      // Черновик статьи-черновика публикуется и становится виден читателю.
      await as(tx, t.editor);
      await tx`select kb_save_draft(${t.draft}, ${JSON.stringify(doc("Текст"))}::text::jsonb, null)`;
      await tx`select kb_publish(${t.draft})`;
      await asServer(tx);
      expect(await visible(tx, t.reader, t.b)).toContain("Черновик");
    }));

  test("поиск: начало слова и окончания, внутри папки, читатель не находит черновики", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const office = await node(tx, t.b, { kind: "folder", title: "Офис" });
      await node(tx, t.b, { parent: office, title: "Касса офиса", text: "Касса в офисе" });
      await node(tx, t.b, { parent: t.folder, title: "Скрытая касса", status: "draft", text: "касса" });

      await as(tx, t.reader);
      let rows = (await tx`select title, snippet from kb_search('админ', ${t.b}, null, 30)`) as Row[];
      expect(rows.map((r) => r.title)).toEqual(["Администратор", "Открытие смены"]);
      expect(rows[1].snippet).toContain("⟦Администраторы⟧");

      rows = (await tx`select title from kb_search('кассы', ${t.b}, null, 30)`) as Row[];
      expect(rows.map((r) => r.title).sort()).toEqual(["Касса офиса", "Открытие смены"]);
      rows = (await tx`select title from kb_search('касса', ${t.b}, ${office}, 30)`) as Row[];
      expect(rows.map((r) => r.title)).toEqual(["Касса офиса"]);
      rows = (await tx`select title from kb_search('%', ${t.b}, null, 30)`) as Row[];
      expect(rows).toHaveLength(0);

      await as(tx, t.editor);
      rows = (await tx`select title from kb_search('касса', ${t.b}, null, 30)`) as Row[];
      expect(rows.map((r) => r.title)).toContain("Скрытая касса");
      await asServer(tx);
    }));

  test("копия статьи — черновиком сразу под оригиналом", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      const [{ id }] = await tx`select kb_copy_node(${t.pub}) as id`;
      const order = await tx`select title, status from kb_nodes where parent_id = ${t.folder} order by sort_order`;
      expect((order as Row[]).map((r) => r.title)).toEqual(["Открытие смены", "Открытие смены (копия)", "Черновик"]);
      const [d] = await tx`select content from kb_drafts where node_id = ${id}`;
      expect(JSON.stringify(d.content)).toContain("Администраторы открывают кассу");
      await asServer(tx);
    }));

  test("чтение и отчёт: папки не считаются, доступ — у владельцев и выданных", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.reader);
      await tx`select kb_mark_read(${t.pub})`;
      await tx`select kb_mark_read(${t.pub})`;
      await tx`select kb_mark_read(${t.draft})`;
      await tx`select kb_mark_read(${t.folder})`;
      expect(await failure(tx, () => tx`select * from kb_report(${t.b})`)).toContain("kb_forbidden");
      await as(tx, t.stranger);
      await tx`select kb_mark_read(${t.pub})`;
      await asServer(tx);
      const reads = await tx`select node_id, read_count from kb_reads`;
      expect(reads).toHaveLength(1);
      expect(reads[0].read_count).toBe(1);

      await as(tx, t.editor);
      const report = (await tx`select * from kb_report(${t.b}) order by title`) as Row[];
      expect(report.map((r) => r.title)).toEqual(["Открытие смены", "Черновик"]);
      // Список «у кого доступ» наружу не выдан — только через отчёт.
      expect(await failure(tx, () => tx`select * from kb_base_audience(${t.b})`)).toContain(
        "permission denied",
      );
      // Аудитория — читатель и редактор (владелец не в счёт): 1 из 2.
      expect(report[0].readers_count).toBe(1);
      expect(report[0].access_count).toBe(2);

      await tx`insert into kb_nodes (base_id, kind, title) values (${t.b}, 'article', 'Своя')`;
      const authors = (await tx`select * from kb_authors(${t.b})`) as Row[];
      expect(authors.map((r) => r.user_id)).toContain(t.editor);
      expect(Object.keys(authors[0])).toEqual(["user_id", "full_name", "avatar_url"]);
      await as(tx, t.stranger);
      expect(await failure(tx, () => tx`select * from kb_authors(${t.b})`)).toContain("kb_forbidden");
      await as(tx, t.editor);
      const readers = (await tx`select * from kb_article_readers(${t.pub})`) as Row[];
      expect(readers.find((r) => r.user_id === t.reader)?.read_count).toBe(1);
      expect(readers.find((r) => r.user_id === t.editor)?.read_count).toBe(0);
      expect(readers.some((r) => r.user_id === t.stranger)).toBe(false);
      expect(readers.some((r) => r.user_id === t.owner)).toBe(false);

      // Кто правил статью — её автор, а не читатель: из аудитории выпадает,
      // его собственные открытия в отчёт не идут.
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("правка"))}::text::jsonb, null)`;
      await tx`select kb_mark_read(${t.pub})`;
      const [after] = (await tx`select * from kb_report(${t.b}) where id = ${t.pub}`) as Row[];
      expect(after.access_count).toBe(1);
      expect(after.readers_count).toBe(1);
      const left = (await tx`select * from kb_article_readers(${t.pub})`) as Row[];
      expect(left.map((r) => r.user_id)).toEqual([t.reader]);
      await asServer(tx);
    }));

  test("учёт чтения: время, прокрутка, версия, дни, поиск и аналитика", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      // Статья опубликована редактором — у неё есть версия (published_at).
      await as(tx, t.editor);
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Версия 1"))}::text::jsonb, null)`;
      await tx`select kb_publish(${t.pub})`;

      await as(tx, t.reader);
      await tx`select kb_mark_read(${t.pub})`;
      await tx`select kb_mark_read(${t.pub})`; // повтор в течение 30 минут не считается
      await tx`select kb_track_reading(${t.pub}, 500, 95)`; // больше 60 секунд за раз не бывает
      await tx`select kb_track_reading(${t.pub}, 20, 40)`;
      await asServer(tx);
      const [read] = (await tx`select * from kb_reads where node_id = ${t.pub} and user_id = ${t.reader}`) as Row[];
      expect(read.read_count).toBe(1);
      expect(read.seconds).toBe(80);
      expect(read.max_scroll).toBe(95);
      expect(read.completed_at).not.toBeNull();
      const days = (await tx`select views, seconds from kb_read_days where user_id = ${t.reader}`) as Row[];
      expect(days).toEqual([{ views: 1, seconds: 80 }]);
      // Писать напрямую нельзя — только RPC.
      await as(tx, t.reader);
      expect(
        await failure(tx, () => tx`insert into kb_read_days (node_id, user_id, base_id, day) values (${t.pub}, ${t.reader}, ${t.b}, current_date)`),
      ).toContain("permission denied");

      // Поиск: набор по буквам — одна строка, клик запоминается, «ничего» — отдельно.
      const [{ id: s1 }] = (await tx`select kb_log_search(${t.b}, 'адм', 2) as id`) as Row[];
      const [{ id: s2 }] = (await tx`select kb_log_search(${t.b}, 'Админ  ', 1) as id`) as Row[];
      expect(s2).toBe(s1);
      await tx`select kb_log_search_click(${s1}, ${t.pub})`;
      await tx`select kb_log_search(${t.b}, 'сейф', 0)`;
      expect(await tx`select 1 from kb_search_log`).toHaveLength(0); // читатель журнал не видит

      // Новая версия: прочитанное становится «прежней версией». В транзакции
      // теста now() один — читали «минуту назад».
      await asServer(tx);
      await tx`update kb_reads set read_published_at = read_published_at - interval '1 minute' where user_id = ${t.reader}`;
      await tx`update kb_nodes set published_at = published_at - interval '1 minute' where id = ${t.pub}`;
      await as(tx, t.editor);
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Версия 2"))}::text::jsonb, null)`;
      await tx`select kb_publish(${t.pub})`;
      const readers = (await tx`select * from kb_article_readers(${t.pub})`) as Row[];
      expect(readers.find((r) => r.user_id === t.reader)?.state).toBe("outdated");

      const ov = ((await tx`select kb_analytics_overview(${t.b}, 30) as o`) as Row[])[0].o;
      expect(ov.people).toBe(2); // читатель и редактор; владелец не в счёт
      expect(ov.read_outdated).toBe(1);
      expect(ov.current.views).toBe(1);
      expect(ov.current.readers).toBe(1);
      expect(ov.current.seconds).toBe(80);
      expect(ov.current.searches).toBe(2);
      expect(ov.current.zero_searches).toBe(1);
      expect(ov.daily).toHaveLength(30);
      expect(ov.zero_queries.map((q: Row) => q.query)).toEqual(["сейф"]);
      expect(ov.top_queries.find((q: Row) => q.query === "админ")?.clicks).toBe(1);
      expect(ov.sections.map((x: Row) => x.title)).toEqual(["Администратор"]);
      // Вкладка «Поиск» — те же цифры отдельной RPC, без расчёта чтения.
      const sr = ((await tx`select kb_analytics_search(${t.b}, 30) as o`) as Row[])[0].o;
      expect(sr.current).toEqual({ searches: 2, zero_searches: 1 });
      expect(sr.previous).toEqual({ searches: 0, zero_searches: 0 });
      expect(sr.top_queries).toEqual(ov.top_queries);
      expect(sr.zero_queries).toEqual(ov.zero_queries);

      const people = (await tx`select * from kb_analytics_people(${t.b}, 30)`) as Row[];
      const me = people.find((r) => r.user_id === t.reader)!;
      expect(me.read_outdated).toBe(1);
      expect(me.seconds_total).toBe(80);
      expect(me.last_node_title).toBe("Открытие смены");
      const person = ((await tx`select kb_analytics_person(${t.b}, ${t.reader}) as p`) as Row[])[0].p;
      expect(person.articles.find((a: Row) => a.id === t.pub)?.state).toBe("outdated");
      expect(person.daily).toHaveLength(30);

      // Открыл новую версию — снова актуальная, прокрутка и «дочитал» заново.
      await asServer(tx);
      await tx`update kb_reads set last_read_at = now() - interval '1 hour' where user_id = ${t.reader}`;
      await as(tx, t.reader);
      await tx`select kb_mark_read(${t.pub})`;
      await asServer(tx);
      const [again] = (await tx`select * from kb_reads where node_id = ${t.pub} and user_id = ${t.reader}`) as Row[];
      expect(again.read_count).toBe(2);
      expect(again.max_scroll).toBe(0);
      expect(again.completed_at).toBeNull();

      // Аналитика — только редакторам и владельцам.
      await as(tx, t.reader);
      expect(await failure(tx, () => tx`select kb_analytics_overview(${t.b}, 30)`)).toContain("kb_forbidden");
      expect(await failure(tx, () => tx`select kb_analytics_search(${t.b}, 30)`)).toContain("kb_forbidden");
      expect(await failure(tx, () => tx`select * from kb_analytics_people(${t.b}, 30)`)).toContain("kb_forbidden");
      expect(await failure(tx, () => tx`select kb_analytics_person(${t.b}, ${t.reader})`)).toContain("kb_forbidden");
      await as(tx, t.owner);
      const report = (await tx`select * from kb_report(${t.b}) where id = ${t.pub}`) as Row[];
      expect(report[0].readers_count).toBe(1);
      expect(report[0].avg_seconds).toBe(80);
      await asServer(tx);
    }));

  test("чистка: файлы без ссылок, сроки журналов, занятое место", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const used = `${t.b}/${t.pub}/used.png`;
      const inRevision = `${t.b}/${t.pub}/old.png`;
      const orphan = `${t.b}/${t.pub}/orphan.png`;
      const fresh = `${t.b}/${t.pub}/fresh.png`;
      const gallery = `${t.b}/${t.pub}/gallery.png`;
      const img = (path: string) => ({ type: "image", props: { url: `kbfile:${path}` }, children: [] });
      await tx`update kb_nodes set content = ${JSON.stringify([
        img(used),
        // У галереи картинки — строкой JSON внутри поля.
        { type: "gallery", props: { images: JSON.stringify([{ url: `kbfile:${gallery}` }]) }, children: [] },
      ])}::text::jsonb where id = ${t.pub}`;
      await tx`insert into kb_revisions (node_id, base_id, title, content)
               values (${t.pub}, ${t.b}, 'v1', ${JSON.stringify([img(inRevision)])}::text::jsonb)`;
      const old = "now() - interval '10 days'";
      for (const [name, size] of [[used, 100], [inRevision, 200], [orphan, 300], [gallery, 50]] as const)
        await tx.unsafe(
          `insert into storage.objects (bucket_id, name, created_at, metadata)
           values ('kb-media', '${name}', ${old}, '{"size": ${size}}')`,
        );
      await tx`insert into storage.objects (bucket_id, name, metadata) values ('kb-media', ${fresh}, '{"size": 1}')`;
      const gc = ((await tx`select name from kb_file_gc_candidates(7, 100)`) as Row[]).map((r) => r.name);
      expect(gc).toEqual([orphan]);

      await tx`insert into kb_search_log (base_id, query, results, created_at) values
               (${t.b}, 'старый', 1, now() - interval '400 days'), (${t.b}, 'новый', 1, now())`;
      await tx`insert into kb_read_days (node_id, user_id, base_id, day, views) values
               (${t.pub}, ${t.reader}, ${t.b}, current_date - 500, 1), (${t.pub}, ${t.reader}, ${t.b}, current_date, 1)`;
      const [{ h }] = (await tx`select kb_housekeeping() as h`) as Row[];
      expect(h).toEqual({ search_log: 1, read_days: 1 });
      expect(((await tx`select query from kb_search_log`) as Row[]).map((r) => r.query)).toEqual(["новый"]);

      // Чистка — только сервер; место — только владелец.
      await as(tx, t.editor);
      expect(await failure(tx, () => tx`select * from kb_file_gc_candidates(7, 100)`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select kb_housekeeping()`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select kb_storage_usage()`)).toContain("kb_forbidden");
      await as(tx, t.owner);
      const [{ u }] = (await tx`select kb_storage_usage() as u`) as Row[];
      const mine = u.bases.find((b: Row) => b.id === t.b);
      expect(mine.files).toBe(5);
      expect(Number(mine.bytes)).toBe(651);
      expect(Number(u.db_bytes)).toBeGreaterThan(0);
      await asServer(tx);
    }));

  test("иконка раздела: пишет редактор, только у папки и ключом из набора", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      await tx`update kb_nodes set icon = 'wallet' where id = ${t.folder}`;
      const [row] = await tx`select icon from kb_nodes where id = ${t.folder}`;
      expect(row.icon).toBe("wallet");
      expect(await failure(tx, () => tx`update kb_nodes set icon = 'wallet' where id = ${t.pub}`)).toContain(
        "kb_nodes_icon_check",
      );
      expect(
        await failure(tx, () => tx`update kb_nodes set icon = '<script>' where id = ${t.folder}`),
      ).toContain("kb_nodes_icon_check");
      await as(tx, t.reader);
      await tx`update kb_nodes set icon = 'fire' where id = ${t.folder}`;
      await asServer(tx);
      const [still] = await tx`select icon from kb_nodes where id = ${t.folder}`;
      expect(still.icon).toBe("wallet");
    }));

  test("корзина: удалённое со всем вложенным возвращается с прежними id и авторством", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      const [{ id: own }] = await tx`insert into kb_nodes (base_id, parent_id, kind, title, status)
                                     values (${t.b}, ${t.folder}, 'article', 'Своя', 'published') returning id`;
      await tx`select kb_save_draft(${own}, ${JSON.stringify(doc("правка"))}::text::jsonb, null)`;
      await as(tx, t.reader);
      await tx`select kb_mark_read(${t.pub})`;
      await tx`insert into kb_favorites (node_id, base_id) values (${t.pub}, ${t.b})`;
      await tx`insert into kb_checks (node_id, base_id, block_id) values (${t.pub}, ${t.b}, 'blk1')`;
      // Читатель не удаляет.
      expect(await failure(tx, () => tx`select kb_trash_node(${t.folder})`)).toContain("kb_forbidden");

      await as(tx, t.editor);
      const [{ id: trashId }] = await tx`select kb_trash_node(${t.folder}) as id`;
      expect(await tx`select id from kb_nodes where base_id = ${t.b}`).toHaveLength(0);
      const [row] = (await tx`select title, kind, articles_count from kb_trash where id = ${trashId}`) as Row[];
      expect(row).toEqual({ title: "Администратор", kind: "folder", articles_count: 3 });
      // Корзину видит только редактор.
      await as(tx, t.reader);
      expect(await tx`select id from kb_trash`).toHaveLength(0);
      expect(await failure(tx, () => tx`select kb_trash_restore(${trashId})`)).toContain("kb_forbidden");

      await as(tx, t.editor);
      const [{ id: restored }] = await tx`select kb_trash_restore(${trashId}) as id`;
      expect(restored).toBe(t.folder);
      await asServer(tx);
      const nodes = (await tx`select id, title, created_by, reader_visible from kb_nodes
                                where base_id = ${t.b} order by title`) as Row[];
      expect(nodes.map((n) => n.title)).toEqual(["Администратор", "Открытие смены", "Своя", "Черновик"]);
      expect(nodes.find((n) => n.id === own)?.created_by).toBe(t.editor);
      expect(nodes.find((n) => n.id === t.pub)?.reader_visible).toBe(true);
      expect(await tx`select 1 from kb_drafts where node_id = ${own}`).toHaveLength(1);
      expect(await tx`select 1 from kb_reads where node_id = ${t.pub}`).toHaveLength(1);
      expect(await tx`select 1 from kb_favorites where node_id = ${t.pub}`).toHaveLength(1);
      expect(await tx`select 1 from kb_checks where node_id = ${t.pub}`).toHaveLength(1);
      expect(await tx`select id from kb_trash`).toHaveLength(0);
      // Восстановление — не удаление: файлы не в очереди.
      expect(await tx`select 1 from kb_file_purge`).toHaveLength(0);

      // Навсегда — файлы статей в очередь; истёкшее чистит только сервер.
      await as(tx, t.editor);
      const [{ id: again }] = await tx`select kb_trash_node(${t.pub}) as id`;
      await tx`select kb_trash_delete(${again})`;
      expect(await failure(tx, () => tx`select kb_trash_purge_due()`)).toContain("permission denied");
      await asServer(tx);
      const queued = (await tx`select base_id, node_id from kb_file_purge`) as Row[];
      expect(queued).toEqual([{ base_id: t.b, node_id: t.pub }]);
      await tx`update kb_trash set purge_after = now() - interval '1 day'`;
      const [{ n }] = await tx`select kb_trash_purge_due() as n`;
      expect(n).toBe(0);
      await tx`delete from kb_bases where id = ${t.b}`;
      expect(await tx`select 1 from kb_file_purge where base_id = ${t.b} and node_id is null`).toHaveLength(1);
    }));

  test("корзина возвращает учёт чтения целиком: версия, время, прокрутка, «дочитал»", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Версия 1"))}::text::jsonb, null)`;
      await tx`select kb_publish(${t.pub})`;
      await as(tx, t.reader);
      await tx`select kb_mark_read(${t.pub})`;
      await tx`select kb_track_reading(${t.pub}, 30, 95)`;
      await asServer(tx);
      const cols = (r: Row) => [r.read_published_at, r.seconds, r.max_scroll, r.completed_at];
      const [before] = (await tx`select * from kb_reads where node_id = ${t.pub}`) as Row[];
      expect(before.seconds).toBe(30);
      expect(before.completed_at).not.toBeNull();

      await as(tx, t.editor);
      const [{ id: trashId }] = await tx`select kb_trash_node(${t.pub}) as id`;
      await tx`select kb_trash_restore(${trashId})`;
      await asServer(tx);
      const [after] = (await tx`select * from kb_reads where node_id = ${t.pub}`) as Row[];
      expect(cols(after)).toEqual(cols(before));
      await as(tx, t.editor);
      const readers = (await tx`select * from kb_article_readers(${t.pub})`) as Row[];
      expect(readers.find((r) => r.user_id === t.reader)?.state).toBe("current");
      await asServer(tx);
    }));

  test("избранное и отметки — свои и только на видимое; шаблоны — редакторам", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.reader);
      await tx`insert into kb_favorites (node_id, base_id) values (${t.pub}, ${t.b})`;
      expect(
        await failure(tx, () => tx`insert into kb_favorites (node_id, base_id) values (${t.draft}, ${t.b})`),
      ).toContain("row-level security");
      expect(
        await failure(tx, () => tx`insert into kb_checks (node_id, base_id, block_id) values (${t.draft}, ${t.b}, 'x')`),
      ).toContain("row-level security");
      await tx`insert into kb_checks (node_id, base_id, block_id) values (${t.pub}, ${t.b}, 'x')`;
      await as(tx, t.editor);
      expect(await tx`select 1 from kb_favorites`).toHaveLength(0);
      expect(await tx`select 1 from kb_checks`).toHaveLength(0);

      // Шаблоны общие для всех баз: редактор одной базы видит и правит
      // шаблон редактора другой; читателю их не видно.
      await tx`insert into kb_templates (title, content) values ('Регламент', ${JSON.stringify(doc("Шаг 1"))}::text::jsonb)`;
      const [tpl] = (await tx`select id, created_by from kb_templates`) as Row[];
      expect(tpl.created_by).toBe(t.editor);
      await asServer(tx);
      const other = await base(tx, "Обучение");
      const otherEditor = await staff(tx, t.s, "trainer");
      await grant(tx, other, otherEditor, "edit");
      await as(tx, otherEditor);
      expect(await tx`select 1 from kb_templates`).toHaveLength(1);
      await tx`update kb_templates set title = 'Регламент смены' where id = ${tpl.id}`;
      const names = ((await tx`select user_id from kb_authors(${other})`) as Row[]).map((r) => r.user_id);
      expect(names).toContain(otherEditor);
      await as(tx, t.reader);
      expect(await tx`select 1 from kb_templates`).toHaveLength(0);
      expect(
        await failure(tx, () => tx`insert into kb_templates (title, content) values ('x', '[]')`),
      ).toContain("row-level security");
      // Удалённый шаблон — его папка файлов в очередь стирания.
      await as(tx, otherEditor);
      await tx`delete from kb_templates where id = ${tpl.id}`;
      await asServer(tx);
      expect(await tx`select 1 from kb_file_purge where folder = ${`templates/${tpl.id}`}`).toHaveLength(1);
      await as(tx, t.reader);

      // Упомянуть можно любого человека портала (2026-10-27); у кого нет
      // доступа к базе — has_access = false и ниже в списке. Клиента — нельзя.
      await asServer(tx);
      const client = await user(tx);
      await tx`insert into user_roles (user_id, studio_id, role) values (${client}, ${t.s}, 'member'::app_role)`;
      await as(tx, t.reader);
      expect(await failure(tx, () => tx`select * from kb_mention_candidates(${t.b})`)).toContain("kb_forbidden");
      await as(tx, t.editor);
      const rows = (await tx`select user_id, has_access from kb_mention_candidates(${t.b})`) as Row[];
      const access = new Map(rows.map((r) => [r.user_id, r.has_access]));
      expect(access.get(t.owner)).toBe(true);
      expect(access.get(t.reader)).toBe(true);
      expect(access.get(t.editor)).toBe(true);
      expect(access.get(t.stranger)).toBe(false);
      expect(access.has(client)).toBe(false);
      expect(rows.findIndex((r) => r.user_id === t.stranger)).toBe(rows.length - 1);

      // Карточка сотрудника и короткие карточки — любому человеку портала.
      await as(tx, t.stranger);
      const [card] = (await tx`select person_card(${t.reader}) as c`) as Row[];
      const c = card.c as Record<string, unknown>;
      expect(c.full_name).toBe("Сотрудник " + t.reader.slice(0, 4));
      expect(c.clubs).toEqual([{ name: "Тест", role: "admin" }]);
      expect(c.active).toBe(true);
      const [none] = (await tx`select person_card(${crypto.randomUUID()}) as c`) as Row[];
      expect(none.c).toBeNull();
      const short = (await tx`select user_id from people_cards(${[t.owner, t.editor]}::uuid[])`) as Row[];
      expect(short.map((r) => r.user_id).sort()).toEqual([t.owner, t.editor].sort());
      await as(tx, client);
      expect(await failure(tx, () => tx`select person_card(${t.reader})`)).toContain("forbidden");
      expect(await failure(tx, () => tx`select * from people_cards(${[t.reader]}::uuid[])`)).toContain(
        "forbidden",
      );
      await asServer(tx);
    }));

  test("оценка статьи: своя и только видимое, версия, выключение, аналитика, корзина", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      await tx`select kb_save_draft(${t.pub}, ${JSON.stringify(doc("Версия 1"))}::text::jsonb, null)`;
      await tx`select kb_publish(${t.pub})`;

      await as(tx, t.reader);
      await tx`select kb_rate(${t.pub}, 1)`;
      await tx`select kb_rate(${t.pub}, 3)`; // та же версия — оценка меняется, строка одна
      expect(await failure(tx, () => tx`select kb_rate(${t.pub}, 4)`)).toContain("kb_bad_score");
      expect(await failure(tx, () => tx`select kb_rate(${t.draft}, 2)`)).toContain("kb_not_found");
      expect(await failure(tx, () => tx`select kb_rate(${t.folder}, 2)`)).toContain("kb_not_found");
      // Писать напрямую нельзя, свои строки — видно.
      expect(
        await failure(tx, () => tx`insert into kb_ratings (node_id, base_id, user_id, score, version_at)
                                    values (${t.pub}, ${t.b}, ${t.reader}, 1, now())`),
      ).toContain("permission denied");
      const own = (await tx`select score from kb_ratings where node_id = ${t.pub}`) as Row[];
      expect(own).toEqual([{ score: 3 }]);
      // Сотрудник без доступа не оценит; аналитику читатель не видит.
      await as(tx, t.stranger);
      expect(await failure(tx, () => tx`select kb_rate(${t.pub}, 2)`)).toContain("kb_not_found");
      await as(tx, t.reader);
      expect(await failure(tx, () => tx`select kb_ratings_report(${t.b}, 30)`)).toContain("kb_forbidden");

      // Новая версия — новая строка; прежняя оценка — «прежней версии».
      await asServer(tx);
      await tx`update kb_ratings set version_at = version_at - interval '1 minute', rated_at = rated_at - interval '1 minute'`;
      await tx`update kb_nodes set published_at = published_at - interval '1 minute' where id = ${t.pub}`;
      await tx`update kb_nodes set published_at = now() where id = ${t.pub}`;
      await as(tx, t.reader);
      await tx`select kb_rate(${t.pub}, 2)`;
      await as(tx, t.owner);
      await tx`select kb_rate(${t.pub}, 1)`;

      await as(tx, t.editor);
      const [{ r }] = (await tx`select kb_ratings_report(${t.b}, 30) as r`) as Row[];
      const report = r as {
        current: Record<string, number>;
        articles: { id: string; count: number; bad: number; ok: number; good: number }[];
        log: { user_id: string; score: number; outdated: boolean }[];
      };
      expect(report.current).toEqual({ count: 3, people: 2, bad: 1, ok: 1, good: 1 });
      expect(report.articles).toHaveLength(1);
      expect(report.articles[0]).toMatchObject({ id: t.pub, count: 3, bad: 1, ok: 1, good: 1 });
      expect(report.log.map((l) => [l.user_id, l.score, l.outdated])).toEqual([
        [t.owner, 1, false],
        [t.reader, 2, false],
        [t.reader, 3, true],
      ]);
      // Редактор видит все оценки базы.
      expect(await tx`select 1 from kb_ratings where base_id = ${t.b}`).toHaveLength(3);

      // Оценку выключили в настройках статьи — оценить нельзя.
      await tx`update kb_nodes set feedback_enabled = false, pager_enabled = false where id = ${t.pub}`;
      await as(tx, t.reader);
      expect(await failure(tx, () => tx`select kb_rate(${t.pub}, 3)`)).toContain("kb_rating_off");

      // Корзина: оценки и настройки статьи возвращаются вместе с ней.
      await as(tx, t.editor);
      const [{ id: trashId }] = await tx`select kb_trash_node(${t.pub}) as id`;
      await asServer(tx);
      expect(await tx`select 1 from kb_ratings where node_id = ${t.pub}`).toHaveLength(0);
      await as(tx, t.editor);
      await tx`select kb_trash_restore(${trashId})`;
      await asServer(tx);
      expect(await tx`select 1 from kb_ratings where node_id = ${t.pub}`).toHaveLength(3);
      const [settings] = (await tx`select feedback_enabled, pager_enabled from kb_nodes where id = ${t.pub}`) as Row[];
      expect(settings).toEqual({ feedback_enabled: false, pager_enabled: false });
      // Копия — с настройками, без оценок.
      await as(tx, t.editor);
      const [{ id: copy }] = await tx`select kb_copy_node(${t.pub}) as id`;
      await asServer(tx);
      const [copied] = (await tx`select feedback_enabled, pager_enabled from kb_nodes where id = ${copy}`) as Row[];
      expect(copied).toEqual({ feedback_enabled: false, pager_enabled: false });
      expect(await tx`select 1 from kb_ratings where node_id = ${copy}`).toHaveLength(0);
    }));

  test("теги: свои у базы, ставит редактор, читатель видит теги видимого, поиск и корзина", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      // «#» и лишние пробелы срезаются; регистр не делает новый тег.
      const [{ id: cash, name }] = await tx`insert into kb_tags (base_id, name) values (${t.b}, '  #Касса   смены ') returning id, name`;
      expect(name).toBe("Касса смены");
      expect(
        await failure(tx, () => tx`insert into kb_tags (base_id, name) values (${t.b}, 'касса СМЕНЫ')`),
      ).toContain("kb_tags_base_name_key");
      expect(await failure(tx, () => tx`insert into kb_tags (base_id, name) values (${t.b}, ' # ')`)).toContain(
        "kb_tag_empty",
      );
      const [{ id: hidden }] = await tx`insert into kb_tags (base_id, name) values (${t.b}, 'Скрытое') returning id`;
      await tx`insert into kb_node_tags (node_id, tag_id) values (${t.pub}, ${cash})`;
      await tx`insert into kb_node_tags (node_id, tag_id) values (${t.draft}, ${hidden})`;
      // Только статьи; тег — той же базы.
      expect(
        await failure(tx, () => tx`insert into kb_node_tags (node_id, tag_id) values (${t.folder}, ${cash})`),
      ).toContain("kb_tag_not_article");
      await asServer(tx);
      const other = await base(tx, "Другая");
      const [{ id: foreign }] = await tx`insert into kb_tags (base_id, name) values (${other}, 'Чужой') returning id`;
      await as(tx, t.editor);
      expect(
        await failure(tx, () => tx`insert into kb_node_tags (node_id, tag_id) values (${t.pub}, ${foreign})`),
      ).toContain("kb_tag_other_base");

      // Читатель: видит теги базы, но на статьях — только у видимых; ставить не может.
      await as(tx, t.reader);
      expect((await tx`select name from kb_tags where base_id = ${t.b} order by name`).map((r: Row) => r.name)).toEqual([
        "Касса смены",
        "Скрытое",
      ]);
      expect((await tx`select node_id from kb_node_tags`).map((r: Row) => r.node_id)).toEqual([t.pub]);
      expect(
        await failure(tx, () => tx`insert into kb_node_tags (node_id, tag_id) values (${t.pub}, ${hidden})`),
      ).toContain("row-level security");
      expect(await failure(tx, () => tx`insert into kb_tags (base_id, name) values (${t.b}, 'Мой')`)).toContain(
        "row-level security",
      );
      await as(tx, t.stranger);
      expect(await tx`select id from kb_tags`).toHaveLength(0);

      // Поиск: «#касса» и «касса смены» находят статью по тегу, хотя в тексте этого нет.
      await asServer(tx);
      const plain = await node(tx, t.b, { parent: t.folder, title: "Без тега", text: "про другое" });
      await as(tx, t.reader);
      const byTag = (await tx`select id from kb_search('#касса', ${t.b})`).map((r: Row) => r.id);
      expect(byTag).toEqual([t.pub]);
      expect((await tx`select id from kb_search('касса смены', ${t.b})`).map((r: Row) => r.id)).toContain(t.pub);
      expect((await tx`select id from kb_search('скрытое', ${t.b})`).map((r: Row) => r.id)).toEqual([]);
      expect((await tx`select id from kb_search('другое', ${t.b})`).map((r: Row) => r.id)).toEqual([plain]);

      // Корзина: удалили статью — теги ушли с ней, вернули — теги на месте.
      await as(tx, t.editor);
      const [{ id: trashId }] = await tx`select kb_trash_node(${t.pub}) as id`;
      await asServer(tx);
      expect(await tx`select 1 from kb_node_tags where node_id = ${t.pub}`).toHaveLength(0);
      await as(tx, t.editor);
      await tx`select kb_trash_restore(${trashId})`;
      await asServer(tx);
      expect((await tx`select tag_id from kb_node_tags where node_id = ${t.pub}`).map((r: Row) => r.tag_id)).toEqual([
        cash,
      ]);
      // Удалили тег — снят со всех статей.
      await tx`delete from kb_tags where id = ${cash}`;
      expect(await tx`select 1 from kb_node_tags where node_id = ${t.pub}`).toHaveLength(0);
    }));

  test("цвет базы: #rrggbb или пусто; ставит владелец", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.owner);
      await tx`update kb_bases set brand_color = '#17b3a3' where id = ${t.b}`;
      expect(
        await failure(tx, () => tx`update kb_bases set brand_color = 'red' where id = ${t.b}`),
      ).toContain("kb_bases_brand_color_check");
      await as(tx, t.editor);
      await tx`update kb_bases set brand_color = '#000000' where id = ${t.b}`; // RLS: не его — 0 строк
      const [row] = (await tx`select brand_color from kb_bases where id = ${t.b}`) as Row[];
      expect(row.brand_color).toBe("#17b3a3");
      await asServer(tx);
    }));

  test("цвет тега: ключ из набора или пусто", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      await as(tx, t.editor);
      const [{ id }] = await tx`insert into kb_tags (base_id, name, color) values (${t.b}, 'Касса', 'green') returning id`;
      await tx`update kb_tags set color = 'pink' where id = ${id}`;
      expect(
        await failure(tx, () => tx`update kb_tags set color = '#ff0000' where id = ${id}`),
      ).toContain("kb_tags_color_check");
      await tx`update kb_tags set color = null where id = ${id}`;
      await asServer(tx);
    }));

  test("файлы: читатель базы читает, пишет только редактор, чужая база закрыта", () =>
    scenario(async (tx) => {
      const t = await setup(tx);
      const other = await base(tx, "Другая");
      // В Supabase у ролей запросов есть доступ к схеме storage, в заглушках — нет.
      await tx`grant usage on schema storage to authenticated`;
      await tx`grant select, insert, update, delete on storage.objects to authenticated`;
      await tx`insert into storage.objects (bucket_id, name) values ('kb-media', ${`${t.b}/${t.pub}/a.png`}),
                                                                   ('kb-media', ${`${other}/x/b.png`})`;
      await as(tx, t.reader);
      const seen = (await tx`select name from storage.objects where bucket_id = 'kb-media'`) as Row[];
      expect(seen.map((r) => r.name)).toEqual([`${t.b}/${t.pub}/a.png`]);
      expect(
        await failure(tx, () => tx`insert into storage.objects (bucket_id, name) values ('kb-media', ${`${t.b}/${t.pub}/c.png`})`),
      ).toContain("row-level security");
      await as(tx, t.editor);
      await tx`insert into storage.objects (bucket_id, name) values ('kb-media', ${`${t.b}/${t.pub}/c.png`})`;
      expect(
        await failure(tx, () => tx`insert into storage.objects (bucket_id, name) values ('kb-media', ${`${other}/x/c.png`})`),
      ).toContain("row-level security");
      // Папка шаблонов — редакторам любой базы, читателю закрыта.
      await tx`insert into storage.objects (bucket_id, name) values ('kb-media', 'templates/t1/d.png')`;
      await as(tx, t.reader);
      expect(await tx`select 1 from storage.objects where name like 'templates/%'`).toHaveLength(0);
      expect(
        await failure(tx, () => tx`insert into storage.objects (bucket_id, name) values ('kb-media', 'templates/t1/e.png')`),
      ).toContain("row-level security");
      await asServer(tx);
    }));
});
