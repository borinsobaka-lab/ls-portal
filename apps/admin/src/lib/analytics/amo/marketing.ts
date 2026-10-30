/**
 * «Маркетинг Lady Stretch / Lady Jump» — их marketing_report_page (app.py):
 * подписи, бюджеты каналов, конверсии, итоги города и плитки. Строки и
 * бюджеты отдаёт RPC an_amo_marketing (их report_filters, marketing_report,
 * marketing_snapshot, qualification_rule_labels —
 * db/migrations/2026-10-30_zzzzzzzzzz_analytics_marketing.sql); здесь — то,
 * что у них считала страница, с их округлением.
 */
import type { AnNeed } from "../access";
import { pyRound } from "../onec-reports/payload";
import { casefold, strip } from "../onec/rules";
import { wholeMoney } from "../vk/register";

export const MKT_BRANDS = [
  { slug: "lady-stretch", brand: "Lady Stretch", need: "mkt.ls" },
  { slug: "lady-jump", brand: "Lady Jump", need: "mkt.lj" },
] as const satisfies readonly { slug: string; brand: string; need: AnNeed }[];
export type MktBrand = (typeof MKT_BRANDS)[number]["brand"];

export type MktResult = "first" | "today";

/** Адрес отчёта: месяц, город, партнёр, режим результата (их параметры формы). */
export type MktSearch = {
  month?: string;
  city?: string;
  partner?: string;
  result?: MktResult;
};

export function validateMktSearch(s: Record<string, unknown>): MktSearch {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    month: typeof s.month === "string" && /^\d{4}-\d{2}$/.test(s.month) ? s.month : undefined,
    city: str(s.city),
    partner: str(s.partner),
    result: s.result === "first" ? "first" : undefined,
  };
}

/** Строка отчёта — их marketing_report / строка среза. */
export type MktRow = {
  city: string;
  partner_name: string;
  source: string;
  leads: number;
  qualified: number;
  booked: number;
  attended: number;
  paid: number;
};

export type MktBudget = { lead_forms?: number; community_messages?: number };

export type MktPayload = {
  brand: MktBrand;
  months: string[];
  cities: string[];
  partners: string[];
  month: string;
  city: string;
  partner: string;
  result: MktResult;
  is_partner: boolean;
  limited: boolean;
  snapshot: boolean;
  rows: MktRow[];
  budgets: Record<string, MktBudget>;
  qualification: Record<string, string[]>;
};

export const MKT_UNMATCHED = "Город не сопоставлен";

/** Их тексты страницы. */
export const MKT_TEXT = {
  lead: "Все показатели формируются по данным вашей amoCRM и обновляются автоматически каждые 15 минут.",
  limited: "Показаны только города, назначенные вашей учётной записи.",
  allCities: "Все города",
  allPartners: "Все партнёры",
  empty: "Нет данных для выбранного результата.",
  noteFirst:
    "Срез на 00:00 МСК 1-го числа следующего месяца: последние известные факты до этой даты.",
  noteFirstMissing:
    "Срез на 1-е число недоступен: месяц ещё не завершён или история фиксации началась позже этой даты.",
  noteToday:
    "Результат на сегодня: лиды выбранного месяца с учётом последующих записей, приходов и покупок.",
};

export const MKT_RESULTS: { value: MktResult; label: string }[] = [
  { value: "first", label: "Результат на 1-е число" },
  { value: "today", label: "Результат на сегодня" },
];

/** Их mode_note. */
export function mktModeNote(result: MktResult, snapshot: boolean): string {
  if (result === "first") return snapshot ? MKT_TEXT.noteFirst : MKT_TEXT.noteFirstMissing;
  return MKT_TEXT.noteToday;
}

/** Их подсказка «?» у города: основания, при которых лид неквалифицирован. */
export function mktQualificationText(labels: string[] | undefined): string {
  const text = labels && labels.length ? labels.join(", ") : "не выбраны";
  return `В этом городе неквалифицированным лидом считаются закрытые сделки с основанием для закрытия: ${text}.`;
}

/** Их money: «—» без бюджета, иначе f"{v:,.0f} ₽". */
export const mktMoney = (v: number | null) => (v === null ? "—" : wholeMoney(v));

/** Их rate: «—» при нулевой базе, иначе f"{value / base:.0%}". */
export function mktRate(value: number, base: number): string {
  if (!base) return "—";
  // Формат «%» Python умножает на 100 во float, затем — как «.0f».
  return `${pyRound((value / base) * 100, 0).toFixed(0)}%`;
}

const MESSAGES = new Set(["вконтакте сообщения", "сообщения сообщества"]);

/** Их source_budget: бюджет канала — сообщения сообщества или лид-формы VK города; прочие — без бюджета. */
export function mktSourceBudget(row: MktRow, budgets: Record<string, MktBudget>): number | null {
  const key = casefold(strip(row.source));
  const budget = budgets[row.city] ?? {};
  if (MESSAGES.has(key)) return budget.community_messages ?? 0;
  if (key === "вконтакте лф нк") return budget.lead_forms ?? 0;
  return null;
}

/** Ячейки строки канала или итога города — их 14 колонок. */
export type MktCells = {
  source: string;
  budget: string;
  leads: number;
  cpl: string;
  qualified: number;
  leadToQualified: string;
  booked: number;
  qualifiedToBooked: string;
  attended: number;
  bookedToAttended: string;
  paid: number;
  attendedToPaid: string;
  qualifiedToPaid: string;
  costPerSale: string;
};

export type MktGroup = {
  key: string;
  city: string;
  partner: string;
  channels: number;
  qualification: string;
  rows: MktCells[];
  total: MktCells;
};

export type MktKpi = { label: string; value: number; note?: string };

type Counts = Pick<MktRow, "leads" | "qualified" | "booked" | "attended" | "paid">;
const KEYS = ["leads", "qualified", "booked", "attended", "paid"] as const;

const sum = (rows: Counts[]): Counts => {
  const t = { leads: 0, qualified: 0, booked: 0, attended: 0, paid: 0 };
  for (const r of rows) for (const k of KEYS) t[k] += Number(r[k] ?? 0);
  return t;
};

function cells(source: string, c: Counts, budget: number | null): MktCells {
  return {
    source,
    budget: mktMoney(budget),
    leads: c.leads,
    cpl: budget !== null && c.leads ? mktMoney(budget / c.leads) : "—",
    qualified: c.qualified,
    leadToQualified: mktRate(c.qualified, c.leads),
    booked: c.booked,
    qualifiedToBooked: mktRate(c.booked, c.qualified),
    attended: c.attended,
    bookedToAttended: mktRate(c.attended, c.booked),
    paid: c.paid,
    attendedToPaid: mktRate(c.paid, c.attended),
    qualifiedToPaid: mktRate(c.paid, c.qualified),
    costPerSale: budget !== null && c.paid ? mktMoney(budget / c.paid) : "—",
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Их блоки «город × партнёр»: порядок — «Город не сопоставлен» последним,
 * затем город и партнёр без регистра; строки — как отдала база; «Итого по
 * городу» — сумма строк, бюджет — только если у города есть канал с бюджетом.
 */
export function mktGroups(p: Pick<MktPayload, "rows" | "budgets" | "qualification">): MktGroup[] {
  const groups = new Map<string, { city: string; partner: string; rows: MktRow[] }>();
  for (const r of p.rows) {
    const key = JSON.stringify([r.city, r.partner_name]);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { city: r.city, partner: r.partner_name, rows: [] }));
    g.rows.push(r);
  }
  const ordered = [...groups.entries()].sort(
    ([, a], [, b]) =>
      Number(a.city === MKT_UNMATCHED) - Number(b.city === MKT_UNMATCHED) ||
      cmp(casefold(a.city), casefold(b.city)) ||
      cmp(casefold(a.partner), casefold(b.partner)),
  );
  return ordered.map(([key, g]) => {
    let cityBudget = 0;
    let hasBudget = false;
    const rows = g.rows.map((r) => {
      const budget = mktSourceBudget(r, p.budgets);
      if (budget !== null) {
        cityBudget += budget;
        hasBudget = true;
      }
      return cells(r.source, sum([r]), budget);
    });
    return {
      key,
      city: g.city,
      partner: g.partner,
      channels: g.rows.length,
      qualification: mktQualificationText(p.qualification[g.city]),
      rows,
      total: cells("Итого по городу", sum(g.rows), hasBudget ? cityBudget : null),
    };
  });
}

/** Их пять плиток: итоги без «Город не сопоставлен». */
export function mktKpis(rows: MktRow[]): MktKpi[] {
  const t = sum(rows.filter((r) => r.city !== MKT_UNMATCHED));
  return [
    { label: "Всего лидов", value: t.leads },
    {
      label: "Квалифицированные",
      value: t.qualified,
      note: `${mktRate(t.qualified, t.leads)} от всех лидов`,
    },
    {
      label: "Записались на пробное",
      value: t.booked,
      note: `${mktRate(t.booked, t.qualified)} от квалифицированных`,
    },
    {
      label: "Пришли на пробное",
      value: t.attended,
      note: `${mktRate(t.attended, t.booked)} доходимость`,
    },
    {
      label: "Купили",
      value: t.paid,
      note: `${mktRate(t.paid, t.qualified)} от квалифицированных`,
    },
  ];
}
