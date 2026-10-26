import * as React from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Крестик «очистить» внутри поля: поиск, комбобокс с выбранным значением.
 * Круглый, как все кнопки. mousedown не уводит фокус из поля — список под
 * ним не схлопывается раньше клика.
 */
export function InputClearButton({
  onClear,
  label = "Очистить",
  className,
  children,
}: {
  onClear: () => void;
  label?: string;
  className?: string;
  /** Вместо крестика — например, спиннер, пока идёт поиск. */
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
      className={cn(
        "absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        className,
      )}
    >
      {children ?? <X />}
    </button>
  );
}

/** Значок лупы в поле поиска — то же место во всех полях. */
export function SearchIcon() {
  return (
    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
  );
}

/**
 * Поле поиска: лупа слева, крестик справа, когда есть текст; Esc стирает.
 * Одно на всю админку — в плашке фильтров (ToolbarSearch), в «Скриптах».
 * Поиск клиента в шапке собран на cmdk, но из тех же SearchIcon и
 * InputClearButton.
 */
export const SearchInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
    value: string;
    onChange: (value: string) => void;
    wrapperClassName?: string;
    /** Подсказка справа в пустом поле (клавиша «/» в «Скриптах»). */
    emptyHint?: React.ReactNode;
  }
>(({ value, onChange, wrapperClassName, emptyHint, className, onKeyDown, ...props }, ref) => (
  <div className={cn("relative", wrapperClassName)}>
    <SearchIcon />
    <Input
      ref={ref}
      inputMode="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          // Не закрываем заодно диалог/панель, где стоит поле.
          e.preventDefault();
          e.stopPropagation();
          onChange("");
        }
        onKeyDown?.(e);
      }}
      className={cn("pl-9 pr-9", className)}
      {...props}
    />
    {value ? <InputClearButton onClear={() => onChange("")} /> : emptyHint}
  </div>
));
SearchInput.displayName = "SearchInput";
