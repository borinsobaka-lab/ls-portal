/**
 * Тесты голосовых сообщений (db/migrations/2026-11-08_zzzzzzzzzzzzzz_chat_voice.sql):
 * вложение хранит пометку, длительность и волну (только у звука), неверные
 * поля отбрасываются, превью списка чатов — «Голосовое сообщение (м:сс)».
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

describe.skipIf(!url)("голосовые сообщения (база)", () => {
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

  async function staff(tx: Tx, studio: string, name: string): Promise<string> {
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

  test("голосовое: поля вложения, превью, неверная волна и не звук", async () => {
    await scenario(async (tx) => {
      const [{ id: studio }] =
        await tx`insert into studios (name, format) values ('Тест', 'packages') returning id`;
      const a = await staff(tx, studio, "Анна Голос");
      const b = await staff(tx, studio, "Борис Слушатель");
      await as(tx, a);
      const [{ id: chat }] = await tx`select chat_open_direct(${b}) as id`;

      const voice = [
        {
          path: `${chat}/v.webm`,
          name: "Голосовое.webm",
          mime: "audio/webm;codecs=opus",
          size: 12000,
          voice: true,
          duration: 72.46,
          waveform: [0, 12.4, 100, 55],
          extra: "лишнее",
        },
      ];
      const [{ m }] =
        await tx`select chat_send(${chat}, null, '', null, ${voice}::jsonb, null) as m`;
      expect(m.attachments).toEqual([
        {
          path: `${chat}/v.webm`,
          name: "Голосовое.webm",
          mime: "audio/webm;codecs=opus",
          size: 12000,
          voice: true,
          duration: 72.5,
          waveform: [0, 12, 100, 55],
        },
      ]);
      const [row] = await tx`select last_message from chat_list() where id = ${chat}`;
      expect(row.last_message.text).toBe("Голосовое сообщение (1:12)");

      // Волна вне 0–100 и длительность строкой — без них; файл принимается.
      const bad = [
        {
          path: `${chat}/w.webm`,
          name: "w.webm",
          mime: "audio/webm",
          voice: true,
          duration: "5",
          waveform: [1, 200],
        },
      ];
      const [{ m: m2 }] =
        await tx`select chat_send(${chat}, null, '', null, ${bad}::jsonb, null) as m`;
      expect(m2.attachments[0]).toEqual({
        path: `${chat}/w.webm`,
        name: "w.webm",
        mime: "audio/webm",
        voice: true,
      });
      const [row2] = await tx`select last_message from chat_list() where id = ${chat}`;
      expect(row2.last_message.text).toBe("Голосовое сообщение");

      // Не звук — пометка голосового не ставится.
      const fake = [
        { path: `${chat}/x.png`, name: "x.png", mime: "image/png", voice: true, duration: 3 },
      ];
      const [{ m: m3 }] =
        await tx`select chat_send(${chat}, null, '', null, ${fake}::jsonb, null) as m`;
      expect(m3.attachments[0]).toEqual({
        path: `${chat}/x.png`,
        name: "x.png",
        mime: "image/png",
      });
      const [row3] = await tx`select last_message from chat_list() where id = ${chat}`;
      expect(row3.last_message.text).toBe("Фото");
    });
  });
});
