/**
 * Нажатие на пуш: public/sw.js (notificationclick) в подставном окружении
 * service worker и отложенный переход приложения (lib/push-open.ts).
 *
 * Сценарии — как на телефоне: приложение открыто и отвечает; закрыто
 * (холодный запуск); уснуло в фоне и молчит (iOS, Android); окно не
 * выводится вперёд; внешняя ссылка; пуш без ссылки.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PUSH_PENDING_KEY,
  PUSH_PENDING_TTL_MS,
  PUSH_STATE_CACHE,
  pendingPushPath,
} from "./push-open";

const ORIGIN = "https://app.lady-stretch.one";
const SW_SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

type FakeWindow = {
  url: string;
  /** Отвечает ли на push-open (запущено приложение и не спит). */
  answers: boolean;
  focusFails?: boolean;
  messages: unknown[];
  focused: number;
};

function makeWindow(path: string, answers: boolean, focusFails = false): FakeWindow {
  return { url: ORIGIN + path, answers, focusFails, messages: [], focused: 0 };
}

/** Service worker из public/sw.js с подставными clients, caches и fetch. */
function loadWorker(windows: FakeWindow[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  const acks: unknown[] = [];
  const store = new Map<string, Map<string, Response>>();
  const key = (req: string) => new URL(req, ORIGIN).href;

  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name)!;
      return {
        put: async (req: string, res: Response) => void c.set(key(req), res),
        match: async (req: string) => c.get(key(req))?.clone(),
        delete: async (req: string) => c.delete(key(req)),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };

  const clients = {
    matchAll: async () =>
      windows.map((w) => ({
        url: w.url,
        postMessage: (message: { type: string; url: string }, ports?: MessagePort[]) => {
          w.messages.push(message);
          if (w.answers && message.type === "push-open") ports?.[0]?.postMessage("ok");
        },
        focus: async () => {
          if (w.focusFails) throw new Error("not allowed");
          w.focused++;
        },
      })),
    openWindow: async (href: string) => {
      opened.push(href);
      return null;
    },
    claim: async () => {},
  };

  const self = {
    location: new URL(ORIGIN + "/sw.js"),
    clients,
    registration: { showNotification: async () => {} },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    acks.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(null, { status: 204 });
  };

  new Function("self", "caches", "fetch", SW_SOURCE)(self, caches, fetch);

  async function click(data: { u?: string | null; n?: string; d?: string }) {
    let pending: Promise<unknown> = Promise.resolve();
    let closed = false;
    listeners.get("notificationclick")!({
      notification: { data, close: () => (closed = true) },
      waitUntil: (p: Promise<unknown>) => (pending = p),
    });
    await pending;
    return { closed };
  }

  async function savedPath() {
    const hit = await (await caches.open(PUSH_STATE_CACHE)).match(PUSH_PENDING_KEY);
    return hit ? pendingPushPath(await hit.json(), Date.now()) : null;
  }

  return { click, opened, acks, savedPath };
}

describe("нажатие на пуш (public/sw.js)", () => {
  test("приложение открыто — переход внутри него, окно вперёд, без нового окна", async () => {
    const app = makeWindow("/", true);
    const sw = loadWorker([app]);
    const { closed } = await sw.click({ u: "/schedule", n: "n1", d: "d1" });
    expect(closed).toBe(true);
    expect(app.messages).toEqual([{ type: "push-open", url: "/schedule" }]);
    expect(app.focused).toBe(1);
    expect(sw.opened).toEqual([]);
    expect(sw.acks).toEqual([{ url: "/api/push-ack", body: { d: "d1", e: "clicked" } }]);
  });

  test("приложение закрыто — открывается адрес раздела в нём, переход отложен для iOS", async () => {
    const sw = loadWorker([]);
    await sw.click({ u: "/memberships", n: "n1", d: "d1" });
    expect(sw.opened).toEqual([`${ORIGIN}/memberships`]);
    expect(await sw.savedPath()).toBe("/memberships");
  });

  test("приложение спит в фоне и молчит — тоже открывается адрес, переход отложен", async () => {
    const asleep = makeWindow("/profile", false);
    const sw = loadWorker([asleep]);
    await sw.click({ u: "schedule?tab=personal" });
    expect(asleep.messages).toEqual([{ type: "push-open", url: "/schedule?tab=personal" }]);
    expect(sw.opened).toEqual([`${ORIGIN}/schedule?tab=personal`]);
    expect(await sw.savedPath()).toBe("/schedule?tab=personal");
  });

  test("окно ответило, но не вывелось вперёд — открывается адрес", async () => {
    const app = makeWindow("/", true, true);
    const sw = loadWorker([app]);
    await sw.click({ u: "/club" });
    expect(sw.opened).toEqual([`${ORIGIN}/club`]);
  });

  test("главная «/» и пуш без ссылки (лента уведомлений)", async () => {
    let sw = loadWorker([]);
    await sw.click({ u: "/" });
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
    sw = loadWorker([]);
    await sw.click({ u: null, n: "abc" });
    expect(sw.opened).toEqual([`${ORIGIN}/notifications?n=abc`]);
    expect(await sw.savedPath()).toBe("/notifications?n=abc");
  });

  test("внешняя ссылка — открывается в браузере, приложение не трогаем", async () => {
    const app = makeWindow("/", true);
    const sw = loadWorker([app]);
    await sw.click({ u: "https://instagram.com/ladystretch" });
    expect(sw.opened).toEqual(["https://instagram.com/ladystretch"]);
    expect(app.messages).toEqual([]);
    expect(await sw.savedPath()).toBe(null);
  });
});

describe("отложенный переход (lib/push-open.ts)", () => {
  const now = 1_800_000_000_000;

  test("свежий путь внутри приложения", () => {
    expect(pendingPushPath({ path: "/schedule", at: now - 1000 }, now)).toBe("/schedule");
    expect(pendingPushPath({ path: "/notifications?n=1", at: now }, now)).toBe(
      "/notifications?n=1",
    );
  });

  test("старый, чужой адрес и мусор — нет", () => {
    expect(pendingPushPath({ path: "/schedule", at: now - PUSH_PENDING_TTL_MS - 1 }, now)).toBe(
      null,
    );
    expect(pendingPushPath({ path: "//evil.com/x", at: now }, now)).toBe(null);
    expect(pendingPushPath({ path: "/\\evil.com", at: now }, now)).toBe(null);
    expect(pendingPushPath({ path: "https://evil.com", at: now }, now)).toBe(null);
    expect(pendingPushPath({ path: "/x" }, now)).toBe(null);
    expect(pendingPushPath(null, now)).toBe(null);
  });
});
