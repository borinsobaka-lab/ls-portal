/**
 * Плитки и блоки подразделов дашборда: подписи, подсказки «?» и вид
 * значения. Отдельно от страниц (routes/_authenticated/dashboard/*): те же
 * подписи рисуют скелетоны (components/page-skeletons.tsx), а им нельзя
 * импортировать файлы страниц. Графики к плиткам страницы добавляют сами.
 */

import { RENEWAL_GRACE_DAYS } from "@/lib/dashboard-analytics";
import type { ClassesKey } from "@/lib/dashboard-classes";
import { formatMoney, formatNumber } from "@/lib/format";

/**
 * Вид значения: percent — доля в процентах (сравнение — в процентных
 * пунктах), score — индекс без единиц (NPS; сравнение — в пунктах), days —
 * дни целым числом.
 */
export type StatFormat = "money" | "number" | "decimal" | "years" | "percent" | "score" | "days";

const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export function formatStat(format: StatFormat, n: number) {
  if (format === "money") return formatMoney(n);
  if (format === "decimal") return decimal.format(n);
  if (format === "years") return `${decimal.format(n)} ${yearsWord(n)}`;
  if (format === "percent") return formatPercent(n);
  if (format === "score") return formatNumber(Math.round(n));
  if (format === "days") return `${formatNumber(Math.round(n))} ${daysWord(Math.round(n))}`;
  return formatNumber(n);
}

/** Доля в процентах: до 10% — с десятыми, дальше целыми. */
export function formatPercent(n: number) {
  return `${Math.abs(n) < 10 ? decimal.format(n) : formatNumber(Math.round(n))}%`;
}

function daysWord(n: number) {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function yearsWord(n: number) {
  if (!Number.isInteger(n)) return "года";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "год";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "года";
  return "лет";
}

export type StatInfo<K extends string = string> = {
  key: K;
  label: string;
  tip: string;
  hint?: string;
  format: StatFormat;
  compare: boolean;
  goodWhenUp: boolean;
};

const GRACE = `${RENEWAL_GRACE_DAYS} дней`;

/** Подразделы дашборда — пункты его меню и заголовки страниц. */
export const DASHBOARD_TITLES = {
  overview: "Общие показатели",
  sales: "Продажи",
  clients: "Клиенты",
  classes: "Занятия",
  marketing: "Маркетинг",
} as const;

/** Подписи и подсказки плашки фильтров дашборда. */
export const DASHBOARD_FILTERS = {
  period: {
    label: "Период",
    tip: "Диапазон дат, за который считаются показатели аналитики.",
  },
  clubs: {
    label: "Клубы",
    tip: "Показатели считаются суммарно по выбранным клубам: один клуб, несколько или все клубы одного формата. Подписочные клубы и клубы с пакетами тренировок вместе не считаются.",
  },
} as const;

/** Высоты графиков — общие у страницы и её скелетона. */
export const DASHBOARD_CHART_HEIGHT = 260;
export const DASHBOARD_PIE_HEIGHT = 180;
/** График рядом с «Топ 10» — высотой с сам рейтинг. */
export const DASHBOARD_RANK_HEIGHT = 360;
/** «Загрузка расписания», пока данных нет (сама сетка — по числу часов). */
export const DASHBOARD_HEATMAP_HEIGHT = 340;

// ---------------------------------------------------------------------------
// Общие показатели

export type OverviewKey =
  | "revenue"
  | "signups"
  | "activeClients"
  | "expiring"
  | "visits"
  | "avgMembership"
  | "avgServices"
  | "avgTotal"
  | "debtPeriod"
  | "debtTotal";

export const OVERVIEW_STATS: StatInfo<OverviewKey>[] = [
  {
    key: "revenue",
    label: "Выручка",
    tip: "Проданные за период абонементы, услуги и товары минус возвраты. Абонемент в рассрочку считается полной стоимостью в день продажи; платежи, снятые возвратом, вычитаются в день возврата.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "signups",
    label: "Новые регистрации",
    tip: "Сколько клиентов появилось за период: зарегистрировались в приложении или заведены в админке.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "activeClients",
    label: "Активные клиенты",
    tip: "Клиенты, у которых сейчас есть действующий абонемент (замороженные не считаются). От периода не зависит.",
    hint: "сейчас",
    format: "number",
    compare: false,
    goodWhenUp: true,
  },
  {
    key: "expiring",
    label: "Заканчивается абонементов",
    tip: "Абонементы, срок которых истекает в выбранном периоде, — кого звать на продление. Не считаются отменённые, с возвратом и те, что клиент уже продлил: купил следующий абонемент того же вида до окончания.",
    hint: "в периоде",
    format: "number",
    compare: true,
    goodWhenUp: false,
  },
  {
    key: "visits",
    label: "Посещений",
    tip: "Сколько посещений занятий отмечено за период.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgMembership",
    label: "Средний чек за абонементы",
    tip: "Сумма проданных за период абонементов, делённая на число продаж.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgServices",
    label: "Средний чек за услуги",
    tip: "Сумма прочих продаж (услуги и товары) за период, делённая на их число.",
    hint: "за период",
    format: "money",
    compare: false,
    goodWhenUp: true,
  },
  {
    key: "avgTotal",
    label: "Средний чек общий",
    tip: "Все продажи за период — абонементы, услуги и товары, — делённые на их число.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "debtPeriod",
    label: "Задолженность за период",
    tip: "Неоплаченные платежи рассрочки со сроком оплаты в выбранном периоде. Платежи, снятые возвратом, не считаются.",
    hint: "не оплачено",
    format: "money",
    compare: true,
    goodWhenUp: false,
  },
  {
    key: "debtTotal",
    label: "Общая задолженность",
    tip: "Все неоплаченные платежи рассрочки клуба — с любым сроком оплаты. Платежи, снятые возвратом, не считаются.",
    hint: "всего",
    format: "money",
    compare: false,
    goodWhenUp: false,
  },
];

/** Сетка плиток: 10 штук — по 5 в ряд на широком экране. */
export const OVERVIEW_GRID = "lg:grid-cols-3 xl:grid-cols-5";

export const OVERVIEW_CHARTS = {
  revenue: {
    title: "Фактическая выручка",
    tip: "Деньги, поступившие в клуб, по дням: оплаты абонементов и внесённые платежи рассрочки, прочие продажи, минус возвраты.",
  },
  rates: {
    title: "Продления и возвращения",
    tip: `Продления — доля абонементов, закончившихся в месяце, после которых клиент купил новый не позже чем через ${GRACE}. Возвращения — доля бывших клиентов (без абонемента дольше ${GRACE}), купивших абонемент в этом месяце. Пакеты персональных тренировок считаются отдельно от групповых абонементов.`,
  },
  visits: {
    title: "Посещения",
    tip: "Отмеченные посещения занятий по дням периода.",
  },
} as const;

// ---------------------------------------------------------------------------
// Продажи

export type SalesKey =
  | "membershipRevenue"
  | "membershipPayments"
  | "otherRevenue"
  | "singleRevenue"
  | "avgMembershipCheck"
  | "avgMembershipPayment"
  | "avgOtherCheck"
  | "singleVisits";

export const SALES_STATS: StatInfo<SalesKey>[] = [
  {
    key: "membershipRevenue",
    label: "Выручка от абонементов",
    tip: "Полная стоимость абонементов, проданных за период, — вместе с ещё не внесёнными платежами рассрочки.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "membershipPayments",
    label: "Платежи по абонементам",
    tip: "Деньги, фактически поступившие за период по абонементам: оплаты без рассрочки и внесённые платежи рассрочки, в том числе по продажам прошлых периодов.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "otherRevenue",
    label: "Прочая выручка",
    tip: "Сумма прочих продаж за период — услуги и товары из раздела «Прочие продажи».",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "singleRevenue",
    label: "Выручка от разовых посещений",
    tip: "Стоимость разовых посещений, проданных за период. Они входят и в выручку от абонементов. Разовое посещение есть только в клубах с пакетами тренировок.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgMembershipCheck",
    label: "Средний чек по абонементам",
    tip: "Выручка от абонементов за период, делённая на число проданных абонементов.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgMembershipPayment",
    label: "Средний платёж по абонементам",
    tip: "Платежи по абонементам за период, делённые на число платежей. При рассрочке каждый внесённый платёж считается отдельно.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgOtherCheck",
    label: "Средний чек по прочим продажам",
    tip: "Прочая выручка за период, делённая на число прочих продаж.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "singleVisits",
    label: "Разовых посещений",
    tip: "Сколько разовых посещений продано за период (с возвратом — тоже, удалённые продажи — нет). Разовое посещение есть только в клубах с пакетами тренировок.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
];

/** Плитки «Продаж» — две строки по четыре: деньги сверху, средние и число разовых снизу. */
export const SALES_GRID = "lg:grid-cols-4";

export const SALES_CHARTS = {
  origin: {
    title: "Доля выручки от абонементов",
    tip: `Выручка от абонементов за период по типу покупки. Новый — первый абонемент клиента; продление — прежний ещё действовал или закончился не больше ${GRACE} назад; возврат — после перерыва дольше ${GRACE}. Разовые посещения (клубы с пакетами тренировок) — отдельная доля, прошлой покупкой не считаются, как и пробное посещение; пакеты персональных тренировок — отдельная история от групповых абонементов.`,
  },
  methods: {
    title: "Способы оплаты",
    tip: "Деньги, поступившие за период (платежи по абонементам и прочие продажи), по способу оплаты.",
  },
  subjects: {
    title: "Предмет оплаты",
    tip: "Деньги, поступившие за период, по тому, за что заплатили: абонементы и позиции прочих продаж.",
  },
  topMemberships: {
    title: "Топ 10 абонементов по выручке",
    tip: "Тарифы из «Номенклатур» с наибольшей суммой платежей за период.",
  },
  topSellers: {
    title: "Топ менеджеров по абонементам",
    tip: "Платежи по абонементам за период по ответственному администратору — тому, кто указан в продаже.",
  },
} as const;

// ---------------------------------------------------------------------------
// Клиенты

export type ClientsKey = "avgAge" | "visitsPerClient" | "ltv";

const MEMBERS = "членов клуба — клиентов с действующим абонементом (в том числе замороженным)";

export const CLIENTS_STATS: StatInfo<ClientsKey>[] = [
  {
    key: "avgAge",
    label: "Средний возраст",
    tip: `Средний возраст ${MEMBERS}. Клиенты без даты рождения не учитываются.`,
    hint: "сейчас",
    format: "years",
    compare: false,
    goodWhenUp: true,
  },
  {
    key: "visitsPerClient",
    label: "Посещений на клиента",
    tip: `Сколько посещений за период в среднем приходится на одного из ${MEMBERS}.`,
    hint: "за период",
    format: "decimal",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "ltv",
    label: "LTV клиента",
    tip: `Сколько денег в среднем принёс один из ${MEMBERS}, за всё время: платежи по абонементам и прочим продажам минус возвраты. От периода не зависит.`,
    hint: "за всё время",
    format: "money",
    compare: false,
    goodWhenUp: true,
  },
];

export const CLIENTS_GRID = "sm:grid-cols-3";

export const CLIENTS_CHARTS = {
  ages: {
    title: "Возраст клиентов",
    tip: "Члены клуба (с действующим абонементом) по возрасту — полных лет на сегодня.",
  },
  topVisits: {
    title: "Топ 10 клиентов по посещениям",
    tip: "Клиенты с наибольшим числом отмеченных посещений за период.",
  },
  topLtv: {
    title: "Топ 10 клиентов по LTV",
    tip: "Клиенты, принёсшие клубу больше всего денег за всё время: все платежи за вычетом возвратов. От периода не зависит.",
  },
} as const;

// ---------------------------------------------------------------------------
// Занятия

const HELD = "групповых занятиях, которые уже прошли и не отменены клубом";

export const CLASSES_STATS: StatInfo<ClassesKey>[] = [
  {
    key: "fillRate",
    label: "Заполняемость",
    tip: `Какая доля мест была занята на ${HELD}: отмеченные посещения / вместимость занятий. Занятия без лимита мест не считаются. Главный показатель расписания — его и растим.`,
    hint: "за период",
    format: "percent",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "showRate",
    label: "Доходимость",
    tip: "Какая доля записавшихся пришла: «Посетил» / («Посетил» + «Не пришёл»). Записи, отменённые до начала, и записи без отметки не считаются.",
    hint: "за период",
    format: "percent",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "avgPerClass",
    label: "Среднее на занятии",
    tip: "Сколько человек в среднем приходит на одно групповое занятие: посещения / проведённые занятия.",
    hint: "человек",
    format: "decimal",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "visits",
    label: "Посещений",
    tip: `Отмеченные посещения на ${HELD}.`,
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "uniqueClients",
    label: "Клиентов на занятиях",
    tip: "Сколько разных клиентов хотя бы раз пришли на групповое занятие за период.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "classes",
    label: "Проведено занятий",
    tip: "Групповые занятия периода, которые уже прошли и не отменены клубом.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "personal",
    label: "Персональных тренировок",
    tip: "Отмеченные посещения персональных тренировок за период.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "cancelRate",
    label: "Отмены записей",
    tip: `Какая доля записей на ${HELD} была отменена до начала — клиентом в приложении или администратором. Лист ожидания не считается.`,
    hint: "за период",
    format: "percent",
    compare: true,
    goodWhenUp: false,
  },
  {
    key: "noShows",
    label: "Не пришли",
    tip: "Записи с отметкой «Не пришёл» на групповые занятия периода — места, которые могли занять другие клиенты.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: false,
  },
  {
    key: "cancelledClasses",
    label: "Отменено занятий",
    tip: "Групповые занятия периода, которые клуб отменил в «Расписании».",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: false,
  },
];

/** Сетка плиток: 10 штук — по 5 в ряд на широком экране. */
export const CLASSES_GRID = "lg:grid-cols-3 xl:grid-cols-5";

export const CLASSES_CHARTS = {
  heatmap: {
    title: "Загрузка расписания",
    tip: "Сколько человек в среднем приходит на групповое занятие по дню недели и часу начала: чем насыщеннее цвет, тем больше. Наведите на ячейку — число занятий и заполняемость. Пустые часы — свободное время в расписании.",
  },
  trainers: {
    title: "Тренеры",
    tip: "Групповые занятия, которые тренер провёл за период. На замене занятие — у заменяющего тренера, занятие с двумя тренерами — у обоих.",
  },
  workouts: {
    title: "Тренировки",
    tip: "Групповые занятия за период по тренировкам из «Тренировок».",
  },
  topSlots: {
    title: "Топ 10 занятий расписания",
    tip: "Занятия расписания — тренировка, день недели и время — с наибольшим средним числом посещений за период.",
  },
  weakSlots: {
    title: "Наименее посещаемые занятия",
    tip: "Занятия расписания с наименьшим средним числом посещений за период — кандидаты на перенос, замену тренировки или продвижение.",
  },
} as const;

/** Колонки таблиц «Тренеры» и «Тренировки» (без первой — имени). */
export const CLASSES_COLUMNS = {
  classes: { label: "Занятий", tip: "Проведённые групповые занятия за период." },
  visits: { label: "Посещений", tip: "Отмеченные посещения этих занятий." },
  avg: { label: "Среднее", tip: "Посещений на одно занятие." },
  fill: {
    label: "Заполняемость",
    tip: "Посещения / вместимость занятий; занятия без лимита мест не считаются.",
  },
  show: {
    label: "Доходимость",
    tip: "«Посетил» / («Посетил» + «Не пришёл»); записи без отметки не считаются.",
  },
  clients: { label: "Клиентов", tip: "Разные клиенты, посетившие эти занятия." },
  repeat: {
    label: "Повторно",
    tip: "Какая доля клиентов пришла на эти занятия ещё раз за период (два посещения и больше) — лояльность к тренеру или направлению.",
  },
  rating: {
    label: "Рейтинг",
    tip: "Оценка тренера клиентами в приложении — за всё время, от периода не зависит.",
  },
} as const;

/** Колонки таблицы «Тренеры» — порядок для страницы и скелетона. */
export const TRAINER_COLUMNS = [
  "classes",
  "visits",
  "avg",
  "fill",
  "show",
  "clients",
  "repeat",
  "rating",
] as const satisfies (keyof typeof CLASSES_COLUMNS)[];
export const WORKOUT_COLUMNS = [
  "classes",
  "visits",
  "avg",
  "fill",
  "show",
  "clients",
  "repeat",
] as const satisfies (keyof typeof CLASSES_COLUMNS)[];

// ---------------------------------------------------------------------------
// Маркетинг

export type MarketingKey =
  | "newClients"
  | "newBuyers"
  | "purchaseConversion"
  | "trialConversion"
  | "firstRevenue"
  | "daysToPurchase"
  | "appSales"
  | "appMembers"
  | "nps"
  | "discounts";

export const MARKETING_STATS: StatInfo<MarketingKey>[] = [
  {
    key: "newClients",
    label: "Новые клиенты",
    tip: "Клиенты, появившиеся за период: заведены в админке или пришли из приложения (по дате регистрации в карточке).",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "newBuyers",
    label: "Новые покупатели",
    tip: "Клиенты, купившие за период свой первый абонемент; пробное и разовое посещения не в счёт. Итог привлечения: сколько пришедших стали платящими.",
    hint: "за период",
    format: "number",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "purchaseConversion",
    label: "Конверсия в покупку",
    tip: "Какая доля новых клиентов периода уже купила абонемент (пробное и разовое посещения не в счёт). Считается на сегодня: у клиентов из конца периода ещё есть время купить.",
    hint: "новых клиентов",
    format: "percent",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "trialConversion",
    label: "Конверсия пробных",
    tip: "Какая доля клиентов, купивших пробное посещение за период, потом купила абонемент (разовое посещение не в счёт). Пробные с возвратом не считаются. В подписочных клубах пробных нет.",
    hint: "за период",
    format: "percent",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "firstRevenue",
    label: "Выручка с первых покупок",
    tip: "Стоимость первых абонементов новых покупателей периода — сколько денег принёс приток новых клиентов.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "daysToPurchase",
    label: "Дней до покупки",
    tip: "Сколько дней в среднем проходит от регистрации клиента до первой покупки абонемента — у новых покупателей периода. Чем быстрее, тем лучше работает воронка.",
    hint: "в среднем",
    format: "days",
    compare: true,
    goodWhenUp: false,
  },
  {
    key: "appSales",
    label: "Покупки в приложении",
    tip: "Доля абонементов за период, которые клиенты купили сами в клиентском приложении; остальные оформлены в админке.",
    hint: "за период",
    format: "percent",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "appMembers",
    label: "Члены клуба в приложении",
    tip: "Какая доля членов клуба (действующий абонемент, в том числе замороженный; пробный не в счёт) вошла в клиентское приложение — до них доходят новости и пуши. От периода не зависит.",
    hint: "сейчас",
    format: "percent",
    compare: false,
    goodWhenUp: true,
  },
  {
    key: "nps",
    label: "NPS",
    tip: "Индекс лояльности по ответам опросов NPS за период: доля промоутеров (9–10 баллов) минус доля критиков (0–6), от −100 до 100. Ответы вносятся в разделе «NPS».",
    hint: "за период",
    format: "score",
    compare: true,
    goodWhenUp: true,
  },
  {
    key: "discounts",
    label: "Скидки",
    tip: "На сколько абонементы за период проданы дешевле цены из «Номенклатур»: ручные скидки и скидки по промокодам.",
    hint: "за период",
    format: "money",
    compare: true,
    goodWhenUp: false,
  },
];

export const MARKETING_GRID = "lg:grid-cols-3 xl:grid-cols-5";

export const MARKETING_CHARTS = {
  funnel: {
    title: "Путь новых клиентов",
    tip: "Что успели сделать клиенты, появившиеся за период, — на сегодня. Доля каждого шага — от всех новых клиентов периода, а не от предыдущего шага: абонемент можно купить и без пробного.",
  },
  sources: {
    title: "Откуда узнали о клубе",
    tip: "Ответ на вопрос анкеты приложения «Откуда вы о нас узнали?» у новых клиентов периода. Клиенты без приложения или без ответа в доли не входят.",
  },
  sourcesTable: {
    title: "Источники клиентов",
    tip: "Новые клиенты периода по ответу в анкете приложения: сколько из них уже купили абонемент и на какую сумму (все их покупки, кроме пробного и разового посещений).",
  },
  goals: {
    title: "Цели новых клиентов",
    tip: "Главная цель тренировок из анкеты приложения у новых клиентов периода — о чём говорить в рекламе и постах.",
  },
  promoCodes: {
    title: "Топ промокодов",
    tip: "Промокоды, указанные в продажах абонементов за период, по сумме продаж. Промокод в продаже — пометка для учёта: скидку он сам не считает.",
  },
  channels: {
    title: "Где покупают абонементы",
    tip: "Абонементы, проданные за период: оформлены администратором в админке или куплены клиентом в приложении.",
  },
} as const;

/** Колонки таблицы «Источники клиентов» (без первой — источника). */
export const SOURCE_COLUMNS = {
  clients: { label: "Новых", tip: "Новые клиенты периода с этим ответом." },
  buyers: {
    label: "Купили",
    tip: "Сколько из них уже купили абонемент (пробное и разовое не в счёт).",
  },
  conversion: { label: "Конверсия", tip: "Купили / новые клиенты." },
  revenue: {
    label: "Выручка",
    tip: "Стоимость всех их абонементов, кроме пробного и разового посещений, — по сегодня.",
  },
} as const;
