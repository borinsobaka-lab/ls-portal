/**
 * Разбор ответа Kinescope Speak (общий для сервера и тестов): из ответа
 * `POST /v1/speak/rooms` — id комнаты и ссылка входа. Ссылка — только https:
 * её открывает браузер сотрудника (iframe окна звонка).
 */
export type SpeakRoom = { id: string; link: string };

export function parseSpeakRoom(json: unknown): SpeakRoom | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const { id, link } = data as { id?: unknown; link?: unknown };
  if (typeof id !== "string" || !id || id.length > 100) return null;
  if (typeof link !== "string" || link.length > 500) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { id, link };
}

/** Ошибка API Kinescope: код ответа и что он сказал. */
export class KinescopeError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(kinescopeErrorText(status, detail));
    this.name = "KinescopeError";
  }
}

/** Текст ошибки из тела ответа: {"error": {"code", "message", …}} или как есть. */
export function kinescopeErrorDetail(body: string): string {
  let detail = body.trim();
  try {
    const json = JSON.parse(body) as { error?: unknown; message?: unknown };
    const err = (json.error ?? json) as Record<string, unknown>;
    const parts = [err.message, err.detail, err.details, err.errors, err.fields]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    if (parts.length) detail = parts.join(" — ");
  } catch {
    // Не JSON — как есть.
  }
  return detail.replace(/\s+/g, " ").slice(0, 300);
}

/** Понятная причина для окна портала (что проверить). */
export function kinescopeErrorText(status: number, detail: string): string {
  const said = detail ? ` (${detail})` : "";
  if (status === 401) return `Kinescope не принял токен — проверьте KINESCOPE_API_TOKEN${said}`;
  if (status === 403)
    return `У токена Kinescope нет прав на Speak — нужны чтение, запись и удаление${said}`;
  if (status === 402) return `Тариф Kinescope не позволяет создать комнату${said}`;
  if (status === 429) return `Kinescope просит подождать — слишком много запросов${said}`;
  if (status >= 500) return `Kinescope временно не отвечает (${status})${said}`;
  return `Kinescope отклонил запрос (${status})${said}`;
}

/** ID владельца из списка комнат Speak (GET /speak/rooms): первый найденный. */
export function ownerFromRooms(json: unknown): string | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const room of data) {
    const owner = (room as { owner_id?: unknown } | null)?.owner_id;
    if (typeof owner === "string" && /^[0-9a-f-]{36}$/i.test(owner)) return owner;
  }
  return null;
}
