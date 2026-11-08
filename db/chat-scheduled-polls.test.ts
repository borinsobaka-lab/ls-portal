/**
 * Тесты отложенных сообщений и опросов
 * (db/migrations/2026-11-08_zzzzzz_chat_scheduled_polls.sql): отправка
 * сервером от имени автора, «отправить сейчас», сбой с причиной и
 * уведомлением, права; опрос — голоса, один или несколько ответов,
 * анонимный, закрытие.
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

type Poll = {
  question: string;
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  voters: number;
  options: { id: string; text: string; count: number; mine: boolean; users: string[] | null }[];
};
type Msg = { id: string; seq: number; author_id: string; text: string; poll: Poll | null };

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe.skipIf(!url)("отложенные сообщения и опросы (база)", () => {
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



  const page = async (tx: Tx, chat: string) =>
    ((await tx`select * from chat_messages_page(${chat})`) as Record<string, unknown>[]).map(
      (r) => Object.values(r)[0] as Msg & { kind: string },
    );
  const people = async (tx: Tx) => {
    studio = null;
    const a = await staff(tx, "Анна");
    const b = await staff(tx, "Борис");
    const c = await staff(tx, "Вера");
    return { a, b, c };
  };
  const schedule = async (tx: Tx, chat: string, text: string, at: string) => {
    const [{ s }] = await tx`select chat_schedule(${chat}, ${doc(text)}::jsonb, ${text}, ${at}::timestamptz) as s`;
    return s as { id: string; status: string };
  };

  test("отложенное: уходит в срок от имени автора, видит только автор", async () => {
    await scenario(async (tx) => {
      const { a, b } = await people(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      expect(
        await failure(tx, () => schedule(tx, chat, "рано", new Date(Date.now() + 5_000).toISOString())),
      ).toContain("chat_schedule_time_invalid");
      const s = await schedule(tx, chat, "Доброе утро! Не забудьте отчёт", new Date(Date.now() + 3600_000).toISOString());
      const s2 = await schedule(tx, chat, "Второе", new Date(Date.now() + 7200_000).toISOString());
      const [{ l }] = await tx`select chat_scheduled_list(${chat}) as l`;
      expect((l as { id: string }[]).map((x) => x.id)).toEqual([s.id, s2.id]);
      // Собеседник чужих отложенных не видит и не трогает.
      await as(tx, b);
      const [{ l: lb }] = await tx`select chat_scheduled_list(${chat}) as l`;
      expect(lb).toEqual([]);
      await tx`select chat_scheduled_delete(${s.id})`;
      // Время пришло — сервер отправляет.
      await asServer(tx);
      await tx`update chat_scheduled set send_at = now() - interval '1 minute' where id = ${s.id}`;
      const [{ n }] = await tx`select chat_scheduled_tick() as n`;
      expect(n).toBe(1);
      await as(tx, b);
      const msgs = await page(tx, chat);
      const last = msgs.at(-1)!;
      expect(last.text).toBe("Доброе утро! Не забудьте отчёт");
      expect(last.author_id).toBe(a);
      // «Отправить сейчас» — своё.
      await as(tx, a);
      await tx`select chat_scheduled_send_now(${s2.id})`;
      expect((await page(tx, chat)).at(-1)!.text).toBe("Второе");
      const [{ l: rest }] = await tx`select chat_scheduled_list(${chat}) as l`;
      expect(rest).toEqual([]);
    });
  });

  test("отложенное в группе, откуда автор ушёл, — не отправлено, автору уведомление", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      await as(tx, b);
      const s = await schedule(tx, chat, "Напомню завтра", new Date(Date.now() + 3600_000).toISOString());
      await tx`select chat_member_remove(${chat}, ${b})`;
      await asServer(tx);
      await tx`update chat_scheduled set send_at = now() - interval '1 minute' where id = ${s.id}`;
      const [{ n }] = await tx`select chat_scheduled_tick() as n`;
      expect(n).toBe(0);
      const [row] = await tx`select status, error from chat_scheduled where id = ${s.id}`;
      expect(row.status).toBe("failed");
      expect(row.error).toContain("chat_forbidden");
      const notes = await tx`select kind from notif_items where user_id = ${b} and kind = 'chat.scheduled'`;
      expect(notes).toHaveLength(1);
      // Повторный проход упавшее не трогает.
      const [{ n: again }] = await tx`select chat_scheduled_tick() as n`;
      expect(again).toBe(0);
    });
  });

  test("опрос: один ответ, переголосовать, несколько, анонимный, закрыть", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await people(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      expect(
        await failure(tx, () => tx`select chat_poll_create(${chat}, 'Когда?', '["Пн"]'::jsonb)`),
      ).toContain("chat_poll_invalid");
      const [{ m }] = await tx`select chat_poll_create(${chat}, 'Когда планёрка?', '["Пн 10:00", "Вт 11:00", "Ср 12:00"]'::jsonb) as m`;
      const poll = m as Msg;
      expect(poll.text).toBe("Опрос: Когда планёрка?");
      expect(poll.poll?.options.map((o) => o.text)).toEqual(["Пн 10:00", "Вт 11:00", "Ср 12:00"]);

      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_poll_vote(${poll.id}, '{1,2}')`)).toContain(
        "chat_poll_invalid",
      );
      await tx`select chat_poll_vote(${poll.id}, '{1}')`;
      const [{ r }] = await tx`select chat_poll_vote(${poll.id}, '{2}') as r`;
      const pb = (r as Msg).poll!;
      expect(pb.options.map((o) => o.count)).toEqual([0, 1, 0]);
      expect(pb.options[1]).toMatchObject({ mine: true, users: [b] });
      await as(tx, c);
      await tx`select chat_poll_vote(${poll.id}, '{2}')`;
      // Закрыть может автор или админ, участник — нет.
      expect(await failure(tx, () => tx`select chat_poll_close(${poll.id})`)).toContain("chat_admin_only");
      await as(tx, a);
      const [{ r: closed }] = await tx`select chat_poll_close(${poll.id}) as r`;
      expect((closed as Msg).poll).toMatchObject({ closed: true, voters: 2 });
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_poll_vote(${poll.id}, '{1}')`)).toContain("chat_poll_closed");

      // Анонимный с несколькими ответами: имён нет.
      await as(tx, a);
      const [{ m: m2 }] = await tx`select chat_poll_create(${chat}, 'Что улучшить?', '["Кофе", "Свет", "Стулья"]'::jsonb, true, true) as m`;
      await as(tx, b);
      const [{ r: r2 }] = await tx`select chat_poll_vote(${(m2 as Msg).id}, '{1,3}') as r`;
      const p2 = (r2 as Msg).poll!;
      expect(p2.options.map((o) => o.count)).toEqual([1, 0, 1]);
      expect(p2.options[0].users).toBeNull();
    });
  });
});
