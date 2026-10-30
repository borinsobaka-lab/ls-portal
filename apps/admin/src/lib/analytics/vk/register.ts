/**
 * VK Ads — «Реестр таргета» (их app.py: `target_register_page`,
 * `remaining_vk_plan_metrics`, `plan_metrics_for_period`): план периода по
 * остатку месячного плана, статусы и ячейки строк, плашки сети, группы по
 * таргетологам. Данные — RPC an_vk_register (строки по городам, планы, факт
 * месяца до начала периода, дни без бюджета). Дроби плана — точные (их
 * Fraction), деньги плашек — их Decimal с ROUND_HALF_UP.
 */
import { pyFloatStr } from "../reviews/parse";
import { pyFixed } from "../reviews/view";
import { VK_VAT, vkNumber } from "./view";

// --- Точные дроби (их fractions.Fraction) ------------------------------------------

export class Frac {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error("ZeroDivisionError");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = g > 1n ? n / g : n;
    this.d = g > 1n ? d / g : d;
  }
  static of(x: number | bigint): Frac {
    return new Frac(BigInt(x));
  }
  add(o: Frac): Frac {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac): Frac {
    return new Frac(this.n * o.n, this.d * o.d);
  }
  div(o: Frac): Frac {
    return new Frac(this.n * o.d, this.d * o.n);
  }
  lt(o: Frac): boolean {
    return this.n * o.d < o.n * this.d;
  }
  /** math.ceil. */
  ceil(): number {
    const q = this.n / this.d;
    const r = this.n % this.d;
    return Number(r > 0n ? q + 1n : q);
  }
  /** float(Fraction): n / d с верным округлением (числа здесь — до 2^53). */
  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

// --- Даты (ГГГГ-ММ-ДД, календарные дни) ---------------------------------------------

const DAY = 86_400_000;
const dayNum = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
const fromNum = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const monthLastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Их month_starts_between: первые числа месяцев периода, ГГГГ-ММ. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let y = +start.slice(0, 4);
  let m = +start.slice(5, 7);
  const endKey = end.slice(0, 7);
  for (;;) {
    const key = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    if (key > endKey) break;
    out.push(key);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// --- Данные RPC -------------------------------------------------------------------

export type RegisterRow = {
  brand: string;
  city: string;
  platform_spent: number;
  lead_form_spent: number;
  campaign_rows: number;
  accounts_count: number;
  community_leads: number;
  community_applications: number;
  lead_form_applications: number;
  targetologist_name: string | null;
  zero_days: string[];
  assumed_days: string[];
  /** Лиды VK (сообщения и ЛФ НК) из amoCRM за период и сколько квалифицированы. */
  qual_leads?: number;
  qual_qualified?: number;
};
export type RegisterPlan = {
  month: string;
  brand: string;
  city: string;
  applications_plan: number;
  target_cpl: number;
};
export type RegisterFact = { month: string; brand: string; city: string; applications: number };
export type RegisterPayload = {
  from: string;
  to: string;
  today: string;
  admin: boolean;
  targetologist: string;
  brand: string;
  people: string[];
  rows: RegisterRow[];
  plans: RegisterPlan[];
  facts: RegisterFact[];
};

const keyOf = (brand: string, city: string) => `${brand}\u0000${city}`;

export type PeriodPlan = {
  /** План заявок периода (дробь) — показывают округлённым вверх. */
  applications: Frac;
  budget: number;
  /** Целевой CPL — из пропорции месячных планов (их plan_metrics_for_period). */
  targetCpl: number;
  /** Дневная норма месяца по остатку — для плана «с учётом простоя». */
  dayRates: Map<string, Frac>;
};

/**
 * Их remaining_vk_plan_metrics: остаток месячного плана после заявок,
 * полученных до начала периода (будущий период — по сегодня), делится на
 * оставшиеся дни месяца; целевой CPL от выполнения не зависит.
 */
export function remainingPlan(
  start: string,
  end: string,
  plans: RegisterPlan[],
  facts: RegisterFact[],
  today: string,
): Map<string, PeriodPlan> {
  const s = dayNum(start);
  const e = dayNum(end);
  const t = dayNum(today);
  // plan_metrics_for_period: пропорция дней — для целевого CPL.
  const first = new Map<string, { apps: number; budget: number }>();
  for (const p of plans) {
    const y = +p.month.slice(0, 4);
    const m = +p.month.slice(5, 7);
    const ms = Date.UTC(y, m - 1, 1) / DAY;
    const last = monthLastDay(y, m);
    const me = ms + last - 1;
    const os = Math.max(s, ms);
    const oe = Math.min(e, me);
    if (os > oe) continue;
    const k = keyOf(p.brand, p.city);
    const entry = first.get(k) ?? { apps: 0, budget: 0 };
    const applications = (p.applications_plan * (oe - os + 1)) / last;
    entry.apps += applications;
    entry.budget += applications * p.target_cpl;
    first.set(k, entry);
  }
  const actual = new Map(
    facts.map((f) => [`${f.month}\u0000${keyOf(f.brand, f.city)}`, f.applications]),
  );
  const out = new Map<string, PeriodPlan>();
  for (const [k, v] of first) {
    out.set(k, {
      applications: Frac.of(0),
      budget: 0,
      targetCpl: v.apps ? v.budget / v.apps : 0,
      dayRates: new Map(),
    });
  }
  for (const p of plans) {
    const y = +p.month.slice(0, 4);
    const m = +p.month.slice(5, 7);
    const ms = Date.UTC(y, m - 1, 1) / DAY;
    const last = monthLastDay(y, m);
    const me = ms + last - 1;
    const ps = Math.max(s, ms);
    const pe = Math.min(e, me);
    if (ps > pe) continue;
    const cutoff = Math.min(ps - 1, t);
    const completed = Math.max(0, Math.min(cutoff, me) - ms + 1);
    const k = keyOf(p.brand, p.city);
    const received = cutoff >= ms ? (actual.get(`${p.month}\u0000${k}`) ?? 0) : 0;
    let remaining = Frac.of(p.applications_plan).sub(Frac.of(received));
    if (remaining.lt(Frac.of(0))) remaining = Frac.of(0);
    const rate = remaining.div(Frac.of(last - completed));
    const applications = rate.mul(Frac.of(pe - ps + 1));
    const entry = out.get(k)!;
    entry.applications = entry.applications.add(applications);
    entry.budget += applications.toNumber() * p.target_cpl;
    entry.dayRates.set(p.month, rate);
  }
  return out;
}

/** План «с учётом простоя»: дневная норма × дни периода без дней простоя. */
export function adjustedPlan(
  start: string,
  end: string,
  plans: RegisterPlan[],
  brand: string,
  city: string,
  plan: PeriodPlan,
  zeroDays: string[],
): number {
  const s = dayNum(start);
  const e = dayNum(end);
  const zero = new Set(zeroDays.map(dayNum));
  let total = Frac.of(0);
  for (const p of plans) {
    if (p.brand !== brand || p.city !== city) continue;
    const y = +p.month.slice(0, 4);
    const m = +p.month.slice(5, 7);
    const ms = Date.UTC(y, m - 1, 1) / DAY;
    const me = ms + monthLastDay(y, m) - 1;
    const ps = Math.max(s, ms);
    const pe = Math.min(e, me);
    if (ps > pe) continue;
    let lost = 0;
    for (const z of zero) if (z >= ps && z <= pe) lost++;
    total = total.add(plan.dayRates.get(p.month)!.mul(Frac.of(pe - ps + 1 - lost)));
  }
  return total.ceil();
}

// --- Форматы ----------------------------------------------------------------------

/** Их whole_money: f"{v:,.0f} ₽". */
export const wholeMoney = (v: number) => `${vkNumber(v, 0)} ₽`;

/** Decimal(str(x)): мантисса и порядок точного десятичного представления. */
function decimalOf(x: number): { m: bigint; e: number } {
  const s = pyFloatStr(x);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
  if (!match) throw new Error(`Не число: ${s}`);
  const frac = match[3] ?? "";
  const m = BigInt(`${match[1]}${match[2]}${frac}`);
  return { m, e: Number(match[4] ?? 0) - frac.length };
}

const pow10 = (k: number) => 10n ** BigInt(k);

/** Округление m × 10^e до целого, ровно посередине — от нуля (ROUND_HALF_UP). */
function halfUpInt(m: bigint, e: number): bigint {
  if (e >= 0) return m * pow10(e);
  const neg = m < 0n;
  const a = neg ? -m : m;
  const div = pow10(-e);
  let q = a / div;
  if ((a % div) * 2n >= div) q += 1n;
  return neg ? -q : q;
}

/** Их summary_money: Decimal(str(v)).quantize(1, ROUND_HALF_UP), f"{…:,.0f} ₽". */
export function summaryMoney(v: number): string {
  const { m, e } = decimalOf(v);
  return `${groupInt(halfUpInt(m, e))} ₽`;
}

/**
 * Их цена заявки плашки: Decimal(str(spent)) / Decimal(n) (точность 28 знаков,
 * к чётному), затем quantize(1, ROUND_HALF_UP).
 */
export function summaryPrice(spent: number, n: number): string {
  const { m, e } = decimalOf(spent);
  if (m === 0n) return `${groupInt(0n)} ₽`;
  const neg = m < 0n !== n < 0;
  const num = (m < 0n ? -m : m) * (e > 0 ? pow10(e) : 1n);
  const den = BigInt(Math.abs(n)) * (e < 0 ? pow10(-e) : 1n);
  // 28 значащих цифр: q = round(num/den × 10^k), где q — 28 цифр.
  let k = 0;
  const intDigits = (num / den).toString().length;
  if (num / den === 0n) {
    // < 1: сдвигаем, пока целая часть не станет значащей.
    let t = num;
    while (t / den === 0n) {
      t *= 10n;
      k++;
    }
    k += 27;
  } else {
    k = 28 - intDigits;
  }
  const scaledNum = k >= 0 ? num * pow10(k) : num;
  const scaledDen = k >= 0 ? den : den * pow10(-k);
  let q = scaledNum / scaledDen;
  const r = scaledNum % scaledDen;
  const twice = r * 2n;
  if (twice > scaledDen || (twice === scaledDen && q % 2n === 1n)) q += 1n;
  const value = halfUpInt(neg ? -q : q, -k);
  return `${groupInt(value)} ₽`;
}

function groupInt(v: bigint): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return neg ? `-${s}` : s;
}

/** Их casefold для сортировки. */
const fold = (s: string) => s.toLowerCase().replace(/ß/g, "ss");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const UNASSIGNED = "Не назначен";

// --- Строки реестра ----------------------------------------------------------------

export type RegisterCity = {
  key: string;
  brand: string;
  city: string;
  cityLabel: string;
  accounts: number;
  targetologist: string;
  hasPlan: boolean;
  /** «План VK / с учётом простоя». */
  ordinary: string;
  adjusted: string;
  /** Факт / план и полоса выполнения. */
  applications: number;
  progress: number;
  percentage: string;
  /** «CPL цель / факт». */
  targetCpl: string;
  actualCpl: string;
  cplTone: "good" | "high" | "";
  total: string;
  status: { label: string; tone: "neutral" | "warning" | "good" };
  volume: { label: string; tone: "good" | "warning" } | null;
  planBudget: string;
  zeroDays: number;
  assumedDays: number;
  qualification: string;
  qualificationTitle: string;
  leadForms: { spent: string; applications: number; price: string };
  messages: {
    spent: string;
    leads: number;
    applications: number;
    conversion: string;
    price: string;
  };
};

export type RegisterSummary = {
  kind: "forms" | "messages" | "total";
  title: string;
  subtitle: string;
  applications: number;
  price: string;
  spent: string;
};

export type RegisterView = {
  groups: { name: string; cities: RegisterCity[]; unassigned: boolean }[];
  summary: RegisterSummary[];
  scope: string;
  period: string;
};

const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Их target_register_page целиком: строки, группы, плашки. */
export function registerView(p: RegisterPayload): RegisterView {
  const plans = remainingPlan(p.from, p.to, p.plans, p.facts, p.today);
  const rows = [...p.rows].sort(
    (a, b) =>
      cmp(fold(a.targetologist_name || UNASSIGNED), fold(b.targetologist_name || UNASSIGNED)) ||
      cmp(fold(a.brand || ""), fold(b.brand || "")) ||
      cmp(fold(a.city || ""), fold(b.city || "")),
  );
  let totalSpent = 0;
  let totalLf = 0;
  let ssApps = 0;
  let lfApps = 0;
  for (const r of rows) {
    totalSpent += r.platform_spent || 0;
    totalLf += r.lead_form_spent || 0;
    ssApps += r.community_applications || 0;
    lfApps += r.lead_form_applications || 0;
  }
  totalSpent *= VK_VAT;
  totalLf *= VK_VAT;
  const totalMessages = totalSpent - totalLf;
  const totalApps = ssApps + lfApps;

  const groups = new Map<string, RegisterCity[]>();
  for (const r of rows) {
    const total = (r.platform_spent || 0) * VK_VAT;
    const lf = (r.lead_form_spent || 0) * VK_VAT;
    const messages = Math.max(0, total - lf);
    const leads = r.community_leads || 0;
    const ssA = r.community_applications || 0;
    const lfA = r.lead_form_applications || 0;
    const applications = ssA + lfA;
    const plan = plans.get(keyOf(r.brand, r.city));
    const planApps = plan ? plan.applications.ceil() : 0;
    const planCpl = plan ? plan.targetCpl : 0;
    const over = applications >= planApps;
    const zero = new Set(r.zero_days).size;
    const progress = plan && planApps ? (applications / planApps) * 100 : 0;
    const actualCpl = applications ? wholeMoney(total / applications) : "—";
    let status: RegisterCity["status"];
    if (!plan) status = { label: "Нет плана", tone: "neutral" };
    else if (applications && total / applications > planCpl)
      status = { label: "Выше цели", tone: "warning" };
    else if (applications < planApps) {
      status = { label: `Нужно ещё ${planApps - applications}`, tone: "warning" };
    } else status = { label: "В норме", tone: "good" };
    const name = r.targetologist_name || UNASSIGNED;
    const list = groups.get(name) ?? [];
    list.push({
      key: keyOf(r.brand, r.city),
      brand: r.brand,
      city: r.city,
      cityLabel: r.city || "Город не назначен",
      accounts: r.accounts_count,
      targetologist: name,
      hasPlan: !!plan,
      ordinary: plan ? String(planApps) : "—",
      adjusted: plan
        ? String(adjustedPlan(p.from, p.to, p.plans, r.brand, r.city, plan, r.zero_days))
        : "—",
      applications,
      progress,
      percentage: plan && planApps ? `${pyFixed(progress, 0)}%` : "—",
      targetCpl: plan ? wholeMoney(planCpl) : "—",
      actualCpl,
      cplTone: plan && applications ? (total / applications <= planCpl ? "good" : "high") : "",
      total: wholeMoney(total),
      status,
      volume: plan
        ? over
          ? { label: `+${applications - planApps} сверх`, tone: "good" }
          : { label: `Нужно ${planApps - applications}`, tone: "warning" }
        : null,
      planBudget: plan ? wholeMoney(planApps * planCpl) : "—",
      zeroDays: zero,
      assumedDays: r.assumed_days.length,
      // Их f"{q / l:.0%}" и подсказка с числами.
      qualification: r.qual_leads
        ? `${pyFixed(((r.qual_qualified ?? 0) / r.qual_leads) * 100, 0)}%`
        : "—",
      qualificationTitle:
        `Квалифицированные / все лиды VK в AmoCRM: ${r.qual_qualified ?? 0} / ${r.qual_leads ?? 0}. ` +
        "По дате создания сделки за выбранный период.",
      leadForms: {
        spent: wholeMoney(lf),
        applications: lfA,
        price: lfA ? wholeMoney(lf / lfA) : "—",
      },
      messages: {
        spent: wholeMoney(messages),
        leads,
        applications: ssA,
        conversion: leads ? `${pyFixed((ssA / leads) * 100, 1)}%` : "—",
        price: ssA ? wholeMoney(messages / ssA) : "—",
      },
    });
    groups.set(name, list);
  }
  const unassigned = groups.get(UNASSIGNED);
  groups.delete(UNASSIGNED);
  const out: RegisterView["groups"] = [...groups].map(([name, cities]) => ({
    name,
    cities,
    unassigned: false,
  }));
  if (unassigned?.length) out.push({ name: UNASSIGNED, cities: unassigned, unassigned: true });

  const price = (spent: number, n: number) => (n ? summaryPrice(spent, n) : "—");
  return {
    groups: out,
    summary: [
      {
        kind: "forms",
        title: "Лид-формы",
        subtitle: "",
        applications: lfApps,
        price: price(totalLf, lfApps),
        spent: summaryMoney(totalLf),
      },
      {
        kind: "messages",
        title: "Сообщения сообщества",
        subtitle: "",
        applications: ssApps,
        price: price(totalMessages, ssApps),
        spent: summaryMoney(totalMessages),
      },
      {
        kind: "total",
        title: "Итого",
        subtitle: "Общие показатели",
        applications: totalApps,
        price: price(totalSpent, totalApps),
        spent: summaryMoney(totalSpent),
      },
    ],
    scope: p.targetologist ? `Показатели: ${p.targetologist}` : "Показатели всех таргетологов",
    period: `${ru(p.from)} — ${ru(p.to)}`,
  };
}

/** Период по умолчанию (их GET): с 1-го числа по вчера МСК; наоборот — меняются. */
export function registerPeriod(from: string | undefined, to: string | undefined, today: string) {
  const valid = (v: string | undefined) =>
    !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromNum(dayNum(v)) === v;
  let start = valid(from) ? from! : `${today.slice(0, 8)}01`;
  let end = valid(to) ? to! : fromNum(dayNum(today) - 1);
  if (end < start) [start, end] = [end, start];
  return { from: start, to: end };
}
