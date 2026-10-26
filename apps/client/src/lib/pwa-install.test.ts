import { describe, expect, test } from "bun:test";

import {
  detectInstalledDisplay,
  detectIosGuide,
  detectPlatform,
  isAndroidChrome,
  splitStepText,
} from "./pwa-install";

const UA = {
  // iOS 26: версия системы заморожена на 18_6, Safari — Version/26.
  safari26:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  safari26_2:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1",
  safari18_6:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  safari17:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // Встроенные браузеры: Version нет.
  instagramFrozen:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0",
  instagramOld:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0",
  chromeIos26:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
  chromeIos17:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

describe("detectPlatform", () => {
  test("iPhone — ios", () => {
    expect(detectPlatform(UA.safari26)).toBe("ios");
    expect(detectPlatform(UA.instagramFrozen)).toBe("ios");
    expect(detectPlatform(UA.chromeIos17)).toBe("ios");
  });

  test("iPad с user agent Mac'а — ios только при сенсорном экране", () => {
    expect(detectPlatform(UA.ipadDesktop, 5)).toBe("ios");
    expect(detectPlatform(UA.ipadDesktop, 0)).toBe("other");
  });

  test("Android и компьютер", () => {
    expect(detectPlatform(UA.android)).toBe("android");
    expect(detectPlatform(UA.windows)).toBe("other");
  });
});

describe("detectIosGuide", () => {
  test("Safari: по Version, а не по замороженной версии системы", () => {
    expect(detectIosGuide(UA.safari26)).toBe("ios26");
    expect(detectIosGuide(UA.safari26_2)).toBe("ios26");
    expect(detectIosGuide(UA.safari18_6)).toBe("legacy");
    expect(detectIosGuide(UA.safari17)).toBe("legacy");
  });

  test("без Version: старая система — ранние версии, 18_6 и выше — iOS 26", () => {
    expect(detectIosGuide(UA.instagramOld)).toBe("legacy");
    expect(detectIosGuide(UA.instagramFrozen)).toBe("ios26");
    expect(detectIosGuide(UA.chromeIos26)).toBe("ios26");
    expect(detectIosGuide(UA.chromeIos17)).toBe("legacy");
  });

  test("неизвестный user agent — iOS 26", () => {
    expect(detectIosGuide("")).toBe("ios26");
  });
});

describe("isAndroidChrome", () => {
  const chromeLike = (token: string) =>
    `Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) ${token} Chrome/141.0.0.0 Mobile Safari/537.36`;

  test("настоящий Chrome на Android", () => {
    expect(isAndroidChrome(UA.android)).toBe(true);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  test("Samsung Internet, Edge, Opera, Яндекс, Xiaomi — не Chrome", () => {
    expect(isAndroidChrome(chromeLike("SamsungBrowser/27.0"))).toBe(false);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
      ),
    ).toBe(false);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/91.0.0.0",
      ),
    ).toBe(false);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.1.100.00 SA/3 Mobile Safari/537.36",
      ),
    ).toBe(false);
    expect(isAndroidChrome(chromeLike("XiaoMi/MiuiBrowser/14.0"))).toBe(false);
  });

  test("встроенные браузеры приложений (WebView, Instagram, Telegram) — не Chrome", () => {
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Instagram 400.0.0.0 Android",
      ),
    ).toBe(false);
    expect(
      isAndroidChrome(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Telegram-Android/12.0.1",
      ),
    ).toBe(false);
  });

  test("iPhone и компьютер — не Chrome на Android", () => {
    expect(isAndroidChrome(UA.chromeIos26)).toBe(false);
    expect(isAndroidChrome(UA.windows)).toBe(false);
  });
});

describe("splitStepText", () => {
  test("русские кавычки, в том числе вложенные", () => {
    expect(splitStepText("Выберите «На экран „Домой“» и нажмите «Добавить»")).toEqual([
      { text: "Выберите ", kind: "plain" },
      { text: "«На экран „Домой“»", kind: "quoted" },
      { text: " и нажмите ", kind: "plain" },
      { text: "«Добавить»", kind: "quoted" },
    ]);
  });

  test("английские и грузинские кавычки", () => {
    expect(splitStepText("Tap “Share”")).toEqual([
      { text: "Tap ", kind: "plain" },
      { text: "“Share”", kind: "quoted" },
    ]);
    expect(splitStepText("დააჭირეთ „Add“-ს")).toEqual([
      { text: "დააჭირეთ ", kind: "plain" },
      { text: "„Add“", kind: "quoted" },
      { text: "-ს", kind: "plain" },
    ]);
  });

  test("название браузера — отдельной частью, на любом языке", () => {
    expect(splitStepText("Откройте эту ссылку в браузере Safari")).toEqual([
      { text: "Откройте эту ссылку в браузере ", kind: "plain" },
      { text: "Safari", kind: "browser" },
    ]);
    expect(splitStepText("გადადით საიტზე და დააჭირეთ Chrome-ის კუთხეში")).toEqual([
      { text: "გადადით საიტზე და დააჭირეთ ", kind: "plain" },
      { text: "Chrome", kind: "browser" },
      { text: "-ის კუთხეში", kind: "plain" },
    ]);
  });

  test("без кавычек и браузера — одна часть", () => {
    expect(splitStepText("Перейдите на сайт")).toEqual([
      { text: "Перейдите на сайт", kind: "plain" },
    ]);
  });
});

describe("detectInstalledDisplay", () => {
  const WEBVIEW =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
  const IOS_WEB_APP =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

  test("установленное: display-mode standalone или navigator.standalone на iPhone", () => {
    expect(detectInstalledDisplay({ userAgent: UA.android, displayModeStandalone: true })).toBe(
      true,
    );
    expect(
      detectInstalledDisplay({
        userAgent: IOS_WEB_APP,
        standalone: true,
        displayModeStandalone: false,
      }),
    ).toBe(true);
  });

  test("вкладка браузера — не установленное", () => {
    expect(detectInstalledDisplay({ userAgent: UA.android, displayModeStandalone: false })).toBe(
      false,
    );
    expect(
      detectInstalledDisplay({
        userAgent: UA.safari26,
        standalone: false,
        displayModeStandalone: false,
      }),
    ).toBe(false);
  });

  test("встроенный браузер мессенджера — не установленное, что бы ни сообщал", () => {
    expect(detectInstalledDisplay({ userAgent: WEBVIEW, displayModeStandalone: true })).toBe(false);
    expect(
      detectInstalledDisplay({
        userAgent: `${WEBVIEW} Telegram-Android/12.0.1`,
        displayModeStandalone: true,
      }),
    ).toBe(false);
    expect(
      detectInstalledDisplay({
        userAgent: `${IOS_WEB_APP} Instagram 400.0.0`,
        standalone: true,
        displayModeStandalone: true,
      }),
    ).toBe(false);
  });
});
