/**
 * «Рабочий день» — порядок дня администратора клуба (решение владельца
 * 2026-10-25): логика без React. Схема — корневой CLAUDE.md
 * (`2026-10-26_workday_checklist.sql`), вид — components/workday/.
 *
 * День и «просрочено» — по Тбилиси, как в базе (`workday_today`): у
 * администратора часы компьютера могут быть в другом поясе.
 */

export type WorkdaySection = {
  id: string;
  studio_id: string;
  title: string;
  sort_order: number;
};

export type WorkdayItem = {
  id: string;
  studio_id: string;
  section_id: string;
  title: string;
  /** Подробная инструкция — текст с разметкой (lib/formatted-text.tsx). */
  details: string | null;
  /** Ориентировочное время «к HH:MM» («10:00:00» из базы), null — без времени. */
  due_time: string | null;
  sort_order: number;
};

export type WorkdayCheck = {
  item_id: string;
  day: string;
  checked_by: string | null;
  checked_by_name: string | null;
  checked_at: string;
};

export type WorkdayData = {
  sections: WorkdaySection[];
  items: WorkdayItem[];
  checks: WorkdayCheck[];
};

const TBILISI = "Asia/Tbilisi";

/** Дата (YYYY-MM-DD) и минуты от полуночи по Тбилиси. */
export function tbilisiNow(at: Date = new Date()): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TBILISI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** «10:00:00» → 600; пусто или мусор — null. */
export function timeToMinutes(time: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** «09:30:00» → «9:30» — подпись времени у пункта. */
export function formatDueTime(time: string | null | undefined): string {
  const minutes = timeToMinutes(time);
  if (minutes == null) return "";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** «09:30:00» → «09:30» — значение поля type="time". */
export function timeInputValue(time: string | null | undefined): string {
  const minutes = timeToMinutes(time);
  if (minutes == null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Время отметки «10:42» по Тбилиси. */
export function formatCheckedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    timeZone: TBILISI,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Просрочен: у пункта есть время, оно прошло (строго позже — к 10:00 можно
 * успеть до 10:00 включительно), а отметки за сегодня нет.
 */
export function isOverdue(item: WorkdayItem, checked: boolean, nowMinutes: number): boolean {
  if (checked) return false;
  const due = timeToMinutes(item.due_time);
  return due != null && nowMinutes > due;
}

export type WorkdayRow = WorkdayItem & {
  check: WorkdayCheck | null;
  overdue: boolean;
};

export type WorkdayGroup = {
  section: WorkdaySection;
  rows: WorkdayRow[];
  done: number;
  overdue: number;
};

const bySort = <T extends { sort_order: number; id: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.id.localeCompare(b.id);

/** Блоки по порядку, в каждом — пункты с отметкой и признаком «просрочен». */
export function groupWorkday(data: WorkdayData, nowMinutes: number): WorkdayGroup[] {
  const checks = new Map(data.checks.map((c) => [c.item_id, c]));
  return [...data.sections].sort(bySort).map((section) => {
    const rows = data.items
      .filter((i) => i.section_id === section.id)
      .sort(bySort)
      .map((i) => {
        const check = checks.get(i.id) ?? null;
        return { ...i, check, overdue: isOverdue(i, !!check, nowMinutes) };
      });
    return {
      section,
      rows,
      done: rows.filter((r) => r.check).length,
      overdue: rows.filter((r) => r.overdue).length,
    };
  });
}

/** Итог дня: выполнено, всего и просрочено — для шапки панели и кнопки. */
export function workdaySummary(groups: WorkdayGroup[]) {
  return groups.reduce(
    (acc, g) => ({
      done: acc.done + g.done,
      total: acc.total + g.rows.length,
      overdue: acc.overdue + g.overdue,
    }),
    { done: 0, total: 0, overdue: 0 },
  );
}

/** Новый порядок id после сдвига элемента на шаг вверх (-1) или вниз (+1). */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] | null {
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** Ошибки базы «Рабочего дня» — понятным текстом. */
export function workdayErrorText(message: string): string {
  if (message.includes("workday_not_today"))
    return "Отметить можно только сегодняшний день — обновите страницу";
  if (message.includes("workday_forbidden") || message.includes("row-level security"))
    return "Нет прав: пункты меняет владелец клуба";
  if (message.includes("workday_source_empty")) return "В выбранном клубе пунктов пока нет";
  if (message.includes("workday_other_studio")) return "Блок другого клуба выбрать нельзя";
  return message;
}
