/**
 * Содержимое пуша для устройства: текст на языке приложения на этом
 * устройстве (push_subscriptions.locale) — язык → английский → русский, как
 * показывает контент клиентское приложение. Поля JSON короткие: пуш
 * ограничен ~4 КБ, а грузинский и русский — по 2–3 байта на букву.
 * Читает их service worker клиентского приложения (apps/client/public/sw.js).
 */
import { parseTranslations } from "@/lib/content-i18n";

/**
 * Содержимое пуша до шифрования, байт. Службы доставки принимают до 4096 байт
 * тела (заголовок 86 байт + шифротекст + 17 байт разделителя и тега).
 */
export const MAX_PAYLOAD_BYTES = 3800;

export type PushLocale = "en" | "ka" | "ru";

export type PushContent = {
  id: string;
  title: string;
  message: string | null;
  action_url: string | null;
  translations: unknown;
};

export type PushPayload = {
  /** Заголовок. */
  t: string;
  /** Текст. */
  b: string;
  /** Куда ведёт нажатие: раздел приложения (/schedule) или внешняя ссылка. */
  u: string | null;
  /** id уведомления — tag (повтор не дублирует) и лента приложения. */
  n: string;
  /** id доставки — подтверждение показа и нажатия (/api/push-ack). */
  d: string;
  /** Иконка приложения (Android; iOS берёт значок приложения сам). */
  i?: string;
};

const MAX_TITLE = 150;
const MAX_BODY = 600;

const CHAIN: Record<PushLocale, ("en" | "ka")[]> = {
  ru: [],
  en: ["en"],
  ka: ["ka", "en"],
};

export function localizePush(
  n: Pick<PushContent, "title" | "message" | "translations">,
  locale: string,
): { title: string; body: string } {
  const translations = parseTranslations(n.translations);
  const chain = CHAIN[(locale as PushLocale) in CHAIN ? (locale as PushLocale) : "en"];
  const pick = (field: "title" | "message", russian: string | null) => {
    for (const lang of chain) {
      const value = translations[lang]?.[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return (russian ?? "").trim();
  };
  return { title: pick("title", n.title), body: pick("message", n.message) };
}

/**
 * Ссылка перехода из админки: внешняя (https://…) — как есть, раздел
 * приложения — путь от корня («schedule» → «/schedule»). Пусто — null.
 */
export function normalizeActionUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return "/" + value.replace(/^\/+/, "");
}

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

export function buildPushPayload(
  n: PushContent,
  locale: string,
  deliveryId: string,
  icon: string | null,
): string {
  const { title, body } = localizePush(n, locale);
  const payload: PushPayload = {
    t: clip(title, MAX_TITLE),
    b: clip(body, MAX_BODY),
    u: normalizeActionUrl(n.action_url),
    n: n.id,
    d: deliveryId,
    ...(icon ? { i: icon } : {}),
  };
  let json = JSON.stringify(payload);
  // Длинная ссылка или текст сверх предела — укорачиваем текст. Каждый шаг
  // короче прежнего хотя бы на символ: «…» вместо одного символа не остаётся.
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
