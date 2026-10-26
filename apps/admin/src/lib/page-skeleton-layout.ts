import type { StudioFormat } from "@/lib/studio-formats";

/*
 * Данные для скелетонов страниц (components/page-skeletons.tsx), которые
 * нужны и самим страницам. Отдельно от компонентов — иначе ломается
 * fast refresh модуля скелетонов.
 */

const FORMAT_KEY = "base40.activeStudioFormat";

/** Запоминает формат активного клуба для скелетонов (StudioBranding). */
export function rememberStudioFormat(format: StudioFormat | undefined) {
  try {
    if (format) window.localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // приватный режим — скелетон просто возьмёт подписочный вид
  }
}

/** Формат клуба, запомненный StudioBranding; по умолчанию — подписочный. */
export const readSkeletonFormat = (): StudioFormat => {
  try {
    return window.localStorage.getItem(FORMAT_KEY) === "packages" ? "packages" : "subscription";
  } catch {
    return "subscription";
  }
};

/**
 * Болванки карточек занятий: шахматный порядок в «рабочие» часы — сетка
 * сразу выглядит расписанием. На телефоне виден один день — там болванка в
 * каждом из этих часов. Общие с schedule.tsx (первая загрузка недели).
 */
export const SCHEDULE_SKELETON_HOURS = new Set([9, 11, 18, 19]);
export const isScheduleSkeletonCell = (hour: number, dayIndex: number, singleDay: boolean) =>
  SCHEDULE_SKELETON_HOURS.has(hour) && (singleDay || (hour + dayIndex) % 2 === 0);
