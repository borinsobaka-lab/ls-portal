import { afterEach, describe, expect, test } from "bun:test";

import { htmlToText, mailProvider, sendMail } from "./mail";

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

describe("выбор провайдера", () => {
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
      { RESEND_API_KEY: "re", UNISENDER_GO_API_KEY: "u" },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].headers.Authorization).toBe("Bearer re");
    expect(calls[0].body).toEqual({
      from: "Base40 <noreply@base40.fit>",
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
