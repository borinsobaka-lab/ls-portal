// Отправка писем с сервера. Копия Lady Stretch (2026-10-26) — по SMTP
// почтового хостинга (reg.ru): SMTP_HOST, SMTP_PORT (465 — SSL, 587 —
// STARTTLS), SMTP_USER, SMTP_PASS. Запасной путь — Resend (RESEND_API_KEY),
// если SMTP не задан. Отправитель — MAIL_FROM (по умолчанию — SMTP_USER) и
// MAIL_FROM_NAME. Всё — только runtime-переменные Coolify, в бандл не
// попадает.

import nodemailer, { type Transporter } from "nodemailer";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const DEFAULT_FROM_NAME = "Lady Stretch";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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
  /** Отправитель; по умолчанию — defaultSender(): MAIL_FROM_NAME <MAIL_FROM>.
   * SMTP-сервер обычно отправляет только со своего ящика. */
  from?: MailSender;
};

export type MailResult = { ok: true } | { ok: false; error: string };

type Env = Record<string, string | undefined>;

export function mailProvider(env: Env = process.env): "smtp" | "resend" | null {
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return "smtp";
  return env.RESEND_API_KEY ? "resend" : null;
}

/** Отправитель по умолчанию: MAIL_FROM (иначе логин SMTP) и MAIL_FROM_NAME. */
export function defaultSender(env: Env = process.env): MailSender {
  const candidates = [env.MAIL_FROM, env.SMTP_USER].map((v) => v?.trim() ?? "");
  const email = candidates.find((v) => EMAIL_RE.test(v)) ?? "noreply@localhost";
  return { email, name: env.MAIL_FROM_NAME?.trim() || DEFAULT_FROM_NAME };
}

/** Настройки SMTP из окружения: 465 — SSL сразу, 587 — обязательно STARTTLS. */
export function smtpOptions(env: Env = process.env) {
  const port = Number(env.SMTP_PORT) || 465;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465;
  return {
    host: env.SMTP_HOST ?? "",
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: { user: env.SMTP_USER ?? "", pass: env.SMTP_PASS ?? "" },
    // Соединение держим открытым (pool): код входа уходит без нового
    // TLS-рукопожатия и входа в ящик — GoTrue ждёт хук 5 секунд.
    pool: true,
    maxConnections: Number(env.SMTP_MAX_CONNECTIONS) || 2,
    maxMessages: 100,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 10000,
  };
}

let smtp: { key: string; transport: Transporter } | null = null;

function smtpTransport(env: Env): Transporter {
  const options = smtpOptions(env);
  const key = JSON.stringify(options);
  if (!smtp || smtp.key !== key) {
    smtp?.transport.close();
    smtp = { key, transport: nodemailer.createTransport(options) };
  }
  return smtp.transport;
}

/** Подмена транспорта в тестах. */
export function setSmtpTransportForTests(transport: Transporter | null, env: Env = {}) {
  smtp = transport ? { key: JSON.stringify(smtpOptions(env)), transport } : null;
}

const formatFrom = (from: MailSender) => `${from.name.replace(/["<>]/g, "")} <${from.email}>`;

// SMTP: одна попытка, без повторов — сервер мог принять письмо и не успеть
// ответить, повтор дал бы два кода. Не уложились в срок — ошибка (GoTrue
// повторит хук сам).
async function sendSmtp(
  msg: MailMessage,
  recipients: string[],
  env: Env,
  deadline: number,
): Promise<MailResult> {
  const left = deadline - Date.now();
  if (left < MIN_REQUEST_MS) return { ok: false, error: "SMTP: не успели отправить до таймаута" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      smtpTransport(env).sendMail({
        from: formatFrom(msg.from ?? defaultSender(env)),
        to: recipients,
        subject: msg.subject,
        html: msg.html,
        text: msg.text ?? htmlToText(msg.html),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("таймаут")), left);
      }),
    ]);
    return { ok: true };
  } catch (e) {
    const error = `SMTP: ${(e as Error).message}`;
    console.error("[mail]", error);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
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

  const provider = mailProvider(env);
  if (!provider) return { ok: false, error: "mail provider not configured" };

  const deadline = opts.deadline ?? Date.now() + MAIL_TIMEOUT_MS;
  if (provider === "smtp") return sendSmtp(msg, recipients, env, deadline);
  const interval = 1000 / (Number(env.RESEND_RPS) || DEFAULT_RESEND_RPS);
  const body = JSON.stringify({
    from: formatFrom(msg.from ?? defaultSender(env)),
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
