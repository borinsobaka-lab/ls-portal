/**
 * VK Ads — сбор лид-форм: правила их lead_forms_collector.py без запросов
 * (строка Google-таблицы A–W, время заявки, ответы анкеты, ссылка на профиль,
 * день заявки по Москве) и разбор ссылки на папку Google Drive.
 */
import { pyFloatStr } from "../reviews/parse";

/** Их HEADERS — колонки A–W таблицы кабинета. */
export const LF_HEADERS = [
  "ID заявки VK",
  "ID рекламного кабинета VK",
  "ID кампании VK",
  "ID группы VK",
  "ID объявления VK",
  "ID лид-формы VK",
  "Лид-форма",
  "Кабинет",
  "Город",
  "Партнёр",
  "Имя",
  "Фамилия",
  "Телефон",
  "E-mail",
  "Ответы на вопросы анкеты",
  "Дата заявки VK",
  "Получено порталом",
  "Статус VK",
  "ID показа VK",
  "ID конверсии VK",
  "Время согласия",
  "Технические данные VK (JSON)",
  "Ссылка на соц. сеть",
];
export const LF_PAGE_SIZE = 100;
export const LF_DEFAULT_SHEET = "Заявки";

export const lfLeadsPath = (formId: string, limit: number, offset: number) =>
  `/api/v1/lead_ads/leads.json?${new URLSearchParams({
    lead_form_id: formId,
    limit: String(limit),
    offset: String(offset),
  }).toString()}`;

/** str(value) Python: None — «None», числа — как у Python. */
export function pyStr(value: unknown): string {
  if (value === null) return "None";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatStr(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** «value or ''» Python: пустое, 0, False, None — пусто. */
const truthy = (v: unknown) =>
  !(
    v === null ||
    v === undefined ||
    v === "" ||
    v === 0 ||
    v === false ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** datetime.fromisoformat(…).timestamp(): без зоны — UTC (часовой пояс их сервера). */
function isoSeconds(text: string): number | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0", frac = ""] = m.slice(1, 8);
  if (+mo < 1 || +mo > 12 || +d < 1 || +h > 23 || +mi > 59 || +s > 59) return null;
  const last = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
  if (+d > last) return null;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + Number(`0.${frac || "0"}`) * 1000;
  const zone = m[8];
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * 60_000;
  }
  return Math.trunc(ms / 1000);
}

/** Их _epoch: секунды (миллисекунды — делятся), строка цифр или ISO; иначе 0. */
export function lfEpoch(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    const n = Math.trunc(value);
    return n > 100_000_000_000 ? Math.floor(n / 1000) : n;
  }
  const text = pyStr(truthy(value) ? value : "").trim();
  if (/^\d+$/.test(text)) return lfEpoch(Number(text));
  if (text) return isoSeconds(text.replace(/Z$/, "+00:00")) ?? 0;
  return 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Их _display_time: «ДД.ММ.ГГГГ ЧЧ:ММ:СС +0300» по Москве; без времени — как есть. */
export function lfDisplayTime(value: unknown): string {
  const stamp = lfEpoch(value);
  if (stamp) {
    const t = new Date((stamp + 3 * 3600) * 1000);
    return (
      `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} ` +
      `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} +0300`
    );
  }
  return pyStr(truthy(value) ? value : "");
}

/** День заявки по Москве (их stat_date) или null, если времени нет. */
export function lfStatDate(value: unknown): string | null {
  const stamp = lfEpoch(value);
  if (!stamp) return null;
  return new Date((stamp + 3 * 3600) * 1000).toISOString().slice(0, 10);
}

/** Их _json: пусто — "", иначе JSON без пробелов (ensure_ascii=False). */
export function lfJson(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return JSON.stringify(value);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Первое «истинное» из полей (их a or b or c). */
function firstTruthy(o: Record<string, unknown>, keys: string[], fallback: unknown): unknown {
  for (const k of keys) if (truthy(o[k])) return o[k];
  return fallback;
}

/** Их _answer_text: «Вопрос: ответ1, ответ2» построчно. */
export function lfAnswerText(lead: Record<string, unknown>): string {
  const answers = lead.answers;
  if (!Array.isArray(answers)) return "";
  const lines: string[] = [];
  for (const item of answers) {
    if (!isObj(item)) continue;
    const question = pyStr(firstTruthy(item, ["question_text", "label", "title"], "Вопрос")).trim();
    let raw = firstTruthy(item, ["answer_options", "answers", "answer", "value"], []);
    if (!Array.isArray(raw)) raw = [raw];
    const values: string[] = [];
    for (const option of raw as unknown[]) {
      const text = isObj(option)
        ? firstTruthy(option, ["text", "title", "value", "name"], undefined)
        : option;
      if (text !== null && text !== undefined && text !== "") values.push(pyStr(text).trim());
    }
    if (values.length) lines.push(`${question}: ${values.join(", ")}`);
  }
  return lines.join("\n");
}

/** Их _profile_url: contact_info.social_media_profile, если VK его отдал. */
export function lfProfileUrl(lead: Record<string, unknown>): string {
  const contact = lead.contact_info;
  if (!isObj(contact)) return "";
  return pyStr(truthy(contact.social_media_profile) ? contact.social_media_profile : "").trim();
}

export type LfRecord = {
  vk_lead_id: string;
  vk_account_id: string;
  ad_plan_id: string;
  ad_group_id: string;
  banner_id: string;
  vk_form_id: string;
  form_name: string | null;
  account_name: string;
  city: string;
  partner_name: string;
  created_at_vk: string;
  received_at: number;
};

/** Их _lead_row: строка таблицы A–W. */
export function lfRow(r: LfRecord, lead: Record<string, unknown>): string[] {
  const contact = isObj(lead.contact_info) ? lead.contact_info : {};
  const get = (o: Record<string, unknown>, k: string) => pyStr(k in o ? o[k] : "");
  return [
    r.vk_lead_id,
    r.vk_account_id,
    r.ad_plan_id,
    r.ad_group_id,
    r.banner_id,
    r.vk_form_id,
    r.form_name || "",
    r.account_name,
    r.city,
    r.partner_name,
    get(contact, "first_name"),
    get(contact, "last_name"),
    get(contact, "phone"),
    get(contact, "email"),
    lfAnswerText(lead),
    lfDisplayTime(r.created_at_vk),
    lfDisplayTime(r.received_at),
    get(lead, "status"),
    get(lead, "impression_id"),
    get(lead, "vk_conversion_id"),
    lfDisplayTime("consent_timestamp" in lead ? lead.consent_timestamp : ""),
    lfJson(lead),
    lfProfileUrl(lead),
  ];
}

/** Их название новой таблицы кабинета. */
export const lfSheetTitle = (city: string, name: string) =>
  `${city || "Без города"} — ${name} — ЛФ VK Ads`;

/** Их проверка ссылки на папку Drive (lead-forms/create). */
export function lfFolderId(url: string): string {
  const u = url.trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(u);
  const id = m ? (m[3].replace(/\/+$/, "").split("/").pop() ?? "") : "";
  if (
    !m ||
    m[1].toLowerCase() !== "https" ||
    !["drive.google.com", "www.drive.google.com"].includes(m[2]) ||
    !id ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    throw new Error("Укажите корректную ссылку на папку Google Drive.");
  }
  return id;
}

/** Их audit_date_fields: поля ответа VK, похожие на дату или время. */
export function lfDateFields(lead: Record<string, unknown>): string[] {
  return Object.keys(lead).filter((k) =>
    ["date", "time", "created", "consent"].some((w) => k.toLowerCase().includes(w)),
  );
}
