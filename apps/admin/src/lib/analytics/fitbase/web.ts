/**
 * FitBase — основания записей со страниц веб-интерфейса, как у них
 * (automatic-basis/web_source.py и worker.py): разбор HTML их же деревом
 * (HTMLParser Python: теги, атрибуты, текст; закрытие по имени вверх по
 * дереву), строки списка записей `/client-schedule/index` (ID записи,
 * основание — выбранная услуга или абонемент, дата занятия), форма выбора
 * клуба, адрес списка с фильтрами, решение по пагинации, приём основания.
 * Без ввода-вывода.
 */

export class FbWebError extends Error {}
export class FbWebLogin extends FbWebError {}

// --- HTML: их Node / Document поверх токенизатора HTMLParser -------------------------------

export type FbNode = {
  tag: string;
  a: Record<string, string | null>;
  parent: FbNode | null;
  children: (FbNode | string)[];
};

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  times: "×",
  minus: "−",
  bull: "•",
  middot: "·",
  thinsp: "\u2009",
  ensp: " ",
  emsp: " ",
  rarr: "→",
  larr: "←",
  deg: "°",
  euro: "€",
  ruble: "₽",
  shy: "­",
};
const LEGACY = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "laquo", "raquo", "shy"]);

/** html.unescape Python (числовые и распространённые именованные ссылки). */
export function fbUnescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)/g,
    (m, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const num = parseInt(body.slice(hex ? 2 : 1).replace(";", ""), hex ? 16 : 10);
        if (
          !Number.isFinite(num) ||
          num > 0x10ffff ||
          (num >= 0xd800 && num <= 0xdfff) ||
          num === 0
        )
          return "�";
        return String.fromCodePoint(num);
      }
      const name = body.replace(";", "");
      if (body.endsWith(";") && name in NAMED) return NAMED[name];
      if (!body.endsWith(";") && LEGACY.has(name)) return NAMED[name];
      return m;
    },
  );
}

const ATTR_RE =
  /((?<=['"\s/])[^\s/>][^\s/=>]*)(\s*=+\s*('[^']*'|"[^"]*"|(?!['"])[^>\s]*))?(?:\s|\/(?!>))*/y;

// Их tagfind_tolerant / endtagfind (html.parser): имя тега — до пробела,
// «/», «>» или NUL. NUL собирается кодом — в литерале его не пропускает линтер.
const NUL = String.fromCharCode(0);
const START_TAG = new RegExp(`^<([a-zA-Z][^\\t\\n\\r\\f />${NUL}]*)(?:\\s|\\/(?!>))*`);
const END_TAG = new RegExp(`^<\\/\\s*([a-zA-Z][^\\t\\n\\r\\f />${NUL}]*)`);

/** Их Document: дерево HTMLParser (непарный закрывающий тег — поиск вверх). */
export function fbParseHtml(html: string): FbNode {
  const root: FbNode = { tag: "", a: {}, parent: null, children: [] };
  let current = root;
  const start = (tag: string, attrs: Record<string, string | null>) => {
    const n: FbNode = { tag, a: attrs, parent: current, children: [] };
    current.children.push(n);
    if (!VOID.has(tag)) current = n;
  };
  const end = (tag: string) => {
    let n: FbNode = current;
    while (n.parent) {
      if (n.tag === tag) {
        current = n.parent;
        return;
      }
      n = n.parent;
    }
  };
  const text = (s: string) => {
    if (s) current.children.push(fbUnescape(s));
  };
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    const next = html[i + 1] ?? "";
    if (/[a-zA-Z]/.test(next)) {
      // Начальный тег: имя, атрибуты, «>» или «/>».
      const nameMatch = START_TAG.exec(html.slice(i, i + 200));
      const tag = nameMatch![1].toLowerCase();
      let k = i + nameMatch![0].length;
      const attrs: Record<string, string | null> = {};
      while (k < len && html[k] !== ">" && !(html[k] === "/" && html[k + 1] === ">")) {
        ATTR_RE.lastIndex = k;
        const m = ATTR_RE.exec(html);
        if (!m || m.index !== k || m[0].length === 0) {
          k += 1;
          continue;
        }
        let value: string | null = m[3] ?? null;
        if (value !== null) {
          if (
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
          )
            value = value.slice(1, -1);
          value = fbUnescape(value);
        }
        const key = m[1].toLowerCase();
        attrs[key] = value;
        k += m[0].length;
      }
      const selfClosing = html[k] === "/";
      i = k + (selfClosing ? 2 : 1);
      start(tag, attrs);
      if (selfClosing && !VOID.has(tag)) end(tag);
      if (!selfClosing && (tag === "script" || tag === "style")) {
        const close = html.toLowerCase().indexOf(`</${tag}`, i);
        const stop = close < 0 ? len : close;
        // Содержимое script / style — как есть, без ссылок на символы (их cdata_elem).
        if (stop > i) current.children.push(html.slice(i, stop));
        i = stop;
      }
    } else if (next === "/") {
      const close = html.indexOf(">", i);
      if (close < 0) {
        text(html.slice(i));
        break;
      }
      const m = END_TAG.exec(html.slice(i, close + 1));
      if (m) end(m[1].toLowerCase());
      i = close + 1;
    } else if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close < 0 ? len : close + 3;
    } else if (next === "!" || next === "?") {
      const close = html.indexOf(">", i);
      i = close < 0 ? len : close + 1;
    } else {
      text("<");
      i += 1;
    }
  }
  return root;
}

export function* fbWalk(n: FbNode): Generator<FbNode> {
  yield n;
  for (const c of n.children) if (typeof c !== "string") yield* fbWalk(c);
}

export const fbText = (n: FbNode): string =>
  n.children.map((c) => (typeof c === "string" ? c : fbText(c))).join("");

const fbHas = (n: FbNode, cls: string) => (n.a.class ?? "").split(/[ \t\n\r\f]+/).includes(cls);

const PY_WS =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const SPLIT_RE = new RegExp(`${PY_WS}+`, "g");
const EDGE_RE = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "g");
/** ' '.join(s.split()) Python. */
const squash = (s: string) => s.replace(EDGE_RE, "").replace(SPLIT_RE, " ");

/** Их clean_label: до «|», без «(не оплачен…)», пробелы сжаты. */
export function fbCleanLabel(text: string): string {
  const head = text.split("|", 1)[0];
  const cleaned = head.replace(
    new RegExp(`\\(${PY_WS}*не${PY_WS}+оплачен[аоы]?${PY_WS}*\\)`, "gi"),
    "",
  );
  return squash(cleaned);
}

/** Их branch_form: поля _csrf, клубы выбора и выбранный клуб (один — иначе «»). */
export function fbBranchForm(html: string): {
  fields: Record<string, string>;
  allowed: Set<string>;
  selected: string;
} {
  const doc = fbParseHtml(html);
  for (const form of fbWalk(doc)) {
    if (form.tag !== "form" || form.a.action !== "/site/change-club") continue;
    let select: FbNode | undefined;
    for (const n of fbWalk(form)) {
      if (n.tag === "select" && n.a.name === "club-picker") {
        select = n;
        break;
      }
    }
    if (!select) continue;
    const options = [...fbWalk(select)].filter((n) => n.tag === "option");
    // Пункт без value у них — None: не равен ни одному клубу, здесь — «».
    const selected = options.filter((n) => "selected" in n.a).map((n) => n.a.value ?? "");
    const fields: Record<string, string> = {};
    for (const n of fbWalk(form)) {
      if (n.tag === "input" && n.a.name === "_csrf") fields[n.a.name] = n.a.value ?? "";
    }
    return {
      fields,
      allowed: new Set(options.flatMap((n) => (n.a.value == null ? [] : [n.a.value]))),
      selected: selected.length === 1 ? selected[0] : "",
    };
  }
  throw new FbWebError("branch_form_missing");
}

export type FbWebRow = {
  registration_id: string;
  label: string;
  reason_ref: string;
  lesson_time: string;
};

/** Их parse_page: строки, всего записей по счётчику и последняя страница из ссылок. */
export function fbParsePage(
  html: string,
  base: string,
): { rows: FbWebRow[]; total: number; lastPage: number } {
  const doc = fbParseHtml(html);
  let grid: FbNode | undefined;
  for (const n of fbWalk(doc)) {
    if (n.a.id === "w5") {
      grid = n;
      break;
    }
  }
  if (!grid) throw new FbWebError("registration_grid_missing");
  const nodes = [...fbWalk(grid)];
  let headers = nodes.filter((n) => n.tag === "th").map((n) => squash(fbText(n)));
  if (!headers.length) {
    const first = nodes.find((n) => n.tag === "tr");
    headers = first
      ? first.children
          .filter((c): c is FbNode => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
          .map((c) => squash(fbText(c)))
      : [];
  }
  if (!headers.includes("Основание") || !headers.includes("Дата занятия"))
    throw new FbWebError("registration_columns_changed");
  const basisIdx = headers.indexOf("Основание");
  const dateIdx = headers.indexOf("Дата занятия");
  const rows = new Map<string, FbWebRow>();
  for (const tr of nodes) {
    if (tr.tag !== "tr" || !tr.a["data-key"]) continue;
    const rid = tr.a["data-key"];
    if (!/^\d{1,20}$/.test(rid)) throw new FbWebError("invalid_registration_id");
    const cells = tr.children.filter((c): c is FbNode => typeof c !== "string" && c.tag === "td");
    if (cells.length <= Math.max(basisIdx, dateIdx))
      throw new FbWebError("registration_columns_changed");
    const cell = cells[basisIdx];
    const cellNodes = [...fbWalk(cell)];
    const select = cellNodes.find((n) => n.tag === "select" && n.a.name === "reason");
    const selected = select
      ? [...fbWalk(select)].filter((n) => n.tag === "option" && "selected" in n.a)
      : [];
    const name = cellNodes.find((n) => fbHas(n, "item-name-single"));
    const label =
      selected.length === 1
        ? fbCleanLabel(fbText(selected[0]))
        : name
          ? fbCleanLabel(fbText(name))
          : "";
    let ref = selected.length === 1 ? (selected[0].a.value ?? "") : "";
    if (ref && !/^(service|contract)_\d{1,20}$/.test(ref)) ref = "";
    if (Array.from(label).length > 500) throw new FbWebError("label_too_long");
    const row: FbWebRow = {
      registration_id: rid,
      label,
      reason_ref: ref,
      lesson_time: squash(fbText(cells[dateIdx])),
    };
    const prior = rows.get(rid);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row))
      throw new FbWebError("conflicting_registration_rows");
    rows.set(rid, row);
  }
  const baseUrl = new URL(base);
  const links: number[] = [];
  for (const n of nodes) {
    if (n.tag !== "a" || !n.a.href) continue;
    let u: URL;
    try {
      u = new URL(n.a.href, base);
    } catch {
      continue;
    }
    if (
      u.protocol !== baseUrl.protocol ||
      u.host !== baseUrl.host ||
      u.pathname !== baseUrl.pathname
    )
      continue;
    const page = u.searchParams.getAll("page").find((v) => v !== "");
    if (page !== undefined && /^\d+$/.test(page)) links.push(Number(page));
  }
  const summary = nodes.find((n) => fbHas(n, "summary"));
  let total: number | null = null;
  if (summary) {
    const m = /из\s+([\d\s\u00a0\u202f]+)/u.exec(fbText(summary));
    if (m) total = Number(m[1].replace(/\D/gu, ""));
  }
  if (total === null) {
    const empty = nodes.find((n) => fbHas(n, "empty"));
    if (!rows.size && empty && /ничего не найдено|нет результатов/i.test(fbText(empty))) total = 0;
    else throw new FbWebError("registration_total_missing");
  }
  if (total > 0 && !rows.size) throw new FbWebError("nonempty_grid_without_rows");
  return { rows: [...rows.values()], total, lastPage: links.length ? Math.max(...links) : 1 };
}

const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Их list_url: фильтры формы FitBase (даты ДД.ММ.ГГГГ, статус пустой), по 10 строк. */
export function fbListUrl(
  origin: string,
  lo: string,
  hi: string,
  page = 1,
  createdFrom: string | null = null,
  createdTo: string | null = null,
  reverse = false,
): string {
  const fields: [string, string][] = [
    ["registration_date_range", "01.01.2000 - 31.12.2099"],
    ["registration_date_from", "01.01.2000"],
    ["registration_date_to", "31.12.2099"],
    ["schedule_time_start_range", `${ru(lo)} - ${ru(hi)}`],
    ["schedule_time_start_from", ru(lo)],
    ["schedule_time_start_to", ru(hi)],
    ["registration_status", ""],
    ["client_fio", ""],
    ["type", ""],
    ["place", ""],
    ["instructor_name", ""],
    ["training_info", ""],
  ];
  if (createdFrom && createdTo) {
    fields[0][1] = `${ru(createdFrom)} - ${ru(createdTo)}`;
    fields[1][1] = ru(createdFrom);
    fields[2][1] = ru(createdTo);
  }
  const q = new URLSearchParams();
  for (const [k, v] of fields) q.append(`ScheduleRegistrationsSearch[${k}]`, v);
  q.append("page", String(page));
  q.append("per-page", "10");
  q.append("sort", reverse ? "-registration_created_at" : "registration_created_at");
  return `${origin}/client-schedule/index?${q.toString()}`;
}

/** Их basis.origin: адрес FitBase сети по домену подключения. */
export function fbWebOrigin(domain: string): string {
  const raw = domain.trim().toLowerCase();
  let host = "";
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    host = "";
  }
  if (!host.includes(".")) host += ".fitbase.io";
  if (!/^[a-z0-9-]+\.fitbase\.io$/.test(host)) throw new FbWebError("Неверный домен FitBase.");
  return `https://${host}`;
}

export type FbBasisJob = {
  connection_id: number;
  month: string;
  owner: string;
  lo: string;
  hi: string;
  page: number;
  seen: number;
  total: number | null;
  finished_at: number;
  failed_at: number;
  error: string;
  interval_seconds: number;
  anchor: string;
  direction: number;
  passes: number;
  last_fingerprint: string;
  last_page: number;
  last_attempt: number;
};

/** Их pagination_action: дальше, обратный проход или готово (до 3 проходов). */
export function fbPaginationAction(
  job: Pick<FbBasisJob, "page" | "passes" | "last_fingerprint" | "last_page">,
  ids: string[],
  seen: number,
  total: number,
  lastPage: number,
  sha256: (s: string) => string,
): ["reverse" | "complete" | "advance", string] {
  const fingerprint = sha256(JSON.stringify(ids));
  const repeated =
    ids.length > 0 && job.last_fingerprint === fingerprint && job.last_page === job.page - 1;
  if (repeated || (job.page >= lastPage && seen < total)) {
    if ((job.passes || 1) >= 3)
      throw new FbWebError(repeated ? "pagination_repeated" : "pagination_gap");
    return ["reverse", fingerprint];
  }
  if (job.page >= lastPage && seen >= total) return ["complete", fingerprint];
  return ["advance", fingerprint];
}

/** Их jobs(): порядок заданий прохода (свежие, текущий месяц, недавние, старые). */
export function fbBasisJobOrder(jobs: FbBasisJob[], today: string, nowSec: number): FbBasisJob[] {
  const month = today.slice(0, 7);
  const recentEdge = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86400000)
    .toISOString()
    .slice(0, 10);
  const rank = (j: FbBasisJob) =>
    j.month === "recent" ? 0 : j.month === month ? 1 : j.hi >= recentEdge ? 2 : 3;
  return jobs
    .filter(
      (j) =>
        (j.finished_at === 0 || j.finished_at + j.interval_seconds <= nowSec) &&
        j.failed_at < nowSec - 900,
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.last_attempt - b.last_attempt ||
        a.finished_at - b.finished_at ||
        a.connection_id - b.connection_id ||
        (a.month < b.month ? 1 : a.month > b.month ? -1 : 0),
    );
}

/** Дата занятия со страницы («дд.мм.гггг чч:мм») → ISO; null — не тот формат. */
export function fbLessonDay(text: string): string | null {
  // strptime('%d.%m.%Y %H:%M'): день, месяц, часы и минуты — одна или две цифры.
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{1,2})$/.exec(text);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59) return null;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > days) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type FbEvidence = FbWebRow & { captured_at: number };
export type FbApplyCounts = Record<
  "trial" | "regular" | "unknown_label" | "not_in_api_cache" | "empty" | "time_mismatch",
  number
>;
/** Ответ an_fb_basis_lookup: владелец подключения, записи API (занятие, день), прежние основания. */
export type FbEvidenceLookup = {
  owner: string | null;
  records: Record<string, [string, string]>;
  basis: Record<string, number>;
};

/**
 * Их apply_evidence без базы: что записать в основания и счётчики. Владелец
 * подключения сменился — ошибка; пустое основание, записи нет в загрузке API,
 * не тот день занятия, название не сопоставлено — пропуск; прежнее основание
 * свежее — пропуск без счёта.
 */
export function fbEvidenceDecide(
  owner: string,
  look: FbEvidenceLookup,
  rows: FbEvidence[],
  resolve: (label: string) => number,
  nowSec: number,
): {
  accepted: {
    owner: string;
    registration_id: string;
    event_id: string;
    label: string;
    captured_at: number;
    imported_at: number;
  }[];
  counts: FbApplyCounts;
} {
  if (look.owner !== owner) throw new FbWebError("connection_owner_changed");
  const counts: FbApplyCounts = {
    trial: 0,
    regular: 0,
    unknown_label: 0,
    not_in_api_cache: 0,
    empty: 0,
    time_mismatch: 0,
  };
  const accepted = new Map<string, ReturnType<typeof fbEvidenceDecide>["accepted"][number]>();
  for (const r of rows) {
    if (!r.label) {
      counts.empty += 1;
      continue;
    }
    const record = look.records[r.registration_id];
    if (!record) {
      counts.not_in_api_cache += 1;
      continue;
    }
    if (fbLessonDay(r.lesson_time) !== record[1]) {
      counts.time_mismatch += 1;
      continue;
    }
    const k = resolve(r.label);
    if (k < 0) {
      counts.unknown_label += 1;
      continue;
    }
    const captured = Math.trunc(Number(r.captured_at));
    const old = accepted.get(r.registration_id)?.captured_at ?? look.basis[r.registration_id];
    if (old !== undefined && old > captured) continue;
    accepted.set(r.registration_id, {
      owner,
      registration_id: r.registration_id,
      event_id: record[0],
      label: r.label,
      captured_at: captured,
      imported_at: nowSec,
    });
    counts[k === 1 ? "trial" : "regular"] += 1;
  }
  return { accepted: [...accepted.values()], counts };
}

/** Состояния сборщика (их status.json) — подписи страницы. */
export const FB_BASIS_STATES: Record<string, string> = {
  not_authorized: "Сессия FitBase не подключена",
  authorized: "Сессия подключена, сбор ещё не запускался",
  running: "Идёт сверка истории",
  up_to_date: "Всё сверено",
  attention_required: "Есть задания с ошибками",
  login_required: "Нужен повторный вход в FitBase",
  worker_error: "Ошибка сборщика",
};

/** Их коды ошибок заданий — пояснения. */
export const FB_BASIS_ERRORS: Record<string, string> = {
  pagination_repeated: "FitBase повторил страницу списка",
  pagination_gap: "Число записей не сошлось со счётчиком FitBase",
  pagination_incomplete: "Список записей не дочитан",
  branch_access_missing: "У учётной записи нет доступа к клубу",
  branch_switch_not_verified: "Клуб не переключился",
  branch_changed_during_read: "Клуб переключили во время чтения",
  branch_form_missing: "Нет выбора клуба на странице",
  csrf_missing: "Нет защитного кода формы",
  registration_grid_missing: "Нет списка записей на странице",
  registration_columns_changed: "Изменились колонки списка записей",
  registration_total_missing: "Нет счётчика записей",
  nonempty_grid_without_rows: "Счётчик есть, строк нет",
  invalid_registration_id: "Неверный ID записи",
  conflicting_registration_rows: "Одна запись с разными основаниями",
  label_too_long: "Слишком длинное основание",
  connection_owner_changed: "Изменились домен или клуб подключения",
  response_too_large: "Слишком большой ответ FitBase",
  cross_origin_redirect_blocked: "FitBase перенаправил на другой адрес",
  request_failed: "FitBase не ответил",
};
