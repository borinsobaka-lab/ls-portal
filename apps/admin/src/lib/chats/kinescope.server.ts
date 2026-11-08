/**
 * Kinescope Speak — комнаты видеозвонков чатов (https://docs.kinescope.ru/api/speak/).
 * Ключ API — только у сервера портала (`KINESCOPE_API_TOKEN`, Coolify):
 * браузер видит лишь ссылку комнаты своего звонка.
 *
 * - `POST /v1/speak/rooms` — комната `instant_meeting` без зала ожидания и
 *   без ожидания ведущего (входят сразу по ссылке), без записи;
 * - `DELETE /v1/speak/rooms/:id` — по окончании звонка (уборка
 *   lib/chats/calls-sweep.server.ts).
 *
 * `KINESCOPE_SPEAK_OWNER_ID` — владелец комнат (ID пользователя Kinescope;
 * в API поле `owner_id`), `KINESCOPE_API_URL` — адрес API (по умолчанию
 * https://api.kinescope.io/v1).
 */
import {
  KinescopeError,
  kinescopeErrorDetail,
  ownerFromRooms,
  parseSpeakRoom,
  type SpeakRoom,
} from "./kinescope";

const TIMEOUT_MS = 15_000;

function apiUrl(): string {
  return (process.env.KINESCOPE_API_URL?.trim() || "https://api.kinescope.io/v1").replace(
    /\/+$/,
    "",
  );
}

function token(): string | null {
  return process.env.KINESCOPE_API_TOKEN?.trim() || null;
}

/** Звонки включены: задан ключ API. */
export function kinescopeConfigured(): boolean {
  return !!token();
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const key = token();
  if (!key) throw new Error("Видеозвонки не настроены: нет ключа Kinescope");
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error(`[kinescope] ${method} ${path}: нет ответа`, e);
    throw new Error("Нет связи с Kinescope — сервер портала не дозвонился до api.kinescope.io");
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[kinescope] ${method} ${path} → ${res.status}: ${text.slice(0, 1000)}`);
    throw new KinescopeError(res.status, kinescopeErrorDetail(text));
  }
  return text ? JSON.parse(text) : null;
}

// Владелец комнат: KINESCOPE_SPEAK_OWNER_ID или найденный в комнатах Speak.
let foundOwner: string | null = null;

async function discoverOwner(): Promise<string | null> {
  if (foundOwner) return foundOwner;
  const json = await call("GET", "/speak/rooms?page=1&per_page=20&order=created_at.desc");
  foundOwner = ownerFromRooms(json);
  if (foundOwner) console.log(`[kinescope] владелец комнат — из комнат Speak: ${foundOwner}`);
  return foundOwner;
}

/**
 * Новая комната звонка. owner_id — из KINESCOPE_SPEAK_OWNER_ID; не задан —
 * сначала без него, Kinescope отказал (400/422) — берём владельца уже
 * созданных комнат Speak и повторяем.
 */
export async function createSpeakRoom(name: string): Promise<SpeakRoom> {
  const configured = process.env.KINESCOPE_SPEAK_OWNER_ID?.trim() || null;
  const body = (owner: string | null) => ({
    name: name.slice(0, 100),
    ...(owner ? { owner_id: owner } : {}),
    type: "instant_meeting",
    autorecording: false,
    transcription_autostart: false,
    waiting_room: false,
    wait_for_host: false,
  });
  let json: unknown;
  try {
    json = await call("POST", "/speak/rooms", body(configured ?? foundOwner));
  } catch (e) {
    const retry =
      e instanceof KinescopeError && (e.status === 400 || e.status === 422) && !configured;
    if (!retry) throw e;
    const owner = await discoverOwner().catch(() => null);
    if (!owner) {
      throw new Error(
        `${e.message}. Создайте одну встречу вручную в Kinescope Speak (speak.kinescope.io) — ` +
          "портал возьмёт владельца комнат из неё, или задайте KINESCOPE_SPEAK_OWNER_ID",
      );
    }
    json = await call("POST", "/speak/rooms", body(owner));
  }
  const room = parseSpeakRoom(json);
  if (!room) {
    console.error("[kinescope] ответ без ссылки комнаты:", JSON.stringify(json).slice(0, 1000));
    throw new Error("Kinescope создал комнату, но не вернул ссылку на неё");
  }
  return room;
}

/** Удалить комнату (уже удалена — тоже успех). */
export async function deleteSpeakRoom(id: string): Promise<void> {
  try {
    await call("DELETE", `/speak/rooms/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof KinescopeError && e.status === 404) return;
    throw e;
  }
}
