/**
 * Что за устройство: система, её версия, модель и браузер — для вкладки
 * «Приложение» в карточке клиента админки (lib/app-activity.ts шлёт это в
 * базу). Чистая логика без запросов и без React: тесты рядом
 * (device-info.test.ts).
 *
 * - iPhone свою модель не сообщает — угадываем семейство по размеру экрана в
 *   точках и плотности (iphoneModelByScreen); версия iOS в user agent с iOS
 *   26 заморожена на 18_6…18_7 — настоящая в «Version/26.0» у Safari.
 * - Chrome на Android прячет модель и версию системы («Android 10; K») —
 *   настоящие отдаёт по запросу (Client Hints, mergeClientHints).
 */

export type DevicePlatform = "ios" | "android" | "other";

export type ParsedDevice = {
  platform: DevicePlatform;
  osName: string | null;
  osVersion: string | null;
  model: string | null;
  browser: string | null;
  browserVersion: string | null;
};

function match(re: RegExp, text: string): string | null {
  return re.exec(text)?.[1] ?? null;
}

/** «18_6_1» → «18.6.1». */
function dotted(v: string | null): string | null {
  return v ? v.replace(/_/g, ".") : null;
}

/** Встроенные браузеры приложений: в user agent — метка приложения. */
const IN_APP: [RegExp, string][] = [
  [/Instagram/, "Instagram"],
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/Telegram/, "Telegram"],
  [/WhatsApp/, "WhatsApp"],
  [/Viber/, "Viber"],
  [/musical_ly|Bytedance/, "TikTok"],
  [/GSA\//, "Google"],
];

function inAppBrowser(ua: string): string | null {
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  return null;
}

function iosBrowser(ua: string): [string, string | null] {
  const app = inAppBrowser(ua);
  if (app) return [app, null];
  if (/CriOS\//.test(ua)) return ["Chrome", match(/CriOS\/(\d+)/, ua)];
  if (/FxiOS\//.test(ua)) return ["Firefox", match(/FxiOS\/(\d+)/, ua)];
  if (/EdgiOS\//.test(ua)) return ["Edge", match(/EdgiOS\/(\d+)/, ua)];
  if (/OPiOS\/|OPT\//.test(ua)) return ["Opera", match(/(?:OPiOS|OPT)\/(\d+)/, ua)];
  if (/YaBrowser\//.test(ua)) return ["Yandex", match(/YaBrowser\/(\d+)/, ua)];
  // Safari и приложение «На экран „Домой“» (у него в user agent нет «Safari»).
  return ["Safari", match(/Version\/(\d+(?:\.\d+)?)/, ua)];
}

function otherBrowser(ua: string): [string | null, string | null] {
  const app = inAppBrowser(ua);
  if (app) return [app, null];
  if (/SamsungBrowser\//.test(ua)) return ["Samsung Internet", match(/SamsungBrowser\/(\d+)/, ua)];
  if (/EdgA?\//.test(ua)) return ["Edge", match(/EdgA?\/(\d+)/, ua)];
  if (/OPR\//.test(ua)) return ["Opera", match(/OPR\/(\d+)/, ua)];
  if (/YaBrowser\//.test(ua)) return ["Yandex", match(/YaBrowser\/(\d+)/, ua)];
  if (/MiuiBrowser\//.test(ua)) return ["Mi Browser", match(/MiuiBrowser\/(\d+)/, ua)];
  if (/Firefox\//.test(ua)) return ["Firefox", match(/Firefox\/(\d+)/, ua)];
  if (/; wv\)/.test(ua)) return ["WebView", match(/Chrome\/(\d+)/, ua)];
  if (/Chrome\//.test(ua)) return ["Chrome", match(/Chrome\/(\d+)/, ua)];
  if (/Safari\//.test(ua)) return ["Safari", match(/Version\/(\d+(?:\.\d+)?)/, ua)];
  return [null, null];
}

/** Модель Android из user agent («Linux; Android 14; SM-S918B Build/…; wv)»). */
function androidModel(ua: string): string | null {
  const raw = match(/Android [^;)]*;\s*([^;)]+)/, ua);
  if (!raw) return null;
  const model = raw.replace(/\s*Build\/.*$/, "").trim();
  // «K» — заглушка Chrome вместо модели; «wv» — метка WebView без модели.
  if (!model || model === "K" || model === "wv" || /^(Mobile|Tablet)$/i.test(model)) return null;
  return model;
}

export function parseUserAgent(ua: string, maxTouchPoints = 0): ParsedDevice {
  const iosDevice = match(/\b(iPhone|iPad|iPod)\b/, ua);
  // iPad (iPadOS 13+) в Safari выдаёт себя за Mac — отличает сенсорный экран.
  const ipadAsMac = !iosDevice && /Macintosh/.test(ua) && maxTouchPoints > 1;

  if (iosDevice || ipadAsMac) {
    const [browser, browserVersion] = iosBrowser(ua);
    const osToken = dotted(match(/OS (\d+[_.]\d+(?:[_.]\d+)?) like Mac OS X/, ua));
    const safariVersion = match(/Version\/(\d+(?:\.\d+)*)/, ua);
    let osVersion = osToken;
    // С iOS 26 версия системы в user agent заморожена на 18.6/18.7 — настоящая
    // в версии Safari. У iPad «как Mac» системы в user agent нет вовсе.
    if (
      safariVersion &&
      (ipadAsMac || (Number(safariVersion.split(".")[0]) >= 26 && osToken?.startsWith("18.")))
    ) {
      osVersion = safariVersion;
    }
    const isIpad = iosDevice === "iPad" || ipadAsMac;
    return {
      platform: "ios",
      osName: isIpad ? "iPadOS" : "iOS",
      osVersion,
      model: isIpad ? "iPad" : (iosDevice ?? "iPhone"),
      browser,
      browserVersion,
    };
  }

  if (/Android/.test(ua)) {
    const [browser, browserVersion] = otherBrowser(ua);
    const model = androidModel(ua);
    // С заглушкой модели («K») и версия системы — заглушка («Android 10»).
    const osVersion = model ? match(/Android (\d+(?:\.\d+)?)/, ua) : null;
    return { platform: "android", osName: "Android", osVersion, model, browser, browserVersion };
  }

  const [browser, browserVersion] = otherBrowser(ua);
  let osName: string | null = null;
  let osVersion: string | null = null;
  if (/Windows NT/.test(ua)) osName = "Windows";
  else if (/CrOS/.test(ua)) osName = "ChromeOS";
  else if (/Macintosh|Mac OS X/.test(ua)) osName = "macOS";
  else if (/Linux/.test(ua)) osName = "Linux";
  if (osName === "Windows") {
    // Windows 11 тоже пишет «NT 10.0» — версию не угадываем.
    osVersion = null;
  }
  return { platform: "other", osName, osVersion, model: null, browser, browserVersion };
}

/** Ответ navigator.userAgentData.getHighEntropyValues (Chrome на Android). */
export type ClientHints = { model?: string; platformVersion?: string };

/** «14.0.0» → «14», «8.1.0» → «8.1». */
function shortVersion(v: string): string | null {
  const parts = v.split(".").filter(Boolean);
  if (!parts.length || !/^\d+$/.test(parts[0])) return null;
  return parts[1] && parts[1] !== "0" ? `${parts[0]}.${parts[1]}` : parts[0];
}

/** Настоящие модель и версия Android из Client Hints — поверх user agent. */
export function mergeClientHints(parsed: ParsedDevice, hints: ClientHints | null): ParsedDevice {
  if (!hints || parsed.platform !== "android") return parsed;
  const model = hints.model?.trim() || null;
  const version = hints.platformVersion ? shortVersion(hints.platformVersion) : null;
  return {
    ...parsed,
    model: model ?? parsed.model,
    osVersion: version ?? parsed.osVersion,
  };
}

/** Модель для людей: у Samsung и Google — с маркой («Samsung SM-S918B»). */
export function deviceModelLabel(parsed: ParsedDevice): string | null {
  const m = parsed.model;
  if (!m || parsed.platform !== "android") return m;
  if (/^SM-/i.test(m)) return `Samsung ${m}`;
  if (/^Pixel/i.test(m)) return `Google ${m}`;
  return m;
}

/**
 * Семейство iPhone по экрану (точки в портретной ориентации и плотность):
 * модели одного размера не различить — перечисляем их. Режим «Увеличенный»
 * в настройках экрана показывает размер меньшей модели. Не нашли — null.
 */
const IPHONE_SCREENS: [number, number, number, string][] = [
  [320, 568, 2, "iPhone 5s / SE"],
  [375, 667, 2, "iPhone 6–8 / SE 2–3"],
  [414, 736, 3, "iPhone 6–8 Plus"],
  [375, 812, 3, "iPhone X / XS / 11 Pro / 12 mini / 13 mini"],
  [414, 896, 2, "iPhone XR / 11"],
  [414, 896, 3, "iPhone XS Max / 11 Pro Max"],
  [390, 844, 3, "iPhone 12 / 13 / 14 / 16e"],
  [428, 926, 3, "iPhone 12 Pro Max / 13 Pro Max / 14 Plus"],
  [393, 852, 3, "iPhone 14 Pro / 15 / 15 Pro / 16"],
  [430, 932, 3, "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus"],
  [402, 874, 3, "iPhone 16 Pro / 17 / 17 Pro"],
  [420, 912, 3, "iPhone Air"],
  [440, 956, 3, "iPhone 16 Pro Max / 17 Pro Max"],
];

export function iphoneModelByScreen(width: number, height: number, dpr: number): string | null {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const d = Math.round(dpr);
  return IPHONE_SCREENS.find(([sw, sh, sd]) => sw === w && sh === h && sd === d)?.[3] ?? null;
}

/** Раздел приложения по адресу — ключ статистики (подписи — в админке, lib/client-app.ts). */
export function screenKey(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path.startsWith("/news/")) return "news";
  const first = path.split("/")[1];
  switch (first) {
    case "schedule":
    case "memberships":
    case "club":
    case "notifications":
    case "profile":
    case "feedback":
      return first;
    default:
      // Вход, анкета, политика, приглашение — не разделы приложения.
      return null;
  }
}
