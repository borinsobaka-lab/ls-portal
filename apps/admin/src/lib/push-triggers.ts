/**
 * Триггерные уведомления клиентского приложения — каталог для страницы
 * «Мобильное приложение» → «Триггеры» (routes/_authenticated/push-triggers.tsx).
 *
 * Тексты, включение и параметры хранятся в базе (push_triggers, строка на
 * формат и триггер), когда и кому уходит — решает база
 * (db/migrations/2026-10-15_push_triggers.sql, push_triggers_run). Здесь —
 * подписи, описание срабатывания, переменные текста и поля параметров.
 * Ключи и параметры должны совпадать с миграцией.
 */
import type { StudioFormat } from "@/lib/studio-formats";
import { plural } from "@/lib/payroll";

export type TriggerGroup = "classes" | "memberships" | "payments" | "engagement";

export const TRIGGER_GROUPS: { key: TriggerGroup; title: string }[] = [
  { key: "classes", title: "Занятия" },
  { key: "memberships", title: "Абонементы" },
  { key: "payments", title: "Оплата" },
  { key: "engagement", title: "Вовлечение" },
];

export type TriggerParamKey = "hours" | "days" | "left" | "send_hour";
export type TriggerParams = Partial<Record<TriggerParamKey, number>>;

export type TriggerParamDef = {
  key: TriggerParamKey;
  label: string;
  tip?: string;
  min: number;
  max: number;
};

/** Переменная текста → что подставится (на языке приложения клиента). */
export type TriggerVars = Record<string, string>;

export type TriggerDef = {
  key: string;
  group: TriggerGroup;
  name: string;
  formats: readonly StudioFormat[];
  /** Когда и кому уходит — с текущими параметрами. */
  describe: (p: TriggerParams) => string;
  params: TriggerParamDef[];
  /** Как в миграции: параметр не задан — это значение. */
  defaults: TriggerParams;
  vars: TriggerVars;
};

const BOTH: readonly StudioFormat[] = ["subscription", "packages"];
const PACKAGES: readonly StudioFormat[] = ["packages"];

const NAME = { name: "имя клиента" };
const CLUB = { club: "клуб" };
const CLASS_VARS: TriggerVars = {
  ...NAME,
  class: "тренировка (персональная — «Персональная тренировка», диагностика — «Диагностика тела»)",
  when: "когда: «сегодня в 18:00», «завтра в 09:30», «17.10 в 18:00»",
  date: "дата занятия (ДД.ММ)",
  time: "время начала",
  trainer: "тренер",
  ...CLUB,
};

const SEND_HOUR: TriggerParamDef = {
  key: "send_hour",
  label: "Время отправки",
  tip: "Во сколько по Тбилиси уходит уведомление в день срабатывания (с 08:00 до 21:00).",
  min: 8,
  max: 21,
};

export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

const hoursText = (n: number) => `${n} ${plural(n, ["час", "часа", "часов"])}`;
const daysText = (n: number) => `${n} ${plural(n, ["день", "дня", "дней"])}`;
const at = (p: TriggerParams, d: TriggerParams) => ` в ${hourLabel(p.send_hour ?? d.send_hour!)}`;

export const PUSH_TRIGGERS: TriggerDef[] = [
  {
    key: "class_reminder",
    group: "classes",
    name: "Напоминание о занятии",
    formats: BOTH,
    defaults: { hours: 3 },
    describe: (p) =>
      `За ${hoursText(p.hours ?? 3)} до начала — всем записанным. Если это время выпадает на ночь (22:00–09:00) — в 09:00 или накануне в 21:00. Записавшимся позже не приходит.`,
    params: [{ key: "hours", label: "За сколько часов до начала", min: 1, max: 48 }],
    vars: CLASS_VARS,
  },
  {
    key: "booked_for_client",
    group: "classes",
    name: "Вас записали на занятие",
    formats: BOTH,
    defaults: {},
    describe: () =>
      "Сразу, когда клиента записал администратор (в админке). Если клиент записался сам — не приходит.",
    params: [],
    vars: CLASS_VARS,
  },
  {
    key: "class_cancelled",
    group: "classes",
    name: "Занятие отменено",
    formats: BOTH,
    defaults: {},
    describe: () =>
      "Сразу после отмены занятия в расписании — всем, кто был записан. Приходит в любое время суток.",
    params: [],
    vars: CLASS_VARS,
  },
  {
    key: "trainer_substitution",
    group: "classes",
    name: "Замена тренера",
    formats: BOTH,
    defaults: {},
    describe: () =>
      "Сразу, когда на занятии поставили замену тренера, — тем, кто записался раньше замены. {trainer} — новый тренер.",
    params: [],
    vars: CLASS_VARS,
  },
  {
    key: "membership_activated",
    group: "memberships",
    name: "Абонемент оформлен",
    formats: BOTH,
    defaults: {},
    describe: () =>
      "Сразу после продажи абонемента — в админке или покупки в приложении (в том числе продление в очереди).",
    params: [],
    vars: { ...NAME, membership: "абонемент", ...CLUB },
  },
  {
    key: "membership_expiring",
    group: "memberships",
    name: "Абонемент скоро закончится",
    formats: BOTH,
    defaults: { days: 3, send_hour: 11 },
    describe: (p) =>
      `За ${daysText(p.days ?? 3)} до окончания срока${at(p, { send_hour: 11 })}. Не приходит, если продление уже куплено, включено автопродление или это пробный.`,
    params: [{ key: "days", label: "За сколько дней до окончания", min: 1, max: 30 }, SEND_HOUR],
    vars: {
      ...NAME,
      membership: "абонемент",
      date: "последний день абонемента (ДД.ММ)",
      days: "сколько дней осталось",
      ...CLUB,
    },
  },
  {
    key: "membership_ended",
    group: "memberships",
    name: "Абонемент закончился",
    formats: BOTH,
    defaults: { send_hour: 11 },
    describe: (p) =>
      `На следующий день после окончания срока${at(p, { send_hour: 11 })}, если нового абонемента нет и тренировки в нём ещё оставались (об отхоженном — «Тренировки закончились»). Пробный — не в счёт.`,
    params: [SEND_HOUR],
    vars: { ...NAME, membership: "абонемент", date: "последний день абонемента (ДД.ММ)", ...CLUB },
  },
  {
    key: "visits_low",
    group: "memberships",
    name: "Осталось мало тренировок",
    formats: PACKAGES,
    defaults: { left: 2 },
    describe: (p) =>
      `После списания тренировки, когда в абонементе осталось ${p.left ?? 2} или меньше (но не ноль). Один раз на абонемент; не приходит, если продление уже куплено. Пробное и разовое посещение — не в счёт.`,
    params: [
      {
        key: "left",
        label: "Когда осталось тренировок",
        tip: "Уведомление придёт, когда остаток станет таким или меньше.",
        min: 1,
        max: 5,
      },
    ],
    vars: { ...NAME, membership: "абонемент", left: "сколько тренировок осталось", ...CLUB },
  },
  {
    key: "visits_exhausted",
    group: "memberships",
    name: "Тренировки закончились",
    formats: PACKAGES,
    defaults: {},
    describe: () =>
      "Когда списана последняя тренировка абонемента и продления нет. Пробное и разовое посещение — не в счёт.",
    params: [],
    vars: { ...NAME, membership: "абонемент", ...CLUB },
  },
  {
    key: "installment_due",
    group: "payments",
    name: "Скоро платёж по рассрочке",
    formats: BOTH,
    defaults: { days: 1, send_hour: 11 },
    describe: (p) => {
      const days = p.days ?? 1;
      return `${days === 0 ? "В день платежа" : `За ${daysText(days)} до платежа`}${at(p, { send_hour: 11 })} — по каждому невнесённому платежу графика.`;
    },
    params: [
      {
        key: "days",
        label: "За сколько дней до платежа",
        tip: "0 — в сам день платежа.",
        min: 0,
        max: 14,
      },
      SEND_HOUR,
    ],
    vars: {
      ...NAME,
      amount: "сумма платежа (число, без ₾)",
      date: "дата платежа (ДД.ММ)",
      membership: "абонемент",
      ...CLUB,
    },
  },
  {
    key: "installment_overdue",
    group: "payments",
    name: "Платёж просрочен",
    formats: BOTH,
    defaults: { days: 1, send_hour: 11 },
    describe: (p) =>
      `Через ${daysText(p.days ?? 1)} после даты платежа${at(p, { send_hour: 11 })}, если он не внесён. Один раз на платёж.`,
    params: [{ key: "days", label: "Через сколько дней после даты", min: 1, max: 30 }, SEND_HOUR],
    vars: {
      ...NAME,
      amount: "сумма платежа (число, без ₾)",
      date: "дата платежа (ДД.ММ)",
      membership: "абонемент",
      ...CLUB,
    },
  },
  {
    key: "trial_followup",
    group: "engagement",
    name: "После пробной тренировки",
    formats: PACKAGES,
    defaults: { hours: 3 },
    describe: (p) =>
      `Через ${hoursText(p.hours ?? 3)} после посещённой пробной тренировки, если абонемент ещё не куплен. Ночью ждёт до 09:00.`,
    params: [{ key: "hours", label: "Через сколько часов после занятия", min: 1, max: 48 }],
    vars: { ...NAME, ...CLUB },
  },
  {
    key: "rate_trainer",
    group: "engagement",
    name: "Оцените тренера",
    formats: PACKAGES,
    defaults: { hours: 2 },
    describe: (p) =>
      `Через ${hoursText(p.hours ?? 2)} после посещённого занятия — если клиент ещё не оценивал этого тренера. Один раз на тренера; ночью ждёт до 09:00.`,
    params: [{ key: "hours", label: "Через сколько часов после занятия", min: 1, max: 48 }],
    vars: CLASS_VARS,
  },
  {
    key: "no_visits",
    group: "engagement",
    name: "Давно не был в клубе",
    formats: BOTH,
    defaults: { days: 14, send_hour: 12 },
    describe: (p) =>
      `Клиенту с действующим абонементом, если ${daysText(p.days ?? 14)} не было посещений и нет будущих записей${at(p, { send_hour: 12 })}. Один раз после каждого последнего посещения.`,
    params: [{ key: "days", label: "Сколько дней без посещений", min: 3, max: 90 }, SEND_HOUR],
    vars: {
      ...NAME,
      date: "дата последнего посещения (ДД.ММ)",
      days: "сколько дней прошло",
      ...CLUB,
    },
  },
  {
    key: "birthday",
    group: "engagement",
    name: "День рождения",
    formats: BOTH,
    defaults: { send_hour: 10 },
    describe: (p) =>
      `В день рождения${at(p, { send_hour: 10 })}. Дата — из карточки клиента или анкеты приложения.`,
    params: [SEND_HOUR],
    vars: { ...NAME, ...CLUB },
  },
];

export const triggerDef = (key: string) => PUSH_TRIGGERS.find((t) => t.key === key);

export const triggersOfFormat = (format: StudioFormat) =>
  PUSH_TRIGGERS.filter((t) => t.formats.includes(format));

/** Переменные в тексте: «{name}, ждём на {class}» → ["name", "class"]. */
export function templateVars(text: string | null | undefined): string[] {
  return [...new Set([...(text ?? "").matchAll(/\{([^{}\s]+)\}/g)].map((m) => m[1]))];
}

/** Переменные, которых у триггера нет: они так и останутся в тексте фигурными скобками. */
export function unknownVars(texts: (string | null | undefined)[], vars: TriggerVars): string[] {
  return [...new Set(texts.flatMap(templateVars))].filter((v) => !(v in vars));
}

/** Параметры для сохранения: только поля триггера, целые, в пределах. */
export function cleanParams(def: TriggerDef, values: TriggerParams): TriggerParams {
  const out: TriggerParams = {};
  for (const p of def.params) {
    const raw = values[p.key] ?? def.defaults[p.key];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    out[p.key] = Math.min(p.max, Math.max(p.min, Math.round(raw)));
  }
  return out;
}

/** Вставка переменной в текст на место курсора (или в конец). */
export function insertAt(
  text: string,
  token: string,
  start: number | null | undefined,
  end: number | null | undefined,
): { text: string; caret: number } {
  const s = start ?? text.length;
  const e = end ?? s;
  const before = text.slice(0, s);
  const after = text.slice(e);
  const pad = before && !/\s$/.test(before) && !/[«„(]$/.test(before) ? " " : "";
  const next = before + pad + token + after;
  return { text: next, caret: (before + pad + token).length };
}
