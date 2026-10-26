// Отправка писем с сервера через Resend (RESEND_API_KEY). С 2026-10-11 —
// единственный провайдер: Unisender Go отключён (решение владельца), домен
// base40.fit верифицирован в Resend; письма Lady Stretch — со своего домена
// (LADY_STRETCH_MAIL_FROM, src/lib/auth-email.ts). Ключ — только runtime-переменная Coolify
// у club40-admin, в бандл не попадает.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const MAIL_FROM_EMAIL = "noreply@base40.fit";
export const MAIL_FROM_NAME = "Base40";

// Сколько ждём ответа провайдера. GoTrue ждёт хук писем ~5 секунд и при
// неудаче повторяет его; если зависший провайдер всё же отправит письмо
// позже, человек получит два кода. Обрываем раньше и отвечаем ошибкой.
const MAIL_TIMEOUT_MS = 4000;

// Перегрузка Resend (2026-10-16, запуск приложения: ~1000 клиентов входят по
// коду в одно утро). Лимит Resend — запросов в секунду на команду (по
// умолчанию 10), сверх него — 429. Поэтому письма уходят по очереди — не
// чаще RESEND_RPS в секунду (по умолчанию 8): всплеск входов ждёт свой слот,
// а не получает отказ; 429 (кроме исчерпанной квоты тарифа) и 5xx
// повторяются с паузой. Всё — в пределах deadline: GoTrue ждёт хук 5 секунд
// на все попытки сразу. Таймаут и обрыв связи не повторяются — письмо могло
// уйти, повтор дал бы два кода.
const DEFAULT_RESEND_RPS = 8;
const MAX_ATTEMPTS = 3;
// Меньше этого до deadline — новый запрос не начинаем: не успеет.
const MIN_REQUEST_MS = 1000;
let nextSlotAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type MailSender = { email: string; name: string };

export type MailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Отправитель; по умолчанию — Base40 <noreply@base40.fit>. Домен адреса
   * должен быть подтверждён в Resend, иначе 403. */
  from?: MailSender;
};

export type MailResult = { ok: true } | { ok: false; error: string };

type Env = Record<string, string | undefined>;

export function mailProvider(env: Env = process.env): "resend" | null {
  return env.RESEND_API_KEY ? "resend" : null;
}

// Текстовая версия письма: HTML без тегов, ссылки — адресом в скобках.
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label}: ${href}` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendMail(
  msg: MailMessage,
  env: Env = process.env,
  opts: { deadline?: number } = {},
): Promise<MailResult> {
  const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to]).filter(Boolean);
  if (recipients.length === 0) return { ok: false, error: "no recipients" };

  if (mailProvider(env) !== "resend") return { ok: false, error: "mail provider not configured" };

  const deadline = opts.deadline ?? Date.now() + MAIL_TIMEOUT_MS;
  const interval = 1000 / (Number(env.RESEND_RPS) || DEFAULT_RESEND_RPS);
  const body = JSON.stringify({
    from: `${msg.from?.name ?? MAIL_FROM_NAME} <${msg.from?.email ?? MAIL_FROM_EMAIL}>`,
    to: recipients,
    subject: msg.subject,
    html: msg.html,
    text: msg.text ?? htmlToText(msg.html),
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
  });

  let error = "Resend: не успели отправить до таймаута";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlotAt);
    if (deadline - slot < MIN_REQUEST_MS) break;
    nextSlotAt = slot + interval;
    if (slot > now) await sleep(slot - now);

    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (e) {
      error = `Resend fetch failed: ${(e as Error).message}`;
      break;
    }
    if (res.ok) return { ok: true };

    const text = await res.text().catch(() => "");
    error = `Resend ${res.status}: ${text}`;
    const transient = (res.status === 429 && !/quota/i.test(text)) || res.status >= 500;
    if (!transient || attempt === MAX_ATTEMPTS) break;
    console.error("[mail]", error, `— попытка ${attempt}, повтор`);
    const retryAfterMs = (Number(res.headers.get("retry-after")) || 0) * 1000;
    const wait = Math.min(Math.max(retryAfterMs, 250 * 2 ** attempt), 1500) + Math.random() * 200;
    if (Date.now() + wait + MIN_REQUEST_MS > deadline) break;
    await sleep(wait);
  }
  console.error("[mail]", error);
  return { ok: false, error };
}
