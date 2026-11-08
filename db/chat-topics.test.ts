/**
 * Тесты тем в группах (db/migrations/2026-11-08_zzzzzzzzzzzzz_chat_topics.sql):
 * включение, кто заводит темы, участники тем = участники группы, своё
 * «прочитано», закрытая тема и «пишут только админы», уведомления с
 * тишиной группы, счётчики — группа с темами одним чатом, удаление.
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

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

type Row = {
  id: string;
  kind: string;
  title: string;
  parent_id: string | null;
  unread: number;
  my_role: string;
  settings: Record<string, unknown>;
};

describe.skipIf(!url)("темы в группах (база)", () => {
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
      const [{ id }] =
        await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
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
    const [{ m }] =
      await tx`select chat_send(${chat}, ${doc(text)}::jsonb, ${text}, null, '[]'::jsonb, null) as m`;
    return m as Msg;
  };
  const list = async (tx: Tx) => (await tx`select * from chat_list()`) as Row[];
  const people = async (tx: Tx) => {
    studio = null;
    const a = await staff(tx, "Анна Владелец");
    const b = await staff(tx, "Борис Участник");
    const c = await staff(tx, "Вера Новенькая");
    const d = await staff(tx, "Глеб Посторонний");
    return { a, b, c, d };
  };
  const group = async (tx: Tx, owner: string, members: string[]) => {
    await as(tx, owner);
    const [{ id }] = await tx`select chat_create_group('Казань', ${members}::uuid[]) as id`;
    return id as string;
  };

  test("включить темы, завести тему, участники и роли — как в группе", async () => {
    await scenario(async (tx) => {
      const { a, b, c, d } = await people(tx);
      const g = await group(tx, a, [b]);
      // Пока темы выключены — темы не завести.
      expect(await failure(tx, () => tx`select chat_topic_create(${g}, 'Отчёты')`)).toContain(
        "chat_topics_off",
      );
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_topics_enable(${g}, true)`)).toContain(
        "chat_admin_only",
      );
      await as(tx, a);
      await tx`select chat_topics_enable(${g}, true)`;
      // По умолчанию темы заводят админы.
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_topic_create(${g}, 'Мемы')`)).toContain(
        "chat_admin_only",
      );
      await as(tx, a);
      const [{ id: t1 }] = await tx`select chat_topic_create(${g}, 'Отчёты', 'green') as id`;
      await tx`select chat_topics_enable(${g}, true, 'all')`;
      await as(tx, b);
      const [{ id: t2 }] = await tx`select chat_topic_create(${g}, 'Вопросы по 1С') as id`;

      // Участник группы видит обе темы в списке, у темы — parent_id.
      const rows = await list(tx);
      expect(
        rows
          .filter((r) => r.parent_id === g)
          .map((r) => r.title)
          .sort(),
      ).toEqual(["Вопросы по 1С", "Отчёты"]);
      expect(rows.find((r) => r.id === t1)).toMatchObject({ kind: "topic", my_role: "member" });

      // Новый участник группы — сразу во всех темах; сменили роль — и в темах.
      await as(tx, a);
      await tx`select chat_members_add(${g}, ${[c]}::uuid[])`;
      await tx`select chat_member_set_role(${g}, ${c}, 'admin')`;
      await as(tx, c);
      const forC = (await list(tx)).filter((r) => r.parent_id === g);
      expect(forC.map((r) => r.my_role)).toEqual(["admin", "admin"]);
      // Посторонний тем не видит и не пишет в них.
      await as(tx, d);
      expect((await list(tx)).some((r) => r.parent_id === g)).toBe(false);
      expect(await failure(tx, () => send(tx, t1 as string, "привет"))).toContain("chat_");
      // Вышел из группы — ушёл и из тем.
      await as(tx, b);
      await tx`select chat_member_remove(${g}, ${b})`;
      expect((await list(tx)).some((r) => r.id === t1 || r.id === t2 || r.id === g)).toBe(false);
      // Темы есть — выключить нельзя.
      await as(tx, a);
      expect(await failure(tx, () => tx`select chat_topics_enable(${g}, false)`)).toContain(
        "chat_topics_exist",
      );
      // В канале тем не бывает.
      void t2;
    });
  });

  test("своё «прочитано», закрытая тема, «пишут только админы», счётчики", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      const g = await group(tx, a, [b]);
      await tx`select chat_topics_enable(${g}, true)`;
      const [{ id: t }] = await tx`select chat_topic_create(${g}, 'Акции', 'pink') as id`;
      await as(tx, b);
      // Всё прежнее (системные строки группы и темы) — прочитано.
      await asServer(tx);
      await tx`update chat_members cm set last_read_seq = c.last_seq from chat_chats c
               where c.id = cm.chat_id and cm.chat_id in (${g}, ${t})`;
      await as(tx, a);
      await send(tx, t as string, "Акция к Чёрной пятнице");
      await send(tx, t as string, "Макеты в папке");
      await as(tx, b);
      const rows = await list(tx);
      expect(rows.find((r) => r.id === t)?.unread).toBe(2);
      expect(rows.find((r) => r.id === g)?.unread).toBe(0);
      // Группа с темами — один чат в счётчике.
      const [{ s }] = await tx`select chat_unread_summary() as s`;
      expect(s).toEqual({ chats: 1, muted: 0 });
      await asServer(tx);
      const [{ n }] = await tx`select portal_badge_count(${b}) as n`;
      expect(n).toBe(1);
      // Тишина группы — тишина её тем.
      await as(tx, b);
      await tx`select chat_set_notify(${g}, 'none')`;
      const [{ s: s2 }] = await tx`select chat_unread_summary() as s`;
      expect(s2).toEqual({ chats: 0, muted: 1 });

      // Закрытая тема: пишут только админы; закрыть может автор или админ.
      expect(
        await failure(tx, () => tx`select chat_topic_update(${t}, '{"closed": true}'::jsonb)`),
      ).toContain("chat_forbidden");
      await as(tx, a);
      await tx`select chat_topic_update(${t}, '{"closed": true, "title": "Акции ноября"}'::jsonb)`;
      await as(tx, b);
      expect(await failure(tx, () => send(tx, t as string, "А можно?"))).toContain(
        "chat_topic_closed",
      );
      await as(tx, a);
      await send(tx, t as string, "Тема закрыта, итоги в «Общей»");
      await tx`select chat_topic_update(${t}, '{"closed": false}'::jsonb)`;
      // «Пишут только админы» в группе действует и в темах.
      await tx`select chat_update(${g}, '{"settings": {"post": "admins"}}'::jsonb)`;
      await as(tx, b);
      expect(await failure(tx, () => send(tx, t as string, "Вопрос"))).toContain(
        "chat_post_admins_only",
      );
      const [{ title }] = await tx`select title from chat_list() where id = ${t}`;
      expect(title).toBe("Акции ноября");
    });
  });

  test("уведомления: «Группа › Тема», тишина группы, удаление темы и группы", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      const g = await group(tx, a, [b]);
      await tx`select chat_topics_enable(${g}, true)`;
      const [{ id: t }] = await tx`select chat_topic_create(${g}, 'Отчёты') as id`;
      const mention = async (text: string) => {
        const content = {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: b, label: "Борис" } },
                { type: "text", text: " " + text },
              ],
            },
          ],
        };
        await tx`select chat_send(${t}, ${content}::jsonb, ${"@Борис " + text}, null, '[]'::jsonb, null)`;
      };
      await mention("отчёт за неделю готов");
      await asServer(tx);
      const [n1] =
        await tx`select title, body from notif_items where user_id = ${b} and kind = 'chat.mention'`;
      expect(n1).toMatchObject({ title: "Упоминание от Анна Владелец" });
      expect(n1.body).toStartWith("«Казань › Отчёты»: ");
      // Уведомления группы выключены — тема молчит и с упоминанием.
      await tx`delete from notif_items where user_id = ${b}`;
      await tx`update chat_members set notify = 'none' where chat_id = ${g} and user_id = ${b}`;
      await as(tx, a);
      await mention("ещё отчёт");
      await asServer(tx);
      const [{ cnt }] = await tx`select count(*)::int as cnt from notif_items where user_id = ${b}`;
      expect(cnt).toBe(0);

      // Удалить тему — её автор или админы; удалить группу — с темами.
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_topic_delete(${t})`)).toContain(
        "chat_forbidden",
      );
      await as(tx, a);
      const [{ id: t2 }] = await tx`select chat_topic_create(${g}, 'Лишняя') as id`;
      await tx`select chat_topic_delete(${t2})`;
      await tx`select chat_delete_group(${g})`;
      await asServer(tx);
      const [{ left }] =
        await tx`select count(*)::int as left from chat_chats where id = ${g} or parent_id = ${g}`;
      expect(left).toBe(0);
    });
  });
});
