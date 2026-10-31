/**
 * «Диалоги VK» → «Статистика» — расчёты их vk_inbox.py построчно
 * (extract_client_phones, summarize_response_statistics,
 * summarize_lead_statistics, summarize_manager_scopes) и вид таблиц их
 * inbox_statistics_page / stat-table-controls.js (форматы, сортировка, CSV).
 * Время — секунды Unix, день — дата по Москве. Считает сервер портала: тексты
 * сообщений с номерами в браузер не уходят.
 */
import { fbFixed } from "../fitbase/reports";
import { pyRound } from "../onec-reports/payload";

// --- Номера телефонов (их extract_client_phones) ---

// Python \d и \w в строковых шаблонах — Юникод: цифры Nd, буквы и цифры.
const D = "\\p{Nd}";
const W = "[\\p{L}\\p{N}_]";
const DATE_RE = new RegExp(
  `(?<!${D})(?:(?:0?[1-9]|[12]${D}|3[01])[./-](?:0?[1-9]|1[0-2])[./-]${D}{2,4}|${D}{4}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]${D}|3[01]))(?!${D})`,
  "gu",
);
const PHONE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_+])(?:\\+?7|8)[ ().-]*(?:${D}[ ().-]*){9}${D}(?!${W})|(?<![\\p{L}\\p{N}_+])9(?:[ ().-]*${D}){9}(?!${W})`,
  "gu",
);

/** Их extract_client_phones: разные российские номера сообщения, к виду 7XXXXXXXXXX. */
export function extractClientPhones(text: string): Set<string> {
  const clean = (text || "").replace(DATE_RE, " DATE ");
  const numbers = new Set<string>();
  for (const m of clean.matchAll(PHONE_RE)) {
    const digits = [...m[0].replace(/\P{Nd}/gu, "")];
    if (digits.length === 10 && digits[0] === "9") numbers.add("7" + digits.join(""));
    else if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8"))
      numbers.add("7" + digits.slice(1).join(""));
  }
  return numbers;
}

// --- Время ---

/** Дата по Москве (UTC+3) для секунд Unix. */
export const mskDay = (sec: number) => {
  const d = new Date(Math.floor(sec * 1000) + 3 * 3_600_000);
  return d.toISOString().slice(0, 10);
};

// --- Скорость ответов (их summarize_response_statistics) ---

/** Строка запроса: [диалог, группа, 'i'|'o', автор из портала, секунды]. */
export type ReplyRow = [number, number, "i" | "o", string | null, number];

export type SpeedMetrics = {
  response_count: number;
  response_median_seconds: number;
  response_p90_seconds: number;
};

function speedMetrics(samples: number[]): SpeedMetrics {
  const s = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const position = (s.length - 1) * fraction;
    const lower = Math.trunc(position);
    const upper = Math.min(lower + 1, s.length - 1);
    return s[lower] + (s[upper] - s[lower]) * (position - lower);
  };
  return {
    response_count: s.length,
    response_median_seconds: percentile(0.5),
    response_p90_seconds: percentile(0.9),
  };
}

/**
 * Их summarize_response_statistics: одно измерение на серию входящих,
 * закрывает любой ответ (и из VK); засчитывается ответившему из портала.
 */
export function summarizeResponseStatistics(
  rows: ReplyRow[],
  start: number,
  end: number,
  managerIds: Set<string> | null,
  groupIds: Set<number> | null,
) {
  const managers = new Map<string, number[]>();
  const daily = new Map<string, number[]>();
  let current: number | null = null;
  let pending: number | null = null;
  for (const [dialog, community, direction, uid, stamp] of rows) {
    if (dialog !== current) {
      current = dialog;
      pending = null;
    }
    if (direction === "i") {
      if (pending === null) pending = stamp;
    } else {
      const waiting = pending;
      pending = null;
      if (
        waiting === null ||
        uid === null ||
        !(start <= stamp && stamp < end) ||
        (managerIds !== null && !managerIds.has(uid)) ||
        (groupIds !== null && !groupIds.has(community))
      )
        continue;
      const seconds = Math.max(0, stamp - waiting);
      const own = managers.get(uid) ?? [];
      own.push(seconds);
      managers.set(uid, own);
      const key = `${uid}|${mskDay(stamp)}`;
      const day = daily.get(key) ?? [];
      day.push(seconds);
      daily.set(key, day);
    }
  }
  return {
    managers: new Map([...managers].map(([k, v]) => [k, speedMetrics(v)])),
    daily: new Map([...daily].map(([k, v]) => [k, speedMetrics(v)])),
  };
}

// --- Лиды и телефоны (их summarize_lead_statistics) ---

export type WorkRow = { user_id: string; day: string; replies: number; dialog_ids: number[] };
export type LeadRow = {
  dialog_id: number;
  lead_at: number;
  history_verified: boolean;
  incoming_at: number | null;
  community_id: number;
  community_name: string;
  city: string;
  owner_id: string | null;
  reply_at: number | null;
  reply_user_id: string | null;
};
export type PhoneRow = {
  id: number;
  dialog_id: number;
  body: string;
  sent_at: number;
  phone_owner_id: string | null;
  bot_before_phone: boolean;
};

export type LeadGroup = {
  community_id: number;
  name: string;
  city: string;
  leads: number;
  phones: number;
  converted: number;
  pending_history: number;
};

export type LeadSummary = {
  daily: {
    user_id: string;
    day: string;
    replies: number;
    leads: number;
    phones: number;
    converted: number;
    median_seconds: number | null;
    first_responses: number;
  }[];
  groups: LeadGroup[];
  leads: number;
  phones: number;
  converted: number;
  unassigned_leads: number;
  unassigned_phones: number;
  bot_phones: number;
  pending_history: number;
  activity: Map<string, { dialogs: number; phones: number; converted_dialogs: number }>;
};

/** Их сравнение строк Python (по кодовым точкам). */
const pyCmp = (a: string, b: string) => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
};

/** Их summarize_lead_statistics: один лид на диалог, каждый номер — один раз за всю историю. */
export function summarizeLeadStatistics(
  leadsIn: LeadRow[],
  phones: PhoneRow[],
  workIn: WorkRow[],
  start: number,
  end: number,
  managerIds: Set<string> | null,
  groupIds: Set<number> | null,
): LeadSummary {
  const leads = leadsIn.filter((r) => groupIds === null || groupIds.has(r.community_id));
  const work = workIn.filter((r) => managerIds === null || managerIds.has(r.user_id));
  type Day = LeadSummary["daily"][number] & { seconds: number[] };
  const days = new Map<string, Day>();
  for (const r of work)
    days.set(`${r.user_id}|${r.day}`, {
      user_id: r.user_id,
      day: r.day,
      replies: Number(r.replies),
      leads: 0,
      phones: 0,
      converted: 0,
      median_seconds: null,
      first_responses: 0,
      seconds: [],
    });
  const firstPhone = new Map<number, number>();
  const phoneEvents = new Map<number, [PhoneRow, number][]>();
  const seenPhones = new Map<number, Set<string>>();
  const sorted = [...phones].sort((a, b) => a.sent_at - b.sent_at || (a.id ?? 0) - (b.id ?? 0));
  for (const row of sorted) {
    if (row.sent_at >= end) continue;
    const seen = seenPhones.get(row.dialog_id) ?? new Set<string>();
    seenPhones.set(row.dialog_id, seen);
    const fresh = [...extractClientPhones(row.body)].filter((p) => !seen.has(p));
    if (fresh.length) {
      for (const p of fresh) seen.add(p);
      if (!firstPhone.has(row.dialog_id)) firstPhone.set(row.dialog_id, row.sent_at);
      const events = phoneEvents.get(row.dialog_id) ?? [];
      events.push([row, fresh.length]);
      phoneEvents.set(row.dialog_id, events);
    }
  }
  type Act = { dialogs: Set<number>; phones: number; converted_dialogs: number };
  const activity = new Map<string, Act>();
  const act = (uid: string) => {
    let a = activity.get(uid);
    if (!a) activity.set(uid, (a = { dialogs: new Set(), phones: 0, converted_dialogs: 0 }));
    return a;
  };
  for (const r of work) for (const id of r.dialog_ids ?? []) act(r.user_id).dialogs.add(id);
  let botPhones = 0;
  const groups = new Map<number, LeadGroup>();
  let totalLeads = 0;
  let totalPhones = 0;
  let totalConverted = 0;
  let unassignedLeads = 0;
  let unassignedPhones = 0;
  let pendingHistory = 0;
  for (const row of leads) {
    const incoming = row.lead_at;
    const leadSelected =
      managerIds === null || (row.owner_id !== null && managerIds.has(row.owner_id));
    const verified = row.history_verified ?? true;
    pendingHistory += Number(!verified && leadSelected);
    const newLead = verified && start <= incoming && incoming < end && leadSelected;
    let phoneCount = 0;
    for (const [details, count] of phoneEvents.get(row.dialog_id) ?? []) {
      const phoneUid = details.phone_owner_id;
      const phoneAt = details.sent_at;
      if (
        !(start <= phoneAt && phoneAt < end) ||
        (managerIds !== null && (phoneUid === null || !managerIds.has(phoneUid)))
      )
        continue;
      phoneCount += count;
      if (phoneUid !== null) {
        const item = act(phoneUid);
        item.phones += count;
        // Их «converted_dialogs» — теперь номера: два номера из одного диалога — 200%.
        if (item.dialogs.has(row.dialog_id)) item.converted_dialogs += count;
      } else if (details.bot_before_phone) botPhones += count;
      const phoneDay = phoneUid !== null ? days.get(`${phoneUid}|${mskDay(phoneAt)}`) : undefined;
      if (phoneDay) phoneDay.phones += count;
      else unassignedPhones += count;
    }
    totalLeads += Number(newLead);
    totalPhones += phoneCount;
    const converted = newLead
      ? (phoneEvents.get(row.dialog_id) ?? [])
          .filter(([d]) => incoming <= d.sent_at && d.sent_at < end)
          .reduce((s, [, c]) => s + c, 0)
      : 0;
    totalConverted += converted;
    const key = row.community_id;
    let g = groups.get(key);
    if (!g)
      groups.set(
        key,
        (g = {
          community_id: key,
          name: row.community_name,
          city: row.city,
          leads: 0,
          phones: 0,
          converted: 0,
          pending_history: 0,
        }),
      );
    g.pending_history += Number(!verified && leadSelected);
    g.leads += Number(newLead);
    g.phones += phoneCount;
    g.converted += converted;
    const uid = row.owner_id;
    const leadDay = uid !== null ? days.get(`${uid}|${mskDay(incoming)}`) : undefined;
    if (newLead) {
      if (leadDay) {
        leadDay.leads += 1;
        leadDay.converted += converted;
      } else unassignedLeads += 1;
    }
    if (
      row.reply_at !== null &&
      row.reply_user_id !== null &&
      start <= row.reply_at &&
      row.reply_at < end
    ) {
      const replyDay = days.get(`${row.reply_user_id}|${mskDay(row.reply_at)}`);
      if (replyDay) replyDay.seconds.push(Math.max(0, row.reply_at - (row.incoming_at ?? 0)));
    }
  }
  const median = (values: number[]) => {
    const v = [...values].sort((a, b) => a - b);
    return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2 : null;
  };
  const daily = [...days.values()].map(({ seconds, ...row }) => ({
    ...row,
    median_seconds: median(seconds),
    first_responses: seconds.length,
  }));
  daily.sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? 1
        : -1
      : a.user_id < b.user_id
        ? 1
        : a.user_id > b.user_id
          ? -1
          : 0,
  );
  return {
    daily,
    groups: [...groups.values()]
      .filter((g) => g.leads || g.phones || g.pending_history)
      .sort((a, b) => b.leads - a.leads || pyCmp(a.name, b.name)),
    leads: totalLeads,
    phones: totalPhones,
    converted: totalConverted,
    unassigned_leads: unassignedLeads,
    unassigned_phones: unassignedPhones,
    bot_phones: botPhones,
    pending_history: pendingHistory,
    activity: new Map(
      [...activity].map(([uid, a]) => [
        uid,
        { dialogs: a.dialogs.size, phones: a.phones, converted_dialogs: a.converted_dialogs },
      ]),
    ),
  };
}

/** Их summarize_manager_scopes: группы менеджера — сумма по назначенным в выборке. */
export function summarizeManagerScopes(
  assignments: Map<string, Set<number>>,
  groups: LeadGroup[],
  allowed: Set<number>,
) {
  const byGroup = new Map(groups.map((g) => [g.community_id, g]));
  return [...assignments].map(([uid, assigned]) => {
    const scope = [...assigned].filter((g) => allowed.has(g));
    const rows = scope.map((g) => byGroup.get(g)).filter((g): g is LeadGroup => !!g);
    return {
      user_id: uid,
      group_count: scope.length,
      leads: rows.reduce((s, r) => s + r.leads, 0),
      phones: rows.reduce((s, r) => s + r.converted, 0),
      total_phones: rows.reduce((s, r) => s + r.phones, 0),
      pending_history: rows.reduce((s, r) => s + r.pending_history, 0),
    };
  });
}

// --- Вид (их duration / conversion и stat-table-controls.js) ---

/** Их duration: «< 1 мин», «N мин», «Ч ч M мин»; нет — «—». */
export function inboxDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const minutes = Math.max(0, pyRound(Number(seconds) / 60, 0));
  if (minutes === 0) return "< 1 мин";
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/** Их conversion: f"{a / b * 100:.1f}%"; нет знаменателя — «—». */
export const inboxConversion = (converted: number, leads: number) =>
  leads ? `${fbFixed((converted / leads) * 100, 1)}%` : "—";

/** Значение ячейки для сортировки их таблиц: число, минуты, строка или нет (в конец). */
export function statSortValue(text: string, sort?: number | null): number | string | null {
  if (sort !== undefined) return sort !== null && Number.isFinite(sort) && sort >= 0 ? sort : null;
  if (text === "—" || !text) return null;
  if (/^[\d.]+%?$/.test(text)) return parseFloat(text);
  if (/мин| ч/.test(text))
    return Number(/(\d+) ч/.exec(text)?.[1] ?? 0) * 60 + Number(/(\d+) мин/.exec(text)?.[1] ?? 0);
  return text;
}

/** Их порядок: пустые — в конце, равные — по исходному порядку. */
export function statSort<
  T extends { index: number; cells: { text: string; sort?: number | null }[] },
>(rows: T[], column: number, direction: "asc" | "desc"): T[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = statSortValue(a.cells[column].text, a.cells[column].sort);
    const y = statSortValue(b.cells[column].text, b.cells[column].sort);
    if (x === null || y === null) return x === y ? a.index - b.index : x === null ? 1 : -1;
    const cmp =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), "ru");
    return cmp * sign || a.index - b.index;
  });
}

/** Их «Скачать таблицу»: «;», всё в кавычках, формулы — с «'», BOM и CRLF. */
export function statCsv(headers: string[], rows: string[][]): string {
  const row = (values: string[]) =>
    values
      .map((v) => {
        const value = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
        return '"' + value.replaceAll('"', '""') + '"';
      })
      .join(";");
  return "﻿" + [row(headers), ...rows.map(row)].join("\r\n");
}

/** Их поиск в таблице: без регистра, по подстроке. */
export const statNormalize = (text: string) => text.toLocaleLowerCase("ru-RU").trim();

// --- Страница (их inbox_statistics_page) ---

export type StatsPerson = {
  user_id: string;
  full_name: string;
  active: boolean;
  communities: number[];
};
export type StatsContext = {
  admin: boolean;
  communities: { id: number; display_name: string; brand: string; city: string }[];
  active: number[];
  people: StatsPerson[];
};
export type StatsQuery = { from?: string; to?: string; managers: string[]; groups: string[] };

export const STATS_TEXT = {
  period: "Выберите корректные даты: начало не позже конца, период — не больше 366 дней.",
  ids: "Недоступный менеджер или группа. Сбросьте фильтры и выберите значения из списка.",
  failed: "Не удалось загрузить статистику. Попробуйте нажать «Показать» ещё раз.",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoValid = (s: string) =>
  ISO_DATE.test(s) &&
  !Number.isNaN(Date.parse(s + "T00:00:00Z")) &&
  new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
/** Полночь по Москве (UTC+3) — секунды Unix. */
const mskMidnight = (iso: string) => Date.parse(iso + "T00:00:00Z") / 1000 - 3 * 3600;

export type StatsScope = {
  from: string;
  to: string;
  start: number;
  end: number;
  error: string | null;
  managerIds: Set<string> | null;
  groupIds: Set<number> | null;
  /** Их scope_groups: группы выборки (после назначений выбранных менеджеров). */
  scopeGroups: Set<number>;
  allowedGroups: Set<number>;
  assignments: Map<string, Set<number>>;
};

/** Их разбор фильтров и выборка групп (до запросов к базе). */
export function inboxStatsScope(ctx: StatsContext, q: StatsQuery, today: string): StatsScope {
  const first = today.slice(0, 8) + "01";
  let error: string | null = null;
  let from = q.from ?? first;
  let to = q.to ?? today;
  if (!isoValid(from) || !isoValid(to) || to < from || dayDiff(from, to) >= 366) {
    error = STATS_TEXT.period;
    from = first;
    to = today;
  }
  const people = new Map(ctx.people.map((p) => [p.user_id, p]));
  const allowedGroups = new Set(ctx.communities.map((c) => c.id));
  // Сводка команды — всем лид-менеджерам; детали групп — только своих.
  const aggregateGroups = ctx.admin ? allowedGroups : new Set(ctx.active);
  const allowedManagers = new Set(people.keys());
  let managerIds: Set<string> | null = null;
  let groupIds: Set<number> | null = null;
  const parse = <T>(
    values: string[],
    ok: (v: string) => T | null,
    allowed: Set<T>,
  ): Set<T> | null => {
    if (!values.length) return null;
    const parsed = new Set(values.map(ok).filter((v): v is T => v !== null));
    if (
      !parsed.size ||
      [...parsed].some((v) => !allowed.has(v)) ||
      parsed.size !== new Set(values).size
    )
      throw new Error(STATS_TEXT.ids);
    return parsed;
  };
  try {
    managerIds = parse(q.managers, (v) => (/^[0-9a-f-]{36}$/.test(v) ? v : null), allowedManagers);
    groupIds = parse(q.groups, (v) => (/^\d+$/.test(v) ? Number(v) : null), allowedGroups);
  } catch (e) {
    error = (e as Error).message;
    managerIds = null;
    groupIds = null;
  }
  let scopeGroups = groupIds ?? aggregateGroups;
  const leadManagers = [...allowedManagers].filter((u) => managerIds === null || managerIds.has(u));
  const assignments = new Map(
    leadManagers.map((u) => [u, new Set(people.get(u)?.communities ?? [])] as const),
  );
  if (managerIds !== null) {
    const union = new Set([...assignments.values()].flatMap((s) => [...s]));
    scopeGroups = new Set([...scopeGroups].filter((g) => union.has(g)));
  }
  return {
    from,
    to,
    start: mskMidnight(from),
    end: mskMidnight(to) + 86_400,
    error,
    managerIds,
    groupIds,
    scopeGroups,
    allowedGroups,
    assignments,
  };
}

export type ManagerStatRow = {
  user_id: string;
  replies: number;
  dialogs: number;
  first_responses: number;
  median_seconds: number | null;
  p90_seconds: number | null;
};

export type StatCell = { text: string; sort?: number | null };
export type StatTable = { headers: string[]; rows: { key: string; cells: StatCell[] }[] };

export type InboxStatsView = {
  admin: boolean;
  from: string;
  to: string;
  error: string | null;
  managers: { id: string; name: string }[];
  groups: { id: number; name: string }[];
  kpi: { leads: number; phones: number; converted: number; conversion: string };
  pending: number;
  managerTable: StatTable;
  groupTable: StatTable;
  activity: StatTable | null;
  empty: boolean;
};

export const MANAGER_HEADERS = [
  "Групп",
  "Менеджер",
  "Новые лиды",
  "Номера от новых лидов",
  "Скорость первого ответа",
  "Первых ответов",
  "Скорость ответа",
  "Ответов в расчёте",
  "Лид → телефон",
  "Всего получено номеров",
  "Все номера / новые лиды",
];
export const GROUP_HEADERS = [
  "Группа",
  "Город",
  "Новые лиды",
  "Получены телефоны",
  "Телефоны от новых лидов",
  "Лид → телефон",
];
export const ACTIVITY_HEADERS = [
  "Менеджер",
  "Диалоги с ответами",
  "Получено телефонов из этих диалогов",
  "Диалог → телефон",
  "Всего получено телефонов",
  "Телефонов получено ботом",
];

/** Их таблицы, плитки и состояние страницы из посчитанного. */
export function inboxStatsView(
  ctx: StatsContext,
  scope: StatsScope,
  statistics: ManagerStatRow[],
  funnel: LeadSummary | null,
  speed: ReturnType<typeof summarizeResponseStatistics> | null,
  error: string | null,
): InboxStatsView {
  const people = new Map(ctx.people.map((p) => [p.user_id, p]));
  const nameOf = (uid: string) => {
    const p = people.get(uid);
    const name = p?.full_name || `Пользователь #${uid}`;
    return p && !p.active ? `${name} (неактивен)` : name;
  };
  const stats = new Map(
    statistics
      .filter((r) => scope.managerIds === null || scope.managerIds.has(r.user_id))
      .map((r) => [r.user_id, r]),
  );
  const empty: LeadSummary = {
    daily: [],
    groups: [],
    leads: 0,
    phones: 0,
    converted: 0,
    unassigned_leads: 0,
    unassigned_phones: 0,
    bot_phones: 0,
    pending_history: 0,
    activity: new Map(),
  };
  const f = funnel ?? empty;
  const managerRows = summarizeManagerScopes(scope.assignments, f.groups, scope.scopeGroups)
    .sort(
      (a, b) =>
        b.leads - a.leads ||
        pyCmp(people.get(a.user_id)?.full_name ?? "", people.get(b.user_id)?.full_name ?? ""),
    )
    .map((item) => {
      const sp = speed?.managers.get(item.user_id);
      const personal = stats.get(item.user_id);
      return {
        key: item.user_id,
        cells: [
          { text: String(item.group_count) },
          { text: nameOf(item.user_id) },
          { text: String(item.leads) },
          { text: String(item.phones) },
          { text: inboxDuration(personal?.median_seconds), sort: personal?.median_seconds ?? -1 },
          { text: String(personal?.first_responses ?? 0) },
          {
            text: inboxDuration(sp?.response_median_seconds),
            sort: sp?.response_median_seconds ?? -1,
          },
          { text: String(sp?.response_count ?? 0) },
          { text: inboxConversion(item.phones, item.leads) },
          { text: String(item.total_phones) },
          { text: inboxConversion(item.total_phones, item.leads) },
        ],
      };
    });
  const groupRows = f.groups
    .filter((g) => ctx.admin || scope.allowedGroups.has(g.community_id))
    .map((g) => ({
      key: String(g.community_id),
      cells: [
        { text: g.name },
        { text: g.city },
        { text: String(g.leads) },
        { text: String(g.phones) },
        { text: String(g.converted) },
        { text: inboxConversion(g.converted, g.leads) },
      ],
    }));
  let activity: StatTable | null = null;
  if (ctx.admin) {
    const rows = [...f.activity]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([uid, item]) => ({
        key: uid,
        cells: [
          { text: people.get(uid)?.full_name || `Пользователь #${uid}` },
          { text: String(item.dialogs) },
          { text: String(item.converted_dialogs) },
          { text: inboxConversion(item.converted_dialogs, item.dialogs) },
          { text: String(item.phones) },
          { text: "—" },
        ],
      }));
    if (scope.managerIds === null)
      rows.push({
        key: "bot",
        cells: [
          { text: "Бот" },
          { text: "—" },
          { text: "—" },
          { text: "—" },
          { text: "—" },
          { text: String(f.bot_phones) },
        ],
      });
    activity = { headers: ACTIVITY_HEADERS, rows };
  }
  return {
    admin: ctx.admin,
    from: scope.from,
    to: scope.to,
    error,
    managers: [...ctx.people]
      .sort((a, b) => pyCmp(a.full_name, b.full_name))
      .map((p) => ({ id: p.user_id, name: p.full_name })),
    groups: ctx.communities.map((c) => ({ id: c.id, name: c.display_name })),
    kpi: {
      leads: f.leads,
      phones: f.phones,
      converted: f.converted,
      conversion: inboxConversion(f.converted, f.leads),
    },
    pending: f.pending_history,
    managerTable: { headers: MANAGER_HEADERS, rows: managerRows },
    groupTable: { headers: GROUP_HEADERS, rows: groupRows },
    activity,
    empty: !error && !scope.assignments.size && !f.groups.length && !stats.size,
  };
}
