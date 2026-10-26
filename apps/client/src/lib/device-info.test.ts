import { describe, expect, test } from "bun:test";

import {
  deviceModelLabel,
  iphoneModelByScreen,
  mergeClientHints,
  parseUserAgent,
  screenKey,
} from "./device-info";

const IOS_18_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IOS_26_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IOS_HOME_SCREEN =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IOS_INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const ANDROID_CHROME_REDUCED =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const ANDROID_SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

describe("parseUserAgent", () => {
  test("iPhone в Safari: версия системы из user agent", () => {
    expect(parseUserAgent(IOS_18_SAFARI)).toEqual({
      platform: "ios",
      osName: "iOS",
      osVersion: "18.5",
      model: "iPhone",
      browser: "Safari",
      browserVersion: "18.5",
    });
  });

  test("iOS 26: версия — из Safari, а не замороженная 18.6", () => {
    expect(parseUserAgent(IOS_26_SAFARI).osVersion).toBe("26.0");
  });

  test("приложение на экране «Домой» — Safari без версии", () => {
    const d = parseUserAgent(IOS_HOME_SCREEN);
    expect(d.osVersion).toBe("17.4.1");
    expect(d.browser).toBe("Safari");
    expect(d.browserVersion).toBeNull();
  });

  test("встроенный браузер приложения — его название", () => {
    expect(parseUserAgent(IOS_INSTAGRAM).browser).toBe("Instagram");
  });

  test("iPad, который выдаёт себя за Mac", () => {
    const d = parseUserAgent(IPAD_AS_MAC, 5);
    expect(d).toMatchObject({
      platform: "ios",
      osName: "iPadOS",
      osVersion: "17.2",
      model: "iPad",
    });
    // Без сенсорного экрана — настоящий Mac.
    expect(parseUserAgent(IPAD_AS_MAC, 0)).toMatchObject({ platform: "other", osName: "macOS" });
  });

  test("Chrome на Android прячет модель — модели и версии нет", () => {
    expect(parseUserAgent(ANDROID_CHROME_REDUCED)).toEqual({
      platform: "android",
      osName: "Android",
      osVersion: null,
      model: null,
      browser: "Chrome",
      browserVersion: "141",
    });
  });

  test("Samsung Internet и WebView: модель из user agent", () => {
    expect(parseUserAgent(ANDROID_SAMSUNG)).toMatchObject({
      osVersion: "14",
      model: "SM-S918B",
      browser: "Samsung Internet",
      browserVersion: "27",
    });
    expect(parseUserAgent(ANDROID_WEBVIEW)).toMatchObject({
      osVersion: "13",
      model: "Pixel 7",
      browser: "WebView",
    });
  });

  test("компьютер", () => {
    expect(parseUserAgent(WINDOWS_EDGE)).toMatchObject({
      platform: "other",
      osName: "Windows",
      browser: "Edge",
      browserVersion: "141",
    });
  });
});

describe("mergeClientHints", () => {
  test("Android: настоящие модель и версия поверх заглушек", () => {
    const d = mergeClientHints(parseUserAgent(ANDROID_CHROME_REDUCED), {
      model: "SM-A546B",
      platformVersion: "14.0.0",
    });
    expect(d).toMatchObject({ model: "SM-A546B", osVersion: "14" });
    expect(deviceModelLabel(d)).toBe("Samsung SM-A546B");
    expect(
      mergeClientHints(parseUserAgent(ANDROID_CHROME_REDUCED), { platformVersion: "8.1.0" })
        .osVersion,
    ).toBe("8.1");
  });

  test("пустые подсказки и не Android — без изменений", () => {
    const android = parseUserAgent(ANDROID_SAMSUNG);
    expect(mergeClientHints(android, { model: "", platformVersion: "" })).toEqual(android);
    const ios = parseUserAgent(IOS_18_SAFARI);
    expect(mergeClientHints(ios, { model: "X" })).toEqual(ios);
  });
});

describe("iphoneModelByScreen", () => {
  test("по размеру экрана в любой ориентации", () => {
    expect(iphoneModelByScreen(393, 852, 3)).toBe("iPhone 14 Pro / 15 / 15 Pro / 16");
    expect(iphoneModelByScreen(852, 393, 3)).toBe("iPhone 14 Pro / 15 / 15 Pro / 16");
    expect(iphoneModelByScreen(414, 896, 2)).toBe("iPhone XR / 11");
    expect(iphoneModelByScreen(414, 896, 3)).toBe("iPhone XS Max / 11 Pro Max");
  });

  test("неизвестный экран — null", () => {
    expect(iphoneModelByScreen(1024, 1366, 2)).toBeNull();
  });
});

describe("screenKey", () => {
  test("разделы приложения", () => {
    expect(screenKey("/")).toBe("home");
    expect(screenKey("/schedule")).toBe("schedule");
    expect(screenKey("/memberships/")).toBe("memberships");
    expect(screenKey("/news/123")).toBe("news");
    expect(screenKey("/profile")).toBe("profile");
  });

  test("вход, анкета и политика — не разделы", () => {
    expect(screenKey("/auth")).toBeNull();
    expect(screenKey("/onboarding")).toBeNull();
    expect(screenKey("/privacy")).toBeNull();
  });
});
