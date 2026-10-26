import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  buildEmails,
  emailBrand,
  emailSender,
  isAdminApp,
  NOT_A_CLUB_MEMBER,
  needsClubMembership,
  type HookPayload,
} from "@/lib/auth-email";
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { mailProvider, sendMail } from "@/lib/mail";

// Send Email Hook для Supabase Auth: GoTrue не шлёт письма сам, а дёргает
// этот эндпоинт, и мы отправляем письмо с noreply@base40.fit через Resend
// (RESEND_API_KEY) — см. src/lib/mail.ts. Клиентам пакетных клубов —
// письмо Lady Stretch со своего адреса (LADY_STRETCH_MAIL_FROM).
//
// Во всех письмах авторизации — 6-значный код, ссылок авто-входа нет: код
// GoTrue передаёт только сюда, на сервер, и он уходит лишь в письмо (в ответ
// GoTrue и в логи не попадает). Вводит его человек на странице входа.
//
// Текст письма зависит от ПРИЛОЖЕНИЯ, а не от человека: один и тот же человек
// может быть и администратором, и клиентом. Признак — хост в
// email_data.redirect_to (его явно задают оба приложения через
// emailRedirectTo): совпал с ADMIN_APP_URL -> письмо «вход в админ-панель»,
// иначе (включая нераспознанный redirect_to) -> клиентское письмо.
//
// Настройка (self-hosted Supabase): переменные GOTRUE_HOOK_SEND_EMAIL_* сервиса
// auth в Coolify, URI https://admin.base40.fit/api/auth-email; тот же секрет и
// ключ почты — в окружении админки (SEND_EMAIL_HOOK_SECRET, RESEND_API_KEY). Пока они не заданы, роут отвечает 500 и письма не
// уходят вовсе (запасной отправки у GoTrue при включённом хуке нет) — хук
// включать только после задания переменных.

// Код входа в клиентское приложение — только члену клуба (карточка клиента
// с этой почтой). Ошибка проверки (нет сервис-ключа, нет функции в базе) —
// письмо уходит: в приложение без карточки всё равно не пустит
// ensure_client_profile.
async function isClubMember(userId: string): Promise<boolean> {
  if (!hasSupabaseAdmin()) return true;
  // Не дольше 1,5 с: остальное окно GoTrue (5 с на хук) — на отправку письма.
  const { data, error } = await getSupabaseAdmin()
    .rpc("client_app_sign_in_allowed", { _user_id: userId })
    .abortSignal(AbortSignal.timeout(CLUB_CHECK_TIMEOUT_MS));
  if (error) {
    console.error("[auth-email] проверка карточки клиента:", error.message);
    return true;
  }
  return data !== false;
}

// Подпись standardized-webhooks: HMAC-SHA256(base64secret, "{id}.{ts}.{body}").
function verifySignature(secretRaw: string, id: string, ts: string, sig: string, body: string) {
  const secretB64 = secretRaw.replace(/^v1,/, "").replace(/^whsec_/, "");
  const mac = createHmac("sha256", Buffer.from(secretB64, "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  // Заголовок может содержать несколько подписей: "v1,<sig1> v1,<sig2>".
  return sig.split(" ").some((part) => {
    const candidate = part.replace(/^v1,/, "");
    const a = Buffer.from(mac);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

// GoTrue ждёт хук 5 секунд — на все свои попытки сразу (таймаут общий),
// поэтому проверка карточки и письмо (с повторами при перегрузке Resend,
// src/lib/mail.ts) укладываются в 4,3 с от прихода запроса.
const HOOK_BUDGET_MS = 4300;
const CLUB_CHECK_TIMEOUT_MS = 1500;

// Полезная нагрузка хука — пользователь и данные письма, единицы килобайт.
// Роут открыт в интернет, а тело читается до проверки подписи, поэтому
// размер ограничиваем: больше — 413, не дочитывая.
const MAX_BODY_BYTES = 64 * 1024;

/** Тело запроса текстом, если оно не больше maxBytes; иначе null. */
async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return null;
  if (!request.body) return "";
  // Content-Length может не быть (chunked) или он может врать — считаем сами.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const Route = createFileRoute("/api/auth-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const deadline = Date.now() + HOOK_BUDGET_MS;
        const secret = process.env.SEND_EMAIL_HOOK_SECRET;
        if (!secret || !mailProvider()) {
          console.error("[auth-email] SEND_EMAIL_HOOK_SECRET / RESEND_API_KEY не заданы");
          return new Response("hook not configured", { status: 500 });
        }

        const body = await readBodyLimited(request, MAX_BODY_BYTES);
        if (body === null) return new Response("payload too large", { status: 413 });
        const id = request.headers.get("webhook-id") ?? "";
        const ts = request.headers.get("webhook-timestamp") ?? "";
        const sig = request.headers.get("webhook-signature") ?? "";
        if (!id || !ts || !sig || !verifySignature(secret, id, ts, sig, body)) {
          return new Response("invalid signature", { status: 401 });
        }
        // Защита от повтора: подписи старше 5 минут не принимаем.
        const sentAt = Number(ts);
        if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > 300) {
          return new Response("stale timestamp", { status: 401 });
        }

        let payload: HookPayload;
        try {
          payload = JSON.parse(body) as HookPayload;
        } catch {
          return new Response("bad payload", { status: 400 });
        }
        if (!payload?.user?.email || !payload?.email_data?.email_action_type) {
          return new Response("bad payload", { status: 400 });
        }

        const fromAdminApp = isAdminApp(payload.email_data.redirect_to);

        // Ошибка хука в формате GoTrue: код не отправляется, сообщение
        // получает приложение (signInWithOtp -> error.message).
        if (needsClubMembership(payload, fromAdminApp) && !(await isClubMember(payload.user.id))) {
          return Response.json({ error: { http_code: 403, message: NOT_A_CLUB_MEMBER } });
        }

        // Бренд и отправитель — тоже по приложению: клиентам пакетных клубов
        // (app.lady-stretch.one, pack.base40.fit) — Lady Stretch.
        const brand = emailBrand(payload.email_data.redirect_to);
        const from = emailSender(brand);
        for (const email of buildEmails(payload, fromAdminApp, brand)) {
          const sent = await sendMail({ ...email, from }, process.env, { deadline });
          if (!sent.ok) {
            console.error("[auth-email] письмо не отправлено:", sent.error);
            // Не-200 заставит Supabase показать ошибку отправки и повторить.
            return new Response("email send failed", { status: 500 });
          }
        }

        return new Response("{}", {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
