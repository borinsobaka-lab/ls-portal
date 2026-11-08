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
import { parseSpeakRoom, type SpeakRoom } from "./kinescope";

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
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // Ответ с ошибкой — в лог сервера целиком, наружу — коротко.
    console.error(`[kinescope] ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    throw new Error(`Kinescope ответил ${res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Новая комната звонка. */
export async function createSpeakRoom(name: string): Promise<SpeakRoom> {
  const owner = process.env.KINESCOPE_SPEAK_OWNER_ID?.trim();
  const json = await call("POST", "/speak/rooms", {
    name: name.slice(0, 100),
    ...(owner ? { owner_id: owner } : {}),
    type: "instant_meeting",
    autorecording: false,
    transcription_autostart: false,
    waiting_room: false,
    wait_for_host: false,
  });
  const room = parseSpeakRoom(json);
  if (!room) throw new Error("Kinescope не вернул ссылку комнаты");
  return room;
}

/** Удалить комнату (уже удалена — тоже успех). */
export async function deleteSpeakRoom(id: string): Promise<void> {
  try {
    await call("DELETE", `/speak/rooms/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes(" 404")) return;
    throw e;
  }
}
