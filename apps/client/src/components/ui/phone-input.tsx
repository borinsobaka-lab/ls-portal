import * as React from "react";
import { Global } from "@solar-icons/react";

import { cn } from "@/lib/utils";
import { LocaleFlag, useT } from "@/i18n";
import {
  DIAL_CODES,
  applyCodeInput,
  applyNationalInput,
  formatNational,
  formatPhone,
  maskFor,
  maskRemainder,
  nationalMaxLength,
  parsePhone,
  type PhoneParts,
} from "@/lib/phone";

/**
 * Поле телефона (решение владельца 2026-10-13): слева флаг и код страны
 * (по умолчанию Грузия, +995 — код можно стереть и ввести другой), справа
 * номер. У грузинского номера маска «___ __ __ __»: недостающие цифры видны
 * серыми подчёркиваниями. Значение для формы — одна строка «+995 555 12 34 56»
 * (логика — lib/phone.ts, проверка — isValidPhone).
 *
 * Для автозаполнения телефона: tel-country-code + tel-national; если система
 * подставит номер целиком в поле номера, код возьмётся из него.
 */
export function PhoneInput({
  value,
  onChange,
  id,
  label,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  /** Подпись внутри поля (как у полей с плавающей подписью — всегда поднята). */
  label?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const t = useT();
  const [parts, setParts] = React.useState<PhoneParts>(() => parsePhone(value));

  // Значение пришло снаружи (карточка догрузилась) — разобрать заново. Своё
  // эхо не трогаем: иначе стёртый для замены код вернулся бы обратно.
  React.useEffect(() => {
    if (value !== formatPhone(parts)) setParts(parsePhone(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сверяем только при смене value
  }, [value]);

  const commit = (next: PhoneParts) => {
    setParts(next);
    onChange(formatPhone(next));
  };

  const country = DIAL_CODES[parts.code];
  const masked = !!maskFor(parts.code);
  const nationalText = formatNational(parts.code, parts.national);

  return (
    <div
      className={cn(
        "relative h-14 w-full rounded-2xl bg-field text-base text-foreground transition-colors focus-within:bg-field-focus",
        className,
      )}
    >
      {label && (
        <span className="pointer-events-none absolute left-4 top-1.5 text-[11px] text-muted-foreground">
          {label}
        </span>
      )}
      <div className={cn("flex h-full items-center", label && "pt-4")}>
        <label className="flex h-full shrink-0 cursor-text items-center gap-2 pl-4 pr-2">
          <CountryFlag country={country} />
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel-country-code"
            aria-label={t("Код страны")}
            value={`+${parts.code}`}
            onChange={(e) => {
              const code = applyCodeInput(e.target.value);
              commit({ code, national: parts.national.slice(0, nationalMaxLength(code)) });
            }}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: `${parts.code.length + 1.6}ch` }}
            className="h-full min-w-[2.6ch] bg-transparent tabular-nums outline-none"
          />
        </label>
        <span aria-hidden="true" className="h-6 w-px shrink-0 bg-foreground/10" />
        <div className="relative h-full min-w-0 flex-1">
          {/* Маска: набранное (невидимо, для отступа) + сколько цифр осталось. */}
          {masked && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center whitespace-pre tabular-nums"
            >
              <span className="invisible">{nationalText}</span>
              <span className="text-field-placeholder">
                {maskRemainder(parts.code, parts.national)}
              </span>
            </span>
          )}
          <input
            id={id}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            aria-label={ariaLabel ?? label ?? t("Номер телефона")}
            value={nationalText}
            onChange={(e) => commit(applyNationalInput(parts.code, e.target.value))}
            placeholder={masked ? undefined : t("Номер телефона")}
            className="h-full w-full scroll-my-6 bg-transparent pl-3 pr-4 tabular-nums outline-none placeholder:text-field-placeholder"
          />
        </div>
      </div>
    </div>
  );
}

/** Флаг кода: свои SVG для Грузии, России, Британии; остальные — эмодзи. */
function CountryFlag({ country }: { country: string | undefined }) {
  if (country === "GE") return <LocaleFlag locale="ka" className="h-5 w-5" />;
  if (country === "RU") return <LocaleFlag locale="ru" className="h-5 w-5" />;
  if (country === "GB") return <LocaleFlag locale="en" className="h-5 w-5" />;
  if (country) {
    const emoji = String.fromCodePoint(...[...country].map((c) => 0x1f1a5 + c.charCodeAt(0)));
    return (
      <span aria-hidden="true" className="w-5 text-center text-lg leading-none">
        {emoji}
      </span>
    );
  }
  return <Global className="h-5 w-5 text-muted-foreground" weight="BoldDuotone" />;
}
