import { describe, expect, test } from "bun:test";

import {
  activeDays,
  activityStrip,
  appInsights,
  compareVersions,
  deviceSystem,
  deviceTitle,
  isOutdated,
  screensRanking,
  timeAgo,
  type AppDevice,
  type ClientAppOverview,
} from "./client-app";

const NOW = new Date("2026-10-15T12:00:00Z"); // 16:00 по Тбилиси

function device(over: Partial<AppDevice> = {}): AppDevice {
  return {
    device_id: "d1",
    app_format: "packages",
    platform: "ios",
    os_name: "iOS",
    os_version: "18.6",
    device_model: "iPhone 14 Pro / 15 / 15 Pro / 16",
    browser: "Safari",
    browser_version: null,
    app_version: "1.9",
    standalone: true,
    push_permission: "granted",
    push_subscribed: true,
    locale: "ru",
    device_language: "ru-RU",
    timezone: "Asia/Tbilisi",
    screen: "393×852@3",
    dark_mode: false,
    user_agent: "ua",
    sessions_count: 3,
    first_seen_at: "2026-10-10T08:00:00Z",
    last_seen_at: "2026-10-15T11:00:00Z",
    ...over,
  };
}

function overview(over: Partial<ClientAppOverview> = {}): ClientAppOverview {
  return {
    has_account: true,
    app_format: "packages",
    latest_app_version: "1.9",
    devices: [device()],
    activity: { first_day: "2026-10-10", days: [], screens_30d: {}, memberships_last_day: null },
    push: {
      subscriptions: 1,
      received_30d: 0,
      read_30d: 0,
      last_received_at: null,
      sent_30d: 0,
      delivered_30d: 0,
      clicked_30d: 0,
    },
    ...over,
  };
}

describe("версии", () => {
  test("по числам: 1.10 новее 1.9", () => {
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9", "2.0")).toBeLessThan(0);
    expect(compareVersions("1.9", "1.9")).toBe(0);
    expect(isOutdated("1.8", "1.10")).toBe(true);
    expect(isOutdated("1.10", "1.10")).toBe(false);
    expect(isOutdated(null, "1.10")).toBe(false);
    expect(isOutdated("dev", "1.10")).toBe(false);
  });
});

describe("время и активность", () => {
  test("timeAgo", () => {
    expect(timeAgo("2026-10-15T11:59:30Z", NOW)).toBe("только что");
    expect(timeAgo("2026-10-15T11:35:00Z", NOW)).toBe("25 минут назад");
    expect(timeAgo("2026-10-15T09:00:00Z", NOW)).toBe("3 часа назад");
    expect(timeAgo("2026-10-14T12:00:00Z", NOW)).toBe("вчера");
    expect(timeAgo("2026-10-10T12:00:00Z", NOW)).toBe("5 дней назад");
  });

  test("полоска 30 дней по Тбилиси, сегодня — последняя", () => {
    const strip = activityStrip(
      [
        { day: "2026-10-15", sessions: 2 },
        { day: "2026-10-13", sessions: 1 },
        { day: "2026-09-01", sessions: 5 },
      ],
      NOW,
    );
    expect(strip).toHaveLength(30);
    expect(strip[29]).toEqual({ day: "2026-10-15", sessions: 2 });
    expect(strip[0].day).toBe("2026-09-16");
    expect(activeDays(strip, 7)).toBe(2);
    expect(activeDays(strip, 30)).toBe(2);
    // Поздний вечер по UTC — уже завтра по Тбилиси.
    expect(activityStrip([], new Date("2026-10-15T21:00:00Z")).at(-1)?.day).toBe("2026-10-16");
  });
});

describe("устройство", () => {
  test("подписи", () => {
    expect(deviceTitle(device())).toBe("iPhone 14 Pro / 15 / 15 Pro / 16");
    expect(deviceTitle(device({ device_model: null, platform: "android" }))).toBe(
      "Android-телефон",
    );
    expect(deviceTitle(device({ device_model: null, platform: "other", os_name: "Windows" }))).toBe(
      "Компьютер (Windows)",
    );
    expect(deviceSystem(device())).toBe("iOS 18.6 · Safari");
    expect(
      deviceSystem(
        device({ os_name: "Android", os_version: null, browser: "Chrome", browser_version: "141" }),
      ),
    ).toBe("Android · Chrome 141");
  });

  test("разделы по убыванию, подписи по формату", () => {
    expect(screensRanking({ home: 3, club: 5, memberships: 0 }, "packages")).toEqual([
      { key: "club", label: "Студия", count: 5 },
      { key: "home", label: "Главная", count: 3 },
    ]);
    expect(screensRanking({ club: 1 }, "subscription")[0].label).toBe("Клуб");
  });
});

describe("appInsights", () => {
  test("всё в порядке — подсказок нет", () => {
    expect(appInsights(overview(), NOW)).toEqual([]);
  });

  test("нет учётной записи — нечего подсказывать", () => {
    expect(appInsights({ has_account: false, app_format: "packages" }, NOW)).toEqual([]);
  });

  test("приложение не сообщало о себе", () => {
    const tips = appInsights(overview({ devices: [] }), NOW);
    expect(tips).toHaveLength(1);
    expect(tips[0].text).toContain("ещё не сообщало");
  });

  test("уведомления: запрещены, не включал, разрешены без подписки", () => {
    expect(
      appInsights(overview({ devices: [device({ push_permission: "denied" })] }), NOW)[0].text,
    ).toContain("запрещены");
    expect(
      appInsights(overview({ devices: [device({ push_permission: "default" })] }), NOW)[0].text,
    ).toContain("не включил");
    const noSub = overview({
      devices: [device({ push_subscribed: false })],
      push: { ...overview().push!, subscriptions: 0 },
    });
    expect(appInsights(noSub, NOW)[0].text).toContain("не подписан");
  });

  test("давно не открывал, смотрел абонементы, устаревшая версия", () => {
    const tips = appInsights(
      overview({
        latest_app_version: "1.10",
        devices: [device({ last_seen_at: "2026-09-25T10:00:00Z", app_version: "1.8" })],
        activity: {
          first_day: "2026-09-01",
          days: [],
          screens_30d: { memberships: 3 },
          memberships_last_day: "2026-09-25",
        },
      }),
      NOW,
    ).map((t) => t.text);
    expect(tips).toEqual([
      "Не открывал приложение 20 дней.",
      "Смотрел абонементы 3 раза за 30 дней, последний раз — 25.09.2026.",
      "Устаревшая версия приложения 1.8 (актуальная — 1.10): попросите закрыть приложение и открыть снова.",
    ]);
  });
});
