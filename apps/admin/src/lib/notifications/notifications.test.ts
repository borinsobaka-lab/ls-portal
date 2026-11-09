import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { MAX_PAYLOAD_BYTES } from "@/lib/push/payload";
import { buildPortalEmail, portalLink } from "./email";
import {
  emailEnabled,
  emailKindsCount,
  NOTIF_KINDS,
  pushEnabled,
  withChannel,
  withPush,
} from "./kinds";
import { groupNotifs, notifCategory, notifDayGroup, untilMorning } from "./feed-logic";
import { buildPortalPushPayload, portalPath } from "./push-payload";
import { timezoneByText } from "./settings-logic";

// Актуальное определение notif_default_push — в последней по имени миграции,
// где она есть (мигратор выполняет файлы по порядку имён).
const MIGRATIONS = new URL("../../../../../db/migrations/", import.meta.url);
const MIGRATION = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS), "utf8"))
  .filter((sql) => sql.includes("function public.notif_default_push"))
  .at(-1)!;

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

  test("почта: по умолчанию выключена, каналы хранятся независимо", () => {
    expect(NOTIF_KINDS.every((k) => !emailEnabled({}, k.key))).toBe(true);
    expect(emailKindsCount({})).toBe(0);
    let prefs = withChannel({}, "chat.direct", "email", true);
    expect(prefs).toEqual({ "chat.direct": { email: true } });
    prefs = withChannel(prefs, "chat.direct", "push", false);
    expect(prefs).toEqual({ "chat.direct": { email: true, push: false } });
    expect(emailEnabled(prefs, "chat.direct")).toBe(true);
    expect(pushEnabled(prefs, "chat.direct")).toBe(false);
    expect(emailKindsCount(prefs)).toBe(1);
    prefs = withChannel(prefs, "chat.direct", "email", false);
    expect(prefs).toEqual({ "chat.direct": { push: false } });
    prefs = withChannel(prefs, "chat.direct", "push", true);
    expect(prefs).toEqual({});
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

describe("письмо-уведомление", () => {
  const env = { ADMIN_APP_URL: "https://portal.ladyfitpro.ru/" };
  const row = {
    kind: "task.assigned",
    title: "Новая задача #12",
    body: "Анна: <b>сделать</b>\nотчёт",
    url: "/tasks/12",
    user_name: "Иванова Анна",
  };

  test("тема, ссылка на портал, экранирование", () => {
    const mail = buildPortalEmail(row, env);
    expect(mail.subject).toBe("Новая задача #12 — LadyFitPro");
    expect(mail.html).toContain('href="https://portal.ladyfitpro.ru/tasks/12"');
    expect(mail.html).toContain("https://portal.ladyfitpro.ru/notifications/settings");
    expect(mail.html).toContain("&lt;b&gt;сделать&lt;/b&gt;<br>отчёт");
    expect(mail.html).not.toContain("<b>сделать");
    expect(mail.html).toContain("Новая задача мне");
    expect(mail.text).toContain("Открыть в портале: https://portal.ladyfitpro.ru/tasks/12");
  });

  test("внешняя ссылка и портал без адреса", () => {
    expect(portalLink("https://evil.example", env)).toBe(
      "https://portal.ladyfitpro.ru/notifications",
    );
    expect(portalLink("//evil.example", env)).toBe("https://portal.ladyfitpro.ru/notifications");
    expect(portalLink("/x", {})).toBeNull();
    const mail = buildPortalEmail({ ...row, url: null }, {});
    expect(mail.html).not.toContain("Открыть в портале");
  });
});

describe("лента и время", () => {
  const TZ = "Europe/Moscow";
  // Среда, 11 ноября 2026, 12:00 МСК.
  const now = new Date("2026-11-11T09:00:00Z");

  test("группы по дням в поясе человека", () => {
    expect(notifDayGroup("2026-11-11T05:00:00Z", TZ, now)).toBe("today");
    // 23:30 МСК 10 ноября — вчера, хотя в UTC это 20:30.
    expect(notifDayGroup("2026-11-10T20:30:00Z", TZ, now)).toBe("yesterday");
    expect(notifDayGroup("2026-11-09T08:00:00Z", TZ, now)).toBe("week");
    expect(notifDayGroup("2026-11-08T08:00:00Z", TZ, now)).toBe("earlier");
    const groups = groupNotifs(
      [
        { id: 1, updated_at: "2026-11-11T08:00:00Z" },
        { id: 2, updated_at: "2026-11-11T06:00:00Z" },
        { id: 3, updated_at: "2026-11-09T06:00:00Z" },
        { id: 4, updated_at: "2026-10-01T06:00:00Z" },
      ],
      TZ,
      now,
    );
    expect(groups.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ["today", [1, 2]],
      ["week", [3]],
      ["earlier", [4]],
    ]);
  });

  test("вид уведомления по ключу", () => {
    expect(notifCategory("chat.direct")).toBe("chat");
    expect(notifCategory("task.review")).toBe("task");
    expect(notifCategory("cal.invite")).toBe("calendar");
    expect(notifCategory("company.birthday")).toBe("company");
    expect(notifCategory("test")).toBe("other");
  });

  test("«до утра» — 9:00 в поясе человека", () => {
    expect(untilMorning(TZ, now).toISOString()).toBe("2026-11-12T06:00:00.000Z");
    // 7:00 МСК — ещё сегодня в 9:00.
    expect(untilMorning(TZ, new Date("2026-11-11T04:00:00Z")).toISOString()).toBe(
      "2026-11-11T06:00:00.000Z",
    );
    expect(untilMorning("Asia/Vladivostok", now).toISOString()).toBe("2026-11-11T23:00:00.000Z");
  });

  test("пояс — «по Москве (МСК)»", () => {
    expect(timezoneByText("Europe/Moscow")).toBe("по Москве (МСК)");
    expect(timezoneByText("Asia/Vladivostok")).toBe("по Владивостоку (МСК+7)");
    expect(timezoneByText("Asia/Tbilisi")).toBe("по Тбилиси");
    expect(timezoneByText("Europe/Paris")).toBe("по поясу Europe/Paris");
  });
});
