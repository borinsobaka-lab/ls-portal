import { afterEach, describe, expect, test } from "bun:test";

import type { Transporter } from "nodemailer";

import {
  defaultSender,
  htmlToText,
  mailProvider,
  sendMail,
  setSmtpTransportForTests,
  smtpOptions,
} from "./mail";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
};
function mockFetch(status: number, reply: unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, opts: RequestInit) => {
    calls.push({
      url,
      headers: opts.headers as Record<string, string>,
      body: JSON.parse(opts.body as string),
      signal: opts.signal,
    });
    return new Response(JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return calls;
}

const SMTP = { SMTP_HOST: "mail.hosting.reg.ru", SMTP_USER: "noreply@x.ru", SMTP_PASS: "p" };

describe("выбор провайдера", () => {
  test("SMTP задан — он, даже при ключе Resend", () =>
    expect(mailProvider({ ...SMTP, RESEND_API_KEY: "r" })).toBe("smtp"));
  test("SMTP без пароля — не он", () =>
    expect(mailProvider({ ...SMTP, SMTP_PASS: "" })).toBeNull());
  test("ключ Resend — он", () => expect(mailProvider({ RESEND_API_KEY: "r" })).toBe("resend"));
  test("ключ Unisender Go больше не используется", () =>
    expect(mailProvider({ UNISENDER_GO_API_KEY: "u" })).toBeNull());
  test("ничего — null", () => expect(mailProvider({})).toBeNull());
});

describe("sendMail", () => {
  test("Resend: формат запроса", async () => {
    const calls = mockFetch(200, { id: "x" });
    const r = await sendMail(
      { to: ["a@b.ru", "c@d.ru"], subject: "Тема", html: "<p>Код<br>1234</p>" },
      { RESEND_API_KEY: "re", UNISENDER_GO_API_KEY: "u", MAIL_FROM: "noreply@x.ru" },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].headers.Authorization).toBe("Bearer re");
    expect(calls[0].body).toEqual({
      from: "Lady Stretch <noreply@x.ru>",
      to: ["a@b.ru", "c@d.ru"],
      subject: "Тема",
      html: "<p>Код<br>1234</p>",
      text: "Код\n1234",
    });
  });

  test("Resend: свой отправитель", async () => {
    const calls = mockFetch(200, { id: "x" });
    await sendMail(
      {
        to: "a@b.ru",
        subject: "s",
        html: "h",
        from: { email: "noreply@lady-stretch.one", name: "Lady Stretch" },
      },
      { RESEND_API_KEY: "re" },
    );
    expect(calls[0].body.from).toBe("Lady Stretch <noreply@lady-stretch.one>");
  });

  test("Resend: ошибка — не ok, со статусом и телом ответа", async () => {
    mockFetch(403, { message: "domain not verified" });
    const origErr = console.error;
    console.error = () => {};
    const r = await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, { RESEND_API_KEY: "k" });
    console.error = origErr;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Resend 403");
    if (!r.ok) expect(r.error).toContain("domain not verified");
  });

  test("без ключа — не ok, запроса нет", async () => {
    const calls = mockFetch(200, {});
    const r = await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, {});
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("sendMail: таймаут провайдера", () => {
  test("у запроса есть сигнал отмены", async () => {
    const calls = mockFetch(200, { id: "x" });
    await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, { RESEND_API_KEY: "r" });
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test("провайдер не ответил вовремя — не ok, без исключения", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const origErr = console.error;
    console.error = () => {};
    const r = await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, { RESEND_API_KEY: "k" });
    console.error = origErr;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timed out");
  });
});

describe("sendMail: перегрузка Resend", () => {
  // Без очереди в тестах: слот каждую миллисекунду.
  const env = { RESEND_API_KEY: "k", RESEND_RPS: "1000" };
  const msg = { to: "a@b.ru", subject: "s", html: "h" };
  function mockFetchSeq(replies: { status: number; body: string }[]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      const r = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      return new Response(r.body, { status: r.status });
    }) as unknown as typeof fetch;
    return () => calls;
  }
  const quiet = async <T>(run: () => Promise<T>) => {
    const origErr = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = origErr;
    }
  };

  test("429 — повтор, письмо уходит", async () => {
    const calls = mockFetchSeq([
      { status: 429, body: '{"name":"rate_limit_exceeded"}' },
      { status: 200, body: '{"id":"x"}' },
    ]);
    const r = await quiet(() => sendMail(msg, env));
    expect(r.ok).toBe(true);
    expect(calls()).toBe(2);
  });

  test("5xx — повтор", async () => {
    const calls = mockFetchSeq([
      { status: 502, body: "bad gateway" },
      { status: 200, body: '{"id":"x"}' },
    ]);
    const r = await quiet(() => sendMail(msg, env));
    expect(r.ok).toBe(true);
    expect(calls()).toBe(2);
  });

  test("исчерпана квота тарифа — без повтора", async () => {
    const calls = mockFetchSeq([{ status: 429, body: '{"name":"daily_quota_exceeded"}' }]);
    const r = await quiet(() => sendMail(msg, env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("daily_quota_exceeded");
    expect(calls()).toBe(1);
  });

  test("429 подряд — не больше трёх попыток", async () => {
    const calls = mockFetchSeq([{ status: 429, body: '{"name":"rate_limit_exceeded"}' }]);
    const r = await quiet(() => sendMail(msg, env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Resend 429");
    expect(calls()).toBe(3);
  });

  test("до deadline не успеть — запроса нет", async () => {
    const calls = mockFetchSeq([{ status: 200, body: '{"id":"x"}' }]);
    const r = await quiet(() => sendMail(msg, env, { deadline: Date.now() + 300 }));
    expect(r.ok).toBe(false);
    expect(calls()).toBe(0);
  });
});

test("htmlToText: ссылка — адресом", () =>
  expect(htmlToText('<p>Нажмите</p><a href="https://x.ru/v">Войти</a>')).toBe(
    "Нажмите\nВойти: https://x.ru/v",
  ));

describe("SMTP", () => {
  afterEach(() => setSmtpTransportForTests(null));

  test("порт: 465 — SSL, 587 — STARTTLS обязателен, по умолчанию 465", () => {
    expect(smtpOptions({ ...SMTP })).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(smtpOptions({ ...SMTP, SMTP_PORT: "587" })).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
    expect(smtpOptions({ ...SMTP, SMTP_PORT: "2525", SMTP_SECURE: "false" })).toMatchObject({
      secure: false,
      requireTLS: false,
    });
    expect(smtpOptions(SMTP).auth).toEqual({ user: "noreply@x.ru", pass: "p" });
  });

  test("отправитель по умолчанию — MAIL_FROM, иначе логин ящика", () => {
    expect(defaultSender({ ...SMTP, MAIL_FROM: "robot@x.ru", MAIL_FROM_NAME: "LS" })).toEqual({
      email: "robot@x.ru",
      name: "LS",
    });
    expect(defaultSender(SMTP)).toEqual({ email: "noreply@x.ru", name: "Lady Stretch" });
  });

  test("письмо уходит через транспорт: отправитель, текстовая версия", async () => {
    const sent: Record<string, unknown>[] = [];
    setSmtpTransportForTests(
      { sendMail: async (m: Record<string, unknown>) => sent.push(m) } as unknown as Transporter,
      SMTP,
    );
    const r = await sendMail(
      {
        to: "a@b.ru",
        subject: "Код",
        html: "<p>Код<br>123456</p>",
        from: { email: "noreply@x.ru", name: 'L "S"' },
      },
      SMTP,
    );
    expect(r.ok).toBe(true);
    expect(sent).toEqual([
      {
        from: "L S <noreply@x.ru>",
        to: ["a@b.ru"],
        subject: "Код",
        html: "<p>Код<br>123456</p>",
        text: "Код\n123456",
      },
    ]);
  });

  test("ошибка сервера — не ok, без повтора", async () => {
    let calls = 0;
    setSmtpTransportForTests(
      {
        sendMail: async () => {
          calls++;
          throw new Error("535 auth failed");
        },
      } as unknown as Transporter,
      SMTP,
    );
    const origErr = console.error;
    console.error = () => {};
    const r = await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, SMTP);
    console.error = origErr;
    expect(r).toEqual({ ok: false, error: "SMTP: 535 auth failed" });
    expect(calls).toBe(1);
  });

  test("завис дольше срока — ошибка к сроку", async () => {
    setSmtpTransportForTests(
      { sendMail: () => new Promise(() => {}) } as unknown as Transporter,
      SMTP,
    );
    const origErr = console.error;
    console.error = () => {};
    const t0 = Date.now();
    const r = await sendMail({ to: "a@b.ru", subject: "s", html: "h" }, SMTP, {
      deadline: Date.now() + 1200,
    });
    console.error = origErr;
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
