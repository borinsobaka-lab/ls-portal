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
