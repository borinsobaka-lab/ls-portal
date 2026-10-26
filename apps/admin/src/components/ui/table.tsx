import * as React from "react";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { FieldHint } from "@/components/ui/field-hint";
import type { SortDir } from "@/lib/table-sort";
import { cn } from "@/lib/utils";

/**
 * Подписи колонок для карточного вида на телефоне. На узком экране таблица
 * перестраивается в стопку карточек (styles.css, `table[data-mobile-cards]`):
 * шапка прячется, а каждая ячейка показывает подпись своей колонки из
 * `data-label`. Подписи ставим здесь, по DOM, а не пропом в каждой из сотни
 * ячеек: так их получают все таблицы админки сразу, и новая колонка не
 * может остаться без подписи. React эти атрибуты не трогает — он не знает
 * о них, — поэтому следим за изменениями строк MutationObserver-ом.
 */
function labelCells(table: HTMLTableElement) {
  const heads = table.tHead?.rows[0]?.cells;
  if (!heads) return;
  const labels: string[] = [];
  for (const th of Array.from(heads)) {
    const text = th.textContent?.trim() ?? "";
    for (let i = 0; i < th.colSpan; i++) labels.push(text);
  }
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        // Ячейка на всю строку — «Ничего не найдено», заглушка загрузки.
        const full = cell.colSpan >= labels.length && labels.length > 1;
        const label = full ? "" : (labels[col] ?? "");
        if (cell.dataset.label !== label) cell.dataset.label = label;
        if (full) cell.dataset.full = "";
        else delete cell.dataset.full;
        col += cell.colSpan;
      }
    }
  }
}

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & {
    /**
     * Карточки вместо строк на телефоне (по умолчанию). false — оставить
     * таблицу с горизонтальной прокруткой: для сеток, где важно сравнение по
     * колонкам.
     */
    mobileCards?: boolean;
  }
>(({ className, mobileCards = true, ...props }, ref) => {
  const innerRef = React.useRef<HTMLTableElement>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTableElement);

  React.useEffect(() => {
    const table = innerRef.current;
    if (!mobileCards || !table) return;
    labelCells(table);
    const observer = new MutationObserver(() => labelCells(table));
    observer.observe(table, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [mobileCards]);

  // Колонки, ушедшие за край: прокрутка вбок есть, но без подсказки её не
  // видно — у края, за которым ещё есть колонки, лежит мягкая тень.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const update = () => {
      const left = box.scrollLeft > 1;
      const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(box);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => {
      box.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative w-full">
      <div ref={scrollRef} className="w-full overflow-auto">
        <table
          ref={innerRef}
          data-mobile-cards={mobileCards ? "" : undefined}
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
      <div
        aria-hidden
        className={cn(
          "table-edge-shadow pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-foreground/[0.12] to-transparent transition-opacity duration-150",
          edges.left ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "table-edge-shadow pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-foreground/[0.12] to-transparent transition-opacity duration-150",
          edges.right ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
});
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  // Светло-серая заливка шапки: отделяет заголовки от строк с контентом.
  // Скругляем верхние углы, чтобы заливка не выходила за рамку обёртки таблицы.
  <thead
    ref={ref}
    className={cn(
      "bg-background [&_tr]:border-b [&>tr:first-child>th:first-child]:rounded-tl-lg [&>tr:first-child>th:last-child]:rounded-tr-lg",
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-background font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

/**
 * tip — подсказка «?» у заголовка колонки, тот же текст, что у поля формы
 * (FormField tip). Значок без текста, поэтому подпись колонки для карточек
 * на телефоне (labelCells, textContent) он не портит.
 *
 * onSort — колонка сортируется по клику на подпись (hooks/use-table-sort.ts:
 * `{...sort.head("key")}`); sortDir — текущее направление, null — по этой
 * колонке не сортируется. Стрелки — тоже без текста.
 */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & {
    tip?: React.ReactNode;
    sortDir?: SortDir | null;
    onSort?: () => void;
  }
>(({ className, tip, sortDir, onSort, children, ...props }, ref) => {
  const SortIcon = sortDir === "asc" ? ArrowUp : sortDir === "desc" ? ArrowDown : ArrowUpDown;
  const label = onSort ? (
    <button
      type="button"
      onClick={onSort}
      className={cn(
        "group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        sortDir && "text-foreground",
      )}
    >
      {children}
      {/* Бледные ↑↓ у каждой колонки рябили в шапке: у неактивной колонки
          они видны, только когда мышь над шапкой (место под них занято
          всегда — подписи не прыгают). */}
      <SortIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          !sortDir &&
            "opacity-0 transition-opacity [thead:hover_&]:opacity-30 group-hover/sort:opacity-70 group-focus-visible/sort:opacity-70",
        )}
      />
    </button>
  ) : (
    children
  );
  return (
    <th
      ref={ref}
      aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : undefined}
      className={cn(
        "h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    >
      {tip || onSort ? (
        <span className="inline-flex items-center gap-1">
          {label}
          {tip && <FieldHint>{tip}</FieldHint>}
        </span>
      ) : (
        children
      )}
    </th>
  );
});
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "p-2 align-middle tabular-nums [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
