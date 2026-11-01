/**
 * Раскладка шапки базы знаний (AdminShell и её скелетон ShellSkeleton kb).
 * С lg шапка — сетка из трёх колонок: вкладки баз — левая (всё свободное
 * место), поиск — средняя постоянной ширины, кнопки (тема, «Обновить») —
 * правая у края. Решение владельца 2026-11-01: поиск — справа, вкладкам
 * баз — больше места. Ширина поиска и кнопок не зависит от вкладок, поэтому
 * поиск стоит на одном месте на всех страницах базы (решение 2026-10-26:
 * поиск не должен «скакать»). Вкладки шире своей колонки прокручиваются
 * (KbBaseTabs: перетаскивание, колесо, стрелки, выбранная — по центру).
 * До lg — строка: меню, вкладки, кнопки; поиск — второй строкой.
 */
export const KB_HEADER_GRID =
  "lg:grid lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-center xl:grid-cols-[minmax(0,1fr)_20rem_auto]";

/** Колонка у каждой части задана явно: место не зависит от соседей. */
export const KB_TABS_SLOT = "min-w-0 flex-1 lg:col-start-1 lg:row-start-1";
export const KB_SEARCH_SLOT = "order-last w-full lg:order-none lg:col-start-2 lg:row-start-1";
export const KB_ACTIONS_SLOT = "flex shrink-0 items-center gap-2 lg:col-start-3 lg:row-start-1";
