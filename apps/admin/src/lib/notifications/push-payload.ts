/**
 * Содержимое пуша сотруднику (портал, не клиентское приложение): заголовок,
 * текст, куда ведёт нажатие, метка группы и число непрочитанного для значка
 * на иконке. Читает его service worker портала (public/sw.js). Поля короткие:
 * тело пуша — до ~4 КБ, а русские буквы — по 2 байта.
 */
import { MAX_PAYLOAD_BYTES } from "@/lib/push/payload";

export type PortalPushRow = {
  notif_id: string;
  title: string;
  body: string | null;
  url: string | null;
  tag: string;
  unread: number;
};

export type PortalPushPayload = {
  /** Заголовок. */
  t: string;
  /** Текст. */
  b: string;
  /** Путь в портале ('/chats/…'), null — центр уведомлений. */
  u: string | null;
  /** Метка: уведомления одного чата заменяют друг друга, а не копятся. */
  g: string;
  /** id строки ленты — отметить прочитанным по нажатию. */
  n: string;
  /** Непрочитанных уведомлений — значок на иконке приложения. */
  c: number;
};

const MAX_TITLE = 150;
const MAX_BODY = 600;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : chars
        .slice(0, max - 1)
        .join("")
        .trimEnd() + "…";
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Только путь внутри портала: внешняя ссылка из базы сюда не попадает. */
export function portalPath(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function buildPortalPushPayload(row: PortalPushRow): string {
  const payload: PortalPushPayload = {
    t: clip(row.title.trim() || "Уведомление", MAX_TITLE),
    b: clip((row.body ?? "").trim(), MAX_BODY),
    u: portalPath(row.url),
    g: clip(row.tag, 200),
    n: row.notif_id,
    c: Math.max(0, Math.floor(row.unread || 0)),
  };
  let json = JSON.stringify(payload);
  while (bytes(json) > MAX_PAYLOAD_BYTES && payload.b.length > 0) {
    const next = Math.floor(Array.from(payload.b).length * 0.8);
    payload.b = next < 2 ? "" : clip(payload.b, next);
    json = JSON.stringify(payload);
  }
  if (bytes(json) > MAX_PAYLOAD_BYTES) {
    payload.u = null;
    json = JSON.stringify(payload);
  }
  return json;
}
