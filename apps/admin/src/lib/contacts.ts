// Проверка и нормализация контактов клиента (телефон, email) — без React,
// покрыто тестом contacts.test.ts.
//
// Телефон хранится в E.164 («+995555123456»): одна запись на номер, по ней
// ищут, по ней пойдут SMS/WhatsApp-рассылки. Администратору код страны знать
// не нужно: номер без «+» читается как номер страны по умолчанию (Грузия),
// номер с «+» — как международный, страна определяется сама. Если номер не
// подходит выбранной стране, но с «+» впереди он верный (написали 7916…,
// 37529…), предлагаем эту страну.

import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";

export type { CountryCode };

/** Страна номера без «+» — студии в Тбилиси. */
export const DEFAULT_PHONE_COUNTRY: CountryCode = "GE";

/** Страны, откуда чаще всего клиенты, — вверху списка. */
const TOP_COUNTRIES: CountryCode[] = ["GE", "RU", "UA", "BY", "KZ", "AM", "AZ", "TR", "IL", "US"];

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["ru"], { type: "region" });
  } catch {
    return null;
  }
})();

export function countryName(code: CountryCode): string {
  return regionNames?.of(code) ?? code;
}

/** Флаг из кода страны (региональные индикаторы Unicode). */
export function countryFlag(code: CountryCode): string {
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export type PhoneCountry = { code: CountryCode; name: string; dial: string; top: boolean };

let countriesCache: PhoneCountry[] | null = null;

/** Все страны: сначала частые, потом остальные по алфавиту. */
export function phoneCountries(): PhoneCountry[] {
  if (countriesCache) return countriesCache;
  const all = getCountries().map((code) => ({
    code,
    name: countryName(code),
    dial: `+${getCountryCallingCode(code)}`,
    top: TOP_COUNTRIES.includes(code),
  }));
  const top = TOP_COUNTRIES.flatMap((c) => all.filter((x) => x.code === c));
  const rest = all.filter((x) => !x.top).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  countriesCache = [...top, ...rest];
  return countriesCache;
}

export type PhoneCheck =
  | { status: "empty" }
  | {
      status: "valid";
      /** Для записи в базу: +995555123456. */
      e164: string;
      country: CountryCode | undefined;
      /** Для показа: +995 555 12 34 56. */
      display: string;
    }
  | {
      status: "invalid";
      error: string;
      /** Тот же набор цифр оказался верным международным номером. */
      suggestion?: { e164: string; country: CountryCode | undefined; display: string };
    };

/**
 * Разбор номера, введённого администратором. `country` — страна, выбранная
 * у поля; номер с «+» (или 00) её не слушает — код страны уже в номере.
 */
export function checkPhone(raw: string, country: CountryCode = DEFAULT_PHONE_COUNTRY): PhoneCheck {
  const input = raw.trim().replace(/^00/, "+");
  const digits = input.replace(/\D/g, "");
  if (!digits) return { status: "empty" };
  if (/[a-zа-яё]/i.test(input)) return { status: "invalid", error: "В номере только цифры" };

  const international = input.startsWith("+");
  const parsed = parsePhoneNumberFromString(input, international ? undefined : country);
  if (parsed?.isValid()) {
    return {
      status: "valid",
      e164: parsed.number,
      country: parsed.country,
      display: parsed.formatInternational(),
    };
  }

  if (!international) {
    // Часто номер диктуют целиком с кодом страны, но без «+».
    const asIntl = parsePhoneNumberFromString(`+${digits}`);
    if (asIntl?.isValid()) {
      return {
        status: "invalid",
        error: `Номер не подходит для страны «${countryName(country)}»`,
        suggestion: {
          e164: asIntl.number,
          country: asIntl.country,
          display: asIntl.formatInternational(),
        },
      };
    }
  }

  const where = international ? "" : ` для страны «${countryName(country)}»`;
  const short = parsed ? parsed.nationalNumber.length : digits.length;
  const error =
    international && !parsed
      ? "Не удалось определить код страны"
      : parsed && !parsed.isPossible() && short < 7
        ? `Номер неполный${where}`
        : `Неверный номер${where}`;
  return { status: "invalid", error };
}

/** Страна, которую форматтер распознал в международном номере (для флага у поля). */
export function phoneCountryOf(raw: string): CountryCode | undefined {
  const input = raw.trim().replace(/^00/, "+");
  if (!input.startsWith("+")) return undefined;
  const formatter = new AsYouType();
  formatter.input(input);
  return formatter.getCountry();
}

/**
 * Номер из базы для поля ввода: верный номер — в национальном виде у своей
 * страны, старый (не E.164, без кода) — как есть, поле покажет ошибку.
 */
export function phoneForEditing(stored: string | null | undefined): {
  value: string;
  country: CountryCode;
} {
  const v = (stored ?? "").trim();
  if (!v) return { value: "", country: DEFAULT_PHONE_COUNTRY };
  const parsed = parsePhoneNumberFromString(v.replace(/^00/, "+"), DEFAULT_PHONE_COUNTRY);
  if (parsed?.isValid() && parsed.country) {
    return { value: parsed.formatNational(), country: parsed.country };
  }
  return { value: v, country: DEFAULT_PHONE_COUNTRY };
}

/** Номер из базы для таблиц: E.164 — с пробелами, прочее — как записано. */
export function formatPhoneDisplay(stored: string | null | undefined): string {
  const v = (stored ?? "").trim();
  if (!v) return "";
  const parsed = v.startsWith("+") ? parsePhoneNumberFromString(v) : undefined;
  return parsed?.isValid() ? parsed.formatInternational() : v;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Почта для записи: без пробелов, в нижнем регистре (вход по почте регистр не различает). */
export function normalizeEmail(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

// Практичная проверка, а не RFC 5322: латиница, цифры и .+-_ до @, домен из
// меток через точку, зона — от 2 букв. Кириллические домены (почта.рф) у
// клиентов не встречаются, а кириллица в адресе — частая ошибка раскладки.
const EMAIL_RE =
  /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9_-])?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function emailError(raw: string): string | null {
  const v = normalizeEmail(raw);
  if (!v) return null;
  if (/[а-яё]/i.test(v)) return "В адресе русские буквы — переключите раскладку";
  const at = v.split("@").length - 1;
  if (at === 0) return "Нет символа @";
  if (at > 1) return "Символ @ должен быть один";
  const [local, domain] = v.split("@");
  if (!local) return "Нет имени до @";
  if (!domain.includes(".")) return "Нет домена после @ (например, gmail.com)";
  if (v.includes("..")) return "Две точки подряд";
  if (!EMAIL_RE.test(v)) return "Неверный адрес почты";
  return null;
}

// Популярные почтовые домены и их частые опечатки.
const EMAIL_DOMAIN_TYPOS: Record<string, string> = {
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.ru": "gmail.com",
  "gmai.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.comm": "gmail.com",
  "googlemail.co": "googlemail.com",
  "mail.ry": "mail.ru",
  "mail.ri": "mail.ru",
  "mali.ru": "mail.ru",
  "mial.ru": "mail.ru",
  "maill.ru": "mail.ru",
  "mail.com.ru": "mail.ru",
  "yandex.r": "yandex.ru",
  "yandex.ry": "yandex.ru",
  "yandeks.ru": "yandex.ru",
  "yandx.ru": "yandex.ru",
  "yadex.ru": "yandex.ru",
  "ya.r": "ya.ru",
  "inbox.ry": "inbox.ru",
  "bk.ry": "bk.ru",
  "list.ry": "list.ru",
  "rambler.ry": "rambler.ru",
  "icloud.co": "icloud.com",
  "icloud.con": "icloud.com",
  "iclod.com": "icloud.com",
  "icoud.com": "icloud.com",
  "icluod.com": "icloud.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "outlook.co": "outlook.com",
  "outlook.con": "outlook.com",
  "outlok.com": "outlook.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yaho.com": "yahoo.com",
};

/** «Возможно, вы имели в виду …» для частой опечатки в домене; иначе null. */
export function emailSuggestion(raw: string): string | null {
  const v = normalizeEmail(raw);
  const at = v.lastIndexOf("@");
  if (at < 1) return null;
  const fixed = EMAIL_DOMAIN_TYPOS[v.slice(at + 1)];
  return fixed ? `${v.slice(0, at)}@${fixed}` : null;
}
