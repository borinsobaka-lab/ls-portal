import { useState } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { AltArrowDown, CheckCircle } from "@solar-icons/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, LocaleFlag, type Locale, useI18n } from "@/i18n";

/**
 * Переключатель языка на входе: компактная плашка «флаг в кружке +
 * название» справа от логотипа (решение владельца 2026-10-12), по нажатию —
 * выпадающий список. tone: "dark" — на тёмной шапке с огоньками, "light" —
 * на светлом фоне. В профиле — строка «Язык» и шторка LanguageSheet.
 */
export function LanguageSwitcher({
  tone = "dark",
  className = "",
}: {
  tone?: "dark" | "light";
  className?: string;
}) {
  const { locale, setLocale, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

  const choose = async (code: Locale) => {
    if (code === locale || busy) return;
    setBusy(true);
    try {
      await setLocale(code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("Язык")}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pl-1 pr-2 text-xs font-medium outline-none transition-colors ${
          tone === "dark"
            ? "bg-white/10 text-white active:bg-white/20"
            : "bg-muted text-foreground active:bg-muted/70"
        } ${busy ? "opacity-60" : ""} ${className}`}
      >
        <LocaleFlag locale={current.code} className="h-5 w-5" />
        <span>{current.name}</span>
        <AltArrowDown className="h-3 w-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[11rem] rounded-2xl p-1.5">
        {LOCALES.map((l) => (
          <DropdownMenuItem
            key={l.code}
            onSelect={() => void choose(l.code)}
            className="gap-3 rounded-xl px-2.5 py-2 text-[15px]"
          >
            <LocaleFlag locale={l.code} className="h-6 w-6" />
            <span className="flex-1">{l.name}</span>
            {l.code === locale && <CheckCircle className="h-5 w-5 text-primary" weight="Bold" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Шторка со списком языков — из строки «Язык» в профиле (решение владельца
 * 2026-10-12: строка как остальные кнопки профиля, выбор — по нажатию).
 */
export function LanguageSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { locale, setLocale, t } = useI18n();
  const [busy, setBusy] = useState(false);

  const choose = async (code: Locale) => {
    if (busy) return;
    if (code !== locale) {
      setBusy(true);
      try {
        await setLocale(code);
      } finally {
        setBusy(false);
      }
    }
    onOpenChange(false);
  };

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-1 mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3">
            <DrawerPrimitive.Title className="text-xl font-semibold">
              {t("Язык")}
            </DrawerPrimitive.Title>
            <ul className="mt-4 space-y-2">
              {LOCALES.map((l) => {
                const active = l.code === locale;
                return (
                  <li key={l.code}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void choose(l.code)}
                      className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${
                        active ? "border-primary bg-primary/5" : "border-border bg-card"
                      }`}
                    >
                      <LocaleFlag locale={l.code} className="h-7 w-7" />
                      <span className="min-w-0 flex-1 font-semibold">{l.name}</span>
                      {active && (
                        <CheckCircle className="h-6 w-6 shrink-0 text-primary" weight="Bold" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
