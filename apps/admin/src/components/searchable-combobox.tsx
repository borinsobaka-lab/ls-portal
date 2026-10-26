import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { InputClearButton } from "@/components/ui/search-input";
import { useFieldAria, useFieldId } from "@/components/ui/field-context";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ComboOption = { value: string; label: string; hint?: string; searchText: string };

/**
 * Выбор из списка с поиском (клиент, абонемент, позиция каталога).
 * Собран на Command + Popover: клавиатура, фокус и позиционирование — из
 * примитивов, а не руками. Раньше компонент был скопирован в «Продажи» и
 * «Прочие продажи» — теперь один на оба раздела.
 *
 * По умолчанию фильтрует переданные options сам. С `onSearchChange` поиск
 * серверный: строка поиска уходит наверх, options — уже найденное.
 */
export function SearchableCombobox({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  onSearchChange,
  selectedLabel,
  onClear,
  disabled,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  onSearchChange?: (search: string) => void;
  /** Подпись выбранного, если его нет в текущих options (серверный поиск). */
  selectedLabel?: string;
  /** Если задан — у выбранного значения появляется крестик «очистить». */
  onClear?: () => void;
  disabled?: boolean;
  id?: string;
}) {
  const fieldId = useFieldId(id);
  const aria = useFieldAria(fieldId);
  const [open, setOpenState] = useState(false);
  // Поле поиска при закрытии очищается (Command размонтируется) — и строку
  // серверного поиска сбрасываем вместе с ним.
  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) onSearchChange?.("");
  };
  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? (value ? selectedLabel : undefined);
  return (
    // modal: комбобокс стоит в диалогах, а диалог глушит прокрутку колесом за
    // своими пределами — без modal длинный список не листался.
    <Popover open={open} onOpenChange={setOpen} modal>
      {/*
        Триггер выглядит как SelectTrigger (те же отступы, шеврон, без ховера):
        в одной форме комбобокс и обычный выбор стоят рядом. Крестик
        «очистить» — соседняя кнопка поверх триггера, а не внутри него:
        кнопка в кнопке — невалидная разметка.
      */}
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            type="button"
            id={fieldId}
            {...aria}
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            data-field=""
            className={cn(fieldTriggerClass, onClear && value && "pr-16")}
          >
            <span className={cn("truncate", !label && "text-muted-foreground")}>
              {label ?? placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        {onClear && value && !disabled && (
          <InputClearButton onClear={onClear} className="right-8" />
        )}
      </div>
      {/* w-(--…) — синтаксис Tailwind 4; w-[--…] из v3 компилировался в
          невалидный CSS, и список был шириной по содержимому. */}
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command
          shouldFilter={!onSearchChange}
          filter={(itemValue, search) => {
            const opt = options.find((o) => o.value === itemValue);
            if (!opt) return 0;
            return opt.searchText.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={searchPlaceholder} onValueChange={onSearchChange} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={(v) => {
                    onChange(v);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === o.value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
