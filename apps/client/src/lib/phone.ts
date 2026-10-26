/**
 * Номер телефона: код страны + национальный номер (решение владельца
 * 2026-10-13 — маска, чтобы не ошибиться). По умолчанию Грузия, +995: маска
 * «___ __ __ __» (9 цифр). Код можно стереть и ввести другой — тогда маски
 * нет, только цифры (по E.164 — не больше 15 вместе с кодом).
 *
 * В базе номер хранится строкой как раньше (clients.phone): «+995 555 12 34 56».
 * Чистая логика без React — проверяется в phone.test.ts; поле —
 * components/ui/phone-input.tsx.
 */

export const DEFAULT_DIAL_CODE = "995";

/** Маски национального номера по коду страны (X — цифра). */
const MASKS: Record<string, string> = {
  "995": "XXX XX XX XX",
};

/** Код → страна (ISO 3166-1 alpha-2) — для флага. +7 — Россия. */
export const DIAL_CODES: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "30": "GR",
  "31": "NL",
  "33": "FR",
  "34": "ES",
  "39": "IT",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "48": "PL",
  "49": "DE",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "98": "IR",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "373": "MD",
  "374": "AM",
  "375": "BY",
  "380": "UA",
  "966": "SA",
  "971": "AE",
  "972": "IL",
  "992": "TJ",
  "993": "TM",
  "994": "AZ",
  "995": "GE",
  "996": "KG",
  "998": "UZ",
};

const MAX_DIGITS = 15;

export type PhoneParts = {
  /** Код страны без «+», может быть пустым, пока его вводят. */
  code: string;
  /** Национальный номер — только цифры. */
  national: string;
};

const digitsOf = (s: string) => s.replace(/\D/g, "");

export function maskFor(code: string): string | null {
  return MASKS[code] ?? null;
}

/** Сколько цифр национального номера допустимо при этом коде. */
export function nationalMaxLength(code: string): number {
  const mask = maskFor(code);
  if (mask) return mask.replace(/[^X]/g, "").length;
  return Math.max(MAX_DIGITS - code.length, 4);
}

/** Самый длинный известный код в начале цифр («37491…» → «374»). */
function knownCodePrefix(digits: string): string | null {
  for (let len = 3; len >= 1; len--) {
    const c = digits.slice(0, len);
    if (c.length === len && DIAL_CODES[c]) return c;
  }
  return null;
}

/**
 * Разбор сохранённого или вставленного номера. Грузинский без кода
 * («555123456», «0555…») — тоже Грузия. Неизвестный формат не теряется:
 * все цифры уходят в номер, код пустой — клиент поправит.
 */
export function parsePhone(raw: string | null | undefined): PhoneParts {
  const s = (raw ?? "").trim();
  const digits = digitsOf(s);
  if (!digits) return { code: DEFAULT_DIAL_CODE, national: "" };

  const international = s.startsWith("+") || s.startsWith("00");
  const intl = s.startsWith("00") ? digits.slice(2) : digits;
  if (international) {
    const code = knownCodePrefix(intl);
    if (code) return { code, national: intl.slice(code.length) };
    return { code: "", national: intl.slice(0, MAX_DIGITS) };
  }
  // 995555123456 — грузинский с кодом без «+».
  if (digits.startsWith(DEFAULT_DIAL_CODE) && digits.length === 12) {
    return { code: DEFAULT_DIAL_CODE, national: digits.slice(3) };
  }
  // 555123456 / 0555123456 — грузинский мобильный без кода.
  const local = digits.replace(/^0/, "");
  if (local.length === 9 && local.startsWith("5")) {
    return { code: DEFAULT_DIAL_CODE, national: local };
  }
  return { code: "", national: digits.slice(0, MAX_DIGITS) };
}

/** Цифры номера по маске: «5910997» → «591 09 97». Без маски — как есть. */
export function formatNational(code: string, national: string): string {
  const mask = maskFor(code);
  if (!mask) return national;
  let out = "";
  let i = 0;
  for (const ch of mask) {
    if (i >= national.length) break;
    if (ch === "X") out += national[i++];
    else out += ch;
  }
  return out;
}

/** Остаток маски после набранного: «591 09 97» → « __» (подсказка, сколько осталось). */
export function maskRemainder(code: string, national: string): string {
  const mask = maskFor(code);
  if (!mask) return "";
  return mask.slice(formatNational(code, national).length).replace(/X/g, "_");
}

/** Строка для базы: «+995 555 12 34 56»; без номера — пусто. */
export function formatPhone({ code, national }: PhoneParts): string {
  if (!national) return "";
  const body = formatNational(code, national);
  return code ? `+${code} ${body}` : body;
}

/** Номер полный: у кода с маской — все цифры маски, иначе код и 6–12 цифр. */
export function isValidPhone(raw: string | null | undefined): boolean {
  const { code, national } = parsePhone(raw);
  if (!code) return false;
  const mask = maskFor(code);
  if (mask) return national.length === nationalMaxLength(code);
  return national.length >= 6 && national.length <= 12;
}

/**
 * Ввод в поле номера. Автоподстановка телефона или вставка часто приносят
 * номер целиком («+995 591…», «995591…») — тогда код тоже берётся из него.
 */
export function applyNationalInput(code: string, input: string): PhoneParts {
  const digits = digitsOf(input);
  const max = nationalMaxLength(code);
  const looksFull = input.trim().startsWith("+") || digits.length > max;
  if (looksFull) {
    const parsed = parsePhone(input.trim().startsWith("+") ? input : `+${digits}`);
    if (parsed.code) {
      return {
        code: parsed.code,
        national: parsed.national.slice(0, nationalMaxLength(parsed.code)),
      };
    }
  }
  return { code, national: digits.slice(0, max) };
}

/** Ввод в поле кода: только цифры, до 3. */
export function applyCodeInput(input: string): string {
  return digitsOf(input).slice(0, 3);
}
