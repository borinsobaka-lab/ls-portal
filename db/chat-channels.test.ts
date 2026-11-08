/**
 * Тесты каналов и чатов с составом из оргструктуры
 * (db/migrations/2026-11-08_zzzzz_chat_channels.sql): канал пишут админы,
 * «Прочитал» и напоминание, состав из подразделения и всей компании,
 * автосостав не убрать вручную, права на источники.
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

type Msg = {
  id: string;
  seq: number;
  kind: string;
  ack: { count: number; total: number; mine: boolean } | null;
};

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe.skipIf(!url)("каналы и чаты подразделений (база)", () => {
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



  const send = async (tx: Tx, chat: string, text: string) => {
    const [{ m }] = await tx`select chat_send(${chat}, ${doc(text)}::jsonb, ${text}, null, '[]'::jsonb, null) as m`;
    return m as Msg;
  };
  const members = async (tx: Tx, chat: string) =>
    (await tx`select user_id, role, source from chat_members_list(${chat})`) as {
      user_id: string;
      role: string;
      source: string;
    }[];
  const createEx = async (tx: Tx, p: Record<string, unknown>) => {
    const [{ id }] = await tx`select chat_create_ex(${p}::jsonb) as id`;
    return id as string;
  };
  const announce = async (tx: Tx, user: string) => {
    await asServer(tx);
    await tx`insert into access_user_rights (user_id, portal, rights) values (${user}, true, '{chats.announce}')
             on conflict (user_id) do update set rights = excluded.rights, portal = true`;
  };
  const people = async (tx: Tx) => {
    studio = null;
    const a = await staff(tx, "Анна Руководитель");
    const b = await staff(tx, "Борис Сотрудник");
    const c = await staff(tx, "Вера Казань");
    const d = await staff(tx, "Глеб Посторонний");
    return { a, b, c, d };
  };

  test("канал: пишут админы, «Прочитал», кто отметил, напоминание", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      // Без права канал не создать.
      await as(tx, d);
      expect(await failure(tx, () => createEx(tx, { title: "Новости", channel: true }))).toContain(
        "chat_sources_forbidden",
      );
      await announce(tx, a);
      await as(tx, a);
      const ch = await createEx(tx, { title: "Новости компании", channel: true, members: [b, c] });
      // Админ не может разрешить писать всем — канал остаётся каналом.
      await tx`select chat_update(${ch}, '{"settings": {"post": "all"}}'::jsonb)`;
      const [{ settings }] = await tx`select settings from chat_list() where id = ${ch}`;
      expect(settings).toMatchObject({ channel: true, post: "admins" });
      const post = await send(tx, ch, "С понедельника новые цены");
      expect(post.ack).toEqual({ count: 0, total: 2, mine: false });

      await as(tx, b);
      expect(await failure(tx, () => send(tx, ch, "А можно вопрос?"))).toContain("chat_post_admins_only");
      const [{ r }] = await tx`select chat_ack(${post.id}) as r`;
      expect((r as Msg).ack).toEqual({ count: 1, total: 2, mine: true });
      // Участник не видит, кто отметил.
      expect(await failure(tx, () => tx`select chat_ack_list(${post.id})`)).toContain("chat_admin_only");

      await as(tx, a);
      const [{ l }] = await tx`select chat_ack_list(${post.id}) as l`;
      const list = l as { acked: { user_id: string }[]; pending: string[] };
      expect(list.acked.map((x) => x.user_id)).toEqual([b]);
      expect(list.pending).toEqual([c]);
      const [{ n }] = await tx`select chat_ack_remind(${post.id}) as n`;
      expect(n).toBe(1);
      expect(await failure(tx, () => tx`select chat_ack_remind(${post.id})`)).toContain("chat_ack_remind_soon");
      await asServer(tx);
      const notes = await tx`select user_id, kind from notif_items where kind in ('chat.ack', 'chat.channel')`;
      expect(notes.filter((x: { kind: string }) => x.kind === "chat.ack").map((x: { user_id: string }) => x.user_id)).toEqual([c]);
      expect(notes.filter((x: { kind: string }) => x.kind === "chat.channel")).toHaveLength(2);
    });
  });

  test("состав из подразделения: сам меняется, вручную не убрать", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      await asServer(tx);
      const [{ id: unit }] = await tx`insert into org_units (name) values ('Отдел развития') returning id`;
      const [{ id: sub }] = await tx`insert into org_units (name, parent_id) values ('Казань', ${unit}) returning id`;
      for (const u of [a, b, c, d]) await tx`insert into portal_users (user_id) values (${u}) on conflict do nothing`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${a}, 'head')`;
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${unit}, ${b}, 'member')`;

      // Посторонний не привяжет чужое подразделение.
      await as(tx, d);
      expect(
        await failure(tx, () => createEx(tx, { title: "x", sources: [{ kind: "unit", unit_id: unit }] })),
      ).toContain("chat_sources_forbidden");
      expect(await failure(tx, () => createEx(tx, { title: "x", sources: [{ kind: "all" }] }))).toContain(
        "chat_sources_forbidden",
      );

      // Руководитель — чат своего отдела с подразделениями ниже.
      await as(tx, a);
      const [{ o }] = await tx`select chat_source_options() as o`;
      expect((o as { announce: boolean; units: string[] }).units.sort()).toEqual([unit, sub].sort());
      const chat = await createEx(tx, {
        title: "Отдел развития",
        sources: [{ kind: "unit", unit_id: unit, scope: "all", with_subunits: true }],
        members: [d],
      });
      let ms = await members(tx, chat);
      expect(ms.find((m) => m.user_id === a)?.role).toBe("owner");
      expect(ms.find((m) => m.user_id === b)?.source).toBe("auto");
      expect(ms.find((m) => m.user_id === d)?.source).toBe("manual");

      // Новый сотрудник подразделения ниже — в чате сам; ушедший — уходит.
      await asServer(tx);
      await tx`insert into org_unit_members (unit_id, user_id, member_role) values (${sub}, ${c}, 'member')`;
      await tx`delete from org_unit_members where unit_id = ${unit} and user_id = ${b}`;
      await as(tx, a);
      ms = await members(tx, chat);
      expect(ms.map((m) => m.user_id).sort()).toEqual([a, c, d].sort());

      // Участника из подразделения не убрать и сам он не выйдет.
      expect(await failure(tx, () => tx`select chat_member_remove(${chat}, ${c})`)).toContain("chat_auto_member");
      await as(tx, c);
      expect(await failure(tx, () => tx`select chat_member_remove(${chat}, ${c})`)).toContain("chat_auto_member");
      // Добавленный вручную выходит как обычно.
      await as(tx, d);
      await tx`select chat_member_remove(${chat}, ${d})`;

      // Источник убрали — автосостав уходит, чат остаётся.
      await as(tx, a);
      await tx`select chat_sources_save(${chat}, '[]'::jsonb)`;
      ms = await members(tx, chat);
      expect(ms.map((m) => m.user_id)).toEqual([a]);
      const [{ s }] = await tx`select chat_sources_get(${chat}) as s`;
      expect((s as { sources: unknown[] }).sources).toEqual([]);
    });
  });

  test("вся компания: все люди портала, новые — сами", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await announce(tx, a);
      await as(tx, a);
      const ch = await createEx(tx, { title: "Lady Stretch — все", channel: true, sources: [{ kind: "all" }] });
      const ms = await members(tx, ch);
      for (const u of [b, c]) expect(ms.find((m) => m.user_id === u)?.source).toBe("auto");
      // Новый человек портала — сразу в канале.
      await asServer(tx);
      const e = await staff(tx, "Ева Новенькая");
      await as(tx, a);
      expect((await members(tx, ch)).some((m) => m.user_id === e)).toBe(true);
      const [{ settings }] = await tx`select settings from chat_list() where id = ${ch}`;
      expect(settings).toMatchObject({ auto: true, channel: true });
    });
  });
});
