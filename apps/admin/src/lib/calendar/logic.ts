/**
 * Календарь — логика без React: цвета календарей, время в поясе человека
 * для сетки (FullCalendar работает в «стенном» времени UTC, пояс считаем
 * сами), подписи повторов, напоминаний и времени события, форма события.
 */
import { addDays, isoDow, localDay, localTime, plural, zoned } from "@/lib/tasks/logic";
import type { CalColor, CalEvent, CalLevel, Response, RRule, RRuleFreq } from "./types";

export const CAL_COLORS: Record<CalColor, { label: string; solid: string }> = {
  blue: { label: "Синий", solid: "#3b82f6" },
  sky: { label: "Голубой", solid: "#0ea5e9" },
  teal: { label: "Бирюзовый", solid: "#14b8a6" },
  green: { label: "Зелёный", solid: "#22c55e" },
  lime: { label: "Салатовый", solid: "#84cc16" },
  amber: { label: "Жёлтый", solid: "#f59e0b" },
  orange: { label: "Оранжевый", solid: "#f97316" },
  red: { label: "Красный", solid: "#ef4444" },
  pink: { label: "Розовый", solid: "#ec4899" },
  purple: { label: "Фиолетовый", solid: "#a855f7" },
  violet: { label: "Индиго", solid: "#6366f1" },
  gray: { label: "Серый", solid: "#64748b" },
};
export const CAL_COLOR_KEYS = Object.keys(CAL_COLORS) as CalColor[];
export const calColor = (c: string | null | undefined) =>
  CAL_COLORS[(c as CalColor) in CAL_COLORS ? (c as CalColor) : "blue"].solid;

export const LEVEL_LABEL: Record<CalLevel, string> = {
  view: "Смотрит",
  edit: "Добавляет события",
  manage: "Управляет",
};

export const RESPONSE_LABEL: Record<Response, string> = {
  pending: "Не ответил(а)",
  accepted: "Придёт",
  declined: "Не придёт",
  maybe: "Возможно",
};

// ---- Время ---------------------------------------------------------------------------

/**
 * «Стенное» время момента в поясе — строка без смещения для FullCalendar
 * (`timeZone: "UTC"`): «2026-11-10T10:00:00».
 */
export function wallClock(at: string | Date, tz: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return `${localDay(d, tz)}T${localTime(d, tz)}:00`;
}

/** Дата из FullCalendar (стенное время в полях UTC) → момент в поясе. */
export function fromWallClock(d: Date, tz: string): Date {
  const iso = d.toISOString();
  return zoned(iso.slice(0, 10), iso.slice(11, 16), tz);
}

/** День сетки FullCalendar «2026-11-10» (поля UTC). */
export const wallDay = (d: Date) => d.toISOString().slice(0, 10);

const DAY_FMT = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const SHORT_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

/** «вторник, 10 ноября» для дня «2026-11-10». */
export function dayTitle(day: string, withWeekday = true): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return (withWeekday ? DAY_FMT : SHORT_FMT).format(date);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Когда: «Вторник, 10 ноября · 10:00–11:00», «10–12 ноября, весь день»,
 * через полночь — «10 ноября, 22:00 – 11 ноября, 02:00».
 */
export function eventWhen(
  e: { start: string; end: string; all_day: boolean; day_from: string; day_to: string },
  tz: string,
): string {
  if (e.all_day) {
    if (e.day_to > e.day_from) {
      return `${dayTitle(e.day_from, false)} – ${dayTitle(e.day_to, false)}, весь день`;
    }
    return `${cap(dayTitle(e.day_from))}, весь день`;
  }
  const s = new Date(e.start);
  const f = new Date(e.end);
  const d1 = localDay(s, tz);
  const d2 = localDay(f, tz);
  if (d1 !== d2) {
    return `${dayTitle(d1, false)}, ${localTime(s, tz)} – ${dayTitle(d2, false)}, ${localTime(f, tz)}`;
  }
  const t =
    s.getTime() === f.getTime() ? localTime(s, tz) : `${localTime(s, tz)}–${localTime(f, tz)}`;
  return `${cap(dayTitle(d1))} · ${t}`;
}

/** «Подключиться» — с 15 минут до начала и до конца встречи. */
export function canJoinVideo(start: string, end: string, now = new Date()): boolean {
  const s = new Date(start).getTime() - 15 * 60_000;
  const f = Math.max(new Date(end).getTime(), new Date(start).getTime() + 60 * 60_000);
  return now.getTime() >= s && now.getTime() <= f;
}

// ---- Повтор --------------------------------------------------------------------------

export const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export const FREQ_OPTIONS: { value: RRuleFreq | "none"; label: string }[] = [
  { value: "none", label: "Не повторять" },
  { value: "daily", label: "Каждый день" },
  { value: "workdays", label: "По рабочим дням" },
  { value: "weekly", label: "Каждую неделю" },
  { value: "monthly", label: "Каждый месяц" },
  { value: "yearly", label: "Каждый год" },
];

const UNIT: Record<Exclude<RRuleFreq, "workdays">, [string, string, string, string]> = {
  // каждый N-й: «Каждый день» / «Каждые 2 дня» / «Каждые 5 дней»
  daily: ["Каждый день", "день", "дня", "дней"],
  weekly: ["Каждую неделю", "неделю", "недели", "недель"],
  monthly: ["Каждый месяц", "месяц", "месяца", "месяцев"],
  yearly: ["Каждый год", "год", "года", "лет"],
};

/** «Каждую неделю: пн, ср до 30 ноября», «По рабочим дням». */
export function rruleText(r: RRule | null | undefined, startDay?: string): string {
  if (!r) return "";
  let text: string;
  if (r.freq === "workdays") {
    text = "По рабочим дням";
  } else {
    const n = r.interval && r.interval > 1 ? r.interval : 1;
    const [one, unit1, unit2, unit5] = UNIT[r.freq];
    text =
      n === 1
        ? one
        : `${n % 10 === 1 && n % 100 !== 11 ? "Каждый" : "Каждые"} ${n} ${plural(n, unit1, unit2, unit5)}`;
    if (r.freq === "weekly" && r.weekdays?.length) {
      text += `: ${[...r.weekdays]
        .sort()
        .map((d) => WEEKDAYS[d - 1])
        .join(", ")}`;
    }
    if (r.freq === "monthly" && startDay) text += `, ${Number(startDay.slice(8, 10))}-го числа`;
    if (r.freq === "yearly" && startDay) text += `, ${dayTitle(startDay, false)}`;
  }
  if (r.until) text += ` до ${dayTitle(r.until, false)}`;
  return text;
}

// ---- Напоминания ---------------------------------------------------------------------

/** Минут до начала. Весь день — до полуночи дня (−540 — в день в 9:00). */
export const REMINDERS_TIMED = [0, 5, 10, 15, 30, 60, 120, 1440, 10080];
export const REMINDERS_ALL_DAY = [-540, 900, 2340, 9540];

export function reminderLabel(m: number, allDay: boolean): string {
  if (allDay) {
    if (m < 0) {
      const mins = -m;
      return `В день события в ${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    }
    const days = Math.ceil(m / 1440);
    const at = days * 1440 - m;
    const time = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    if (days === 1) return `За день в ${time}`;
    if (days === 7) return `За неделю в ${time}`;
    return `За ${days} ${plural(days, "день", "дня", "дней")} в ${time}`;
  }
  if (m === 0) return "В момент начала";
  if (m < 60) return `За ${m} мин`;
  if (m % 10080 === 0) return m === 10080 ? "За неделю" : `За ${m / 10080} нед.`;
  if (m % 1440 === 0)
    return m === 1440 ? "За день" : `За ${m / 1440} ${plural(m / 1440, "день", "дня", "дней")}`;
  if (m % 60 === 0)
    return m === 60 ? "За час" : `За ${m / 60} ${plural(m / 60, "час", "часа", "часов")}`;
  return `За ${m} мин`;
}

// ---- Форма события -----------------------------------------------------------------

export type EventForm = {
  calendarId: string;
  title: string;
  allDay: boolean;
  dayFrom: string;
  timeFrom: string;
  dayTo: string;
  timeTo: string;
  freq: RRuleFreq | "none";
  interval: number;
  weekdays: number[];
  until: string;
  location: string;
  description: string;
  video: boolean;
  attendees: string[];
  reminders: number[];
};

const pad = (n: number) => String(n).padStart(2, "0");
function addMinutes(time: string, mins: number): { time: string; dayShift: number } {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const dayShift = Math.floor(total / 1440);
  const t = ((total % 1440) + 1440) % 1440;
  return { time: `${pad(Math.floor(t / 60))}:${pad(t % 60)}`, dayShift };
}

/** Пустая форма: ближайший час (или выбранный в сетке промежуток). */
export function newEventForm(
  calendarId: string,
  tz: string,
  now = new Date(),
  pick?: { day: string; time?: string; endDay?: string; endTime?: string; allDay?: boolean },
): EventForm {
  let dayFrom: string;
  let timeFrom: string;
  if (pick) {
    dayFrom = pick.day;
    timeFrom = pick.time ?? "10:00";
  } else {
    const t = localTime(now, tz);
    const next = addMinutes(`${t.slice(0, 2)}:00`, 60);
    dayFrom = addDays(localDay(now, tz), next.dayShift);
    timeFrom = next.time;
  }
  let dayTo = pick?.endDay ?? dayFrom;
  let timeTo = pick?.endTime ?? "";
  if (!timeTo) {
    const end = addMinutes(timeFrom, 60);
    timeTo = end.time;
    if (!pick?.endDay) dayTo = addDays(dayFrom, end.dayShift);
  }
  return {
    calendarId,
    title: "",
    allDay: !!pick?.allDay,
    dayFrom,
    timeFrom,
    dayTo,
    timeTo,
    freq: "none",
    interval: 1,
    weekdays: [isoDow(dayFrom)],
    until: "",
    location: "",
    description: "",
    video: false,
    attendees: [],
    reminders: pick?.allDay ? [-540] : [15],
  };
}

/** Форма из события (повторение — его время). */
export function eventToForm(e: CalEvent, tz: string): EventForm {
  const s = new Date(e.occ_start);
  const f = new Date(e.occ_end);
  const dayFrom = e.all_day ? e.day_from : localDay(s, tz);
  return {
    calendarId: e.calendar.id,
    title: e.title,
    allDay: e.all_day,
    dayFrom,
    timeFrom: e.all_day ? "10:00" : localTime(s, tz),
    dayTo: e.all_day ? e.day_to : localDay(f, tz),
    timeTo: e.all_day ? "11:00" : localTime(f, tz),
    freq: e.rrule?.freq ?? "none",
    interval: e.rrule?.interval ?? 1,
    weekdays: e.rrule?.weekdays?.length ? e.rrule.weekdays : [isoDow(dayFrom)],
    until: e.rrule?.until ?? "",
    location: e.location ?? "",
    description: e.description ?? "",
    video: e.video,
    attendees: e.attendees.map((a) => a.user_id),
    reminders: e.my_reminders ?? e.reminders,
  };
}

/** Начало и конец формы как моменты (весь день — полночь в поясе и после последнего дня). */
export function formTimes(f: EventForm, tz: string): { start: Date; end: Date } {
  if (f.allDay) {
    const to = f.dayTo < f.dayFrom ? f.dayFrom : f.dayTo;
    return { start: zoned(f.dayFrom, "00:00", tz), end: zoned(addDays(to, 1), "00:00", tz) };
  }
  return { start: zoned(f.dayFrom, f.timeFrom, tz), end: zoned(f.dayTo, f.timeTo, tz) };
}

export function formRRule(f: EventForm): RRule | null {
  if (f.freq === "none") return null;
  const r: RRule = { freq: f.freq };
  if (f.freq !== "workdays" && f.interval > 1) r.interval = Math.min(99, Math.round(f.interval));
  if (f.freq === "weekly") r.weekdays = [...new Set(f.weekdays)].sort();
  if (f.until) r.until = f.until;
  return r;
}

/** Проверка формы: текст ошибки или null. */
export function formProblem(f: EventForm, tz: string): string | null {
  if (!f.title.trim()) return "Напишите название";
  if (!f.dayFrom || (!f.allDay && (!f.timeFrom || !f.dayTo || !f.timeTo)))
    return "Укажите дату и время";
  const { start, end } = formTimes(f, tz);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Укажите дату и время";
  if (end < start) return "Окончание раньше начала";
  if (f.freq === "weekly" && f.weekdays.length === 0) return "Выберите дни недели";
  if (f.until && f.until < f.dayFrom) return "Повтор заканчивается раньше начала";
  return null;
}

/**
 * Данные для cal_event_save. `series` — правка всей серии из повторения:
 * время серии сдвигается на столько же, на сколько сдвинули повторение
 * (серия начинается раньше этого повторения).
 */
export function formPayload(
  f: EventForm,
  tz: string,
  base?: { occStart: string; occEnd: string; seriesStart: string; seriesEnd: string },
): Record<string, unknown> {
  const { start, end } = formTimes(f, tz);
  let startsAt = start.toISOString();
  let endsAt = end.toISOString();
  if (base) {
    const shiftStart = start.getTime() - new Date(base.occStart).getTime();
    const shiftEnd = end.getTime() - new Date(base.occEnd).getTime();
    startsAt = new Date(new Date(base.seriesStart).getTime() + shiftStart).toISOString();
    endsAt = new Date(new Date(base.seriesEnd).getTime() + shiftEnd).toISOString();
  }
  return {
    calendar_id: f.calendarId,
    title: f.title.trim(),
    all_day: f.allDay,
    starts_at: startsAt,
    ends_at: endsAt,
    tz,
    rrule: formRRule(f),
    location: f.location.trim(),
    description: f.description.trim(),
    video: f.video,
    attendees: f.attendees,
    reminders: f.reminders,
  };
}

// ---- Ошибки --------------------------------------------------------------------------

const ERRORS: Record<string, string> = {
  cal_forbidden: "Нет прав на это действие в календаре",
  cal_not_found: "Событие не найдено — возможно, его удалили",
  cal_not_attendee: "Вы не участник этой встречи",
  cal_title_required: "Напишите название",
  cal_name_required: "Напишите название календаря",
  cal_end_before_start: "Окончание раньше начала",
  cal_rrule_invalid: "Проверьте настройки повтора",
  cal_reminders_invalid: "Не больше 5 напоминаний",
  cal_occurrence_not_found: "Этого повторения уже нет — обновите календарь",
  cal_access_forbidden: "Открыть календарь всей компании или этому подразделению вы не можете",
  cal_access_invalid: "Проверьте, кому открыт календарь",
  cal_personal_delete: "Личный календарь не удаляется",
  cal_invalid: "Проверьте данные события",
};

export function calErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const key = Object.keys(ERRORS).find((k) => msg.includes(k));
  return key ? ERRORS[key] : msg || "Не получилось";
}

// ---- Адрес ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Параметры адреса «Календаря»: событие и повторение, настройки, «Ждут ответа». */
export function calendarSearch(raw: Record<string, unknown>): {
  event?: string;
  at?: string;
  settings?: string;
  invites?: boolean;
} {
  const event = typeof raw.event === "string" && UUID_RE.test(raw.event) ? raw.event : undefined;
  const at =
    event && typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? raw.at : undefined;
  const settings =
    typeof raw.settings === "string" && (raw.settings === "new" || UUID_RE.test(raw.settings))
      ? raw.settings
      : undefined;
  const invites =
    raw.invites === true || raw.invites === "1" || raw.invites === 1 || raw.invites === "true";
  return {
    ...(event ? { event } : {}),
    ...(at ? { at } : {}),
    ...(settings ? { settings } : {}),
    ...(invites ? { invites: true } : {}),
  };
}
