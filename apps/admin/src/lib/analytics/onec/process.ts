/**
 * Обработка выгрузок 1С — перенос обработчика Lady Stretch
 * (`analytics-1c-test/process.py --recompute` + `build()` и своды
 * `scripts/build_*_summary.py`) как есть: те же правила, порядок файлов,
 * дедупликация, атрибуция пробных и состав снимка (items × facts).
 *
 * Отличия только платформенные:
 *   * «папки» — выгрузки, загруженные на портал (вид × имя файла); имя —
 *     без «_очищено» (сырой файл 1С и очищенный ExcelCleaner — одна выгрузка,
 *     значения у них одинаковые);
 *   * справочники — таблицы портала, а не Excel на ПК;
 *   * окно новых номенклатур — не посреди обработки: обработка
 *     останавливается со списком (status `review`), после выбора категорий её
 *     запускают снова (у них после окна обработка продолжалась сразу).
 */
import {
  cleanedView,
  cleanPlan,
  iterRows,
  openXlsx,
  type Cell,
  type CleanPlan,
  type Inflate,
  type XlsxBook,
} from "./xlsx-read";
import {
  BASE_DESIGNATIONS,
  CLOSED,
  NO_DETAIL_ARTICLE,
  OPEN,
  REVIEW,
  SUBSCRIPTION,
  TRIAL,
  UNDEFINED,
  addDays,
  asNumber,
  asPositiveNumber,
  canonicalCity,
  casefold,
  classifyNomenclature,
  excelRoundTrip,
  normalizeMembershipName,
  normalizeName,
  normalizeProcess,
  normalizeStudio,
  normalizeStudioName,
  normalizeText,
  orEmpty,
  parseActivityDate,
  parseRuDate,
  parseSaleDatetime,
  pyCompare,
  pyFloat,
  pyStr,
  splitNomenclature,
  strip,
} from "./rules";

export type OnecKind = "cash" | "sales" | "classes" | "visits";

/** Папки старого обработчика — виды выгрузок. */
export const ONEC_KIND_FOLDER: Record<OnecKind, string> = {
  cash: "Выгрузки для НДЯ",
  sales: "Продажи",
  classes: "Занятия и направления",
  visits: "Занятия с членством и клиентом",
};

export type OnecFileInput = {
  kind: OnecKind;
  /** Имя выгрузки без «_очищено» (как файл в папке). */
  name: string;
  load: () => Promise<Uint8Array>;
  /** План ExcelCleaner, если уже посчитан для этой версии файла. */
  plan?: CleanPlan;
  /** План посчитан (чтобы сохранить и не считать в следующий раз). */
  onPlan?: (plan: CleanPlan) => void;
};

/** Строка справочника студий — колонки их studios_unique.xlsx по порядку. */
export type StudioRefRow = {
  studio: string | null;
  status: string | null;
  city: string | null;
  partner: string | null;
  comment: string | null;
};
/** Строка справочника номенклатуры (nomenclature_reference.xlsx). */
export type NomenclatureRow = {
  code: string;
  names: string;
  category: string;
  direction: string;
};
/** Строка справочника точки 0 (city_break_even_reference.xlsx): нужные сборке колонки. */
export type BreakEvenRow = {
  direction: string | null;
  city_for_board: string | null;
  amount: string | null;
};

export type OnecReport = "revenue" | "sales" | "activities" | "funnel" | "trial_products" | "zero";
export const ONEC_REPORTS: OnecReport[] = [
  "revenue",
  "sales",
  "activities",
  "funnel",
  "trial_products",
  "zero",
];

export type ItemRow = {
  no: number;
  report: OnecReport;
  city: string;
  studio: string;
  dimension: string;
  code: string;
  status: string;
};
/** Факт: номер item, день, v1…v8. Один (item, день) может прийти несколько раз — суммировать. */
export type FactRow = [
  number,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface SnapshotWriter {
  items(rows: ItemRow[]): Promise<void>;
  facts(rows: FactRow[]): Promise<void>;
}

export type ReviewItem = {
  code: string;
  name: string;
  reason: string;
  suggested_designation: string;
};

export type OnecResult =
  | {
      status: "review";
      nomenclature: NomenclatureRow[];
      review: { items: ReviewItem[]; choices: string[] };
    }
  | {
      status: "done";
      nomenclature: NomenclatureRow[];
      sourceRows: Record<OnecReport, number>;
      issues: Record<string, number>;
      breakEven: Record<string, number>;
      zeroControls: { blankCostRows: number; explicitZeroRows: number; excludedTrialRows: number };
      stats: Record<string, number>;
    };

export class OnecError extends Error {}

export type OnecDeps = {
  inflate: Inflate;
  writer: SnapshotWriter;
  log: (line: string) => void;
};

// --- Порядок файлов --------------------------------------------------------------

/** sorted(glob('*_очищено.xlsx')) на Windows: имена без регистра, по кодам символов. */
function fileSortKey(name: string) {
  const stem = name.replace(/\.xlsx$/i, "");
  return casefold(stem + "_очищено.xlsx");
}
function sortFiles(files: OnecFileInput[]) {
  return [...files].sort((a, b) => pyCompare(fileSortKey(a.name), fileSortKey(b.name)));
}

/** Выгрузка так, как её читает их обработчик: после ExcelCleaner. */
async function book(file: OnecFileInput, inflate: Inflate): Promise<XlsxBook> {
  const raw = await openXlsx(await file.load(), inflate, { sheet: "first" });
  const plan = file.plan ?? (await cleanPlan(raw));
  file.onPlan?.(plan);
  return cleanedView(raw, plan);
}

// --- Справочники --------------------------------------------------------------------

const cell = (v: string | null): Cell => (v === null || v === undefined ? null : v);

/** load_studio_reference (выручка): ключ — str(Студия_1С).strip(). */
function revenueStudioRef(rows: StudioRefRow[]) {
  const ref = new Map<string, { status: string; city: string; partner: string }>();
  for (const r of rows) {
    if (!r.studio) continue;
    ref.set(strip(r.studio), {
      status: r.status !== null ? strip(r.status) : "",
      city: r.city !== null ? strip(r.city) : "",
      partner: r.partner !== null ? strip(r.partner) : "",
    });
  }
  return ref;
}

/** load_studios_reference (продажи, занятия, воронка): ключ — normalize_studio. */
function studioCities(rows: StudioRefRow[]) {
  const ref = new Map<string, string>();
  for (const r of rows) {
    if (r.studio === null) continue;
    ref.set(normalizeStudio(cell(r.studio)), strip(orEmpty(cell(r.city))));
  }
  return ref;
}

/** Справочник process.build: ключ — normalize(r[0]), город и статус без strip. */
function processStudioRef(rows: StudioRefRow[]) {
  const ref = new Map<string, { city: string; status: string }>();
  for (const r of rows) {
    ref.set(normalizeProcess(cell(r.studio)), {
      city: orEmpty(cell(r.city)),
      status: orEmpty(cell(r.status)),
    });
  }
  return ref;
}

/** load_nomenclature_reference: код → категория. */
function categoriesByCode(rows: NomenclatureRow[]) {
  const ref = new Map<string, string>();
  for (const r of rows) ref.set(strip(r.code), strip(r.category ?? ""));
  return ref;
}

/** Порядок строк файла справочника: sorted по (категория, направление, названия, код). */
export function sortNomenclature(rows: NomenclatureRow[]): NomenclatureRow[] {
  return [...rows].sort(
    (a, b) =>
      pyCompare(a.category, b.category) ||
      pyCompare(a.direction, b.direction) ||
      pyCompare(a.names, b.names) ||
      pyCompare(a.code, b.code),
  );
}

/** load_membership_designations: название (нормализованное) → категория; позже в файле — главнее. */
function membershipDesignations(rows: NomenclatureRow[]) {
  const out = new Map<string, string>();
  for (const r of rows) {
    const designation = normalizeText(r.category);
    for (const name of normalizeText(r.names).split(" | ")) {
      const key = normalizeMembershipName(name);
      if (key && designation) out.set(key, designation);
    }
  }
  return out;
}

/** board_references: точка 0 по «Городу для борда» для строк Lady Stretch. */
export function breakEvenByCity(rows: BreakEvenRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (
      strip(orEmpty(cell(r.direction))) !== "Lady Stretch" ||
      !strip(orEmpty(cell(r.city_for_board)))
    ) {
      continue;
    }
    if (r.amount === null) continue;
    const value = pyFloat(r.amount);
    if (!Number.isFinite(value)) continue;
    const name = canonicalCity(r.city_for_board);
    out[name] = (out[name] ?? 0) + value;
  }
  return out;
}

// --- Снимок (process.build: add) ----------------------------------------------------

class SnapshotBuilder {
  private items = new Map<string, number>();
  private newItems: ItemRow[] = [];
  private facts = new Map<string, FactRow>();
  readonly sourceRows: Record<OnecReport, number> = {
    revenue: 0,
    sales: 0,
    activities: 0,
    funnel: 0,
    trial_products: 0,
    zero: 0,
  };

  constructor(
    private ref: Map<string, { city: string; status: string }>,
    private writer: SnapshotWriter,
    private batch = 20_000,
  ) {}

  async add(
    report: OnecReport,
    date: string | null,
    city: Cell,
    studioCell: Cell,
    dimensionCell: Cell,
    codeCell: Cell,
    values: number[],
  ) {
    const studio = normalizeProcess(studioCell);
    const cityName = canonicalCity(city);
    const dimension = orEmpty(dimensionCell);
    const code = orEmpty(codeCell);
    const status = this.ref.get(studio)?.status ?? "";
    const key = `${report}\u0001${cityName}\u0001${studio}\u0001${dimension}\u0001${code}\u0001${status}`;
    let no = this.items.get(key);
    if (no === undefined) {
      no = this.items.size + 1;
      this.items.set(key, no);
      this.newItems.push({ no, report, city: cityName, studio, dimension, code, status });
    }
    // Своды (кроме нулевой номенклатуры) у них проходят через Excel.
    const v = values.map((x) => (report === "zero" ? x || 0 : excelRoundTrip(x || 0)));
    while (v.length < 8) v.push(0);
    if (!studio || v.length !== 8 || !v.every((x) => Number.isFinite(x))) {
      throw new OnecError("Некорректная строка " + report);
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
      throw new OnecError("В своде отсутствует корректная дата");
    }
    const day = date.slice(0, 10);
    const fk = `${no}\u0001${day}`;
    const f = this.facts.get(fk);
    if (f) for (let i = 0; i < 8; i++) f[i + 2] = (f[i + 2] as number) + v[i];
    else this.facts.set(fk, [no, day, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]);
    this.sourceRows[report]++;
    if (this.facts.size >= this.batch) await this.flush();
  }

  async flush() {
    if (this.newItems.length) {
      await this.writer.items(this.newItems);
      this.newItems = [];
    }
    if (this.facts.size) {
      await this.writer.facts([...this.facts.values()]);
      this.facts.clear();
    }
  }
}

// --- Продажи: разбор файла -----------------------------------------------------------

type PaidRow = {
  datetime: string;
  studio: string;
  client: string;
  code: string;
  name: string;
  cost: number;
  payment: number;
};
type ZeroRow = {
  blank: boolean;
  code: string;
  product: string;
  studio: string;
  day: string | null;
};

/** Одна копия повторяющихся строк (студии, коды, названия): строк продаж — сотни тысяч. */
type Intern = (s: string) => string;
function makeIntern(): Intern {
  const pool = new Map<string, string>();
  return (s) => {
    const hit = pool.get(s);
    if (hit !== undefined) return hit;
    pool.set(s, s);
    return s;
  };
}

async function parseSalesFile(b: XlsxBook, intern: Intern) {
  const names = new Map<string, Set<string>>();
  const paid: PaidRow[] = [];
  const zero: ZeroRow[] = [];
  for await (const row of iterRows(b, { minRow: 3, maxCol: 7 })) {
    // collect_nomenclature (max_col=2)
    if (row[1] !== null) {
      const [code, name] = splitNomenclature(row[1]);
      if (code) {
        let set = names.get(code);
        if (!set) names.set(code, (set = new Set()));
        set.add(name);
      }
    }
    // collect_raw_sales_file: оплаченные строки до справочника
    if (row[1] !== null) {
      const payment = asPositiveNumber(row[6]);
      const datetime = parseSaleDatetime(row[3]);
      const studio = normalizeStudio(row[0]);
      if (payment !== null && datetime !== null && studio) {
        const [code, name] = splitNomenclature(row[1]);
        paid.push({
          datetime,
          studio: intern(studio),
          client: intern(strip(orEmpty(row[2]))),
          code: intern(code),
          name: intern(name),
          cost: asNumber(row[5]),
          payment,
        });
      }
    }
    // process.build: нулевые продажи
    const cost = row[5];
    if (typeof cost !== "boolean") {
      let isZero: boolean;
      const blank = cost === null || (typeof cost === "string" && strip(cost) === "");
      if (blank) isZero = true;
      else {
        const n = pyFloat(pyStr(cost).replace(/ /g, "").replace(/,/g, "."));
        isZero = !Number.isNaN(n) && n === 0;
      }
      if (isZero) {
        const datetime = parseSaleDatetime(row[3]);
        const [code, product] = splitNomenclature(row[1]);
        zero.push({
          blank,
          code: intern(code),
          product: intern(product),
          studio: intern(normalizeProcess(row[0])),
          day: datetime ? intern(datetime.slice(0, 10)) : null,
        });
      }
    }
  }
  return { names, paid, zero };
}

// --- Занятия с членством: разбор файла -------------------------------------------------

type VisitRow = {
  studio: Cell;
  status: Cell;
  direction: Cell;
  client: Cell;
  membership: string;
  datetime: Cell;
};

async function parseVisitsFile(b: XlsxBook, trialNames: Set<string>) {
  /** collect_trial_membership_names: названия с «пробн». */
  const marked = new Set<string>();
  /** Строки, которые могут оказаться пробными при окончательном справочнике. */
  const candidates: VisitRow[] = [];
  for await (const row of iterRows(b, { minRow: 3, maxCol: 9 })) {
    const raw = orEmpty(row[4]);
    if (casefold(raw).includes("пробн")) {
      const name = strip(raw);
      if (name) marked.add(name);
    }
    if (!row.some((v) => v !== null && strip(pyStr(v)) !== "")) continue;
    const membership = normalizeText(row[4]);
    if (
      !trialNames.has(normalizeMembershipName(membership)) &&
      !casefold(membership).includes("пробн")
    ) {
      continue;
    }
    candidates.push({
      studio: row[0],
      status: row[1],
      direction: row[2],
      client: row[3],
      membership,
      datetime: row[5],
    });
  }
  return { marked, candidates };
}

// --- Справочник номенклатуры (build_reference) ------------------------------------

export function rebuildNomenclature(
  current: NomenclatureRow[],
  nomenclature: Map<string, Set<string>>,
  trialMembershipNames: Set<string>,
  sha256Hex: (s: string) => string,
) {
  const items = new Map<string, Set<string>>();
  for (const [code, names] of nomenclature) items.set(code, new Set(names));
  const salesNames = new Set<string>();
  for (const names of items.values()) {
    for (const n of names) {
      const k = normalizeName(n);
      if (k) salesNames.add(k);
    }
  }
  for (const name of [...trialMembershipNames].sort(pyCompare)) {
    const k = normalizeName(name);
    if (salesNames.has(k)) continue;
    const code = "Членство:" + sha256Hex(k).slice(0, 16);
    let set = items.get(code);
    if (!set) items.set(code, (set = new Set()));
    set.add(name);
  }

  const existing = new Map<string, { category: string; direction: string }>();
  const existingNames = new Map<string, Set<string>>();
  for (const r of current) {
    const code = strip(r.code);
    existing.set(code, { category: strip(r.category ?? ""), direction: strip(r.direction ?? "") });
    existingNames.set(
      code,
      new Set(
        (r.names ?? "")
          .split(" | ")
          .map((p) => strip(p))
          .filter(Boolean),
      ),
    );
  }

  const rows: NomenclatureRow[] = [];
  for (const [code, names] of items) {
    const display = [...names].filter(Boolean).sort(pyCompare).join(" | ");
    const e = existing.get(code) ?? { category: REVIEW, direction: "" };
    rows.push({ code, names: display, category: e.category, direction: e.direction });
  }
  const sorted = sortNomenclature(rows);

  const trialNormalized = new Set([...trialMembershipNames].map((n) => normalizeName(n)));
  const review: ReviewItem[] = [];
  for (const r of rows) {
    const known = existingNames.get(r.code) ?? new Set<string>();
    const newNames = [...(items.get(r.code) ?? [])].filter((n) => !known.has(n));
    if (["", REVIEW, UNDEFINED].includes(r.category) || newNames.length > 0) {
      const isTrialMembership = [...(items.get(r.code) ?? [])].some((n) =>
        trialNormalized.has(normalizeName(n)),
      );
      review.push({
        code: r.code,
        name: r.names,
        reason: isTrialMembership
          ? "Номенклатура из выгрузки занятий"
          : !existingNames.has(r.code)
            ? "Новая номенклатура"
            : newNames.length
              ? "Новое название у известного кода"
              : "Нет категории",
        suggested_designation: classifyNomenclature(r.names),
      });
    }
  }
  const saved = new Set<string>();
  for (const e of existing.values()) if (e.category) saved.add(e.category);
  saved.delete(REVIEW);
  const choices = [...new Set([...BASE_DESIGNATIONS, ...[...saved].sort(pyCompare)])];
  return { rows: sorted, review, choices };
}

// --- Продажи абонементов (collect_subscription_sales + build_summary) ---------------

type Sale = PaidRow & { city: string };

function collectSubscriptionSales(
  files: { paid: PaidRow[] }[],
  categories: Map<string, string>,
  cities: Map<string, string>,
) {
  const byKey = new Map<string, Sale>();
  let missingStudios = 0;
  let missingClients = 0;
  for (const f of files) {
    for (const s of f.paid) {
      const category = categories.get(s.code);
      if (category === undefined || category === "" || category === REVIEW) {
        throw new OnecError(
          `Номенклатура ${s.code} требует классификации. Добавьте её в справочник номенклатуры.`,
        );
      }
      if (category !== SUBSCRIPTION) continue;
      const city = cities.get(s.studio) ?? "";
      if (!city) missingStudios++;
      if (!s.client) missingClients++;
      const key = `${s.studio}\u0001${s.code}\u0001${s.client}\u0001${s.datetime}\u0001${s.cost}\u0001${s.payment}`;
      byKey.set(key, { ...s, city });
    }
  }
  return { sales: [...byKey.values()], missingStudios, missingClients };
}

// --- Воронка пробных (build_trial_funnel_summary) ----------------------------------

type Trial = {
  datetime: string;
  date: string;
  city: string;
  studio: string;
  direction: string;
  client: string;
  membership: string;
  statuses: Set<string>;
  arrived: boolean;
  status?: string;
  sale: Sale | null;
};

function isArrived(status: string) {
  const s = status.toLowerCase();
  return s.includes("прибыл") && !s.includes("не прибыл");
}

function collectTrials(
  files: VisitRow[][],
  cities: Map<string, string>,
  designations: Map<string, string>,
) {
  const issues = new Map<string, number>();
  const bump = (k: string) => issues.set(k, (issues.get(k) ?? 0) + 1);
  const byKey = new Map<string, Trial>();
  for (const rows of files) {
    // collect_trials_from_file
    const fileTrials = new Map<string, Trial>();
    for (const row of rows) {
      const membership = row.membership;
      const designation = designations.get(normalizeMembershipName(membership)) ?? "";
      if (designation !== TRIAL) {
        if (
          casefold(membership).includes("пробн") &&
          ["", REVIEW, UNDEFINED].includes(designation)
        ) {
          bump(`Пробная номенклатура не размечена в справочнике: ${membership}`);
        }
        continue;
      }
      const studio = normalizeStudio(row.studio);
      const status = normalizeText(row.status);
      const direction = normalizeText(row.direction);
      const client = normalizeText(row.client);
      const datetime = parseSaleDatetime(row.datetime);
      if (!client) {
        bump("У пробного нет кода клиента");
        continue;
      }
      if (!studio || !direction || datetime === null) {
        bump("У пробного не заполнены ключевые поля");
        continue;
      }
      const city = cities.get(studio) ?? "";
      if (!city) bump(`Студия пробного без города: ${studio}`);
      const key = `${client}\u0001${studio}\u0001${datetime}`;
      const record = fileTrials.get(key);
      if (!record) {
        fileTrials.set(key, {
          datetime,
          date: datetime.slice(0, 10),
          city,
          studio,
          direction,
          client,
          membership,
          statuses: new Set([status]),
          arrived: isArrived(status),
          sale: null,
        });
      } else {
        record.statuses.add(status);
        record.arrived = record.arrived || isArrived(status);
        if (record.direction !== direction) bump("Повтор пробного с разными направлениями");
      }
    }
    // collect_trials: слияние файлов
    for (const candidate of fileTrials.values()) {
      candidate.city = cities.get(candidate.studio) ?? "";
      const key = `${candidate.client}\u0001${candidate.studio}\u0001${candidate.datetime}`;
      const record = byKey.get(key);
      if (!record) byKey.set(key, candidate);
      else {
        for (const s of candidate.statuses) record.statuses.add(s);
        record.arrived = record.arrived || candidate.arrived;
        if (record.direction !== candidate.direction)
          bump("Повтор пробного с разными направлениями");
      }
    }
  }
  const trials = [...byKey.values()];
  for (const t of trials) {
    t.status = [...t.statuses].filter(Boolean).sort(pyCompare).join(" | ");
    if (!t.status) bump("У пробного не заполнен статус прибытия");
  }
  return { trials, issues };
}

function attributeSales(trials: Trial[], sales: Sale[]): string {
  const valid = sales
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => strip(s.client))
    .sort((a, b) => pyCompare(a.s.datetime, b.s.datetime) || a.i - b.i)
    .map(({ s }) => s);
  if (!valid.length)
    throw new OnecError("Не найдены оплаченные продажи абонементов с кодом клиента.");
  const maxSaleDate = valid[valid.length - 1].datetime.slice(0, 10);
  const byClient = new Map<string, Trial[]>();
  for (const t of trials) {
    t.sale = null;
    let list = byClient.get(t.client);
    if (!list) byClient.set(t.client, (list = []));
    list.push(t);
  }
  for (const list of byClient.values()) {
    const indexed = list.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => pyCompare(a.t.datetime, b.t.datetime) || a.i - b.i);
    list.splice(0, list.length, ...indexed.map((x) => x.t));
  }
  for (const sale of valid) {
    const saleDate = sale.datetime.slice(0, 10);
    let best: Trial | null = null;
    for (const t of byClient.get(sale.client) ?? []) {
      if (!t.arrived || t.sale !== null) continue;
      if (!(t.date <= saleDate && saleDate <= addDays(t.date, 13))) continue;
      // max(candidates, key=datetime): первый из максимальных
      if (best === null || t.datetime > best.datetime) best = t;
    }
    if (best) best.sale = sale;
  }
  return maxSaleDate;
}

// --- Запуск ----------------------------------------------------------------------------

export type OnecInputs = {
  files: OnecFileInput[];
  studios: StudioRefRow[];
  nomenclature: NomenclatureRow[];
  breakEven: BreakEvenRow[];
  sha256Hex: (s: string) => string;
  /**
   * Позиции окна новых номенклатур, на которые оператор только что ответил
   * («код\u0001название»). У них после окна обработка шла дальше в том же
   * запуске; у нас — новым запуском, и эти позиции второй раз не спрашиваются.
   * Нужно, потому что у кода с « | » в названии окно всплывает каждый раз.
   */
  answeredReview?: Set<string>;
};

export const reviewKey = (item: { code: string; name: string }) => `${item.code}\u0001${item.name}`;

export async function processOnec(input: OnecInputs, deps: OnecDeps): Promise<OnecResult> {
  const { inflate, writer, log } = deps;
  const byKind = (kind: OnecKind) => sortFiles(input.files.filter((f) => f.kind === kind));
  const stats: Record<string, number> = {};

  // 1. Продажи: номенклатура, оплаченные строки, нулевые.
  const salesFiles = byKind("sales");
  const sales: { name: string; paid: PaidRow[]; zero: ZeroRow[] }[] = [];
  const nomenclature = new Map<string, Set<string>>();
  const intern = makeIntern();
  for (const f of salesFiles) {
    log(`Читаю: ${ONEC_KIND_FOLDER.sales}/${f.name}`);
    const parsed = await parseSalesFile(await book(f, inflate), intern);
    for (const [code, names] of parsed.names) {
      let set = nomenclature.get(code);
      if (!set) nomenclature.set(code, (set = new Set()));
      for (const n of names) set.add(n);
    }
    sales.push({ name: f.name, paid: parsed.paid, zero: parsed.zero });
  }
  if (!nomenclature.size) throw new OnecError("В выгрузках продаж не найдена номенклатура.");

  // 2. Занятия с членством: названия с «пробн» и возможные пробные.
  const trialNames = new Set<string>();
  for (const r of input.nomenclature) {
    if (normalizeText(r.category) !== TRIAL) continue;
    for (const n of normalizeText(r.names).split(" | ")) {
      const k = normalizeMembershipName(n);
      if (k) trialNames.add(k);
    }
  }
  const visitFiles = byKind("visits");
  const marked = new Set<string>();
  const visits: VisitRow[][] = [];
  for (const f of visitFiles) {
    log(`Читаю: ${ONEC_KIND_FOLDER.visits}/${f.name}`);
    const parsed = await parseVisitsFile(await book(f, inflate), trialNames);
    for (const n of parsed.marked) marked.add(n);
    visits.push(parsed.candidates);
  }

  // 3. Справочник номенклатуры и проверка новых.
  log("Проверка новых номенклатур…");
  const rebuilt = rebuildNomenclature(input.nomenclature, nomenclature, marked, input.sha256Hex);
  const answered = input.answeredReview ?? new Set<string>();
  if (rebuilt.review.some((item) => !answered.has(reviewKey(item)))) {
    return {
      status: "review",
      nomenclature: rebuilt.rows,
      review: { items: rebuilt.review, choices: rebuilt.choices },
    };
  }
  const reference = rebuilt.rows;
  const categories = categoriesByCode(reference);
  const cities = studioCities(input.studios);
  const builder = new SnapshotBuilder(processStudioRef(input.studios), writer);

  // 4. Выручка (build_revenue_summary).
  const cashFiles = byKind("cash");
  if (!cashFiles.length) throw new OnecError(`Не найдены выгрузки «${ONEC_KIND_FOLDER.cash}».`);
  log("Пересчёт: выручка");
  const revenueRef = revenueStudioRef(input.studios);
  const unverified = new Set<string>();
  let revenueRows = 0;
  for (const f of cashFiles) {
    log(`Читаю: ${ONEC_KIND_FOLDER.cash}/${f.name}`);
    const b = await book(f, inflate);
    const first: Cell[][] = [];
    for await (const row of iterRows(b)) {
      first.push(row);
      if (first.length >= 5) break;
    }
    const layout = detectLayout(first);
    let currentDate: string | null = null;
    for await (const row of iterRows(b)) {
      const studio = row[layout.studio] ?? null;
      const article = layout.article === null ? NO_DETAIL_ARTICLE : (row[layout.article] ?? null);
      const periodDay = row[layout.date] ?? null;
      const income = row[layout.income] ?? null;
      const expense = row[layout.expense] ?? null;
      const parsed = parseRuDate(periodDay);
      if (parsed) {
        currentDate = parsed;
        continue;
      }
      if (studio === "Итого") continue;
      if (!truthy(studio) || !truthy(article) || !currentDate) continue;
      const isNum = (v: Cell) => typeof v === "number" || typeof v === "boolean";
      if (!isNum(income) && !isNum(expense)) continue;
      const inc = numberOrZero(income);
      const exp = numberOrZero(expense);
      // Статус студии в снимке — из справочника (process.build), пометка
      // «(удален)» в имени влияет только на сверку статусов ниже.
      const { name } = normalizeStudioName(studio);
      const refRow = revenueRef.get(name);
      const refStatus = refRow?.status ?? "";
      if (!(refStatus === OPEN || refStatus === CLOSED)) unverified.add(name);
      await builder.add(
        "revenue",
        currentDate,
        refRow?.city ?? "",
        name,
        strip(pyStr(article)),
        "",
        [inc, exp, inc - exp],
      );
      revenueRows++;
    }
  }
  if (unverified.size) {
    const sample = [...unverified].sort(pyCompare).slice(0, 10).join("; ");
    throw new OnecError(
      `Проверка статусов студий не пройдена: этих студий нет в справочнике студий или у них не указан статус: ${sample}`,
    );
  }
  stats.revenueRows = revenueRows;
  await builder.flush();

  // 5. Продажи абонементов.
  if (!salesFiles.length) throw new OnecError("Не найдены выгрузки продаж.");
  log("Пересчёт: продажи абонементов");
  const all = collectSubscriptionSales(sales, categories, cities);
  {
    const first = new Map<string, string>();
    for (const s of all.sales) {
      if (!s.client) continue;
      const prev = first.get(s.client);
      if (prev === undefined || s.datetime < prev) first.set(s.client, s.datetime);
    }
    const summary = new Map<string, { s: Sale; v: number[] }>();
    for (const s of all.sales) {
      const key = `${s.datetime.slice(0, 10)}\u0001${s.city}\u0001${s.studio}\u0001${s.code}\u0001${s.name}`;
      let e = summary.get(key);
      if (!e) summary.set(key, (e = { s, v: [0, 0, 0, 0, 0, 0] }));
      e.v[0] += 1;
      e.v[5] += s.cost;
      if (s.client && s.datetime === first.get(s.client)) {
        e.v[1] += 1;
        e.v[3] += s.payment;
      } else if (s.client) {
        e.v[2] += 1;
        e.v[4] += s.payment;
      }
    }
    for (const { s, v } of summary.values()) {
      await builder.add("sales", s.datetime, s.city, s.studio, s.name, s.code, v);
    }
    stats.subscriptionSales = all.sales.length;
  }
  await builder.flush();

  // 6. Занятия (build_activities_summary).
  const classFiles = byKind("classes");
  if (!classFiles.length) throw new OnecError("Не найдены выгрузки занятий.");
  log("Пересчёт: занятия");
  let classSource = 0;
  let classValid = 0;
  for (const f of classFiles) {
    log(`Читаю: ${ONEC_KIND_FOLDER.classes}/${f.name}`);
    for await (const row of iterRows(await book(f, inflate), { minRow: 3, maxCol: 6 })) {
      if (!row.some((v) => v !== null && strip(pyStr(v)) !== "")) continue;
      classSource++;
      const studio = normalizeStudio(row[0]);
      const direction = strip(orEmpty(row[1]));
      const date = parseActivityDate(row[2]);
      const scheduled = asPositiveNumber(row[3]);
      const attended = asPositiveNumber(row[4]);
      const held = asPositiveNumber(row[5]);
      if (!studio || !direction || date === null) continue;
      if (held === null || scheduled === null || attended === null) continue;
      classValid++;
      await builder.add("activities", date, cities.get(studio) ?? "", studio, direction, "", [
        held,
        scheduled,
        attended,
      ]);
    }
  }
  stats.classSourceRows = classSource;
  stats.classValidRows = classValid;
  await builder.flush();

  // 7. Воронка пробных и виды пробных.
  if (!visitFiles.length) {
    throw new OnecError("Не найдены выгрузки занятий с членством и клиентом.");
  }
  log("Пересчёт: воронка пробных");
  const designations = membershipDesignations(reference);
  const { trials, issues: trialIssues } = collectTrials(visits, cities, designations);
  const missing = [...trialIssues.keys()]
    .filter((k) => k.startsWith("Пробная номенклатура не размечена в справочнике: "))
    .map((k) => k.slice("Пробная номенклатура не размечена в справочнике: ".length))
    .sort(pyCompare);
  if (missing.length) {
    let preview = missing.slice(0, 20).join("; ");
    if (missing.length > 20) preview += `; и ещё ${missing.length - 20}`;
    throw new OnecError(
      `Пересчёт воронки остановлен: следующие пробные номенклатуры не размечены в справочнике как «${TRIAL}»: ${preview}.`,
    );
  }
  const years = new Set(trials.map((t) => t.date.slice(0, 4)));
  const relevant = sales.filter((f) => [...years].some((y) => fileSortKey(f.name).includes(y)));
  if (!relevant.length) {
    throw new OnecError(
      `Не найдены выгрузки продаж за годы пробных: ${[...years].sort(pyCompare).join(", ")}.`,
    );
  }
  const funnelSales = collectSubscriptionSales(relevant, categories, cities);
  const maxSaleDate = attributeSales(trials, funnelSales.sales);
  {
    const summary = new Map<string, { t: Trial; v: number[] }>();
    for (const t of trials) {
      const sale = t.sale;
      const windowClosed = addDays(t.date, 13) <= maxSaleDate;
      const purchaseDay = !!sale && sale.datetime.slice(0, 10) === t.date;
      const purchaseWindow = !!sale;
      const purchaseLater = !!sale && sale.datetime.slice(0, 10) > t.date;
      const key = `${t.date}\u0001${t.city}\u0001${t.studio}\u0001${t.direction}`;
      let e = summary.get(key);
      if (!e) summary.set(key, (e = { t, v: [0, 0, 0, 0, 0, 0, 0, 0] }));
      e.v[0] += 1;
      if (t.arrived) {
        e.v[1] += 1;
        e.v[2] += 1;
        e.v[3] += purchaseDay ? 1 : 0;
        e.v[4] += 1;
        e.v[5] += purchaseWindow ? 1 : 0;
        e.v[6] += purchaseLater ? 1 : 0;
        e.v[7] += windowClosed ? 0 : 1;
      }
      await builder.add("trial_products", t.date, t.city, t.studio, t.membership, "", [
        1,
        t.arrived ? 1 : 0,
        purchaseDay ? 1 : 0,
        purchaseWindow ? 1 : 0,
      ]);
    }
    for (const { t, v } of summary.values()) {
      await builder.add("funnel", t.date, t.city, t.studio, t.direction, "", v);
    }
    stats.trials = trials.length;
    stats.maxSaleDate = Number(maxSaleDate.replace(/-/g, ""));
  }
  await builder.flush();

  // 8. Нулевая номенклатура.
  log("Нулевые продажи");
  const processRef = processStudioRef(input.studios);
  const zeroControls = { blankCostRows: 0, explicitZeroRows: 0, excludedTrialRows: 0 };
  const issues: Record<string, number> = {};
  for (const f of sales) {
    for (const z of f.zero) {
      if (z.blank) zeroControls.blankCostRows++;
      else zeroControls.explicitZeroRows++;
      if (categories.get(z.code) === TRIAL) {
        zeroControls.excludedTrialRows++;
        continue;
      }
      if (z.day === null || !z.studio || !z.product) {
        issues.zero_invalid_rows = (issues.zero_invalid_rows ?? 0) + 1;
        continue;
      }
      await builder.add(
        "zero",
        z.day,
        processRef.get(z.studio)?.city ?? "",
        z.studio,
        z.product,
        z.code,
        [1],
      );
    }
  }
  await builder.flush();

  return {
    status: "done",
    nomenclature: reference,
    sourceRows: builder.sourceRows,
    issues,
    breakEven: breakEvenByCity(input.breakEven),
    zeroControls,
    stats,
  };
}

function truthy(v: Cell): boolean {
  return !(v === null || v === "" || v === 0 || v === false);
}

function numberOrZero(v: Cell): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

type Layout = {
  studio: number;
  article: number | null;
  date: number;
  income: number;
  expense: number;
};

/** detect_layout (выручка): три раскладки отчёта «НДЯ выгрузка». */
function detectLayout(first: Cell[][]): Layout {
  for (const row of first) {
    const values = row.map((v) => (v === null ? "" : strip(pyStr(v))));
    if (
      values.length >= 6 &&
      values[0] === "Структурная единица" &&
      values[1] === "Период день" &&
      values[2] === "Сумма"
    ) {
      return { studio: 0, article: null, date: 1, income: 3, expense: 4 };
    }
    if (
      values.length >= 8 &&
      values[0] === "Структурная единица" &&
      values[1] === "Тип денежных средств" &&
      values[2] === "Статья" &&
      values[3] === "Период день" &&
      values[4] === "Сумма"
    ) {
      return { studio: 0, article: 2, date: 3, income: 5, expense: 6 };
    }
    if (values.length >= 14 && values[0] === "Структурная единица") {
      return { studio: 0, article: 3, date: 9, income: 11, expense: 12 };
    }
  }
  throw new OnecError("Неизвестная раскладка отчёта 1С: не найдены ожидаемые заголовки.");
}
