import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { MAX_PAYLOAD_BYTES } from "@/lib/push/payload";
import { NOTIF_KINDS, pushEnabled, withPush } from "./kinds";
import { buildPortalPushPayload, portalPath } from "./push-payload";

const MIGRATION = readFileSync(
  new URL("../../../../../db/migrations/2026-11-07_zz_portal_notifications.sql", import.meta.url),
  "utf8",
);

describe("виды уведомлений", () => {
  test("пуш по умолчанию совпадает с notif_default_push в базе", () => {
    const fn = /function public\.notif_default_push[\s\S]*?select p_kind not in \(([^)]*)\)/.exec(
      MIGRATION,
    );
    expect(fn).not.toBeNull();
    const off = [...fn![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(
      NOTIF_KINDS.filter((k) => !k.defaultPush)
        .map((k) => k.key)
        .sort(),
    ).toEqual(off);
  });

  test("ключи уникальны и не длиннее 60", () => {
    const keys = NOTIF_KINDS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(60);
  });

  test("хранятся только отличия от умолчаний", () => {
    let prefs = withPush({}, "chat.group", true);
    expect(prefs).toEqual({ "chat.group": { push: true } });
    expect(pushEnabled(prefs, "chat.group")).toBe(true);
    prefs = withPush(prefs, "chat.group", false);
    expect(prefs).toEqual({});
    expect(pushEnabled(prefs, "chat.group")).toBe(false);
    expect(pushEnabled({}, "chat.direct")).toBe(true);
    expect(pushEnabled({}, "unknown.kind")).toBe(true);
  });
});

describe("пуш сотруднику", () => {
  const row = {
    notif_id: "n1",
    title: "Анна Иванова",
    body: "Привет",
    url: "/chats/1",
    tag: "chat:1",
    unread: 3,
  };

  test("поля и ссылка", () => {
    const p = JSON.parse(buildPortalPushPayload(row));
    expect(p).toEqual({
      t: "Анна Иванова",
      b: "Привет",
      u: "/chats/1",
      g: "chat:1",
      n: "n1",
      c: 3,
    });
  });

  test("внешняя ссылка не проходит", () => {
    expect(portalPath("https://evil.example")).toBeNull();
    expect(portalPath("//evil.example/x")).toBeNull();
    expect(portalPath("/tasks/12")).toBe("/tasks/12");
    expect(JSON.parse(buildPortalPushPayload({ ...row, url: "javascript:x" })).u).toBeNull();
  });

  test("длинный текст укорачивается до предела", () => {
    const json = buildPortalPushPayload({ ...row, body: "Ж".repeat(5000), title: "Т".repeat(500) });
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const p = JSON.parse(json);
    expect(Array.from(p.t as string).length).toBeLessThanOrEqual(150);
    expect((p.b as string).endsWith("…")).toBe(true);
  });
});

describe("настройки", () => {
  test("подпись устройства", async () => {
    const { deviceLabel } = await import("./settings-logic");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome · Windows");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iPhone");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 YaBrowser/24.10 Mobile Safari/537.36",
      ),
    ).toBe("Яндекс Браузер · Android");
    expect(deviceLabel(null)).toBe("Устройство");
  });
});
