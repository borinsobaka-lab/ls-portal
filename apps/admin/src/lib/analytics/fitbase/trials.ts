/**
 * FitBase — пробные занятия, как у них: связи записей с услугами и выбранные
 * пробные услуги филиала (fitbase_trial_services.py: owner, service_id,
 * collect_refs, overrides), браузерные основания записей (fitbase_trial_basis
 * + fitbase_trial_fast: normalized, classifier, apply_basis), воронка
 * (fitbase_trials.py: calculate, aggregate, страница) и реестр «Записи без
 * услуги» с CSV (fitbase_trial_review.py). Без ввода-вывода и React.
 */
import type { Json } from "./rules";
import { fbDay, isObj, obj, pyFalsy } from "./rules";
import { fbFixed, fbInteger, fbTimestamp } from "./reports";
import { pyStr } from "../vk/lf";

// --- Владелец, связи и правила ---------------------------------------------------------------

/** Их owner(c): json.dumps([domain, str(club_id)]) — правила и каталог не переходят к другому клубу. */
export function fbTrialOwner(c: { domain: string; club_id: string }): string {
  return `[${JSON.stringify(c.domain)}, ${JSON.stringify(String(c.club_id))}]`;
}

/** Их service_id: услуга записи или активации (client_service / service). */
export function fbServiceId(row: Json): string {
  const linked = obj("client_service" in row ? row.client_service : row.service);
  const value = obj(obj(linked.service).available_service).id;
  if (value === null || value === undefined || typeof value === "boolean") return "";
  return pyStr(value);
}

/**
 * Их collect_refs: услуги записи — из самой записи (клиент совпадает) и из
 * активаций услуг того же клиента в этом клубе. registrations — уже
 * последние версии записей по ID; clients — ID записи → клиент из занятий.
 */
export function fbCollectRefs(
  registrations: Json[],
  activations: Json[],
  clients: Map<string, string>,
  club: string,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const add = (rid: string, sid: string) => {
    if (!refs.has(rid)) refs.set(rid, new Set());
    refs.get(rid)!.add(sid);
  };
  const baseline = new Map<string, Json>();
  for (const r of registrations) baseline.set(pyStr(r.id), r);
  for (const [rid, row] of baseline) {
    const sid = fbServiceId(row);
    const client = row.client_id;
    if (
      client !== null &&
      client !== undefined &&
      clients.has(rid) &&
      pyStr(client) !== clients.get(rid)
    )
      continue;
    if (clients.has(rid) && sid) add(rid, sid);
  }
  for (const row of activations) {
    const rid = pyFalsy(row.registration_id) ? "" : pyStr(row.registration_id);
    const rowClub = obj(pyFalsy(row.club) ? {} : row.club).id;
    if (!clients.has(rid) || (rowClub !== null && rowClub !== undefined && pyStr(rowClub) !== club))
      continue;
    const client = pyFalsy(row.client_id) ? "" : pyStr(row.client_id);
    if (!client || !clients.get(rid) || client !== clients.get(rid)) continue;
    const sid = fbServiceId(row);
    if (sid) add(rid, sid);
  }
  return refs;
}

export type FbTrialRule = { mode: "auto" | "selected"; selected: string[]; revision: number };

/**
 * Их _overrides_before_speed для одного филиала: в режиме «По выбранным
 * услугам» запись со связью — пробная (1), если её услуги выбраны, обычная
 * (0), если нет; смешанные — неопределённая (-1).
 */
export function fbServiceOverrides(
  rule: FbTrialRule | null,
  refs: [string, string[]][],
): Map<string, number> {
  const values = new Map<string, number>();
  if (!rule || rule.mode !== "selected") return values;
  const chosen = new Set(rule.selected);
  for (const [rid, ids] of refs) {
    const kinds = new Set(ids.map((sid) => (chosen.has(sid) ? 1 : 0)));
    if (kinds.size) values.set(rid, kinds.size === 1 ? [...kinds][0] : -1);
  }
  return values;
}

const PY_WS =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const SPLIT_RE = new RegExp(`${PY_WS}+`, "g");
const EDGE_RE = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "g");

/** Их normalized: ' '.join(label.split()).casefold().replace('ё', 'е'). */
export function fbNormLabel(label: string): string {
  return label
    .replace(EDGE_RE, "")
    .replace(SPLIT_RE, " ")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ")
    .replace(/ё/g, "е");
}

/**
 * Их classifier: название основания → тип по каталогу услуг филиала
 * (выбрана — 1, нет — 0), иначе по названиям абонементов; несколько типов
 * или ничего — -1. Только в режиме «По выбранным услугам».
 */
export function fbBasisClassifier(
  rule: FbTrialRule | null,
  catalog: { service_id: string; name: string }[],
  contracts: { label: string; is_trial: number }[],
): (label: string) => number {
  if (!rule || rule.mode !== "selected") return () => -1;
  const chosen = new Set(rule.selected);
  const byName = new Map<string, Set<number>>();
  for (const row of catalog) {
    const key = fbNormLabel(row.name);
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(chosen.has(row.service_id) ? 1 : 0);
  }
  const byContract = new Map<string, Set<number>>();
  for (const row of contracts) {
    if (row.is_trial < 0) continue;
    const key = fbNormLabel(row.label);
    if (!byContract.has(key)) byContract.set(key, new Set());
    byContract.get(key)!.add(row.is_trial);
  }
  return (label: string) => {
    const key = fbNormLabel(label);
    const kinds = byName.has(key) ? byName.get(key)! : (byContract.get(key) ?? new Set<number>());
    return kinds.size === 1 ? [...kinds][0] : -1;
  };
}

/**
 * Их apply_basis: основание записи из веб-интерфейса FitBase поверх связей
 * с услугами; противоречие с определённой связью — неопределённая (-1).
 * basis — строки основания, у которых есть та же запись того же занятия.
 */
export function fbApplyBasis(
  values: Map<string, number>,
  basis: { registration_id: string; label: string }[],
  resolve: (label: string) => number,
): Map<string, number> {
  const out = new Map(values);
  for (const row of basis) {
    const k = resolve(row.label);
    if (k < 0) continue;
    const prior = out.get(row.registration_id);
    out.set(row.registration_id, prior !== undefined && prior >= 0 && prior !== k ? -1 : k);
  }
  return out;
}

// --- Воронка (их calculate / aggregate) ------------------------------------------------------

export const FB_TRIAL_COUNT_KEYS = [
  "registered",
  "visited",
  "day",
  "within",
  "day_base",
  "window_base",
  "day_mature",
  "window_mature",
  "immature",
] as const;
type CountKey = (typeof FB_TRIAL_COUNT_KEYS)[number];

export type FbTrialConnection = {
  id: number;
  name: string;
  city: string;
  brand: string;
  attendance_synced_at: number | null;
  attendance_from: string;
  attendance_to: string;
  sales_payments_at: number | null;
  sales_synced_at: number | null;
};
export type FbTrialRecord = {
  connection_id: number;
  registration_id: string;
  client_key: string;
  /** Статус по правилам студии; важен только «visited». */
  status: string;
  kind: number;
  day: string;
  end_at: number;
};
export type FbTrialSale = {
  connection_id: number;
  contract_id: string;
  client_id: string;
  purchased_at: number;
  price_cents: number;
  kind: number;
};
export type FbTrialPayment = {
  connection_id: number;
  contract_id: string;
  operation: string;
  amount_cents: number;
  pay_at: number;
};

export type FbTrialStudio = Record<CountKey, number> & {
  unknown: number;
  missing_client: number;
  uncertain: number;
  loaded: boolean;
  paid_ready: boolean;
  base_complete: boolean;
  paid_complete: boolean;
};

const DAY_MS = 86400000;
/** Дата по Москве (их datetime.fromtimestamp(x, TZ).date()). */
const mskDay = (sec: number) => fbDay(sec);
const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const codeCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type TrialMatch = {
  converted: Set<string>;
  sameDay: Set<string>;
  uncertain: Set<string>;
  cutoff: string;
};
const trialId = (uid: number, rid: string) => `${uid}\u0000${rid}`;

/**
 * Их calculate (первая часть): покупка — первая положительная оплата
 * платного непробного абонемента с положительным остатком после возвратов;
 * относится к последнему ещё не учтённому посещённому пробному того же
 * клиента в этой студии за 14 дней (договор не раньше пробного).
 */
function trialMatch(
  records: FbTrialRecord[],
  sales: FbTrialSale[],
  payments: FbTrialPayment[],
  now: number,
): TrialMatch {
  const cutoff = shift(mskDay(now), -1);
  const visits = new Map<string, FbTrialRecord[]>();
  const unknownVisits = new Map<string, FbTrialRecord[]>();
  const push = (m: Map<string, FbTrialRecord[]>, k: string, r: FbTrialRecord) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  };
  for (const r of records) {
    if (r.status === "visited" && r.client_key) {
      const k = `${r.connection_id}\u0000${r.client_key}`;
      if (r.kind === 1) push(visits, k, r);
      else if (r.kind < 0) push(unknownVisits, k, r);
    }
  }
  const byContract = new Map<string, FbTrialPayment[]>();
  for (const p of payments) {
    if (p.pay_at > now) continue;
    const k = `${p.connection_id}\u0000${p.contract_id}`;
    if (!byContract.has(k)) byContract.set(k, []);
    byContract.get(k)!.push(p);
  }
  const candidates: [number, string, FbTrialSale][] = [];
  for (const sale of sales) {
    if (sale.kind === 1 || sale.price_cents <= 0) continue;
    const paid = byContract.get(`${sale.connection_id}\u0000${sale.contract_id}`) ?? [];
    let net = 0;
    let first: number | null = null;
    for (const p of paid) {
      net += p.amount_cents * (p.operation === "purchase" ? 1 : -1);
      if (p.operation === "purchase" && p.amount_cents > 0 && (first === null || p.pay_at < first))
        first = p.pay_at;
    }
    if (first !== null && net > 0) candidates.push([first, String(sale.contract_id), sale]);
  }
  candidates.sort((a, b) => a[0] - b[0] || codeCmp(a[1], b[1]));
  const converted = new Set<string>();
  const sameDay = new Set<string>();
  const uncertain = new Set<string>();
  for (const [stamp, , sale] of candidates) {
    const uid = sale.connection_id;
    const day = mskDay(stamp);
    const created = mskDay(sale.purchased_at);
    const key = `${uid}\u0000${sale.client_id}`;
    const eligible = (visits.get(key) ?? []).filter((r) => {
      const gap = daysBetween(r.day, day);
      return (
        !converted.has(trialId(uid, r.registration_id)) && gap >= 0 && gap < 14 && created >= r.day
      );
    });
    if (!eligible.length) continue;
    let trial = eligible[0];
    for (const r of eligible.slice(1)) {
      if (
        r.end_at > trial.end_at ||
        (r.end_at === trial.end_at && codeCmp(r.registration_id, trial.registration_id) > 0)
      )
        trial = r;
    }
    const identity = trialId(uid, trial.registration_id);
    if (
      sale.kind < 0 ||
      (unknownVisits.get(key) ?? []).some((r) => trial.day <= r.day && r.day <= day)
    ) {
      uncertain.add(identity);
      continue;
    }
    converted.add(identity);
    if (day === trial.day) sameDay.add(identity);
  }
  return { converted, sameDay, uncertain, cutoff };
}

/** Пустой счётчик студии с её готовностью (их начальный result[uid]). */
function trialBucket(c: FbTrialConnection, start: string, end: string): FbTrialStudio {
  const counts = Object.fromEntries(FB_TRIAL_COUNT_KEYS.map((k) => [k, 0])) as Record<
    CountKey,
    number
  >;
  return {
    ...counts,
    unknown: 0,
    missing_client: 0,
    uncertain: 0,
    loaded: Boolean(
      c.attendance_synced_at &&
      (c.attendance_from ?? "") <= start &&
      (c.attendance_to ?? "") >= end,
    ),
    paid_ready: Boolean(
      c.sales_payments_at && c.sales_synced_at && c.sales_payments_at >= c.sales_synced_at,
    ),
    base_complete: false,
    paid_complete: false,
  };
}

/**
 * Их calculate (вторая часть): счётчики периода по дате пробного. Запись
 * считается в счётчик bucketOf(r) (у них — студии, в «Мой город · FitBase» —
 * студии и названия пробного); window_same_day — их добавка trial_dimensions
 * (покупки в день пробного среди завершённых 14-дневных окон).
 */
function trialCount(
  connections: FbTrialConnection[],
  records: FbTrialRecord[],
  m: TrialMatch,
  start: string,
  end: string,
  now: number,
  bucketOf: (r: FbTrialRecord) => FbTrialStudio & { window_same_day?: number },
  buckets: Iterable<FbTrialStudio>,
) {
  const states = new Map(connections.map((c) => [c.id, c]));
  for (const r of records) {
    if (!(start <= r.day && r.day <= end)) continue;
    const uid = r.connection_id;
    const b = bucketOf(r);
    const c = states.get(uid)!;
    if (r.kind === 0) continue;
    if (r.kind < 0) {
      b.unknown += 1;
      continue;
    }
    b.registered += 1;
    if (r.status !== "visited") continue;
    b.visited += 1;
    const identity = trialId(uid, r.registration_id);
    b.day += m.sameDay.has(identity) ? 1 : 0;
    b.within += m.converted.has(identity) ? 1 : 0;
    b.missing_client += r.client_key ? 0 : 1;
    b.uncertain += m.uncertain.has(identity) ? 1 : 0;
    const paidDay = shift(mskDay(Math.min(c.sales_payments_at || 0, now)), -1);
    const horizon = paidDay < m.cutoff ? paidDay : m.cutoff;
    if (r.day <= horizon) {
      b.day_base += 1;
      b.day_mature += m.sameDay.has(identity) ? 1 : 0;
    }
    if (shift(r.day, 13) <= horizon) {
      b.window_base += 1;
      b.window_mature += m.converted.has(identity) ? 1 : 0;
      if (b.window_same_day !== undefined) b.window_same_day += m.sameDay.has(identity) ? 1 : 0;
    } else b.immature += 1;
  }
  for (const b of buckets) {
    b.base_complete = b.loaded && !b.unknown;
    b.paid_complete = b.base_complete && b.paid_ready && !b.missing_client && !b.uncertain;
  }
}

/**
 * Их calculate: сопоставление покупок с пробными, затем счётчики периода по
 * дате пробного — по студиям.
 */
export function fbTrialCalculate(
  connections: FbTrialConnection[],
  records: FbTrialRecord[],
  sales: FbTrialSale[],
  payments: FbTrialPayment[],
  start: string,
  end: string,
  now: number,
): Map<number, FbTrialStudio> {
  const m = trialMatch(records, sales, payments, now);
  const result = new Map<number, FbTrialStudio>();
  for (const c of connections) result.set(c.id, trialBucket(c, start, end));
  trialCount(
    connections,
    records,
    m,
    start,
    end,
    now,
    (r) => result.get(r.connection_id)!,
    result.values(),
  );
  return result;
}

export type FbTrialDimension = FbTrialStudio & {
  connection_id: number;
  label: string;
  window_same_day: number;
};

/**
 * Их trial_dimensions (fitbase_partner_view.py): тот же расчёт, но счётчики —
 * на пару «студия + название пробного» (покупки сопоставляются по всем
 * пробным, группируются на этапе подсчёта), только записи и покупки с
 * определённым типом (их _calculate_confirmed).
 */
export function fbTrialCalculateByLabel(
  connections: FbTrialConnection[],
  records: FbTrialRecord[],
  sales: FbTrialSale[],
  payments: FbTrialPayment[],
  start: string,
  end: string,
  now: number,
  labelOf: (r: FbTrialRecord) => string,
  keys: [number, string][] = [],
): FbTrialDimension[] {
  const confirmed = records.filter((r) => r.kind >= 0);
  const m = trialMatch(
    confirmed,
    sales.filter((s) => s.kind >= 0),
    payments,
    now,
  );
  const byId = new Map(connections.map((c) => [c.id, c]));
  // Их _dimension_keys — пары по всем записям отчёта (и обычным, и
  // неопределённым): пустая пара тоже входит в полноту названия.
  const result = new Map<string, FbTrialDimension>();
  const add = (uid: number, label: string) => {
    const key = `${uid}\u0000${label}`;
    const c = byId.get(uid);
    if (c && !result.has(key))
      result.set(key, {
        ...trialBucket(c, start, end),
        connection_id: uid,
        label,
        window_same_day: 0,
      });
  };
  for (const [uid, label] of keys) add(uid, label);
  for (const r of confirmed) add(r.connection_id, labelOf(r));
  trialCount(
    connections,
    confirmed,
    m,
    start,
    end,
    now,
    (r) => result.get(`${r.connection_id}\u0000${labelOf(r)}`)!,
    result.values(),
  );
  return [...result.values()];
}

/** Их _calculate_confirmed: только записи и покупки с определённым типом. */
export function fbTrialCalculateConfirmed(
  connections: FbTrialConnection[],
  records: FbTrialRecord[],
  sales: FbTrialSale[],
  payments: FbTrialPayment[],
  start: string,
  end: string,
  now: number,
) {
  return fbTrialCalculate(
    connections,
    records.filter((r) => r.kind >= 0),
    sales.filter((s) => s.kind >= 0),
    payments,
    start,
    end,
    now,
  );
}

export type FbTrialBucket = Record<CountKey, number> & {
  base_complete: boolean;
  paid_complete: boolean;
  known: number;
  expected: number;
  paid_known: number;
  attendance: number | null;
  day_conversion: number | null;
  conversion: number | null;
};

/** Их aggregate: суммы загруженных студий, полнота и проценты. */
export function fbTrialAggregate(items: FbTrialStudio[]): FbTrialBucket {
  const counts = Object.fromEntries(
    FB_TRIAL_COUNT_KEYS.map((k) => [k, items.reduce((s, b) => s + (b.loaded ? b[k] : 0), 0)]),
  ) as Record<CountKey, number>;
  const base = items.length > 0 && items.every((b) => b.base_complete);
  const paid = items.length > 0 && items.every((b) => b.paid_complete);
  return {
    ...counts,
    base_complete: base,
    paid_complete: paid,
    known: items.filter((b) => b.loaded).length,
    expected: items.length,
    paid_known: items.filter((b) => b.loaded && b.paid_ready).length,
    attendance: base && counts.registered ? (counts.visited / counts.registered) * 100 : null,
    day_conversion: paid && counts.day_base ? (counts.day_mature / counts.day_base) * 100 : null,
    conversion:
      paid && counts.window_base ? (counts.window_mature / counts.window_base) * 100 : null,
  };
}

/** Их подписи плиток и колонок (labels). */
export const FB_TRIAL_LABELS = [
  ["registered", "Записались на пробное"],
  ["visited", "Пришли на пробное"],
  ["attendance", "Доходимость"],
  ["day", "Купили в день пробного"],
  ["day_conversion", "Конверсия продажи в день пробного"],
  ["within", "Купили в течение 14 дней с пробного"],
  ["conversion", "Конверсия продажи в течение 14 дней"],
  ["later", "Купили не в день пробного"],
] as const;
export type FbTrialMetric = (typeof FB_TRIAL_LABELS)[number][0];

/** Их number(): проценты «12,3%», «later» — только при полных оплатах, прочие — при загрузке. */
export function fbTrialNumber(b: FbTrialBucket, key: FbTrialMetric): string {
  if (key === "attendance" || key === "day_conversion" || key === "conversion") {
    const v = b[key];
    return v === null ? "—" : `${fbFixed(v, 1)}%`.replace(".", ",");
  }
  if (key === "later") return b.paid_complete ? fbInteger(b.within - b.day) : "—";
  const known = key === "registered" || key === "visited" ? b.known : b.paid_known;
  return known ? fbInteger(b[key]) : "—";
}

export type FbTrialsData = {
  from: string;
  to: string;
  now: number;
  admin: boolean;
  batch: { active?: boolean; message?: string };
  connections: { id: number; name: string; city: string; brand: string }[];
  selected: FbTrialConnection[];
  /** Пробные записи (тип 1) за всё время: [студия, ID, клиент, пришёл, день, окончание]. */
  records: [number, string, string, boolean, string, number][];
  /** Непробные платные абонементы клиентов с посещённым пробным: [студия, договор, клиент, создан, цена]. */
  sales: [number, string, string, number, number][];
  /** Оплаты этих договоров: [студия, договор, операция, сумма, время]. */
  payments: [number, string, string, number, number][];
  review_count: number;
};

export type FbTrialsReport = {
  connections: FbTrialConnection[];
  studios: Map<number, FbTrialStudio>;
  total: FbTrialBucket;
  cities: [string, FbTrialBucket][];
};

/** Их report(): студии, итог и города (по алфавиту). */
export function fbTrialsReport(data: FbTrialsData): FbTrialsReport {
  const records: FbTrialRecord[] = data.records.map(([cid, rid, client, visited, day, end]) => ({
    connection_id: cid,
    registration_id: rid,
    client_key: client,
    status: visited ? "visited" : "",
    kind: 1,
    day,
    end_at: end,
  }));
  const sales: FbTrialSale[] = data.sales.map(([cid, contract, client, created, price]) => ({
    connection_id: cid,
    contract_id: contract,
    client_id: client,
    purchased_at: created,
    price_cents: price,
    kind: 0,
  }));
  const payments: FbTrialPayment[] = data.payments.map(([cid, contract, op, amount, at]) => ({
    connection_id: cid,
    contract_id: contract,
    operation: op,
    amount_cents: amount,
    pay_at: at,
  }));
  const studios = fbTrialCalculateConfirmed(
    data.selected,
    records,
    sales,
    payments,
    data.from,
    data.to,
    data.now,
  );
  const names = [...new Set(data.selected.map((c) => c.city))].sort(codeCmp);
  return {
    connections: data.selected,
    studios,
    total: fbTrialAggregate([...studios.values()]),
    cities: names.map((name) => [
      name,
      fbTrialAggregate(data.selected.filter((c) => c.city === name).map((c) => studios.get(c.id)!)),
    ]),
  };
}

/** Их заметки «Проверка данных пробных» по студии. */
export function fbTrialNotes(
  c: FbTrialConnection,
  s: FbTrialStudio,
  stamp: (sec: number) => string,
): string {
  const notes: string[] = [];
  if (!s.loaded) notes.push("Выбранный период посещаемости ещё не загружен");
  if (s.unknown) notes.push(`Не определён тип или статус записей: ${s.unknown}`);
  if (!s.paid_ready) notes.push("Нужна актуальная загрузка оплат и возвратов");
  if (s.missing_client) notes.push(`Нет ID клиента у пробных посещений: ${s.missing_client}`);
  if (s.uncertain) notes.push(`Неоднозначная связь покупки с пробным: ${s.uncertain}`);
  const at = (v: number | null) => (v ? stamp(v) : "нет загрузки");
  notes.push(`Посещаемость: ${at(c.attendance_synced_at)}`, `Оплаты: ${at(c.sales_payments_at)}`);
  return notes.join("; ");
}

/** Их тексты страницы воронки. */
export const FB_TRIAL_TEXT = {
  quality:
    "Расчёт только по записям и покупкам с определённым типом. Записи с неопределённым типом вынесены отдельно. Прочерк — недостаточно данных для расчёта.",
  refresh: "Посещаемость и выручка сохраняются. После завершения обновите страницу.",
  busy: "Студии обрабатываются последовательно. Очередь работает.",
  separate:
    "Записи с неопределённым типом исключены из расчёта. Покупки учитываются только при определённом типе абонемента; связь строится среди известных пробных. Это отдельная выборка, а не оценка всех возможных пробных.",
  rules: (immature: number) => [
    "Период отбирается по дате пробного занятия. Считаются записи, а не уникальные люди. «Записались» — все записи с определённым пробным продуктом на неотменённые занятия выбранного периода, включая отказ, неявку, ожидание оплаты, лист ожидания и будущие занятия. Статус влияет только на «Пришли»: учитывается «Пришёл». Пробное определяется по флагу услуги FitBase либо названию продукта с «пробн…».",
    "Покупка — первая положительная фактическая оплата платного непробного абонемента с положительным остатком после возвратов. Бесплатные и полностью возвращённые договоры исключены. Договор, созданный до пробного, исключён. Покупка относится к последнему ещё не учтённому посещённому пробному в этой студии. Одна покупка и одно пробное учитываются не более одного раза.",
    `14 дней — день пробного и следующие 13 календарных дней. Покупка в день включена в показатель за 14 дней. «Не в день» показывается только при полной классификации и загрузке оплат. Даты — Москва. Конверсии используют завершённые окна наблюдения и полные оплаты. Незавершённых окон: ${immature}. Расчёт выполнен только по записям и покупкам с определённым типом; неопределённые исключены. При незагруженной посещаемости, оплатах или отсутствии ID клиента проценты скрыты.`,
  ],
};

// --- «Записи без услуги / абонемента» (их fitbase_trial_review) ----------------------------

export const FB_REVIEW_STATUSES: Record<string, string> = {
  registered: "Не подтверждено",
  confirmed: "Подтверждено",
  visited: "Пришёл",
  no_show: "Не пришёл",
  late_cancel: "Поздняя отмена",
  refused: "Отказался",
  waiting: "Лист ожидания",
  pending_payment: "Ожидание оплаты",
  unknown: "Статус не сопоставлен",
};

export const FB_REVIEW_HEADERS = [
  ["branch", "Филиал"],
  ["city", "Город"],
  ["brand", "Направление"],
  ["date", "Дата занятия"],
  ["end_time", "Окончание, МСК"],
  ["training", "Занятие"],
  ["status", "Статус"],
  ["event_id", "ID занятия"],
  ["registration_id", "ID записи"],
  ["reason", "Причина проверки"],
] as const;
export type FbReviewRow = Record<(typeof FB_REVIEW_HEADERS)[number][0], string>;

export type FbReviewData = {
  from: string;
  to: string;
  connections: { id: number; name: string; city: string; brand: string }[];
  /** [филиал, город, направление, день, окончание, занятие, статус, ID занятия, ID записи] */
  rows: [string, string, string, string, number, string, string, string, string][];
};

/** Их строки реестра: время окончания МСК, порядок (дата, время, филиал, ID записи). */
export function fbReviewRows(data: FbReviewData): FbReviewRow[] {
  const rows = data.rows.map(([branch, city, brand, date, end, training, status, event, rid]) => ({
    branch,
    city,
    brand,
    date,
    end_time: fbTimestamp(end).slice(11, 16),
    training,
    status: FB_REVIEW_STATUSES[status] ?? "Статус не сопоставлен",
    event_id: event,
    registration_id: rid,
    reason: "Не определена услуга / абонемент",
  }));
  return rows.sort(
    (a, b) =>
      codeCmp(a.date, b.date) ||
      codeCmp(a.end_time, b.end_time) ||
      codeCmp(a.branch, b.branch) ||
      codeCmp(a.registration_id, b.registration_id),
  );
}

const LSTRIP_RE = new RegExp(`^${PY_WS}+`);

/** Их safe_cell: защита от формул в Excel. */
export function fbSafeCell(value: string): string {
  return /^[=+\-@]/.test(value.replace(LSTRIP_RE, "")) || /^[\t\r\n]/.test(value)
    ? `'${value}`
    : value;
}

/** Поле csv.writer Python (QUOTE_MINIMAL, «;»). */
function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Их export: CSV «;» с BOM, строки \r\n, без персональных данных клиентов. */
export function fbReviewCsv(rows: FbReviewRow[]): string {
  const lines = [FB_REVIEW_HEADERS.map(([, title]) => csvField(title)).join(";")];
  for (const row of rows) {
    lines.push(FB_REVIEW_HEADERS.map(([key]) => csvField(fbSafeCell(row[key]))).join(";"));
  }
  return `\ufeff${lines.map((l) => `${l}\r\n`).join("")}`;
}

export const FB_REVIEW_TEXT = {
  intro:
    "Отдельный список для проверки: тип записи не определён. Эти записи не объявляются пробными или обычными. Персональные данные клиентов в выгрузку не входят.",
  time: "Время — окончание занятия по Москве. В доступной таблице посещаемости время начала не хранится.",
  limit: "На странице показаны первые 500 записей. В CSV включены все найденные.",
};

// --- Пробные услуги филиала (их fitbase_trial_services.render) -----------------------------

export const FB_TRIAL_SERVICES_TEXT = {
  link: "Выберите услуги этого филиала, включая бесплатные пробные с любым названием.",
  selected:
    "В режиме «По выбранным услугам» только отмеченные услуги считаются пробными. Цена, название и флаг FitBase для них не важны. Остальные связанные услуги считаются обычными.",
  scope:
    "Правило касается записей со связью на услугу. Записи только по абонементу продолжают определяться по прежним признакам. Записи без услуги и без абонемента остаются неопределёнными. Посещаемость, оплаты и выручка не меняются.",
  saved: "Сохранено. Правило применяется к уже загруженным записям и к следующим обновлениям.",
  autoWarning:
    "Выбранные галочки сейчас не применяются: активен автоматический режим. Для их применения выберите «По выбранным услугам» и сохраните.",
  empty: "Сначала нажмите «Обновить список услуг из FitBase».",
};

/** Строка каталога услуг из ответа FitBase (их load_catalog): null — услуга чужого клуба. */
export function fbCatalogRow(
  row: unknown,
  club: string,
  archived: number,
): { service_id: string; name: string; is_trial: number; archived: number } | null {
  if (!isObj(row) || row.id === null || row.id === undefined || typeof row.id === "boolean") {
    throw new Error("FitBase вернул услугу без ID. Прежний каталог сохранён.");
  }
  const sid = pyStr(row.id);
  const clubs = row.clubs;
  if (Array.isArray(clubs) && clubs.length) {
    const ids = new Set(clubs.map((x) => (isObj(x) ? pyStr(x.id) : pyStr(x))));
    if (!ids.has(club)) return null;
  }
  const name = pyFalsy(row.name) ? `Услуга ${sid}` : pyStr(row.name);
  const arch = "archive" in row ? row.archive : archived;
  return {
    service_id: sid,
    name,
    is_trial: row.is_trial === true ? 1 : 0,
    archived: pyFalsy(arch) ? 0 : 1,
  };
}
