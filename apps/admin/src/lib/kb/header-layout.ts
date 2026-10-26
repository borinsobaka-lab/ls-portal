/**
 * Раскладка шапки базы знаний (AdminShell и её скелетон ShellSkeleton kb).
 * С lg шапка — сетка из трёх колонок: вкладки баз — левая, поиск — средняя,
 * кнопки (тема, «Обновить») — правая. Крайние колонки равны,
 * поэтому поиск всегда ровно по центру и не сдвигается ни от числа и длины
 * вкладок, ни при переходе между базами (решение владельца 2026-10-26:
 * раньше много вкладок сдвигали поиск вправо, а скелетон ставил его к краю).
 * Вкладки шире своей колонки прокручиваются (KbBaseTabs). До lg — строка с
 * переносом: меню, вкладки, кнопки; поиск — второй строкой.
 */
export const KB_HEADER_GRID =
  "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem_minmax(0,1fr)] lg:items-center";

/** Колонка у каждой части задана явно: место не зависит от соседей. */
export const KB_TABS_SLOT = "min-w-0 flex-1 lg:col-start-1 lg:row-start-1";
export const KB_SEARCH_SLOT = "order-last w-full lg:order-none lg:col-start-2 lg:row-start-1";
export const KB_ACTIONS_SLOT = "lg:col-start-3 lg:row-start-1";
