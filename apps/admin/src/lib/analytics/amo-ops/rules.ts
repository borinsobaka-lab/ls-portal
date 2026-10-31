/**
 * «Операционная аналитика amoCRM» — их пилот amocrm-operations построчно, без
 * сети: очистка фактов (collector.py: sanitize_lead / sanitize_task /
 * sanitize_event), нормализация событий и задач (normalize_events /
 * normalize_tasks), расчёты (metrics.py: lead_reaction, reaction_summary,
 * task_status), отчёт (report.py: build_report) и вычисления их страницы
 * (ui/report.html: реакция, задачи, источники и неквал).
 */

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
/** Python bool(). */
export const opsTruthy = (v: unknown) =>
  v === null || v === undefined
    ? false
    : typeof v === "boolean"
      ? v
      : typeof v === "number"
        ? v !== 0
        : typeof v === "string"
          ? v.length > 0
          : Array.isArray(v)
            ? v.length > 0
            : Object.keys(v as object).length > 0;
/** Python str() для значений JSON. */
const pyStr = (v: unknown) =>
  typeof v === "string"
    ? v
    : v === null || v === undefined
      ? "None"
      : typeof v === "boolean"
        ? v
          ? "True"
          : "False"
        : typeof v === "number"
          ? String(v)
          : JSON.stringify(v);
/** Python int(). */
const pyInt = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw new TypeError("int");
};
/** Сравнение строк Python (по кодовым точкам). */
export const pyCmp = (a: string, b: string) => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
};

/** Их EVENT_TYPES и KINDS. */
export const OPS_EVENT_TYPES = [
  "task_completed",
  "task_deadline_changed",
  "lead_status_changed",
  "entity_responsible_changed",
  "incoming_call",
  "outgoing_call",
  "incoming_chat_message",
  "outgoing_chat_message",
] as const;
const KINDS: Record<string, string> = {
  task_completed: "task_completed",
  lead_status_changed: "stage_changed",
  outgoing_call: "call_attempt",
  outgoing_chat_message: "outgoing_message",
};
/** Их PRIMARY: основные действия по заявке. */
const PRIMARY = new Set(["message_attempt", "outgoing_message", "call_attempt", "task_completed"]);

export type OpsConfig = {
  close_basis_field_id: string;
  auto_source_field_id: string;
  manual_source_field_id: string;
  unqualified_reasons: Record<string, string>;
  user_labels: Record<string, string>;
};

export type OpsLead = {
  account_id: string;
  id: string;
  created_at: number;
  updated_at: number;
  responsible_user_id: string;
  pipeline_id: string;
  status_id: string;
  team: string;
  source: string;
  closed_lost: boolean;
  close_reason_id: string;
  contact_ids: string[];
};
export type OpsTask = {
  account_id: string;
  id: string;
  entity_id: string;
  entity_type: string;
  responsible_user_id: string;
  created_at: number;
  updated_at: number;
  current_deadline: number;
  is_completed: boolean;
  task_type_id: string;
};
export type OpsValue = Record<string, Record<string, unknown>>;
export type OpsEvent = {
  account_id: string;
  id: string;
  type: string;
  entity_id: string;
  entity_type: string;
  occurred_at: number;
  created_by: string;
  before: OpsValue[];
  after: OpsValue[];
};

/** Их field(): enum_id и значение (до 150 знаков) первого значения поля. */
function field(lead: Dict, fieldId: unknown): [string, string] {
  const fields = Array.isArray(lead.custom_fields_values) ? lead.custom_fields_values : [];
  for (const f of fields) {
    if (!isDict(f) || pyStr(f.field_id ?? null) !== pyStr(fieldId ?? null)) continue;
    const values = Array.isArray(f.values) ? f.values : [];
    if (values.length) {
      const v = isDict(values[0]) ? values[0] : {};
      const value = opsTruthy(v.value) ? pyStr(v.value) : "";
      return [opsTruthy(v.enum_id) ? pyStr(v.enum_id) : "", [...value].slice(0, 150).join("")];
    }
  }
  return ["", ""];
}

/** Их sanitize_lead: без контактов и текстов, только ID, время, этап, источник. */
export function sanitizeLead(lead: Dict, account: string, config: OpsConfig): OpsLead {
  const [reason] = field(lead, config.close_basis_field_id);
  const [, automatic] = field(lead, config.auto_source_field_id);
  const [, manual] = field(lead, config.manual_source_field_id);
  const resp = opsTruthy(lead.responsible_user_id) ? pyStr(lead.responsible_user_id) : "";
  const embedded = isDict(lead._embedded) ? lead._embedded : {};
  const contacts = Array.isArray(embedded.contacts) ? embedded.contacts : [];
  return {
    account_id: account,
    id: pyStr(lead.id),
    created_at: pyInt(lead.created_at),
    updated_at: pyInt(lead.updated_at),
    responsible_user_id: resp,
    pipeline_id: opsTruthy(lead.pipeline_id) ? pyStr(lead.pipeline_id) : "",
    status_id: opsTruthy(lead.status_id) ? pyStr(lead.status_id) : "",
    team: config.user_labels[resp] ?? "amo user " + (resp || "unknown"),
    source: automatic || manual || "Источник не указан",
    closed_lost: pyStr(lead.status_id ?? null) === "143",
    close_reason_id: reason,
    contact_ids: contacts
      .filter((x) => isDict(x) && opsTruthy(x.id))
      .map((x) => pyStr((x as Dict).id)),
  };
}

/** Их sanitize_task. */
export function sanitizeTask(task: Dict, account: string): OpsTask {
  const s = (v: unknown) => (opsTruthy(v) ? pyStr(v) : "");
  return {
    account_id: account,
    id: pyStr(task.id),
    entity_id: s(task.entity_id),
    entity_type: s(task.entity_type),
    responsible_user_id: s(task.responsible_user_id),
    created_at: pyInt(task.created_at),
    updated_at: pyInt(task.updated_at),
    current_deadline: pyInt(task.complete_till),
    is_completed: opsTruthy(task.is_completed),
    task_type_id: s(task.task_type_id),
  };
}

const VALUE_KEYS: [string, string[]][] = [
  ["task_deadline", ["timestamp"]],
  ["responsible_user", ["id"]],
  ["lead_status", ["id", "pipeline_id"]],
  ["note", ["id"]],
  ["message", ["id"]],
];

/** Их sanitize_event: из значений «до / после» — только ID и сроки. */
export function sanitizeEvent(event: Dict, account: string): OpsEvent {
  const select = (values: unknown): OpsValue[] => {
    const out: OpsValue[] = [];
    for (const v of Array.isArray(values) ? values : []) {
      if (!isDict(v)) continue;
      const row: OpsValue = {};
      for (const [name, keys] of VALUE_KEYS) {
        const inner = v[name];
        if (isDict(inner))
          row[name] = Object.fromEntries(keys.filter((k) => k in inner).map((k) => [k, inner[k]]));
      }
      if (Object.keys(row).length) out.push(row);
    }
    return out;
  };
  return {
    account_id: account,
    id: pyStr(event.id),
    type: event.type as string,
    entity_id: pyStr(event.entity_id),
    entity_type: event.entity_type as string,
    occurred_at: pyInt(event.created_at),
    created_by: opsTruthy(event.created_by) ? pyStr(event.created_by) : "0",
    before: select(event.value_before),
    after: select(event.value_after),
  };
}

export type OpsNormalizedEvent = OpsEvent & { lead_id: string; kind: string; actor_kind: string };

/** Их normalize_events: событие — к сделке (прямо или через задачу), контактные — без связи. */
export function normalizeEvents(
  leads: OpsLead[],
  tasks: OpsTask[],
  events: OpsEvent[],
  humans: Set<string>,
  bots: Set<string>,
): [OpsNormalizedEvent[], Record<string, number>] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const leadIds = new Set(leads.map((l) => l.id));
  const output: OpsNormalizedEvent[] = [];
  const unresolved: Record<string, number> = {};
  for (const e of events) {
    if (!(e.type in KINDS)) continue;
    let parent: string | null = null;
    if (e.entity_type === "lead" && leadIds.has(e.entity_id)) parent = e.entity_id;
    else if (e.entity_type === "task") {
      const task = taskMap.get(e.entity_id);
      if (
        task &&
        (task.entity_type === "leads" || task.entity_type === "lead") &&
        leadIds.has(task.entity_id)
      )
        parent = task.entity_id;
    }
    if (!parent) {
      unresolved[e.type] = (unresolved[e.type] ?? 0) + 1;
      continue;
    }
    const actor = humans.has(e.created_by) ? "human" : bots.has(e.created_by) ? "bot" : "unknown";
    output.push({ ...e, lead_id: parent, kind: KINDS[e.type], actor_kind: actor });
  }
  return [output, unresolved];
}

export type OpsNormalizedTask = OpsTask & {
  completed_at: number | null;
  deadline_at_completion: number | null;
  original_deadline: number | null;
  state_after_cutoff: boolean;
  moved_after_due: boolean;
};

/** Их int(e['before'][0]['task_deadline']['timestamp']) — нет значения — ошибка. */
function deadlineOf(e: OpsEvent): number {
  const td = e.before[0].task_deadline;
  if (!isDict(td) || !("timestamp" in td)) throw new TypeError("deadline");
  return pyInt(td.timestamp);
}

/** Их normalize_tasks: срок на момент завершения — по истории переносов. */
export function normalizeTasks(
  tasks: OpsTask[],
  events: OpsEvent[],
  start: number,
  end: number,
): OpsNormalizedTask[] {
  const byTask = new Map<string, OpsEvent[]>();
  for (const e of events) {
    if (e.entity_type !== "task") continue;
    const list = byTask.get(e.entity_id) ?? [];
    list.push(e);
    byTask.set(e.entity_id, list);
  }
  return tasks.map((task) => {
    const history = [...(byTask.get(task.id) ?? [])].sort(
      (a, b) => a.occurred_at - b.occurred_at || pyCmp(a.id, b.id),
    );
    const completions = history.filter((e) => e.type === "task_completed");
    const completed =
      completions.length && task.is_completed
        ? completions[completions.length - 1].occurred_at
        : null;
    const changes = history.filter((e) => e.type === "task_deadline_changed");
    let deadline: number | null = task.current_deadline;
    if (completed !== null) {
      let valid = true;
      for (const e of [...changes].reverse()) {
        if (e.occurred_at > completed) {
          try {
            deadline = deadlineOf(e);
          } catch {
            valid = false;
          }
        } else if (e.occurred_at === completed) valid = false;
      }
      if (!valid) deadline = null;
    } else deadline = null;
    let original: number | null = null;
    if (start <= task.created_at && task.created_at <= end && task.updated_at <= end) {
      try {
        original = changes.length ? deadlineOf(changes[0]) : task.current_deadline;
      } catch {
        original = null;
      }
    }
    const moved = changes.some((e) => {
      if (!e.before.length) return false;
      const td = e.before[0].task_deadline;
      const ts = isDict(td) && "timestamp" in td ? (td.timestamp as number) : e.occurred_at;
      return ts < e.occurred_at;
    });
    return {
      ...task,
      completed_at: completed,
      deadline_at_completion: deadline,
      original_deadline: original,
      state_after_cutoff: task.updated_at > end,
      moved_after_due: moved,
    };
  });
}

// --- metrics.py ---

export type OpsReaction = {
  status: "primary" | "stage_only" | "not_observed";
  event_id: string | null;
  kind: string | null;
  minutes: number | null;
  unknown_actor_events: number;
};

const sameEvent = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameEvent(x, b[i]));
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameEvent(a[k], b[k]));
  }
  return false;
};

/** Их lead_reaction: первое основное действие человека; перенос этапа — запасной признак. */
export function leadReaction(
  lead: { account_id: string; id: string; created_at: number },
  events: {
    account_id: string;
    id: string;
    lead_id?: string;
    occurred_at: number;
    kind: string;
    actor_kind: string;
  }[],
  cutoff: number,
): OpsReaction {
  const seen = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    if (
      e.account_id === lead.account_id &&
      e.lead_id === lead.id &&
      lead.created_at <= e.occurred_at &&
      e.occurred_at <= cutoff
    ) {
      const key = `${e.account_id}\u0000${e.id}`;
      if (seen.has(key) && !sameEvent(seen.get(key), e)) throw new Error("Conflicting event ID");
      seen.set(key, e);
    }
  }
  const candidates = [...seen.values()].sort(
    (a, b) => a.occurred_at - b.occurred_at || pyCmp(String(a.id), String(b.id)),
  );
  const primary = candidates.find((e) => PRIMARY.has(e.kind) && e.actor_kind === "human");
  const stage = candidates.find((e) => e.kind === "stage_changed" && e.actor_kind === "human");
  const event = primary ?? stage;
  return {
    status: primary ? "primary" : stage ? "stage_only" : "not_observed",
    event_id: event ? event.id : null,
    kind: event ? event.kind : null,
    minutes: event ? (event.occurred_at - lead.created_at) / 60 : null,
    unknown_actor_events: candidates.filter(
      (e) => PRIMARY.has(e.kind) && e.actor_kind === "unknown",
    ).length,
  };
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Их reaction_summary. */
export function reactionSummary<L extends OpsLead>(
  leads: L[],
  events: Parameters<typeof leadReaction>[1],
  cutoff: number,
) {
  const rows = leads
    .filter((l) => l.created_at <= cutoff)
    .map((l) => ({ ...l, reaction: leadReaction(l, events, cutoff) }));
  const values = rows
    .filter((r) => r.reaction.status === "primary")
    .map((r) => r.reaction.minutes as number);
  return {
    created: rows.length,
    measured: values.length,
    mean_minutes: values.length ? mean(values) : null,
    median_minutes: values.length ? median(values) : null,
    stage_only: rows.filter((r) => r.reaction.status === "stage_only").length,
    not_observed: rows.filter((r) => r.reaction.status === "not_observed").length,
    rows,
  };
}

export type OpsTaskStatus =
  | "on_time"
  | "late"
  | "overdue"
  | "pending"
  | "unknown_completion"
  | "unknown_deadline"
  | "unknown_state";

/** Их task_status. */
export function taskStatus(
  task: {
    state_after_cutoff?: boolean;
    completed_at?: number | null;
    deadline_at_completion?: number | null;
    is_completed?: boolean;
    current_deadline: number;
  },
  cutoff: number,
): OpsTaskStatus {
  if (task.state_after_cutoff) return "unknown_state";
  const completed = task.completed_at ?? null;
  if (completed !== null && completed <= cutoff) {
    const deadline = task.deadline_at_completion ?? null;
    if (deadline === null) return "unknown_deadline";
    return completed <= deadline ? "on_time" : "late";
  }
  if (task.is_completed && completed === null) return "unknown_completion";
  return task.current_deadline < cutoff ? "overdue" : "pending";
}

// --- report.py: build_report ---

export type OpsSnapshot = {
  leads: OpsLead[];
  tasks: OpsTask[];
  events: OpsEvent[];
  config: OpsConfig;
  humans: string[];
  bots: string[];
  coverage: string;
  request_count: number;
  limitations: string[];
};

export function buildOpsReport(w: {
  account: string;
  start: number;
  end: number;
  captured_at: number;
  snapshot: OpsSnapshot;
}) {
  const { leads, tasks, events } = w.snapshot;
  const [normalized, unresolved] = normalizeEvents(
    leads,
    tasks,
    events,
    new Set(w.snapshot.humans),
    new Set(w.snapshot.bots),
  );
  const observed = normalized
    .filter((e) => e.actor_kind !== "bot")
    .map((e) => ({ ...e, actor_kind: "human" }));
  const observedSummary = reactionSummary(leads, observed, w.end);
  const observedById = new Map(observedSummary.rows.map((r) => [r.id, r.reaction]));
  const human = reactionSummary(leads, normalized, w.end);
  const rows = human.rows.map((r) => ({ ...r, observed_reaction: observedById.get(r.id)! }));
  const eventCounts: Record<string, number> = Object.create(null);
  for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  return {
    account: w.account,
    start: w.start,
    end: w.end,
    captured_at: w.captured_at,
    demo: w.snapshot.coverage === "SYNTHETIC DEMONSTRATION",
    reaction: { ...human, rows },
    events: normalized,
    tasks: normalizeTasks(tasks, events, w.start, w.end).map((t) => ({
      ...t,
      status: taskStatus(t, w.end),
    })),
    reasons: { [w.account]: w.snapshot.config.unqualified_reasons ?? {} } as Record<
      string,
      Record<string, string>
    >,
    unresolved,
    limitations: w.snapshot.limitations,
    coverage: w.snapshot.coverage,
    request_count: w.snapshot.request_count,
    unknown_authors: normalized.filter((e) => e.actor_kind === "unknown").length,
    all_event_types: [...new Set(events.map((e) => e.type))].sort(pyCmp),
    event_counts: eventCounts,
  };
}
export type OpsReport = ReturnType<typeof buildOpsReport>;
export type OpsRow = OpsReport["reaction"]["rows"][number];

// --- ui/report.html ---

export const OPS_KIND_LABELS: Record<string, string> = {
  outgoing_message: "Отправка сообщения",
  call_attempt: "Попытка звонка",
  task_completed: "Выполнение задачи",
  stage_changed: "Перенос сделки",
};
export const OPS_TASK_LABELS: Record<OpsTaskStatus, string> = {
  on_time: "В срок",
  late: "Завершено поздно",
  overdue: "Открытая просрочка",
  pending: "Срок не наступил",
  unknown_completion: "Время завершения неизвестно",
  unknown_deadline: "Срок при завершении неизвестен",
  unknown_state: "Состояние после конца окна",
};
export const OPS_EVENT_LABELS: Record<string, string> = {
  outgoing_call: "Исходящие звонки",
  incoming_call: "Входящие звонки",
  outgoing_chat_message: "Исходящие сообщения",
  incoming_chat_message: "Входящие сообщения",
  task_completed: "Завершения задач",
  task_deadline_changed: "Переносы срока задач",
  lead_status_changed: "Переносы сделок",
  entity_responsible_changed: "Смена ответственного",
};

/** Их rows(): реакция — по всем действиям, кроме ботов; фильтры ответственного и источника. */
export function opsRows(report: OpsReport, team: string, source: string) {
  return report.reaction.rows
    .map((l) => ({
      ...l,
      verified_reaction: l.reaction,
      reaction: l.observed_reaction || l.reaction,
    }))
    .filter(
      (l) => (team === "all" || l.team === team) && (source === "all" || l.source === source),
    );
}
export type OpsViewRow = ReturnType<typeof opsRows>[number];

/** Их сводка вкладки «Реакция»: среднее и медиана измеренных. */
export function opsReactionStats(rows: OpsViewRow[]) {
  const v = rows
    .filter((l) => l.reaction.status === "primary")
    .map((l) => l.reaction.minutes as number)
    .sort((a, b) => a - b);
  return {
    created: rows.length,
    measured: v.length,
    avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null,
    median: v.length
      ? (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2
      : null,
  };
}

/** Их вкладка «Задачи»: при фильтре — задачи сделок из выборки. */
export function opsTasks(report: OpsReport, rows: OpsViewRow[], filtered: boolean) {
  const ids = new Set(rows.map((l) => l.id));
  return filtered
    ? report.tasks.filter(
        (t) => (t.entity_type === "lead" || t.entity_type === "leads") && ids.has(t.entity_id),
      )
    : report.tasks;
}

/** Их вкладка «Источники и неквал»: закрытые по выбранным основаниям (порядок ключей — объекта JS). */
export function opsSources(report: OpsReport, rows: OpsViewRow[]) {
  type Bucket = { n: number; u: number; r: Record<string, number>; ids: string[] };
  const bs: Record<string, Bucket> = Object.create(null);
  for (const l of rows) {
    const b = bs[l.source] || (bs[l.source] = { n: 0, u: 0, r: Object.create(null), ids: [] });
    b.n++;
    const map = report.reasons[l.account_id];
    const reason = map && Object.hasOwn(map, l.close_reason_id) ? map[l.close_reason_id] : "";
    if (l.closed_lost && reason) {
      b.u++;
      b.r[reason] = (b.r[reason] || 0) + 1;
      b.ids.push(l.id);
    }
  }
  return Object.entries(bs).map(([source, b]) => ({ source, ...b, r: Object.entries(b.r) }));
}

const NUM = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
/** Их num(): «—» или число с одним знаком. */
export const opsNum = (n: number | null) => (n === null || n === undefined ? "—" : NUM.format(n));
/** Их stamp(): дата и время по Москве. */
export const opsStamp = (t: number) =>
  new Date(t * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });

/** Окно сбора их мастера: прошедший день по Москве — [00:00, 23:59:59]. */
export function opsWindow(day: string, today: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) return null;
  const utc = Date.parse(day + "T00:00:00Z");
  // Их date.fromisoformat: несуществующий день (30 февраля) — ошибка.
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== day) return null;
  const start = utc / 1000 - 3 * 3600;
  return { start, end: start + 86_400 - 1 };
}
