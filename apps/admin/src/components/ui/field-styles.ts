/**
 * Внешний вид поля — один на всю админку: Input, SelectTrigger,
 * SearchableCombobox, DateRangeFilter, выбор страны в телефоне, поиск в
 * шапке. Поле — прямоугольник (rounded-md) высотой 40px; кнопки, наоборот,
 * «пилюли» (button.tsx) — по форме видно, что заполняется, а что нажимается.
 *
 * Заливка одна везде — шапка, плашка фильтров, диалог (`bg-field`, токен
 * `--field` в styles.css); в фокусе поле белеет. Новый контрол, который
 * выглядит как поле (триггер выбора, фильтр), берёт `fieldTriggerClass` —
 * своей заливки не задаёт. Ошибка (`error` у FormField → aria-invalid) —
 * красная рамка.
 */
export const fieldClass =
  "h-10 w-full rounded-md border border-input bg-field px-3 text-base transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/** Поле-кнопка: открывает список, календарь, выбор страны. Шеврон — справа. */
export const fieldTriggerClass = `${fieldClass} flex cursor-pointer items-center justify-between gap-2 whitespace-nowrap text-left`;
