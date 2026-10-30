/**
 * amoCRM — правила их amocrm.py без ввода-вывода: адрес и токен подключения,
 * значения полей сделки, источник, этапы и квалификация, строка сделки для
 * базы, итог сверки. Сделка хранится без контактов клиента.
 */
import { pyStr } from "../vk/lf";

export const AMO_BRANDS = ["Lady Stretch", "Lady Jump"] as const;
export type AmoBrand = (typeof AMO_BRANDS)[number];

/** Их MARKETING_START_AT: сделки, созданные раньше 01.09.2026 (UTC), не собираются. */
export const AMO_START = Date.UTC(2026, 8, 1) / 1000;
/** Перекрытие инкремента — 15 минут до прошлого успешного сбора. */
export const AMO_OVERLAP = 900;
export const AMO_PAGE = 250;
export const AMO_MAX_PAGES = 1000;
export const AMO_USER_AGENT = "LadyStretch-CRMIntegration/1.0";
/** Поля сделки, которые выбираются в «Правилах маркетинговой аналитики». */
export const AMO_FIELD_KEYS = [
  "auto_source_field_id",
  "manual_source_field_id",
  "booked_field_id",
  "attended_field_id",
  "paid_field_id",
  "close_basis_field_id",
] as const;
export type AmoFieldKey = (typeof AMO_FIELD_KEYS)[number];
export type AmoSettings = { new_lead_pipeline_id: string } & Record<AmoFieldKey, string>;

const ALLOWED_HOSTS = [".amocrm.ru", ".kommo.com"];

/** «x or ''» Python. */
const truthy = (v: unknown) =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === "" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );
const str = (v: unknown) => (truthy(v) ? pyStr(v) : "");
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** s[:n] Python (по символам, не по UTF-16). */
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/** int(x or 0) Python: строка цифр, число (вниз к нулю), True — 1; иное — ошибка. */
export function pyInt(v: unknown): number {
  if (!truthy(v)) return 0;
  if (v === true) return 1;
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  throw new Error(`invalid literal for int() with base 10: '${pyStr(v)}'`);
}

/** Их normalize_base_url: только https, домен amoCRM или Kommo, без пути. */
export function amoNormalizeBaseUrl(value: string): string {
  const bad = "Укажите адрес AmoCRM в виде https://ваш-поддомен.amocrm.ru";
  const s = value.trim().replace(/\/+$/, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(s);
  if (!m || m[1].toLowerCase() !== "https" || !["", "/"].includes(m[3])) throw new Error(bad);
  const netloc = m[2].slice(m[2].lastIndexOf("@") + 1);
  const hp = /^([^:[\]]+)(?::(\d*))?$/.exec(netloc);
  if (!hp || !hp[1]) throw new Error(bad);
  const host = hp[1].toLowerCase();
  const port = hp[2] ? Number(hp[2]) : 0;
  if (port > 65535) throw new Error(bad);
  if (!ALLOWED_HOSTS.some((h) => host.endsWith(h))) {
    throw new Error("Адрес должен относиться к AmoCRM (*.amocrm.ru) или Kommo (*.kommo.com).");
  }
  return `https://${host}${port ? `:${port}` : ""}`;
}

/** Их проверка токена: долгоживущий токен интеграции не короче 20 знаков. */
export function amoTokenCheck(token: string): string {
  const t = token.trim();
  if (t.length < 20) throw new Error("Токен AmoCRM выглядит неполным.");
  return t;
}

/** Их save_connection: название, токен, адрес — в этом порядке. */
export function amoConnectionCheck(v: { name: string; baseUrl: string; token: string }) {
  const name = cut(v.name.trim(), 160);
  if (!name) throw new Error("Укажите понятное название подключения.");
  const token = amoTokenCheck(v.token);
  return { name, token, baseUrl: amoNormalizeBaseUrl(v.baseUrl) };
}

// --- Справочники ---------------------------------------------------------------------

export type AmoPipeline = { id: string; name: string; is_archive: boolean };
export type AmoField = {
  id: string;
  name: string;
  code: string;
  enums: { id: string; value: string }[];
};
export type AmoUser = { id: string; name: string };

const embedded = (payload: unknown, key: string): unknown =>
  isObject(payload) && isObject(payload._embedded) ? payload._embedded[key] : [];

/**
 * Их fetch_metadata: списки воронок, полей сделки и пользователей. Храним
 * только id, названия и значения списков — без почт и прав пользователей.
 */
export function amoMetadata(
  pipelinesPayload: unknown,
  fieldsPayload: unknown,
  usersPayload: unknown,
) {
  const pipelines = embedded(pipelinesPayload, "pipelines") ?? [];
  const fields = embedded(fieldsPayload, "custom_fields") ?? [];
  const users = embedded(usersPayload, "users") ?? [];
  if (!Array.isArray(pipelines) || !Array.isArray(fields) || !Array.isArray(users)) {
    throw new Error("AmoCRM вернула неожиданный формат справочников.");
  }
  const id = (v: unknown) => (v === undefined || v === null ? "" : pyStr(v));
  return {
    pipelines: pipelines
      .filter(isObject)
      .map(
        (p): AmoPipeline => ({ id: id(p.id), name: str(p.name), is_archive: truthy(p.is_archive) }),
      ),
    fields: fields.filter(isObject).map(
      (f): AmoField => ({
        id: id(f.id),
        name: str(f.name),
        code: str(f.code),
        enums: (Array.isArray(f.enums) ? f.enums : [])
          .filter(isObject)
          .map((e) => ({ id: str(e.id), value: str(e.value) })),
      }),
    ),
    users: users.filter(isObject).map((u): AmoUser => ({ id: id(u.id), name: str(u.name) })),
  };
}

// --- Сделка --------------------------------------------------------------------------

/** Их _custom_value: id значения списка и текст первого значения поля. */
export function amoCustomValue(lead: Record<string, unknown>, fieldId: string): [string, string] {
  const fields = Array.isArray(lead.custom_fields_values) ? lead.custom_fields_values : [];
  for (const field of fields) {
    if (!isObject(field) || pyStr(field.field_id) !== fieldId) continue;
    const values = field.values;
    if (!Array.isArray(values) || !values.length || !isObject(values[0])) return ["", ""];
    const value = values[0];
    return [str(value.enum_id), cut(str(value.value).trim(), 300)];
  }
  return ["", ""];
}

const NO = new Set(["", "0", "false", "нет", "no", "null", "none"]);

/** Их _flag: этап пройден, если значение поля не пустое и не «нет». */
export function amoFlag(lead: Record<string, unknown>, fieldId: string): 0 | 1 {
  return NO.has(amoCustomValue(lead, fieldId)[1].toLowerCase()) ? 0 : 1;
}

const UTM = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_referrer",
] as const;
export type UtmKey = (typeof UTM)[number];

/** Их _utm_field_ids: поля UTM — по коду (или названию) поля. */
export function amoUtmFieldIds(fields: { id: string; code: string; name: string }[]) {
  const result: Partial<Record<UtmKey, string>> = {};
  for (const f of fields) {
    const label = (f.code || f.name || "").toLowerCase().replaceAll(" ", "_");
    for (const key of UTM) if (label === key) result[key] = f.id;
  }
  return result;
}

export type AmoResponsible = {
  amo_user_name: string;
  brand: string;
  city: string;
  partner_name: string;
};

export type AmoSyncContext = {
  settings: AmoSettings;
  utm: Partial<Record<UtmKey, string>>;
  responsibles: Map<string, AmoResponsible>;
  pipelineBrands: Map<string, string>;
  unqualified: Set<string>;
};

export type AmoLeadRow = {
  amo_lead_id: string;
  created_at: number;
  updated_at: number;
  pipeline_id: string;
  status_id: string;
  responsible_user_id: string;
  responsible_name: string;
  brand: string;
  city: string;
  partner_name: string;
  automatic_source: string;
  responsible_source: string;
  effective_source: string;
  is_booked: 0 | 1;
  is_attended: 0 | 1;
  is_paid: 0 | 1;
  is_closed: 0 | 1;
  close_basis_value_id: string;
  close_basis_value: string;
  is_qualified: 0 | 1;
} & Record<UtmKey, string>;

export type AmoLeadOutcome =
  | { kind: "invalid" }
  | { kind: "before" }
  | { kind: "row"; row: AmoLeadRow };

/**
 * Их цикл sync_connection для одной сделки: без id и созданные до 01.09.2026
 * — мимо; «другую воронку» отсеивает база (новая сделка не из воронки новых
 * лидов). Поздний этап включает предыдущие (пропущенный триггер CRM).
 */
export function amoLeadRow(lead: Record<string, unknown>, ctx: AmoSyncContext): AmoLeadOutcome {
  const id = str(lead.id);
  const createdAt = pyInt(lead.created_at);
  if (!id) return { kind: "invalid" };
  if (createdAt < AMO_START) return { kind: "before" };
  const s = ctx.settings;
  const pipelineId = str(lead.pipeline_id);
  const responsibleId = str(lead.responsible_user_id);
  const mapped = ctx.responsibles.get(responsibleId);
  const automatic = amoCustomValue(lead, s.auto_source_field_id)[1];
  const manual = amoCustomValue(lead, s.manual_source_field_id)[1];
  const utm = Object.fromEntries(
    UTM.map((k) => [k, ctx.utm[k] ? amoCustomValue(lead, ctx.utm[k]!)[1] : ""]),
  ) as Record<UtmKey, string>;
  const [basisId, basisValue] = amoCustomValue(lead, s.close_basis_field_id);
  const statusId = str(lead.status_id);
  const closed = statusId === "143" ? 1 : 0;
  const paid = amoFlag(lead, s.paid_field_id);
  const attended = Math.max(amoFlag(lead, s.attended_field_id), paid) as 0 | 1;
  const booked = Math.max(amoFlag(lead, s.booked_field_id), attended) as 0 | 1;
  return {
    kind: "row",
    row: {
      amo_lead_id: id,
      created_at: createdAt,
      updated_at: truthy(lead.updated_at) ? pyInt(lead.updated_at) : createdAt,
      pipeline_id: pipelineId,
      status_id: statusId,
      responsible_user_id: responsibleId,
      responsible_name: mapped?.amo_user_name ?? "",
      brand: ctx.pipelineBrands.get(pipelineId) || (mapped ? mapped.brand : ""),
      city: mapped?.city ?? "",
      partner_name: mapped?.partner_name ?? "",
      automatic_source: automatic,
      responsible_source: manual,
      effective_source:
        utm.utm_source.toLowerCase() === "avito_ads"
          ? "Авито Реклама"
          : automatic || manual || "Не присвоен источник",
      ...utm,
      is_booked: booked,
      is_attended: attended,
      is_paid: paid,
      is_closed: closed,
      close_basis_value_id: basisId,
      close_basis_value: basisValue,
      is_qualified: closed && ctx.unqualified.has(basisId) ? 0 : 1,
    },
  };
}

/** Их итог сверки: какие воронки вернула amoCRM и сколько отсеяно. */
export function amoSyncDetails(v: {
  kind: "full" | "incremental";
  expected: string;
  pipelines: Map<string, number>;
  other: number;
  before: number;
  invalid: number;
}): string {
  const found =
    [...v.pipelines]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ") || "нет";
  const kind = v.kind === "full" ? "Полная сверка с 01.09.2026" : "Обновление изменённых сделок";
  return (
    `${kind}. Ожидаемая воронка ID ${v.expected}; AmoCRM вернула по воронкам: ${found}. ` +
    `Отсеяно: другая воронка — ${v.other}, до 01.09.2026 — ${v.before}, без ID — ${v.invalid}.`
  );
}

/** Ключ воронки для подсчёта: без id — «без ID». */
export const amoPipelineKey = (lead: Record<string, unknown>) => str(lead.pipeline_id) || "без ID";

/** Путь списка сделок: изменённые с момента или созданные с 01.09.2026. */
export function amoLeadsPath(filter: "updated" | "created", from: number, page: number): string {
  const q = new URLSearchParams({
    [`filter[${filter}_at][from]`]: String(from),
    page: String(page),
    limit: String(AMO_PAGE),
  });
  return `/api/v4/leads?${q.toString()}`;
}
