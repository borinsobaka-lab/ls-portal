/**
 * FitBase — правила их кода без запросов (fitbase_runtime.py,
 * fitbase_trials.py): поддомен, суммы, даты, названия продуктов и пробные,
 * минимизация строк API, коды статусов записей, телефон и ключ клиента.
 * Берут сервер загрузки и страницы «Интеграции FitBase».
 */
import { casefold } from "../onec/rules";
import { pyStrip } from "../onec/xlsx-read";
import { pyStr } from "../vk/lf";

export const FB_BRANDS = ["Lady Stretch", "Lady Jump"] as const;

/** Их ValueError: текст показывается в состоянии загрузки как есть. */
export class FbError extends Error {}

/** Их OUTCOMES: что означает этап воронки FitBase. */
export const FB_OUTCOMES: Record<string, string> = {
  new: "Новый лид",
  working: "В работе",
  booked: "Записались на пробное",
  attended: "Пришли",
  paid: "Купили",
  no_show: "Не пришли",
  no_purchase: "Пришли, не купили",
  lost: "Закрыто и не реализовано",
  ignore: "Не учитывать",
};

/** Их привязка источников к бюджету. */
export const FB_SOURCE_BUDGETS: [string, string][] = [
  ["none", "Без бюджета"],
  ["community_messages", "VK · сообщения"],
  ["lead_forms", "VK · лид-формы"],
];

/** Их ATTENDANCE_STATUSES и ATTENDANCE_CODES (коды проверены в кабинете FitBase). */
export const FB_ATTENDANCE_STATUSES: Record<string, string> = {
  registered: "Не подтверждено",
  confirmed: "Подтверждено",
  visited: "Пришёл",
  no_show: "Не пришёл",
  late_cancel: "Поздняя отмена",
  refused: "Отказался",
  waiting: "Лист ожидания",
  pending_payment: "Ожидание оплаты",
};
export const FB_ATTENDANCE_CODES: Record<string, string> = {
  "0": "registered",
  "1": "confirmed",
  "2": "refused",
  "3": "visited",
  "4": "no_show",
  "5": "late_cancel",
  "7": "waiting",
  "8": "pending_payment",
};

/** Их подписи разделов выгрузки (fetch.labels). */
export const FB_ENDPOINT_LABELS: Record<string, string> = {
  "club-items": "Клубы",
  "purchase-funnel": "Воронки",
  "purchase-funnel-step": "Этапы",
  "advertising-source": "Источники",
  lead: "Лиды",
  "client-contract": "Абонементы",
  "client-service": "Названия услуг",
  "activated-services": "Связи записей с услугами",
  schedule: "Занятия",
  "schedule-registration": "Записи на занятия",
  "till-order-steps": "Оплаты и возвраты",
};

/** Разделы, которые их загрузка ведёт постранично с повторами (progressive). */
export const FB_PAGED = new Set([
  "lead",
  "client-contract",
  "client-service",
  "activated-services",
  "schedule",
  "schedule-registration",
  "till-order-steps",
]);

export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** «value or {}» Python для словарей. */
export const obj = (v: unknown): Json => (isObj(v) ? v : {});
/** Ложное в Python: None, False, 0, '', пустые список и словарь. */
export const pyFalsy = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === false ||
  v === 0 ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (isObj(v) && Object.keys(v).length === 0);

/** Их проверка «удалено / нет даты»: значения None, '', 0, '0'. */
export const fbEmptyMark = (v: unknown) =>
  v === null || v === undefined || v === "" || v === 0 || v === "0";

// --- Поддомен ------------------------------------------------------------------------

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_TEXT = "Нужен поддомен клуба FitBase, например lady-stretch.";
/** Их domain(): адрес https://клуб.fitbase.io (без пути и параметров) или поддомен. */
export function fbDomain(raw: string): string {
  let value = pyStrip(raw).toLowerCase();
  const sep = value.indexOf("://");
  if (sep >= 0) {
    const scheme = value.slice(0, sep);
    let rest = value.slice(sep + 3);
    const hashAt = rest.indexOf("#");
    const fragment = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
    if (hashAt >= 0) rest = rest.slice(0, hashAt);
    const queryAt = rest.indexOf("?");
    const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";
    if (queryAt >= 0) rest = rest.slice(0, queryAt);
    const pathAt = rest.indexOf("/");
    const netloc = pathAt >= 0 ? rest.slice(0, pathAt) : rest;
    const path = pathAt >= 0 ? rest.slice(pathAt) : "";
    const at = netloc.lastIndexOf("@");
    const userinfo = at >= 0 ? netloc.slice(0, at) : null;
    const hostport = at >= 0 ? netloc.slice(at + 1) : netloc;
    const colon = userinfo === null ? -1 : userinfo.indexOf(":");
    const username = userinfo === null ? "" : colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const password = userinfo !== null && colon >= 0 ? userinfo.slice(colon + 1) : "";
    const portAt = hostport.lastIndexOf(":");
    const port = portAt >= 0 && !hostport.endsWith("]") ? hostport.slice(portAt + 1) : "";
    if (port && !/^\d+$/.test(port)) throw new FbError(DOMAIN_TEXT);
    if (
      scheme !== "https" ||
      username ||
      password ||
      (port && Number(port) !== 0) ||
      query ||
      fragment ||
      (path !== "" && path !== "/")
    ) {
      throw new FbError("Укажите поддомен FitBase без пути и параметров.");
    }
    value = portAt >= 0 && !hostport.endsWith("]") ? hostport.slice(0, portAt) : hostport;
  }
  for (const suffix of [".fitbase.io", ".fitbase.tech", ".fitbase.team"]) {
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  if (!DOMAIN_RE.test(value)) throw new FbError(DOMAIN_TEXT);
  return value;
}

/** Их проверки save() до записи (порядок — их): домен, партнёр, поля, ключ. */
export function fbConnectionInput(v: {
  id: number | null;
  name: string;
  brand: string;
  city: string;
  domain: string;
  partner: string;
  key: string;
}) {
  const domain = fbDomain(v.domain);
  const partner = pyStrip(v.partner);
  if (Array.from(partner).length > 150) throw new FbError("Имя партнёра — не больше 150 символов.");
  const name = pyStrip(v.name);
  const city = pyStrip(fbCanonicalCity(v.brand, v.city));
  if (
    !name ||
    !city ||
    Array.from(name).length > 150 ||
    Array.from(city).length > 100 ||
    !(FB_BRANDS as readonly string[]).includes(v.brand)
  ) {
    throw new FbError("Заполните студию, направление и город.");
  }
  const key = pyStrip(v.key);
  if (!v.id && !key) throw new FbError("Введите API-ключ.");
  if (key.includes("\n") || key.includes("\r") || key.length > 8192) {
    throw new FbError("Некорректный API-ключ.");
  }
  return { domain, partner, name, city, key };
}

/** Их city_aliases.canonical_city. */
export function fbCanonicalCity(brand: string, city: string): string {
  const cleaned = pyStrip(city.replace(/\u00a0/g, " "));
  if (
    pyStrip(brand) === "Lady Jump" &&
    ["Казань", "Казань Вишневского", "Казань · Вишневского"].includes(cleaned)
  ) {
    return "Казань · Вишневского";
  }
  return city;
}

// --- Суммы -----------------------------------------------------------------------------

const MONEY_ERROR = "Не удалось прочитать сумму абонемента FitBase. Предыдущая выгрузка сохранена.";

/**
 * Их money_cents: Decimal(str(v) без пробелов, запятая — точка) × 100,
 * ROUND_HALF_UP; |сумма| ≤ 1e9. Нет суммы (None, bool) — своя ошибка.
 */
export function fbMoneyCents(value: unknown): number {
  if (value === null || value === undefined || typeof value === "boolean") {
    throw new FbError("FitBase не передал сумму абонемента. Предыдущая выгрузка сохранена.");
  }
  if (typeof value !== "string" && typeof value !== "number") throw new FbError(MONEY_ERROR);
  const text = pyStrip(
    pyStr(value)
      .replace(/\u00a0/g, "")
      .replace(/ /g, "")
      .replace(/,/g, "."),
  );
  const m =
    /^([+-]?)(?:(\d(?:_?\d)*)(?:\.((?:\d(?:_?\d)*)?))?|\.(\d(?:_?\d)*))(?:[eE]([+-]?\d(?:_?\d)*))?$/.exec(
      text,
    );
  if (!m) throw new FbError(MONEY_ERROR);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = (m[2] ?? "").replace(/_/g, "");
  const frac = (m[3] ?? m[4] ?? "").replace(/_/g, "");
  const exp = Number((m[5] ?? "0").replace(/_/g, ""));
  // Значение = digits × 10^(exp − frac.length); нужно ×100 и округлить.
  const digits = BigInt((intPart + frac).replace(/^0+(?=\d)/, "") || "0");
  const scale = exp - frac.length + 2;
  // |сумма| ≤ 1e9 (их Decimal('1000000000')): digits × 10^(scale−2) ≤ 10^9.
  const limit = scale - 2;
  if (digits !== 0n) {
    if (
      limit >= 0 ? digits * 10n ** BigInt(limit) > 10n ** 9n : digits > 10n ** BigInt(9 - limit)
    ) {
      throw new FbError(MONEY_ERROR);
    }
  }
  let cents: bigint;
  if (scale >= 0) cents = digits * 10n ** BigInt(scale);
  else {
    const div = 10n ** BigInt(-scale);
    const q = digits / div;
    const r = digits % div;
    cents = r * 2n >= div ? q + 1n : q;
  }
  return Number(sign * cents);
}

// --- Время -----------------------------------------------------------------------------

export const FB_MSK = "Europe/Moscow";
/** Их REVENUE_TZ: выручка — по Самаре. */
export const FB_REVENUE_TZ = "Europe/Samara";

const partsFormat = new Map<string, Intl.DateTimeFormat>();
function zoneParts(epochMs: number, zone: string) {
  let f = partsFormat.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormat.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Дата «ГГГГ-ММ-ДД» метки времени (секунды) в поясе зоны (их fromtimestamp(...).date()). */
export function fbDay(epochSeconds: number, zone = FB_MSK): string {
  const p = zoneParts(Math.floor(epochSeconds) * 1000, zone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Год метки времени в поясе зоны. */
export function fbYear(epochSeconds: number, zone = FB_MSK): number {
  return zoneParts(Math.floor(epochSeconds) * 1000, zone).year;
}

/** Секунды Unix для «настенного» времени в поясе зоны (их replace(tzinfo=ZoneInfo)). */
export function fbWallToEpoch(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  zone = FB_MSK,
): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, zone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += asUtc - shown;
  }
  return guess / 1000;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6})\d*)?)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;

/** datetime.fromisoformat (с «Z» как +00:00): секунды Unix или null. */
function fromIso(text: string): number | null {
  const m = ISO_RE.exec(text.replace("Z", "+00:00"));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const micro = m[7] ? Number(m[7].padEnd(6, "0")) / 1e6 : 0;
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  if (!m[8]) return fbWallToEpoch(y, mo, d, h, mi, s) + micro;
  const off = m[8].replace(/:/g, "");
  const sign = off[0] === "-" ? -1 : 1;
  const oh = Number(off.slice(1, 3));
  const om = Number(off.slice(3, 5) || 0);
  const os = Number(off.slice(5, 7) || 0);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 + micro - sign * (oh * 3600 + om * 60 + os);
}

function validDate(y: number, mo: number, d: number): boolean {
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysIn(y, mo);
}
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysIn = (y: number, mo: number) =>
  [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];

/** strptime по их форматам «дд.мм.гггг[ чч:мм[:сс]]» — по Москве. */
function fromDotted(text: string): number | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(text);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 61) return null;
  return fbWallToEpoch(y, mo, d, h, mi, Math.min(s, 59));
}

const pyTypeName = (v: unknown) =>
  v === null || v === undefined
    ? "NoneType"
    : typeof v === "boolean"
      ? "bool"
      : typeof v === "number"
        ? Number.isInteger(v)
          ? "int"
          : "float"
        : typeof v === "string"
          ? "str"
          : Array.isArray(v)
            ? "list"
            : "dict";

/**
 * Их lead_created_at: created_at, иначе analytics.created_at_date; число —
 * секунды (от 1e11 — миллисекунды), строка — ISO или «дд.мм.гггг …» (без
 * пояса — Москва); год 1970–2200. Не прочиталось — их ошибка.
 */
export function fbCreatedAt(row: Json): number {
  const candidates = [row.created_at, obj(row.analytics).created_at_date];
  for (const value of candidates) {
    if (value === null || value === undefined || typeof value === "boolean") continue;
    const text = pyStrip(typeof value === "string" ? value : pyStr(value));
    if (!text) continue;
    let stamp: number | null;
    if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(text)) {
      let n = typeof value === "number" ? value : Number(text);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (n >= 100000000000) n /= 1000;
      stamp = n;
    } else {
      stamp = fromIso(text) ?? fromDotted(text);
      if (stamp === null) continue;
    }
    const year = fbYear(Math.floor(stamp));
    if (year < 1970 || year > 2200) continue;
    const whole = Math.trunc(stamp);
    if (whole > 0) return whole;
  }
  throw new FbError(
    `Не удалось прочитать дату создания лида FitBase #${pyStr(row.id ?? "?")} (формат ${pyTypeName(row.created_at)}). Предыдущие данные сохранены.`,
  );
}

// --- Продукты и пробные ----------------------------------------------------------------

/** \bпробн[а-яё]*\b с re.I: границы слова Python (буквы, цифры, «_»). */
const TRIAL_RE = /(?<![\p{L}\p{N}_])пробн[а-яё]*(?![\p{L}\p{N}_])/iu;
const isTrialName = (label: string) => (TRIAL_RE.test(label) ? 1 : 0);
const uniqueJoin = (labels: string[]) => [...new Set(labels)].join(" / ");

/** Их trial_product: название абонемента (и услуги у записи) и признак «пробн…». */
export function fbTrialProduct(row: Json, registration = false): [string, number] {
  const contract = registration ? obj(row.contract) : row;
  const item = obj(obj(contract.ticket).contract_item);
  const labels: unknown[] = [contract.contract_name, item.name];
  if (registration) {
    labels.push(obj(obj(obj(row.service).service).available_service).name);
  }
  const clean = labels
    .filter((v): v is string => typeof v === "string" && pyStrip(v) !== "")
    .map((v) => pyStrip(v));
  const label = uniqueJoin(clean);
  return [label, label ? isTrialName(label) : -1];
}

/** Их normalize_registration: client_contract / client_service — как contract / service. */
export function fbNormalizeRegistration(row: Json): Json {
  const out = { ...row };
  if ("client_contract" in row) out.contract = row.client_contract;
  if ("client_service" in row) out.service = row.client_service;
  return out;
}

/** Их fitbase_trials.product: флаг услуги is_trial, иначе названия. */
export function fbClassifiedProduct(raw: Json): [string, number] {
  const row = fbNormalizeRegistration(raw);
  const service = obj(obj(obj(row.service).service).available_service);
  const contract = obj(row.contract);
  const names = [
    service.name,
    contract.contract_name,
    obj(obj(contract.ticket).contract_item).name,
  ];
  const label = uniqueJoin(
    names.filter((v): v is string => typeof v === "string" && pyStrip(v) !== "").map(pyStrip),
  );
  if (typeof service.is_trial === "boolean") return [label, service.is_trial ? 1 : 0];
  return [label, label ? isTrialName(label) : -1];
}

const pick = (row: Json, keys: readonly string[]) => {
  const out: Json = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
};
const pickAll = (row: Json, keys: readonly string[]) => {
  const out: Json = {};
  for (const k of keys) out[k] = row[k] ?? null;
  return out;
};

const CHECKPOINT_FIELDS: Record<string, readonly string[]> = {
  lead: ["id", "client_id", "phone", "created_at"],
  "client-contract": [
    "id",
    "client_id",
    "created_at",
    "deleted_at",
    "price",
    "price_full",
    "amount_of_payment",
  ],
  "client-service": ["id", "client_id"],
  "activated-services": ["id", "client_id", "registration_id", "activation_date"],
  schedule: ["id", "date", "time_start", "time_end", "event_type", "cancel", "registrations_count"],
  "schedule-registration": ["id", "client_id", "status"],
  "till-order-steps": ["id", "pay_date", "amount", "item_type", "item_id", "client_id"],
};

/** Их checkpoint_row: только поля, нужные отчётам (без DTO клиента). */
export function fbCheckpointRow(endpoint: string, input: Json): Json {
  let row = input;
  const result = pick(row, [...(CHECKPOINT_FIELDS[endpoint] ?? []), "updated_at", "deleted_at"]);
  for (const key of ["club", "funnel_step", "advertising_source"]) {
    if (key in row) result[key] = { id: obj(row[key]).id ?? null };
  }
  if ("analytics" in row) {
    result.analytics = { created_at_date: obj(row.analytics).created_at_date ?? null };
  }
  if ("training" in row) result.training = pickAll(obj(row.training), ["id", "name"]);
  if ("event" in row) result.event = pickAll(obj(row.event), ["id", "registrations_count"]);
  if (endpoint === "till-order-steps" && "client" in row) {
    result.client = { id: obj(row.client).id ?? null };
  }
  if (endpoint === "till-order-steps" && "item" in row) {
    result.item = pickAll(obj(row.item), ["id", "type"]);
  }
  if (endpoint === "schedule-registration") row = fbNormalizeRegistration(row);
  if (endpoint === "client-contract" || endpoint === "schedule-registration") {
    const contract = endpoint === "client-contract" ? row : obj(row.contract);
    const item = obj(obj(contract.ticket).contract_item);
    const product = {
      id: contract.id ?? null,
      contract_name: contract.contract_name ?? null,
      ticket: { contract_item: pickAll(item, ["id", "name"]) },
    };
    if (endpoint === "client-contract") {
      result.contract_name = product.contract_name;
      result.ticket = product.ticket;
    } else {
      result.contract = product;
      const clientService = obj(row.service);
      const variant = obj(clientService.service);
      const service = obj(variant.available_service);
      result.service = {
        id: clientService.id ?? null,
        client_id: clientService.client_id ?? null,
        service: {
          id: variant.id ?? null,
          available_service: pickAll(service, ["id", "name", "is_trial"]),
        },
      };
    }
  }
  if (endpoint === "client-service") {
    const variant = obj(row.service);
    const service = obj(variant.available_service);
    result.service = {
      id: variant.id ?? null,
      available_service: pickAll(service, ["id", "name", "is_trial"]),
    };
  }
  if (endpoint === "activated-services") {
    const linked = fbCheckpointRow("schedule-registration", {
      service: row.client_service ?? null,
      contract: row.client_contract ?? null,
    });
    result.client_service = linked.service;
    result.client_contract = linked.contract;
  }
  return result;
}

// --- Клиент и этапы ------------------------------------------------------------------

/** Их phone_of: 11 цифр с 7 (8… → 7…, 10 цифр → 7 + номер), иначе пусто. */
export function fbPhone(lead: Json): string {
  let phone = (pyFalsy(lead.phone) ? "" : pyStr(lead.phone)).replace(/\P{Nd}/gu, "");
  if (phone.length === 11 && phone[0] === "8") phone = "7" + phone.slice(1);
  if (phone.length === 10) phone = "7" + phone;
  return phone.length === 11 ? phone : "";
}

/** Их suggested(): исход этапа по его названию, иначе «В работе». */
export function fbSuggested(name: string): string {
  const map: Record<string, string> = {
    "записались на пробное": "booked",
    "думают после пробного": "attended",
    "не пришли на пробное": "no_show",
    "не купили на пробном": "no_purchase",
    оплатили: "paid",
    "закрыто и не реализовано": "lost",
    "новая сделка": "new",
    "не дозвон": "working",
  };
  return map[casefold(pyStrip(name))] ?? "working";
}

/** Их attendance_effective_rules: коды FitBase + сохранённые соответствия. */
export function fbAttendanceRules(saved: unknown): Record<string, string> {
  const rules: Record<string, string> = { ...FB_ATTENDANCE_CODES };
  for (const [k, v] of Object.entries(obj(saved))) {
    if (typeof v === "string" && v in FB_ATTENDANCE_STATUSES) rules[k] = v;
  }
  return rules;
}

/** Их attendance_state_label: прежний текст расхождения счётчиков — понятнее. */
export function fbAttendanceStateLabel(value: string | null | undefined): string {
  return (value ?? "").replace(
    /Расхождение счётчиков у (\d+) занятий; полнота записей подтверждена API\./g,
    (_m, n: string) =>
      `Сверка всей загруженной истории: у ${n} занятий сводные счётчики FitBase отличаются. Полный список записей проверен по API; это не число пропущенных занятий.`,
  );
}

// --- Даты отчётов ---------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** date.fromisoformat: «ГГГГ-ММ-ДД», иначе их ValueError Python. */
export function fbIsoDate(text: string): { y: number; m: number; d: number } {
  const m = ISO_DAY.exec(text ?? "");
  if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new FbError(`Invalid isoformat string: '${text}'`);
  }
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
export const fbIso = (x: { y: number; m: number; d: number }) =>
  `${String(x.y).padStart(4, "0")}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
export function fbAddDays(day: string, days: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
export const fbDaysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Их shift(d, months): месяц вперёд/назад, день — не больше дней месяца. */
export function fbShiftMonths(day: string, months: number): string {
  const x = fbIsoDate(day);
  const n = x.y * 12 + x.m - 1 + months;
  const y = Math.floor(n / 12);
  const m = n - y * 12 + 1;
  return fbIso({ y, m, d: Math.min(x.d, daysIn(y, m)) });
}

/** Их attendance_window: период до 366 дней и те же дни месяц и год назад. */
export function fbAttendanceWindow(start: string, end: string) {
  fbIsoDate(start);
  fbIsoDate(end);
  if (end < start || fbDaysBetween(start, end) >= 366) {
    throw new FbError("Выберите период не больше 366 дней.");
  }
  return {
    start,
    end,
    pmStart: fbShiftMonths(start, -1),
    pmEnd: fbShiftMonths(end, -1),
    pyStart: fbShiftMonths(start, -12),
    pyEnd: fbShiftMonths(end, -12),
  };
}

/** Их revenue_period: текущий месяц по Самаре, «вчера» и шесть прошлых месяцев. */
export function fbRevenuePeriod(offset = 0, today?: string) {
  const now = today ?? fbDay(Date.now() / 1000, FB_REVENUE_TZ);
  if (!Number.isInteger(offset) || offset < 0 || offset > 60) {
    throw new FbError("Выберите историю не больше пяти лет.");
  }
  const first = `${now.slice(0, 8)}01`;
  const cutoff = fbAddDays(now, -1);
  const history = Array.from({ length: 6 }, (_, i) => fbShiftMonths(first, -(offset + i + 1)));
  const { y, m } = fbIsoDate(first);
  const monthEnd = fbAddDays(fbShiftMonths(first, 1), -1);
  const lastDay = cutoff < monthEnd ? cutoff : monthEnd;
  return {
    first,
    cutoff,
    days: daysIn(y, m),
    elapsed: Math.max(0, fbDaysBetween(first, lastDay) + 1),
    history,
    fromDate: history[history.length - 1],
    offset,
  };
}

/** Их schedule_label: когда следующая ночная загрузка (01:00 МСК). */
export function fbScheduleLabel(
  c: { club_id: string; busy: boolean },
  nightly: { last_run_day: string; error: string },
  nowSeconds = Date.now() / 1000,
): string {
  if (!c.club_id) return "Выберите клуб в настройках";
  if (nightly.error) return nightly.error;
  if (c.busy) return "Выполняется загрузка";
  const today = fbDay(nowSeconds);
  const p = zoneParts(nowSeconds * 1000, FB_MSK);
  const afterDue = p.hour >= 1;
  if (afterDue && nightly.last_run_day !== today) {
    return "Ночная загрузка ожидается в течение минуты · ежедневно в 01:00 МСК";
  }
  const day = afterDue ? fbAddDays(today, 1) : today;
  return `Следующая загрузка: ${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)} 01:00 МСК · ежедневно`;
}

/** Час по Москве (их local.hour). */
export const fbMskHour = (nowSeconds: number) => zoneParts(nowSeconds * 1000, FB_MSK).hour;
