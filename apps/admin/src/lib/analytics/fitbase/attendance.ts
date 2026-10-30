/**
 * FitBase — «Занятия и посещаемость», как у них: attendance_report
 * (fitbase_runtime.py), страница fitbase_attendance_page (app.py) и её
 * скрипт fitbase-attendance.js (промежуточные итоги по студиям с данными,
 * строки студий без данных у администратора). Множества занятий, записей и
 * посещений по группам считает база (RPC an_fb_attendance_data); здесь —
 * их средние, доходимость, покрытие, сравнения и форматы. Без React.
 */
import { fbFixed, fbInteger } from "./reports";

export const FB_ATT_METRICS = [
  "lessons",
  "registered",
  "visited",
  "avg_registered",
  "avg_visited",
  "attendance",
] as const;
export type FbAttMetric = (typeof FB_ATT_METRICS)[number];
export type FbAttView = "current" | "month" | "year";
export const FB_ATT_VIEWS: FbAttView[] = ["current", "month", "year"];

/** Их подписи плиток (labels). */
export const FB_ATT_LABELS: Record<FbAttMetric, string> = {
  lessons: "Занятий проведено",
  registered: "Записей на занятия",
  visited: "Посещений",
  avg_registered: "Среднее записано на занятие",
  avg_visited: "Среднее посетило на занятие",
  attendance: "Доходимость",
};

export type FbAttConnection = {
  id: number;
  name: string;
  city: string;
  brand: string;
  studio_status: "active" | "archived";
  attendance_synced_at: number | null;
  attendance_from: string;
  attendance_to: string;
  attendance_state: string;
  sync_state: string;
  busy: boolean;
};

export type FbAttendanceData = {
  from: string;
  to: string;
  pm_from: string;
  pm_to: string;
  py_from: string;
  py_to: string;
  admin: boolean;
  /** Все подключения — для фильтров (их fb.connections()). */
  connections: {
    id: number;
    name: string;
    city: string;
    brand: string;
    club_id: string;
    studio_status: string;
  }[];
  /** Отобранные студии (одна на пару «домен + клуб»). */
  selected: FbAttConnection[];
  trainings: string[];
  /** [вид, город|null, студия|null, направление|null, занятия, записи, посещения, неизвестный код] */
  groups: [
    FbAttView,
    string | null,
    number | null,
    string | null,
    number,
    number,
    number,
    boolean,
  ][];
  /** Неизвестные коды текущего периода: [студия, код]. */
  unknown: [number, string][];
};

export type FbAttMetrics = Record<FbAttMetric, number | null> & {
  lessons: number;
  registered: number;
  visited: number;
};
export type FbAttAvailability = Record<FbAttMetric, boolean>;
export type FbAttKey = [string, number | null, string | null];

export type FbAttGroup = {
  key: FbAttKey;
  metrics: Record<FbAttView, FbAttMetrics>;
  coverage: Record<FbAttView, FbAttAvailability>;
};

export type FbAttendanceReport = {
  windows: Record<FbAttView, [string, string]>;
  total: Record<FbAttView, FbAttMetrics>;
  metricCoverage: Record<FbAttView, FbAttAvailability>;
  coverage: Record<FbAttView, boolean>;
  groups: Map<string, FbAttGroup>;
  connections: FbAttConnection[];
  trainings: string[];
  unknown: [number, string][];
  ready: boolean;
  updated: number | null;
};

const keyOf = (k: FbAttKey) => JSON.stringify(k);
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Их metrics(): средние и доходимость из количеств. */
export function fbAttMetrics(lessons: number, registered: number, visited: number): FbAttMetrics {
  return {
    lessons,
    registered,
    visited,
    avg_registered: lessons ? registered / lessons : null,
    avg_visited: lessons ? visited / lessons : null,
    attendance: registered ? (visited / registered) * 100 : null,
  };
}

const empty = () => fbAttMetrics(0, 0, 0);

/** Их attendance_report: итоги, группы, покрытие и готовность по видам. */
export function fbAttendanceReport(data: FbAttendanceData): FbAttendanceReport {
  const windows: Record<FbAttView, [string, string]> = {
    current: [data.from, data.to],
    month: [data.pm_from, data.pm_to],
    year: [data.py_from, data.py_to],
  };
  const total: Record<FbAttView, FbAttMetrics> = {
    current: empty(),
    month: empty(),
    year: empty(),
  };
  const unknownView: Record<FbAttView, boolean> = { current: false, month: false, year: false };
  const raw = new Map<
    string,
    {
      key: FbAttKey;
      metrics: Record<FbAttView, FbAttMetrics>;
      problems: Record<FbAttView, boolean>;
    }
  >();
  for (const [view, city, uid, training, lessons, registered, visited, problems] of data.groups) {
    const m = fbAttMetrics(lessons, registered, visited);
    if (city === null) {
      total[view] = m;
      unknownView[view] = problems;
      continue;
    }
    const key: FbAttKey = [city, uid, training];
    const k = keyOf(key);
    if (!raw.has(k)) {
      raw.set(k, {
        key,
        metrics: { current: empty(), month: empty(), year: empty() },
        problems: { current: false, month: false, year: false },
      });
    }
    const g = raw.get(k)!;
    g.metrics[view] = m;
    g.problems[view] = problems;
  }
  const loadedFor = (conns: FbAttConnection[], [lo, hi]: [string, string]) =>
    conns.length > 0 &&
    conns.every(
      (c) => !!c.attendance_synced_at && c.attendance_from <= lo && c.attendance_to >= hi,
    );
  const availability = (
    conns: FbAttConnection[],
    view: FbAttView,
    problems: boolean,
  ): FbAttAvailability => {
    const loaded = loadedFor(conns, windows[view]);
    return Object.fromEntries(
      FB_ATT_METRICS.map((m) => [m, loaded && (m === "lessons" || !problems)]),
    ) as FbAttAvailability;
  };
  const selected = data.selected;
  const coverage = Object.fromEntries(
    FB_ATT_VIEWS.map((v) => [v, loadedFor(selected, windows[v]) && !unknownView[v]]),
  ) as Record<FbAttView, boolean>;
  const metricCoverage = Object.fromEntries(
    FB_ATT_VIEWS.map((v) => [v, availability(selected, v, unknownView[v])]),
  ) as Record<FbAttView, FbAttAvailability>;
  const groups = new Map<string, FbAttGroup>();
  for (const [k, g] of raw) {
    const [city, uid] = g.key;
    const owners = selected.filter((c) => c.city === city && (uid === null || c.id === uid));
    groups.set(k, {
      key: g.key,
      metrics: g.metrics,
      coverage: Object.fromEntries(
        FB_ATT_VIEWS.map((v) => [v, availability(owners, v, g.problems[v])]),
      ) as Record<FbAttView, FbAttAvailability>,
    });
  }
  const stamps = selected.map((c) => c.attendance_synced_at).filter((v): v is number => !!v);
  return {
    windows,
    total,
    metricCoverage,
    coverage,
    groups,
    connections: selected,
    trainings: [...data.trainings].sort(codeSort),
    unknown: [...data.unknown].sort((a, b) => a[0] - b[0] || codeSort(a[1], b[1])),
    ready: coverage.current,
    updated: stamps.length ? Math.min(...stamps) : null,
  };
}

export const fbAttGroup = (r: FbAttendanceReport, key: FbAttKey) => r.groups.get(keyOf(key));

/** Их number(): целые — с пробелами, прочее — «1,5», доходимость — «82,3%». */
export function fbAttNumber(value: number | null, key: FbAttMetric): string {
  if (value === null) return "—";
  if (key === "lessons" || key === "registered" || key === "visited") return fbInteger(value);
  return fbFixed(value, 1).replace(".", ",") + (key === "attendance" ? "%" : "");
}

/** Их delta плиток: «↗ +12,3%» к тому же периоду прошлого месяца; null — «—». */
export function fbAttDelta(
  r: FbAttendanceReport,
  key: FbAttMetric,
): { text: string; up: boolean } | null {
  const now = r.total.current[key];
  const prior = r.total.month[key];
  if (!r.metricCoverage.current[key] || !r.metricCoverage.month[key] || now === null || !prior)
    return null;
  const value = ((now - prior) / prior) * 100;
  return {
    text: `${value >= 0 ? "↗" : "↘"} ${fbFixed(value, 1, true).replace(".", ",")}%`,
    up: value >= 0,
  };
}

export type FbAttCell = { text: string; tone?: "up" | "down" };

/** Их cells(): значения текущего периода или изменение к месяцу / году. */
export function fbAttCells(
  metrics: Record<FbAttView, FbAttMetrics>,
  available: Record<FbAttView, FbAttAvailability>,
  view: FbAttView,
): FbAttCell[] {
  return FB_ATT_METRICS.map((key) => {
    if (view === "current") {
      return { text: fbAttNumber(available.current[key] ? metrics.current[key] : null, key) };
    }
    const cur = metrics.current[key];
    const old = metrics[view][key];
    if (!available.current[key] || !available[view][key] || cur === null || !old)
      return { text: "—" };
    const diff = ((cur - old) / old) * 100;
    return {
      text: `${fbFixed(diff, 1, true).replace(".", ",")}%`,
      tone: diff >= 0 ? "up" : "down",
    };
  });
}

/** Строки таблицы: город → студии → направления (их порядок). */
export type FbAttRow =
  | { kind: "city"; key: FbAttKey; label: string }
  | { kind: "studio"; key: FbAttKey; label: string; city: string; id: number }
  | { kind: "training"; key: FbAttKey; label: string; city: string; id: number }
  | { kind: "pending-city"; label: string }
  | { kind: "pending-studio"; label: string; city: string; id: number; status: string };

/** Их подпись строки студии без данных (fitbase-attendance.js, statusLabel). */
export function fbAttPendingLabel(c: FbAttConnection): string {
  if (c.busy) return "Загружается";
  if (/нет доступа/i.test((c.sync_state || "") + (c.attendance_state || "")))
    return "Нет доступа API";
  return c.attendance_synced_at ? "Данные периода ещё не доступны" : "Ожидает загрузки";
}

/**
 * Порядок строк: их сервер — города по алфавиту (точки кода), студии по
 * имени, направления; у администратора их скрипт добавляет студии без
 * строк (и их города) и сортирует города localeCompare('ru').
 */
export function fbAttRows(r: FbAttendanceReport, admin: boolean): FbAttRow[] {
  const groupKeys = [...r.groups.values()].map((g) => g.key);
  const cities = [...new Set(groupKeys.map((k) => k[0]))].sort(codeSort);
  const blocks: { city: string; rows: FbAttRow[] }[] = cities.map((city) => {
    const rows: FbAttRow[] = [{ kind: "city", key: [city, null, null], label: city }];
    const studios = r.connections
      .filter((c) => c.city === city && r.groups.has(keyOf([city, c.id, null])))
      .sort((a, b) => codeSort(a.name, b.name));
    for (const c of studios) {
      rows.push({ kind: "studio", key: [city, c.id, null], label: c.name, city, id: c.id });
      const trainings = groupKeys
        .filter((k) => k[0] === city && k[1] === c.id && k[2] !== null)
        .map((k) => k[2] as string)
        .sort(codeSort);
      for (const t of trainings) {
        rows.push({ kind: "training", key: [city, c.id, t], label: t, city, id: c.id });
      }
    }
    return { city, rows };
  });
  if (!admin || !r.connections.length) return blocks.flatMap((b) => b.rows);
  for (const c of r.connections) {
    if (r.groups.has(keyOf([c.city, c.id, null]))) continue;
    let block = blocks.find((b) => b.city === c.city);
    if (!block) {
      block = { city: c.city, rows: [{ kind: "pending-city", label: c.city }] };
      blocks.push(block);
    }
    block.rows.push({
      kind: "pending-studio",
      label: c.name,
      city: c.city,
      id: c.id,
      status: fbAttPendingLabel(c),
    });
  }
  blocks.sort((a, b) => a.city.localeCompare(b.city, "ru"));
  return blocks.flatMap((b) => b.rows);
}

/** Их summarize() скрипта: суммы по студиям с известными числами. */
export function fbAttSummarize(
  rows: (number | null)[][],
): { value: number | null; known: number }[] {
  const result: { value: number | null; known: number }[] = [];
  for (let metric = 0; metric < 6; metric++) {
    const indices = metric < 3 ? [metric] : metric === 3 ? [0, 1] : metric === 4 ? [0, 2] : [1, 2];
    const known = rows.filter((row) =>
      indices.every((i) => Number.isSafeInteger(row[i]) && (row[i] as number) >= 0),
    );
    const sums = [0, 1, 2].map((i) => known.reduce((s, row) => s + (row[i] || 0), 0));
    let value: number | null = null;
    if (known.length) {
      if (metric < 3) value = sums[metric];
      else if (metric === 3 && sums[0]) value = sums[1] / sums[0];
      else if (metric === 4 && sums[0]) value = sums[2] / sums[0];
      else if (metric === 5 && sums[1]) value = (sums[2] / sums[1]) * 100;
    }
    result.push({ value, known: known.length });
  }
  return result;
}

/** Их format() скрипта: Intl ru-RU (целые и «1,5»), доходимость — с «%». */
export function fbAttPartialNumber(value: number | null, metric: number): string {
  if (value === null) return "—";
  const text = new Intl.NumberFormat(
    "ru-RU",
    metric < 3
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  ).format(value);
  return text + (metric === 5 ? "%" : "");
}

/** Числа строки студии в текущем периоде, как их читает скрипт (прочерк — неизвестно). */
export function fbAttStudioValues(r: FbAttendanceReport, key: FbAttKey): (number | null)[] {
  const g = fbAttGroup(r, key);
  if (!g) return [null, null, null];
  return (["lessons", "registered", "visited"] as const).map((m) =>
    g.coverage.current[m] ? g.metrics.current[m] : null,
  );
}

/** Их тексты страницы. */
export const FB_ATT_TEXT = {
  partial:
    "Промежуточные итоги по студиям с доступными данными за выбранный период. * Неполный итог. Средние и доходимость пересчитаны из количеств по тем же студиям. Незагруженные данные не считаются нулём. Сравнения разных составов студий не показываются.",
  queued:
    "Загрузка запущена в фоне. Состояние доступно в интеграции FitBase. После окончания обновите страницу отчёта.",
  busy: "Для одной или нескольких студий уже идёт загрузка. Дождитесь её завершения.",
  unknownCodes:
    "Для части студий не определены значения кодов записей. Количество проведённых занятий показано по расписанию; показатели клиентов скрыты только там, где коды ещё не сопоставлены. Настройки затронутых студий:",
  notLoaded:
    "Данные выбранного периода ещё не загружены полностью. Нажмите «Обновить данные»; вместе с периодом загрузятся данные для сравнения.",
  noClient:
    "FitBase не передал ID части клиентов этого периода. Уникальных клиентов нельзя посчитать достоверно; проверьте записи в FitBase.",
  noStudios:
    "Для выбранных фильтров нет подключённых студий. Проверьте фильтры и выбор клуба в интеграции FitBase.",
  failed:
    "Последняя попытка обновления занятий завершилась ошибкой. Показана предыдущая успешная выгрузка.",
  rules: [
    "Записано и посетило — количество записей и отметок посещения, а не уникальных людей. Один человек на двух занятиях даёт две записи и два посещения. Каждая запись FitBase учитывается один раз по её ID; повторные заявки на разные занятия не объединяются. Средние на занятие — число записей или посещений, делённое на число занятий. Неизвестный код не скрывает число занятий и данные других студий. Показатели клиентов, средние и доходимость для затронутой строки и её общего итога остаются прочерком до подтверждения кодов.",
    "Проведено — завершившиеся по расписанию неотменённые занятия. Будущие, отменённые занятия и аренда исключены. В записи включаются не подтверждённые, подтверждённые, пришедшие, неявки и поздние отмены. Отказы, лист ожидания и ожидание оплаты исключены. Доходимость — число посещений / число записей на занятия. Сравнение с тем же диапазоном дней прошлого месяца или года. Автообновление ежедневно в 01:00 МСК; вход на страницу загрузку не запускает. Статус студии задаётся в настройках интеграции.",
  ],
};

/** Их сообщение «не готово»: причина и затронутые студии (null — сообщения нет). */
export function fbAttNotReady(
  r: FbAttendanceReport,
): { reason: string; affected: FbAttConnection[] } | null {
  if (r.ready) return null;
  let reason = r.unknown.length ? FB_ATT_TEXT.unknownCodes : FB_ATT_TEXT.notLoaded;
  if (r.unknown.some(([, code]) => code === "Клиент не указан")) reason = FB_ATT_TEXT.noClient;
  if (!r.connections.length) reason = FB_ATT_TEXT.noStudios;
  const ids = new Set(r.unknown.map(([id]) => id));
  return { reason, affected: r.connections.filter((c) => ids.has(c.id)) };
}
