import { useId } from "react";

import type { Locale } from "./locales";

/**
 * Флаги языков в кружке (переключатель языка). Свои SVG, а не эмодзи:
 * эмодзи-флагов нет на Windows, и рисуются они на разных телефонах по-разному.
 */
export function LocaleFlag({
  locale,
  className = "h-5 w-5",
}: {
  locale: Locale;
  className?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 ${className}`}
      aria-hidden="true"
    >
      {locale === "en" ? <FlagGB /> : locale === "ka" ? <FlagGE /> : <FlagRU />}
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
