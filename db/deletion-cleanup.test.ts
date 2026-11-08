/**
 * Тесты уборки удалённого (db/migrations/2026-11-08_zzzz_deletion_cleanup.sql):
 * файлы удалённых чатов, сообщений, задач, проектов, аватарок, клубов,
 * постов контент-плана — в очередь и стираются, только если на них больше
 * ничто не ссылается; удаление проекта уносит задачи, чаты, уведомления;
 * комната звонка удалённого чата; суточная страховка.
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

describe.skipIf(!url)("уборка удалённого (база)", () => {
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

  async function three(tx: Tx) {
    studio = null;
    await asServer(tx);
    await tx`delete from storage_purge_queue`;
    const a = await staff(tx, "Анна");
    const b = await staff(tx, "Борис");
    const c = await staff(tx, "Вера");
    return { a, b, c };
  }

  /** Файл в бакете (как его оставил бы Storage), по умолчанию — вчерашний. */
  async function object(tx: Tx, bucket: string, name: string, daysAgo = 1) {
    await asServer(tx);
    await tx`insert into storage.objects (bucket_id, name, created_at)
             values (${bucket}, ${name}, now() - make_interval(days => ${daysAgo}))`;
  }

  /** Что сервер стёр бы сейчас (очередь разбирается; стёртое уходит из бакета, как у Storage). */
  async function purge(tx: Tx): Promise<string[]> {
    await asServer(tx);
    const rows = (await tx`select bucket_id, name from storage_purge_due(1000)`) as {
      bucket_id: string;
      name: string;
    }[];
    for (const r of rows) {
      await tx`delete from storage.objects where bucket_id = ${r.bucket_id} and name = ${r.name}`;
    }
    return rows.map((r) => `${r.bucket_id}:${r.name}`).sort();
  }

  const attach = (path: string) => [{ path, name: "файл.pdf", mime: "application/pdf", size: 100 }];

  test("чат: удалённое сообщение — файл стирается, пересланный — остаётся, пока есть ссылка", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: ab }] = await tx`select chat_open_direct(${b}) as id`;
      const [{ id: ac }] = await tx`select chat_open_direct(${c}) as id`;
      const own = `${ab}/${crypto.randomUUID()}.pdf`;
      const shared = `${ab}/${crypto.randomUUID()}.pdf`;
      await object(tx, "chat-files", own);
      await object(tx, "chat-files", shared);
      await as(tx, a);
      const [{ m: m1 }] = await tx`select chat_send(${ab}, null, '', null, ${attach(own)}::jsonb) as m`;
      const [{ m: m2 }] = await tx`select chat_send(${ab}, null, '', null, ${attach(shared)}::jsonb) as m`;
      await tx`select chat_forward(${[m2.id]}::uuid[], ${[ac]}::uuid[])`;

      await tx`select chat_delete_message(${m1.id})`;
      await tx`select chat_delete_message(${m2.id})`;
      // Пересланная копия в другом чате держит файл.
      expect(await purge(tx)).toEqual([`chat-files:${own}`]);
      expect(await purge(tx)).toEqual([]);
    });
  });

  test("группа удалена: файлы папки (и неотправленные), папки пользователей, уведомления", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const sent = `${g}/${crypto.randomUUID()}.pdf`;
      const unsent = `${g}/${crypto.randomUUID()}.pdf`;
      await object(tx, "chat-files", sent);
      await object(tx, "chat-files", unsent, 0);
      await as(tx, a);
      await tx`select chat_send(${g}, null, '', null, ${attach(sent)}::jsonb)`;
      await as(tx, b);
      await tx`select chat_folder_save(null, 'Работа', ${[g]}::uuid[])`;
      await asServer(tx);
      await tx`insert into notif_items (user_id, kind, title, url, group_key)
               values (${b}, 'chat.mention', 'Упомянули', ${`/chats/${g}?m=1`}, ${`chatmention:${g}`})`;

      await as(tx, a);
      await tx`select chat_delete_group(${g})`;
      expect(await purge(tx)).toEqual([`chat-files:${sent}`, `chat-files:${unsent}`].sort());
      const [{ n }] = await tx`select count(*)::int as n from notif_items where url like ${`/chats/${g}%`}`;
      expect(n).toBe(0);
      const [{ left }] = await tx`select count(*)::int as left from chat_folders where ${g}::uuid = any (chat_ids)`;
      expect(left).toBe(0);
    });
  });

  test("звонок в удалённом чате: комната Kinescope уходит на удаление", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: g }] = await tx`select chat_create_group('Отдел', ${[b, c]}::uuid[]) as id`;
      const [{ r }] = await tx`select chat_call_start(${g}) as r`;
      await asServer(tx);
      await tx`select chat_call_set_room(${r.call.id}, 'room-9', 'https://speak.kinescope.io/x')`;
      await as(tx, a);
      await tx`select chat_delete_group(${g})`;
      await asServer(tx);
      const rooms = await tx`select * from chat_call_sweep()`;
      expect(rooms.map((x: { room_id: string }) => x.room_id)).toContain("room-9");
      await tx`select chat_call_room_deleted(${r.call.id})`;
      const again = await tx`select * from chat_call_sweep()`;
      expect(again.map((x: { room_id: string }) => x.room_id)).not.toContain("room-9");
    });
  });

  test("файл задачи: убран — стирается, файл постановки держат другие задачи", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      const common = `new/${a}/${crypto.randomUUID()}.pdf`;
      await object(tx, "task-files", common);
      await as(tx, a);
      const [{ r }] = await tx`select task_create(${{
        title: "Брендбук",
        assignees: [b, c],
        mode: "separate",
        files: attach(common),
      }}::jsonb) as r`;
      const t1 = r.tasks[0].id as string;
      const own = `${t1}/${crypto.randomUUID()}.png`;
      await object(tx, "task-files", own);
      await as(tx, a);
      await tx`select task_file_add(${t1}, ${attach(own)}::jsonb)`;
      await asServer(tx);
      const files = await tx`select id, path from task_files where task_id = ${t1}`;
      for (const f of files as { id: string }[]) {
        await as(tx, a);
        await tx`select task_file_delete(${f.id})`;
      }
      expect(await purge(tx)).toEqual([`task-files:${own}`]);
    });
  });

  test("проект удалён: задачи, их файлы, картинки описания, чаты, уведомления — тоже", async () => {
    await scenario(async (tx) => {
      const { a, b, c } = await three(tx);
      await as(tx, a);
      const [{ id: pr }] = await tx`select task_project_save(null, ${{ title: "Казань", kind: "city", members: [b] }}::jsonb) as id`;
      await asServer(tx);
      const [{ chat_id: projectChat }] = await tx`select chat_id from task_projects where id = ${pr}`;
      await as(tx, a);
      const [{ r }] = await tx`select task_create(${{ title: "Афиша", assignees: [b], project_id: pr }}::jsonb) as r`;
      const task = r.tasks[0] as { id: string; number: number };
      const [{ r: keep }] = await tx`select task_create(${{ title: "Без проекта", assignees: [c] }}::jsonb) as r`;

      const file = `${task.id}/${crypto.randomUUID()}.pdf`;
      const img = `tasks/${task.id}/${crypto.randomUUID()}.webp`;
      const tplImg = `tasks/${task.id}/${crypto.randomUUID()}.webp`;
      await object(tx, "task-files", file);
      await object(tx, "kb-media", img);
      await object(tx, "kb-media", tplImg);
      await as(tx, a);
      await tx`select task_file_add(${task.id}, ${attach(file)}::jsonb)`;
      await tx`select task_update(${task.id}, ${{
        description: [{ type: "image", props: { url: `kbfile:${img}` } }],
      }}::jsonb)`;
      // Шаблон из задачи держит картинку описания.
      await tx`select task_template_save(null, ${{
        name: "Афиша",
        task: { title: "Афиша", description: [{ type: "image", props: { url: `kbfile:${tplImg}` } }] },
      }}::jsonb)`;
      const [{ id: taskChat }] = await tx`select task_chat_open(${task.id}) as id`;
      const chatFile = `${taskChat}/${crypto.randomUUID()}.pdf`;
      await object(tx, "chat-files", chatFile);
      await as(tx, a);
      await tx`select chat_send(${taskChat}, null, '', null, ${attach(chatFile)}::jsonb)`;
      await asServer(tx);
      const [{ before }] = await tx`select count(*)::int as before from notif_items where group_key = ${`task:${task.id}`}`;
      expect(before).toBeGreaterThan(0);
      await tx`delete from storage_purge_queue`;

      await as(tx, a);
      await tx`select task_project_delete(${pr})`;
      await asServer(tx);
      const [{ tasks }] = await tx`select count(*)::int as tasks from tasks where id = ${task.id}`;
      expect(tasks).toBe(0);
      const [{ kept }] = await tx`select count(*)::int as kept from tasks where id = ${keep.tasks[0].id}`;
      expect(kept).toBe(1);
      const [{ chats }] = await tx`select count(*)::int as chats from chat_chats where id in (${taskChat}, ${projectChat})`;
      expect(chats).toBe(0);
      const [{ n }] = await tx`select count(*)::int as n from notif_items where group_key = ${`task:${task.id}`}`;
      expect(n).toBe(0);
      expect(await purge(tx)).toEqual([`chat-files:${chatFile}`, `kb-media:${img}`, `task-files:${file}`].sort());
    });
  });

  test("аватарка, логотип клуба, картинки поста контент-плана", async () => {
    await scenario(async (tx) => {
      const { a } = await three(tx);
      const av1 = `staff/${crypto.randomUUID()}.webp`;
      const av2 = `staff/${crypto.randomUUID()}.webp`;
      await object(tx, "avatars", av1);
      await object(tx, "avatars", av2);
      await tx`update profiles set avatar_url = ${av1} where id = ${a}`;
      await tx`update profiles set avatar_url = ${av2} where id = ${a}`;
      expect(await purge(tx)).toEqual([`avatars:${av1}`]);
      // Клиентские аватарки (не staff/) не трогаем.
      await tx`select storage_purge_enqueue('avatars', ${[`${a}/me.png`]}::text[])`;
      await object(tx, "avatars", `${a}/me.png`);
      expect(await purge(tx)).toEqual([]);

      const [{ id: st }] = await tx`insert into studios (name, format) values ('Клуб', 'packages') returning id`;
      const logo = `${st}/${crypto.randomUUID()}.png`;
      const photo = `${st}/photo/${crypto.randomUUID()}.jpg`;
      await object(tx, "studio-logos", logo);
      await object(tx, "studio-logos", photo);
      await tx`update studios set logo_url = ${logo}, photo_url = ${photo} where id = ${st}`;
      await tx`update studios set logo_url = null where id = ${st}`;
      expect(await purge(tx)).toEqual([`studio-logos:${logo}`]);
      await tx`delete from studios where id = ${st}`;
      expect(await purge(tx)).toEqual([`studio-logos:${photo}`]);

      const [{ id: post }] = await tx`insert into an_content_posts (brand, body, created_by)
        values ('Lady Stretch', 'Текст', ${a}) returning id`;
      const pic = `${crypto.randomUUID()}.jpg`;
      await object(tx, "an-content", pic);
      await tx`insert into an_content_post_media (post_id, storage_path, original_name, mime_type, size_bytes, sort_order)
               values (${post}, ${pic}, 'a.jpg', 'image/jpeg', 10, 0)`;
      await tx`delete from an_content_posts where id = ${post}`;
      expect(await purge(tx)).toEqual([`an-content:${pic}`]);
    });
  });

  test("суточная страховка: без ссылок и старше запаса; свежие и со ссылками — нет", async () => {
    await scenario(async (tx) => {
      const { a, b } = await three(tx);
      await as(tx, a);
      const [{ id: ab }] = await tx`select chat_open_direct(${b}) as id`;
      const old = `${ab}/${crypto.randomUUID()}.pdf`;
      const fresh = `${ab}/${crypto.randomUUID()}.pdf`;
      const used = `${ab}/${crypto.randomUUID()}.pdf`;
      const avatarOld = `staff/${crypto.randomUUID()}.webp`;
      await object(tx, "chat-files", old, 30);
      await object(tx, "chat-files", fresh, 1);
      await object(tx, "chat-files", used, 30);
      await object(tx, "avatars", avatarOld, 30);
      await object(tx, "avatars", `${a}/client.png`, 30);
      await as(tx, a);
      await tx`select chat_send(${ab}, null, '', null, ${attach(used)}::jsonb)`;
      await asServer(tx);
      const rows = (await tx`select bucket_id, name from storage_gc_candidates(5000)`) as {
        bucket_id: string;
        name: string;
      }[];
      const names = rows.map((r) => `${r.bucket_id}:${r.name}`);
      expect(names).toContain(`chat-files:${old}`);
      expect(names).toContain(`avatars:${avatarOld}`);
      expect(names).not.toContain(`chat-files:${fresh}`);
      expect(names).not.toContain(`chat-files:${used}`);
      expect(names).not.toContain(`avatars:${a}/client.png`);
    });
  });

  test("функции уборки закрыты браузеру", async () => {
    await scenario(async (tx) => {
      const { a } = await three(tx);
      await as(tx, a);
      await tx`savepoint t`;
      let error = "";
      try {
        await tx`select * from storage_purge_due(10)`;
      } catch (e) {
        error = (e as Error).message;
      }
      await tx`rollback to savepoint t`;
      expect(error).toContain("permission denied");
    });
  });
});
