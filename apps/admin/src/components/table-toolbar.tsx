import { Children, Fragment, isValidElement, useState, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";

// Единая плашка поиска и фильтров над таблицей — один вид во всех разделах.
// Правила (см. .interface-design/system.md):
//  - одна строка, на узком экране фильтры переносятся (flex-wrap); поиск
//    тянется, фильтры фиксированной ширины, никаких лейблов над контролами;
//  - высоту контролов НЕ задаём на месте: она одна на всю админку и приходит
//    из Input / SelectTrigger / Button (см. .interface-design/system.md);
//  - плашка стоит первой в контейнере страницы, сразу над таблицей;
//  - фильтры в шапку AdminShell не выносим (слот filters удалён);
//  - на телефоне (до sm) поиск — на всю ширину, фильтры — по два в строку
//    (правило .table-toolbar в styles.css: фиксированные w-40/w-48 там не
//    помещались парой и вставали по одному в неровную колонку).
//  - на телефоне при поиске и двух и больше фильтрах фильтры прячутся за
//    кнопку «Фильтры» рядом с поиском (точка на ней — фильтр применён):
//    в «Абонементах» восемь фильтров занимали весь первый экран.
export function TableToolbar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children);
  const isSearch = (c: ReactNode) => isValidElement(c) && c.type === ToolbarSearch;
  const collapsible = items.some(isSearch) && items.filter((c) => !isSearch(c)).length >= 2;
  const applied = items.some(
    (c) => isValidElement<{ active?: boolean }>(c) && c.type === ToolbarReset && !!c.props.active,
  );
  return (
    <div
      className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3"
      data-collapsible={collapsible ? "" : undefined}
      data-open={open ? "" : undefined}
    >
      {items.map((c) =>
        isSearch(c) && collapsible ? (
          <Fragment key="search">
            {c}
            <Button
              variant={open ? "default" : "outline"}
              size="icon"
              className="toolbar-filters-toggle relative sm:hidden"
              aria-label={applied ? "Фильтры (применены)" : "Фильтры"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <SlidersHorizontal />
              {applied && (
                <span
                  aria-hidden
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive ring-2 ring-background"
                />
              )}
            </Button>
          </Fragment>
        ) : (
          c
        ),
      )}
    </div>
  );
}

export function ToolbarSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <SearchInput
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={placeholder}
      wrapperClassName="toolbar-search w-full max-w-96"
    />
  );
}

/**
 * «Сбросить» фильтры — одна на все плашки: светло-красная с красным крестиком,
 * видна только когда есть что сбрасывать (раньше в одном разделе показывалась
 * всегда, в другом — только при фильтре, в третьем была маленькой). Цветная —
 * чтобы применённый фильтр было видно сразу (решение владельца 2026-10-13;
 * светло-красная вместо оранжевой — 2026-10-15).
 */
export function ToolbarReset({ active, onReset }: { active: boolean; onReset: () => void }) {
  if (!active) return null;
  return (
    <Button variant="attention" onClick={onReset}>
      <X />
      Сбросить
    </Button>
  );
}
