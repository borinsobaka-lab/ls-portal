/**
 * Тесты видеозвонков в чатах (db/migrations/2026-11-08_zzz_chat_calls.sql):
 * начать, звонит, принять / отклонить, сроки (пропущен, закрыл вкладку,
 * комната не создана), окончание, сообщение звонка в переписке, доступ,
 * уборка комнат.
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

type CallJson = {
  id: string;
  chat_id: string;
  ready: boolean;
  link: string | null;
  my_state: string | null;
  ended_at: string | null;
  end_reason: string | null;
  answered_at: string | null;
  members: { user_id: string; state: string }[];
};

describe.skipIf(!url)("видеозвонки в чатах (база)", () => {
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

  async function user(tx: Tx): Promise<string> {
    await tx`set local session_replication_role = replica`;
    const [{ id }] =
      await tx`insert into auth.users (email) values (${`u-${crypto.randomUUID()}@example.com`}) returning id`;
    await tx`set local session_replication_role = origin`;
    return id as string;
  }

  let studio: string | null = null;
  async function staff(tx: Tx, name: string): Promise<string> {
    if (!studio) {
      const [{ id }] = await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
      studio = id;
    }
    const id = await user(tx);
    await tx`insert into user_roles (user_id, studio_id, role) values (${id}, ${studio}, 'admin'::app_role)`;
    await tx`insert into profiles (id, studio_id, full_name, email) values (${id}, ${studio}, ${name}, 'x@example.com')
             on conflict (id) do update set full_name = excluded.full_name`;
    return id;
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

  async function three(tx: Tx) {
    studio = null;
    const a = await staff(tx, "Анна");
    const b = await staff(tx, "Борис");
    const c = await staff(tx, "Вера");
    return { a, b, c };
  }

  const LINK = "https://speak.kinescope.io/abc-defg-hij";

  /** a звонит в чат; сервер ставит комнату. */
  async function call(tx: Tx, caller: string, chat: string): Promise<CallJson> {
    await as(tx, caller);
    const [{ r }] = await tx`select chat_call_start(${chat}) as r`;
    expect(r.needs_room).toBe(true);
    await asServer(tx);
    await tx`select chat_call_set_room(${r.call.id}, 'room-1', ${LINK})`;
    await as(tx, caller);
    return r.call as CallJson;
  }

  const get = async (tx: Tx, id: string) =>
    ((await tx`select chat_call_get(${id}) as r`)[0].r as CallJson);
  const incoming = async (tx: Tx) =>
    ((await tx`select chat_call_incoming() as r`)[0].r as CallJson[]);
  const callMessage = async (tx: Tx, chat: string) => {
    const page = await tx`select * from chat_messages_page(${chat})`;
    return page
      .map((r: { chat_messages_page: { kind: string; content: { system?: Record<string, unknown> } } }) => r.chat_messages_page)
      .filter((m: { kind: string }) => m.kind === "system")
      .at(-1)?.content?.system as Record<string, unknown> | undefined;
  };

  /** Отодвинуть время звонка назад (сроки считаются от now()). */
  async function age(tx: Tx, id: string, seconds: number) {
    await asServer(tx);
    await tx`update chat_calls set created_at = created_at - make_interval(secs => ${seconds}),
               rang_at = rang_at - make_interval(secs => ${seconds}) where id = ${id}`;
    await tx`update chat_call_members set seen_at = seen_at - make_interval(secs => ${seconds}),
               joined_at = joined_at - make_interval(secs => ${seconds}) where call_id = ${id}`;
  }

  test("личный: звонит после комнаты, принял — идёт, положил трубку — окончен", async () => {
    await scenario(async (tx) => {
      const { a, b } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const [{ r: started }] = await tx`select chat_call_start(${chat}) as r`;
      expect(started.call.ready).toBe(false);
      // До комнаты — не звонит.
      await as(tx, b);
      expect(await incoming(tx)).toEqual([]);
      await asServer(tx);
      const [{ r: set }] = await tx`select chat_call_set_room(${started.call.id}, 'room-1', ${LINK}) as r`;
      expect(set.ready).toBe(true);
      // Пуш собеседнику — только пуш, без строки в ленте.
      const [n] = await tx`select kind, feed, url from notif_items where user_id = ${b}`;
      expect(n.kind).toBe("chat.call");
      expect(n.feed).toBe(false);
      expect(n.url).toBe(`/chats/${chat}?call=${started.call.id}`);
      // Событие звонка в личные темы.
      const events = await tx`select topic from realtime.messages where payload->>'type' = 'call'`;
      expect(events.map((e: { topic: string }) => e.topic)).toContain(`user:${b}`);

      await as(tx, b);
      const inc = await incoming(tx);
      expect(inc.map((x) => x.id)).toEqual([started.call.id]);
      expect(inc[0].link).toBe(LINK);
      expect(await callMessage(tx, chat)).toMatchObject({ type: "call", state: "live" });

      const [{ r: joined }] = await tx`select chat_call_join(${started.call.id}) as r`;
      expect(joined.link).toBe(LINK);
      expect(joined.call.answered_at).not.toBeNull();
      expect(await incoming(tx)).toEqual([]);

      // Повторное нажатие «Видеозвонок» — тот же звонок.
      await as(tx, a);
      const [{ r: again }] = await tx`select chat_call_start(${chat}) as r`;
      expect(again.needs_room).toBe(false);
      expect(again.call.id).toBe(started.call.id);

      const [{ r: left }] = await tx`select chat_call_leave(${started.call.id}) as r`;
      expect(left.end_reason).toBe("finished");
      expect(left.members.every((m: { state: string }) => m.state === "left")).toBe(true);
      expect(await callMessage(tx, chat)).toMatchObject({ state: "ended", reason: "finished" });
      // Новый звонок после оконченного — новый.
      const [{ r: next }] = await tx`select chat_call_start(${chat}) as r`;
      expect(next.call.id).not.toBe(started.call.id);
    });
  });

  test("личный: отклонил — окончен «отклонён», не ответил 45 с — «пропущен»", async () => {
    await scenario(async (tx) => {
      const { a, b } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const first = await call(tx, a, chat);
      await as(tx, b);
      const declined = (await tx`select chat_call_decline(${first.id}) as r`)[0].r as CallJson;
      expect(declined.end_reason).toBe("declined");
      expect(await callMessage(tx, chat)).toMatchObject({ reason: "declined" });

      const second = await call(tx, a, chat);
      await age(tx, second.id, 30);
      await as(tx, a);
      expect((await tx`select chat_call_ping(${second.id}) as r`)[0].r.ended_at).toBeNull();
      await age(tx, second.id, 20);
      await as(tx, b);
      expect(await incoming(tx)).toEqual([]);
      const missed = await get(tx, second.id);
      expect(missed.end_reason).toBe("missed");
      // Пропущенный — непрочитанное у собеседника.
      const [row] = (await tx`select * from chat_list()`).filter((r: { id: string }) => r.id === chat);
      expect(row.unread).toBeGreaterThan(0);
    });
  });

  test("позвонивший положил трубку до ответа — «отменён»; закрыл вкладку — вышел", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const one = await call(tx, a, chat);
      const left = (await tx`select chat_call_leave(${one.id}) as r`)[0].r as CallJson;
      expect(left.end_reason).toBe("cancelled");
      expect(left.members.find((m) => m.user_id === b)?.state).toBe("missed");

      // Группа: двое говорят, третий не ответил; один перестал отмечаться.
      const [{ id: group }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const g = await call(tx, a, group);
      await as(tx, b);
      await tx`select chat_call_join(${g.id})`;
      await age(tx, g.id, 50);
      await as(tx, b);
      // c не ответил (пропущен), a и b в звонке — идёт.
      const live = (await tx`select chat_call_ping(${g.id}) as r`)[0].r as CallJson;
      expect(live.ended_at).toBeNull();
      expect(live.members.find((m) => m.user_id === c)?.state).toBe("missed");
      await age(tx, g.id, 40);
      await as(tx, b);
      await tx`select chat_call_ping(${g.id})`;
      const after = await get(tx, g.id);
      // a молчал 90 с — вышел; b остался один в группе — звонок идёт.
      expect(after.members.find((m) => m.user_id === a)?.state).toBe("left");
      expect(after.ended_at).toBeNull();
      // c подключается к идущему звонку из плашки чата.
      await as(tx, c);
      const active = (await tx`select chat_call_active(${group}) as r`)[0].r as CallJson;
      expect(active.id).toBe(g.id);
      await tx`select chat_call_join(${g.id})`;
      await tx`select chat_call_leave(${g.id})`;
      await as(tx, b);
      const done = (await tx`select chat_call_leave(${g.id}) as r`)[0].r as CallJson;
      expect(done.end_reason).toBe("finished");
      await as(tx, c);
      expect((await tx`select chat_call_active(${group}) as r`)[0].r).toBeNull();
    });
  });

  test("группа: никто не взял — «пропущен»; комната не создана — «не состоялся»", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: group }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const g = await call(tx, a, group);
      await as(tx, b);
      await tx`select chat_call_decline(${g.id})`;
      await as(tx, a);
      expect((await get(tx, g.id)).ended_at).toBeNull();
      await as(tx, c);
      const done = (await tx`select chat_call_decline(${g.id}) as r`)[0].r as CallJson;
      expect(done.end_reason).toBe("missed");

      await as(tx, a);
      const [{ r }] = await tx`select chat_call_start(${group}) as r`;
      await age(tx, r.call.id, 61);
      await as(tx, a);
      expect((await get(tx, r.call.id)).end_reason).toBe("failed");
      // Комната пришла позже — в уборку.
      await asServer(tx);
      expect((await tx`select chat_call_set_room(${r.call.id}, 'room-late', ${LINK}) as r`)[0].r).toBeNull();
      const sweep = await tx`select * from chat_call_sweep()`;
      expect(sweep.map((s: { room_id: string }) => s.room_id)).toContain("room-late");
      await tx`select chat_call_room_deleted(${r.call.id})`;
      const again = await tx`select * from chat_call_sweep()`;
      expect(again.map((s: { room_id: string }) => s.room_id)).not.toContain("room-late");

      // Сбой создания комнаты.
      await as(tx, a);
      const [{ r: f }] = await tx`select chat_call_start(${group}) as r`;
      await asServer(tx);
      await tx`select chat_call_fail(${f.call.id}, 'kinescope 500')`;
      await as(tx, a);
      expect((await get(tx, f.call.id)).end_reason).toBe("failed");
    });
  });

  test("доступ: посторонний и «Избранное» — нет; серверные — не браузеру; таблицы закрыты", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const [{ id: self }] = await tx`select chat_open_self() as id`;
      expect(await failure(tx, () => tx`select chat_call_start(${self})`)).toContain("chat_call_self");
      const one = await call(tx, a, chat);
      await as(tx, c);
      expect(await failure(tx, () => tx`select chat_call_start(${chat})`)).toContain("chat_forbidden");
      expect(await failure(tx, () => tx`select chat_call_join(${one.id})`)).toContain("chat_forbidden");
      expect(await failure(tx, () => tx`select chat_call_get(${one.id})`)).toContain("chat_forbidden");
      expect(await incoming(tx)).toEqual([]);
      expect(await failure(tx, () => tx`select chat_call_set_room(${one.id}, 'x', ${LINK})`)).toContain(
        "permission denied",
      );
      expect(await failure(tx, () => tx`select * from chat_call_sweep()`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from chat_calls`)).toContain("permission denied");
      expect(await failure(tx, () => tx`select * from chat_call_members`)).toContain("permission denied");
      await asServer(tx);
      expect(
        await failure(tx, () => tx`select chat_call_set_room(${one.id}, 'x', 'javascript:alert(1)')`),
      ).toContain("chat_call_bad_room");
    });
  });
});
