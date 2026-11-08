/**
 * Тесты чатов портала (db/migrations/2026-11-08_chats.sql): личные чаты и
 * «Избранное», группы и права, отправка, упоминания и уведомления,
 * прочтение, правка и удаление, реакции, закрепы, пересылка и файлы, поиск,
 * папки, события Realtime.
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

const KEY_P256 = "B" + "A".repeat(86);
const KEY_AUTH = "A".repeat(22);

const doc = (text: string, mentions: string[] = []) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text },
        ...mentions.map((id) => ({ type: "mention", attrs: { id, label: "x" } })),
      ],
    },
  ],
});

describe.skipIf(!url)("чаты (база)", () => {
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

  const send = async (tx: Tx, chat: string, text: string, extra: { mentions?: string[]; reply?: number; client?: string } = {}) => {
    const [{ m }] = await tx`select chat_send(${chat}, ${doc(text, extra.mentions)}::jsonb, ${text},
      ${extra.reply ?? null}, '[]'::jsonb, ${extra.client ?? null}) as m`;
    return m as { id: string; seq: number; mentions: string[]; mention_all: boolean };
  };

  const listOf = async (tx: Tx, chat: string) =>
    (await tx`select * from chat_list()`).find((r: { id: string }) => r.id === chat);

  test("личный чат: один на пару, «Избранное», посторонний — нет", async () => {
    await scenario(async (tx) => {
      const { a, b } = await three(tx);
      await as(tx, a);
      const [{ id: d1 }] = await tx`select chat_open_direct(${b}) as id`;
      await as(tx, b);
      const [{ id: d2 }] = await tx`select chat_open_direct(${a}) as id`;
      expect(d2).toBe(d1);
      const row = await listOf(tx, d1);
      expect(row.kind).toBe("direct");
      expect(row.peer_id).toBe(a);
      const [{ id: self }] = await tx`select chat_open_self() as id`;
      const [{ id: self2 }] = await tx`select chat_open_direct(${b}) as id`;
      expect(self2).toBe(self);
      expect((await listOf(tx, self)).kind).toBe("self");

      await asServer(tx);
      const stranger = await user(tx);
      await as(tx, a);
      expect(await failure(tx, () => tx`select chat_open_direct(${stranger})`)).toContain(
        "chat_user_unknown",
      );
      await as(tx, stranger);
      expect(await failure(tx, () => tx`select * from chat_list()`)).toContain("forbidden");
      expect(await failure(tx, () => tx`select * from chat_messages_page(${d1})`)).toContain(
        "chat_forbidden",
      );
    });
  });

  test("отправка: номера, повтор без дубля, непрочитанные, превью, чужому — нет", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      const m1 = await send(tx, chat, "Привет", { client: crypto.randomUUID() });
      const client = crypto.randomUUID();
      const m2 = await send(tx, chat, "Как дела?", { client });
      const again = await send(tx, chat, "Как дела?", { client });
      expect([m1.seq, m2.seq, again.seq]).toEqual([1, 2, 2]);
      expect(again.id).toBe(m2.id);
      expect(await failure(tx, () => send(tx, chat, "   "))).toContain("chat_message_empty");

      const mine = await listOf(tx, chat);
      expect(mine.unread).toBe(0);
      expect(mine.last_message.text).toBe("Как дела?");
      await as(tx, b);
      const theirs = await listOf(tx, chat);
      expect(theirs.unread).toBe(2);
      const page = await tx`select * from chat_messages_page(${chat})`;
      expect(page.map((r: { chat_messages_page: { seq: number } }) => r.chat_messages_page.seq)).toEqual([1, 2]);

      await as(tx, c);
      expect(await failure(tx, () => send(tx, chat, "Я тоже"))).toContain("chat_forbidden");
    });
  });

  test("прочтение: счётчик, «кто прочитал», уведомления чата прочитаны", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const m = await send(tx, chat, "Планёрка в 10", { mentions: [b] });
      await as(tx, b);
      expect((await listOf(tx, chat)).mentions).toBe(1);
      expect((await tx`select notif_unread_count() as n`)[0].n).toBe(1);
      const [{ chat_mark_read: seq }] = await tx`select chat_mark_read(${chat}, null)`;
      expect(Number(seq)).toBe(m.seq);
      expect((await listOf(tx, chat)).unread).toBe(0);
      expect((await tx`select notif_unread_count() as n`)[0].n).toBe(0);
      await as(tx, a);
      const [{ chat_read_receipts: r }] = await tx`select chat_read_receipts(${m.id})`;
      expect(r.read).toEqual([b]);
      expect(Number(r.total)).toBe(2);
    });
  });

  test("упоминания: только участники, «@все» — админам; ответ — тоже упоминание", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await asServer(tx);
      const outsider = await staff(tx, "Гость");
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const m = await send(tx, chat, "Смотрите", { mentions: [b, outsider] });
      expect(m.mentions).toEqual([b]);

      await as(tx, b);
      const all = await send(tx, chat, "Все сюда", { mentions: ["all"] });
      expect(all.mention_all).toBe(false);
      const reply = await send(tx, chat, "Отвечаю", { reply: m.seq });
      await as(tx, a);
      const feed = await tx`select * from notif_list()`;
      expect(feed.some((n: { title: string }) => n.title === "Ответ от Борис")).toBe(true);
      expect(reply.seq).toBe(4);

      await as(tx, a);
      const all2 = await send(tx, chat, "Все сюда", { mentions: ["all"] });
      expect(all2.mention_all).toBe(true);
      // У Веры — только «@все» от админа (от Бориса «@все» не считается).
      await as(tx, c);
      expect((await listOf(tx, chat)).mentions).toBe(1);
    });
  });

  test("пуши: личное — пушем без строки в ленте; группа — без пуша по умолчанию; без звука", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, b);
      await tx`select portal_push_register(${`https://fcm.googleapis.com/fcm/send/${b}`}, ${KEY_P256}, ${KEY_AUTH})`;
      await as(tx, a);
      const [{ id: dm }] = await tx`select chat_open_direct(${b}) as id`;
      await send(tx, dm, "Привет");
      await send(tx, dm, "Ты тут?");
      await asServer(tx);
      const rows = await tx`select kind, feed, count, group_key from notif_items where user_id = ${b}`;
      expect(rows).toEqual([{ kind: "chat.direct", feed: false, count: 2, group_key: `chat:${dm}` }]);
      expect(Number((await tx`select count(*) as n from portal_push_deliveries where user_id = ${b}`)[0].n)).toBe(2);
      await as(tx, b);
      expect((await tx`select notif_unread_count() as n`)[0].n).toBe(0);

      // Группа: пуш выключен по умолчанию — строки нет.
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      await send(tx, g, "Новости");
      await asServer(tx);
      expect(Number((await tx`select count(*) as n from notif_items where user_id = ${b} and kind = 'chat.group'`)[0].n)).toBe(0);

      // Без звука: личное — нет, упоминание — да.
      await as(tx, b);
      await tx`select chat_set_notify(${dm}, 'mentions', null)`;
      await as(tx, a);
      await send(tx, dm, "Ещё");
      await asServer(tx);
      expect(Number((await tx`select count(*) as n from portal_push_deliveries where user_id = ${b}`)[0].n)).toBe(2);
      await as(tx, a);
      await send(tx, g, "Борис, глянь", { mentions: [b] });
      await asServer(tx);
      expect(Number((await tx`select count(*) as n from portal_push_deliveries where user_id = ${b}`)[0].n)).toBe(3);
    });
  });

  test("правка и удаление: своё; админ группы — чужое; в личном — только своё", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      await as(tx, b);
      const m = await send(tx, g, "Опечтка");
      const [{ m: edited }] = await tx`select chat_edit(${m.id}, ${doc("Опечатка")}::jsonb, 'Опечатка') as m`;
      expect(edited.text).toBe("Опечатка");
      expect(edited.edited_at).not.toBeNull();
      await as(tx, c);
      expect(await failure(tx, () => tx`select chat_edit(${m.id}, ${doc("x")}::jsonb, 'x')`)).toContain(
        "chat_edit_forbidden",
      );
      expect(await failure(tx, () => tx`select chat_delete_message(${m.id})`)).toContain(
        "chat_delete_forbidden",
      );
      await as(tx, a);
      await tx`select chat_delete_message(${m.id})`;
      const [{ chat_messages_page: row }] = await tx`select * from chat_messages_page(${g}, null, ${m.seq - 1})`;
      expect(row.deleted).toBe(true);
      expect(row.text).toBe("");
      expect((await listOf(tx, g)).last_message.deleted).toBe(true);

      const [{ id: dm }] = await tx`select chat_open_direct(${b}) as id`;
      await as(tx, b);
      const dmMsg = await send(tx, dm, "Моё");
      await as(tx, a);
      expect(await failure(tx, () => tx`select chat_delete_message(${dmMsg.id})`)).toContain(
        "chat_delete_forbidden",
      );
    });
  });

  test("реакции и закрепы (в группе — админы)", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const m = await send(tx, g, "Важное");
      await as(tx, b);
      await tx`select chat_react(${m.id}, '👍', true)`;
      await as(tx, c);
      const [{ m: r }] = await tx`select chat_react(${m.id}, '👍', true) as m`;
      expect(r.reactions).toEqual([{ emoji: "👍", count: 2, mine: true, users: [b, c] }]);
      await tx`select chat_react(${m.id}, '👍', false)`;
      expect(await failure(tx, () => tx`select chat_pin(${m.id}, true)`)).toContain("chat_admin_only");
      await as(tx, a);
      await tx`select chat_pin(${m.id}, true)`;
      const pins = await tx`select * from chat_pinned(${g})`;
      expect(pins.length).toBe(1);
      await tx`select chat_update(${g}, ${{ settings: { pin: "all" } }}::jsonb)`;
      await as(tx, c);
      await tx`select chat_pin(${m.id}, false)`;
      expect((await tx`select * from chat_pinned(${g})`).length).toBe(0);
    });
  });

  test("группа: участники, права, «пишут админы», выход владельца, последний — удаление", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await asServer(tx);
      const d = await staff(tx, "Дина");
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b]}::uuid[]) as id`;
      await as(tx, b);
      expect(await failure(tx, () => tx`select chat_members_add(${g}, ${[c]}::uuid[])`)).toContain(
        "chat_admin_only",
      );
      await as(tx, a);
      expect((await tx`select chat_members_add(${g}, ${[c, d]}::uuid[]) as n`)[0].n).toBe(2);
      // Новичку история видна, непрочитанное — только «добавлены в группу».
      await as(tx, c);
      expect((await listOf(tx, g)).unread).toBe(1);
      expect((await tx`select * from chat_messages_page(${g})`).length).toBeGreaterThan(0);

      await as(tx, a);
      await tx`select chat_update(${g}, ${{ settings: { post: "admins" } }}::jsonb)`;
      await as(tx, b);
      expect(await failure(tx, () => send(tx, g, "Можно?"))).toContain("chat_post_admins_only");
      await as(tx, a);
      await tx`select chat_member_set_role(${g}, ${b}, 'admin')`;
      await as(tx, b);
      await send(tx, g, "Теперь можно");
      expect(await failure(tx, () => tx`select chat_member_remove(${g}, ${a})`)).toContain(
        "chat_admin_only",
      );
      await tx`select chat_member_remove(${g}, ${d})`;

      await as(tx, a);
      await tx`select chat_member_remove(${g}, ${a})`;
      await as(tx, b);
      const members = await tx`select * from chat_members_list(${g})`;
      expect(members.find((m: { user_id: string }) => m.user_id === b).role).toBe("owner");
      await tx`select chat_member_remove(${g}, ${b})`;
      await as(tx, c);
      await tx`select chat_member_remove(${g}, ${c})`;
      await asServer(tx);
      expect((await tx`select * from chat_chats where id = ${g}`).length).toBe(0);
    });
  });

  test("пересылка: копия с пометкой, файл виден получателю", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: ab }] = await tx`select chat_open_direct(${b}) as id`;
      const [{ id: ac }] = await tx`select chat_open_direct(${c}) as id`;
      const path = `${ab}/${crypto.randomUUID()}/plan.pdf`;
      const [{ m }] = await tx`select chat_send(${ab}, null, '', null,
        ${[{ path, name: "plan.pdf", mime: "application/pdf", size: 1000 }]}::jsonb) as m`;
      expect(
        await failure(
          tx,
          () => tx`select chat_send(${ab}, null, '', null, ${[{ path: `${ac}/x/evil.pdf`, name: "e" }]}::jsonb)`,
        ),
      ).toContain("chat_file_invalid");

      await as(tx, c);
      expect((await tx`select chat_file_allowed(${path}) as ok`)[0].ok).toBe(false);
      await as(tx, a);
      expect((await tx`select chat_forward(${[m.id]}::uuid[], ${[ac]}::uuid[]) as n`)[0].n).toBe(1);
      await as(tx, c);
      expect((await tx`select chat_file_allowed(${path}) as ok`)[0].ok).toBe(true);
      expect((await tx`select chat_file_allowed(${path}, true) as ok`)[0].ok).toBe(false);
      const [{ chat_messages_page: fwd }] = await tx`select * from chat_messages_page(${ac})`;
      expect(fwd.forward.chat_id).toBe(ab);
      expect(fwd.attachments[0].name).toBe("plan.pdf");
      const files = await tx`select * from chat_files(${ac}, 'files')`;
      expect(files.length).toBe(1);
    });
  });

  test("поиск по словам во всех своих чатах, ссылки", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: ab }] = await tx`select chat_open_direct(${b}) as id`;
      await send(tx, ab, "Отправила отчёты по рекламе https://example.com/report");
      const [{ id: ac }] = await tx`select chat_open_direct(${c}) as id`;
      await as(tx, c);
      await send(tx, ac, "Реклама в Казани");
      await as(tx, b);
      const hits = await tx`select * from chat_search('отчет реклам')`;
      expect(hits.length).toBe(1);
      expect(hits[0].chat_id).toBe(ab);
      expect(hits[0].snippet).toContain("⟦");
      expect((await tx`select * from chat_search('Казани')`).length).toBe(0);
      const links = await tx`select * from chat_links(${ab})`;
      expect(links[0].url).toBe("https://example.com/report");
    });
  });

  test("папки: свои, только свои чаты; «Прочитать всё»", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: ab }] = await tx`select chat_open_direct(${b}) as id`;
      await send(tx, ab, "1");
      await as(tx, c);
      const [{ id: cb }] = await tx`select chat_open_direct(${b}) as id`;
      await send(tx, cb, "2");
      await as(tx, b);
      const [{ id: folder }] = await tx`select chat_folder_save(null, 'Работа', ${[ab, cb]}::uuid[]) as id`;
      await as(tx, a);
      expect((await tx`select * from chat_folders_list()`).length).toBe(0);
      expect(await failure(tx, () => tx`select chat_folder_save(${folder}, 'Моё', '{}'::uuid[])`)).toContain(
        "chat_forbidden",
      );
      await as(tx, b);
      const [f] = await tx`select * from chat_folders_list()`;
      expect(f.chat_ids.sort()).toEqual([ab, cb].sort());
      expect((await tx`select chat_mark_all_read(${[ab, cb]}::uuid[]) as n`)[0].n).toBe(2);
      expect((await tx`select chat_unread_summary() as s`)[0].s.chats).toBe(0);
    });
  });

  test("Realtime: события в личные темы участников, тема чата — только участникам", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;
      await send(tx, chat, "Привет");
      await asServer(tx);
      const topics = (
        await tx`select topic from realtime.messages where payload->>'chat_id' = ${chat} and payload->>'type' = 'message'`
      ).map((r: { topic: string }) => r.topic);
      expect(topics.sort()).toEqual([`user:${a}`, `user:${b}`].sort());
      await as(tx, b);
      expect((await tx`select chat_topic_member(${`chat:${chat}`}) as ok`)[0].ok).toBe(true);
      expect((await tx`select chat_topic_member('chat:bad') as ok`)[0].ok).toBe(false);
      await as(tx, c);
      expect((await tx`select chat_topic_member(${`chat:${chat}`}) as ok`)[0].ok).toBe(false);
    });
  });

  test("таблицы закрыты браузеру, внутренние функции не выданы", async () => {
    await scenario(async (tx) => {
      const { a } = await three(tx);
      await as(tx, a);
      for (const t of ["chat_chats", "chat_members", "chat_messages", "chat_reactions", "chat_pins", "chat_folders"]) {
        expect(await failure(tx, () => tx.unsafe(`select * from ${t}`))).toContain("permission denied");
      }
      expect(
        await failure(tx, () => tx`select notif_send_ex(${a}, 'x', 'y', null, null, null, null, false, true)`),
      ).toContain("permission denied");
      expect(await failure(tx, () => tx`select chat_broadcast(gen_random_uuid(), '{}'::jsonb)`)).toContain(
        "permission denied",
      );
    });
  });
});
