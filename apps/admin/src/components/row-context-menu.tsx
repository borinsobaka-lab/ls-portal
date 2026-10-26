import {
  cloneElement,
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export type RowAction = {
  label: string;
  /** Иконка из lucide-react — по смыслу действия (Pencil, Trash2, Copy, …). */
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
  /** Разрушающее действие уезжает вниз за разделитель и красится destructive. */
  destructive?: boolean;
  disabled?: boolean;
};

/** Касание по этим элементам — их собственное действие, а не меню строки. */
const INTERACTIVE =
  "button, a, input, textarea, select, label, [role=switch], [role=checkbox], [role=combobox]";

/**
 * На телефоне и планшете правого клика нет, а долгое нажатие никто не
 * угадает: там меню открывается обычным касанием строки. Открываем его тем же
 * событием contextmenu в точке касания — Radix ставит меню туда же, где оно
 * появилось бы по правому клику.
 */
function openMenuOnTap(e: MouseEvent<HTMLElement>) {
  if (e.defaultPrevented) return;
  if (!window.matchMedia("(max-width: 767px), (pointer: coarse)").matches) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
  e.currentTarget.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
    }),
  );
}

/**
 * С клавиатуры меню строки открывается клавишей меню или Shift+F10 — как
 * системное контекстное меню. Тем же событием contextmenu, у левого края
 * строки: Radix ставит меню туда.
 */
function openMenuOnKey(e: KeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented || e.target !== e.currentTarget) return;
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 16,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

/**
 * Контекстное меню строки таблицы (правый клик / долгое нажатие / касание
 * на телефоне).
 *
 * Единственное место, где живут действия со строкой: колонки с кнопками в
 * конце строки нет — на узком экране до неё пришлось бы горизонтально
 * прокручивать всю таблицу.
 *
 * Раз видимых кнопок нет, строке нужен признак, что с ней вообще что-то можно
 * сделать: вешаем `cursor-pointer` — палец читается как «здесь есть действие»
 * и выглядит спокойнее системного курсора `context-menu`. Класс подмешивается
 * первым, поэтому собственный курсор строки его перебивает: twMerge оставляет
 * последний из конфликтующих.
 *
 * Строка с действиями попадает в Tab-порядок (видимое кольцо фокуса внутри
 * строки), меню — клавишей меню или Shift+F10 (`openMenuOnKey`): иначе все
 * действия со строками были доступны только мышью и касанием.
 *
 * Если действий нет, компонент отдаёт строку как есть — без курсора и без
 * меню, правый клик тогда работает как обычно в браузере.
 */
export function RowContextMenu({
  actions,
  children,
}: {
  actions: RowAction[];
  children: ReactElement<{
    className?: string;
    onClick?: (e: MouseEvent<HTMLElement>) => void;
    onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
    tabIndex?: number;
    "data-row-actions"?: string;
  }>;
}) {
  const items = actions.filter(Boolean);
  if (items.length === 0) return children;

  // У строки бывает своё действие по клику («Открыть обращение») — тогда
  // касание делает его, а меню остаётся на долгом нажатии.
  const ownClick = children.props.onClick;
  const ownKeyDown = children.props.onKeyDown;
  const row = cloneElement(children, {
    className: cn(
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      children.props.className,
    ),
    // Метка для «⋯» в углу карточки на телефоне (styles.css).
    "data-row-actions": "",
    tabIndex: children.props.tabIndex ?? 0,
    onClick: ownClick ?? openMenuOnTap,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      ownKeyDown?.(e);
      openMenuOnKey(e);
    },
  });

  const regular = items.filter((a) => !a.destructive);
  const destructive = items.filter((a) => a.destructive);

  const renderItem = (a: RowAction) => {
    const Icon = a.icon;
    return (
      <ContextMenuItem
        key={a.label}
        disabled={a.disabled}
        onSelect={a.onSelect}
        className={cn(
          "gap-2",
          a.destructive && "text-destructive focus:bg-destructive/10 focus:text-destructive",
        )}
      >
        {/*
          Иконка приглушена, как в плашке фильтров: она подсказка к пункту, а
          не второй акцент рядом с текстом. У разрушающего пункта цвет не
          трогаем — иконка наследует destructive от самого пункта.
        */}
        {Icon && <Icon className={cn("h-4 w-4", !a.destructive && "text-muted-foreground")} />}
        {a.label}
      </ContextMenuItem>
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {regular.map(renderItem)}
        {regular.length > 0 && destructive.length > 0 && <ContextMenuSeparator />}
        {destructive.map(renderItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
