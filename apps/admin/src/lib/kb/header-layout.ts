/**
 * Раскладка шапки базы знаний (AdminShell и её скелетон ShellSkeleton kb).
 *
 * Первая строка с lg — сетка из трёх колонок: поиск — ровно по центру
 * (средняя колонка), кнопки темы и «Обновить» — у правого края; крайние
 * колонки равны, поэтому поиск стоит на одном месте на всех страницах базы
 * (решения владельца 2026-10-26, 2026-11-01). До lg — строка: меню, поиск,
 * кнопки.
 *
 * Вторая строка — переключатель баз (KbBaseTabs, решение владельца
 * 2026-11-01): только если сотруднику открыто больше одной базы; с md —
 * вкладки, на телефоне — выпадающий список с иконками.
 */
export const KB_HEADER_ROW =
  "flex items-center gap-2 px-3 py-2 lg:grid lg:h-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] lg:gap-3 lg:px-4 lg:py-0";

/** Колонка у каждой части задана явно: место не зависит от соседей. */
export const KB_SEARCH_SLOT = "min-w-0 flex-1 lg:col-start-2 lg:row-start-1";
export const KB_ACTIONS_SLOT =
  "flex shrink-0 items-center gap-2 lg:col-start-3 lg:row-start-1 lg:justify-self-end";

/** Вторая строка шапки — базы знаний. */
export const KB_TABS_ROW = "flex justify-center border-t px-3 py-2 lg:px-4";

/**
 * Была ли вторая строка у последней шапки: болванка страницы (ShellSkeleton
 * kb, без хуков) рисует её так же — шапка не прыгает при переходе.
 */
export const kbTabsRowMemory = { shown: false };
