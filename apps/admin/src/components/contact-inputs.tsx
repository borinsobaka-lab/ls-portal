import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  checkPhone,
  countryFlag,
  countryName,
  emailError,
  emailSuggestion,
  normalizeEmail,
  phoneCountries,
  phoneCountryOf,
  phoneForEditing,
  type CountryCode,
} from "@/lib/contacts";
import { cn } from "@/lib/utils";
import { fieldTriggerClass } from "@/components/ui/field-styles";

export type PhoneValue = { value: string; country: CountryCode };

/**
 * Телефон клиента: страна (флаг и код) + номер. Код страны администратору
 * знать не нужно: по умолчанию — Грузия; иностранный номер — выбрать страну
 * по названию или ввести номер целиком с «+», страна определится сама.
 * Ошибка показывается после ухода из поля или попытки сохранить (`showError`).
 * Проверка и номер для базы — `checkPhone` (lib/contacts.ts).
 */
export function PhoneInput({
  value,
  onChange,
  showError,
}: {
  value: PhoneValue;
  onChange: (v: PhoneValue) => void;
  showError?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const check = checkPhone(value.value, value.country);

  const setNumber = (raw: string) => {
    // Набирают с «+» — флаг у поля сразу показывает страну из номера.
    const detected = phoneCountryOf(raw);
    onChange({ value: raw, country: detected ?? value.country });
  };

  // Верный номер после ухода из поля — в национальный вид у своей страны:
  // «+79161234567» → 🇷🇺 «8 (916) 123-45-67».
  const tidy = () => {
    setTouched(true);
    if (check.status === "valid") onChange(phoneForEditing(check.e164));
  };

  const visibleError = (touched || showError) && check.status === "invalid";

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <CountryPicker
          value={value.country}
          onChange={(country) => onChange({ value: value.value, country })}
        />
        <Input
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={value.value}
          onChange={(e) => setNumber(e.target.value)}
          onBlur={tidy}
          placeholder={value.country === "GE" ? "555 12 34 56" : "Номер телефона"}
          aria-invalid={visibleError || undefined}
          className={cn(visibleError && "border-destructive focus-visible:ring-destructive")}
        />
      </div>
      {check.status === "valid" ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          {check.country ? `${countryName(check.country)} · ` : ""}
          <span className="tabular-nums">{check.display}</span>
        </p>
      ) : visibleError ? (
        <div className="space-y-1 text-xs">
          <p className="text-destructive">{check.error}</p>
          {check.suggestion ? (
            <button
              type="button"
              className="cursor-pointer text-left text-foreground underline underline-offset-2 hover:text-link-hover"
              onClick={() => onChange(phoneForEditing(check.suggestion!.e164))}
            >
              Это номер {check.suggestion.country ? countryName(check.suggestion.country) : ""}{" "}
              {check.suggestion.display}? Исправить
            </button>
          ) : (
            <p className="text-muted-foreground">
              Иностранный номер — выберите страну слева или введите его целиком с «+».
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CountryPicker({
  value,
  onChange,
}: {
  value: CountryCode;
  onChange: (c: CountryCode) => void;
}) {
  const [open, setOpen] = useState(false);
  const countries = useMemo(() => phoneCountries(), []);
  const current = countries.find((c) => c.code === value);
  const top = countries.filter((c) => c.top);
  const rest = countries.filter((c) => !c.top);

  const item = (c: (typeof countries)[number]) => (
    <CommandItem
      key={c.code}
      // Поиск — по названию, коду страны и коду набора.
      value={`${c.name} ${c.code} ${c.dial}`}
      onSelect={() => {
        onChange(c.code);
        setOpen(false);
      }}
    >
      <Check className={cn("h-4 w-4", value === c.code ? "opacity-100" : "opacity-0")} />
      <span className="text-base leading-none">{countryFlag(c.code)}</span>
      <span className="flex-1 truncate">{c.name}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{c.dial}</span>
    </CommandItem>
  );

  return (
    // modal: список открыт поверх диалога карточки, а диалог глушит прокрутку
    // колесом за своими пределами — без modal список стран не листался.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Страна: ${current?.name ?? value}`}
          title={current?.name}
          data-field=""
          className={cn(fieldTriggerClass, "w-auto shrink-0 gap-1.5 px-2.5 tabular-nums")}
        >
          <span className="text-base leading-none">{countryFlag(value)}</span>
          <span>{current?.dial}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Страна или код" />
          <CommandList>
            <CommandEmpty>Страна не найдена</CommandEmpty>
            <CommandGroup>{top.map(item)}</CommandGroup>
            <CommandSeparator />
            <CommandGroup>{rest.map(item)}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Email клиента: пробелы и заглавные убираются сами, адрес проверяется,
 * частая опечатка в домене (gmial.com, mail.ry) — кнопкой «Исправить».
 * Ошибка — после ухода из поля или попытки сохранить (`showError`).
 */
export function EmailInput({
  value,
  onChange,
  showError,
}: {
  value: string;
  onChange: (v: string) => void;
  showError?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const error = emailError(value);
  const suggestion = error ? null : emailSuggestion(value);
  const visibleError = (touched || showError) && !!error;

  return (
    <div className="space-y-1.5">
      <Input
        type="email"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(normalizeEmail(e.target.value))}
        onBlur={() => setTouched(true)}
        placeholder="name@gmail.com"
        aria-invalid={visibleError || undefined}
        className={cn(visibleError && "border-destructive focus-visible:ring-destructive")}
      />
      {visibleError && <p className="text-xs text-destructive">{error}</p>}
      {suggestion && (
        <button
          type="button"
          className="cursor-pointer text-left text-xs text-foreground underline underline-offset-2 hover:text-link-hover"
          onClick={() => onChange(suggestion)}
        >
          Возможно, {suggestion}? Исправить
        </button>
      )}
    </div>
  );
}
