import { useId, type ReactNode } from "react";

import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ContentTranslationsForm } from "@/hooks/use-content-translations";
import { CONTENT_LANGS, fallbackText, type ContentLang } from "@/lib/content-i18n";
import { cn } from "@/lib/utils";

/**
 * Язык текстов для клиентского приложения в формах контента: переключатель
 * в шапке диалога (решение владельца 2026-10-12), подсказка под шапкой и
 * флаг у подписей переводимых полей. Логика — lib/content-i18n.ts и
 * hooks/use-content-translations.ts.
 */

/**
 * Флаг языка в кружке. Свои SVG, а не эмодзи: эмодзи-флагов нет на Windows.
 * Копия apps/client/src/i18n/flags.tsx (приложения независимы).
 */
export function ContentLangFlag({
  lang,
  className = "size-4",
}: {
  lang: ContentLang;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-black/10",
        className,
      )}
      aria-hidden="true"
    >
      {lang === "en" ? <FlagGB /> : lang === "ka" ? <FlagGE /> : <FlagRU />}
    </span>
  );
}

// Иконки вариантов переключателя — постоянные компоненты (не стрелки в map:
// иначе каждый рендер монтировал бы их заново).
const FlagIconRu = () => <ContentLangFlag lang="ru" />;
const FlagIconEn = () => <ContentLangFlag lang="en" />;
const FlagIconKa = () => <ContentLangFlag lang="ka" />;
const FLAG_ICONS = { ru: FlagIconRu, en: FlagIconEn, ka: FlagIconKa } as const;

/**
 * Переключатель языка текстов формы — в шапке диалога (`DialogHeader`, после
 * описания) или в шапке карточки формы на странице. Точка — на языке есть
 * хоть один перевод.
 */
export function ContentLangSwitch({
  tr,
  className,
}: {
  tr: Pick<ContentTranslationsForm, "lang" | "setLang" | "filled">;
  className?: string;
}) {
  return (
    <SegmentedControl
      aria-label="Язык текстов для клиентов"
      value={tr.lang}
      onChange={tr.setLang}
      // mt-2 — отступ от описания в DialogHeader; в строке заголовка карточки — mt-0.
      className={cn("mt-2 self-start", className)}
      options={CONTENT_LANGS.map((l) => ({
        value: l.value,
        label: l.short,
        title: l.label,
        icon: FLAG_ICONS[l.value],
        dot: l.value !== "ru" && tr.filled(l.value) ? "есть перевод" : undefined,
      }))}
    />
  );
}

/**
 * Подсказка при en/ka — первым блоком тела диалога (под шапкой): что сейчас
 * заполняется и что увидит клиент, если поле пустое. На ru ничего не рисует.
 */
export function ContentLangNote({ lang }: { lang: ContentLang }) {
  if (lang === "ru") return null;
  const onLang = CONTENT_LANGS.find((l) => l.value === lang)?.onLang;
  return (
    <InfoNote className="flex items-start gap-2">
      <ContentLangFlag lang={lang} className="mt-px size-4" />
      <span>
        Тексты для клиентов на {onLang}: поля с флагом. Остальные поля общие для всех языков.{" "}
        {fallbackText(lang)}
      </span>
    </InfoNote>
  );
}

/**
 * Подпись переводимого поля: на en/ka после текста — флаг языка, чтобы было
 * видно, какие поля сейчас правятся на нём, а какие общие.
 */
export function ContentLangLabel({ lang, children }: { lang: ContentLang; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {lang !== "ru" && <ContentLangFlag lang={lang} className="size-3.5" />}
    </span>
  );
}

function FlagGB() {
  // Union Jack 60×30, в кружке — середина (slice).
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" className="block h-full w-full">
      <clipPath id={`${id}t`}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path
        d="M0,0 L60,30 M60,0 L0,30"
        clipPath={`url(#${id}t)`}
        stroke="#C8102E"
        strokeWidth="4"
      />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}

function FlagGE() {
  // Белое поле, большой красный крест и четыре малых (болнур-кацхури — упрощённо).
  const small = (x: number, y: number) => (
    <path
      key={`${x}-${y}`}
      d={`M${x - 0.6},${y - 2} h1.2 v1.4 h1.4 v1.2 h-1.4 v1.4 h-1.2 v-1.4 h-1.4 v-1.2 h1.4 z`}
      fill="#E8112D"
    />
  );
  return (
    <svg viewBox="0 0 24 24" className="block h-full w-full">
      <rect width="24" height="24" fill="#fff" />
      <rect x="10" y="0" width="4" height="24" fill="#E8112D" />
      <rect x="0" y="10" width="24" height="4" fill="#E8112D" />
      {[small(5.5, 5.5), small(18.5, 5.5), small(5.5, 18.5), small(18.5, 18.5)]}
    </svg>
  );
}

function FlagRU() {
  return (
    <svg viewBox="0 0 24 24" className="block h-full w-full">
      <rect width="24" height="8" fill="#fff" />
      <rect y="8" width="24" height="8" fill="#0039A6" />
      <rect y="16" width="24" height="8" fill="#D52B1E" />
    </svg>
  );
}
