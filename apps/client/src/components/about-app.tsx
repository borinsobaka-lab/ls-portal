import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AltArrowRight, Smartphone } from "@solar-icons/react";
import { toast } from "sonner";

import borinLogo from "@/assets/borin-logo.webp";

import { Button } from "@/components/ui/button";
import { BottomDrawer } from "@/components/bottom-drawer";
import { useAuth } from "@/hooks/use-auth";
import { useClientStudio } from "@/hooks/use-studios";
import { LOCALES, msg, useI18n, useLocalize, useT } from "@/i18n";
import { APP_VERSION } from "@/lib/app-version";
import { copyText } from "@/lib/clipboard";
import {
  readPushDevice,
  readPushPermission,
  type PushDevice,
  type PushPermission,
} from "@/lib/push";
import { detectPlatform, isInstalledDisplay } from "@/lib/pwa-install";
import { IS_PACKAGES } from "@/lib/terms";

/**
 * «О приложении» в профиле (решение владельца 2026-10-15): по нажатию строки
 * снизу выдвигается шторка (как у новостей и тренировок) — плашка
 * разработчика, технические данные для разбора проблем клиента и закреплённая
 * внизу «Скопировать техническую информацию» (клиент отправляет текст
 * администратору в мессенджер). Копируется то же, что на экране, на языке
 * приложения. Без ID учётной записи, карточки и студии, адреса и сборки
 * (решение владельца 2026-10-15). Новое поле — строкой в useTechRows ниже
 * (подпись — msg()).
 */

const APP_NAME = IS_PACKAGES ? "Lady Stretch" : "Base40";

type TechRow = { label: string; value: string };

const PUSH_PERMISSION_LABEL: Record<PushPermission, string> = {
  granted: msg("Разрешены"),
  denied: msg("Запрещены"),
  default: msg("Ещё не спрашивали"),
  unsupported: msg("Не поддерживаются"),
};

const PUSH_DEVICE_LABEL: Record<PushDevice, string> = {
  subscribed: msg("Подписано"),
  "not-subscribed": msg("Не подписано"),
  "no-worker": msg("Нет service worker"),
  unsupported: msg("Не поддерживается"),
};

export function AboutAppRow() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-4 py-4 text-left"
      >
        <span className="text-muted-foreground">
          <Smartphone className="h-5 w-5" weight="BoldDuotone" />
        </span>
        <span className="flex-1 min-w-0 block text-sm font-medium">{t("О приложении")}</span>
        <span className="text-sm text-muted-foreground">
          {t("Версия {version}", { version: APP_VERSION })}
        </span>
        <AltArrowRight className="h-4 w-4 text-muted-foreground" weight="BoldDuotone" />
      </button>
      {/* Содержимое монтируется в открытой шторке: данные устройства — только в браузере. */}
      <BottomDrawer
        open={open}
        onOpenChange={setOpen}
        title={t("О приложении")}
        footer={<CopyTechInfoButton />}
      >
        <AboutAppDetails />
      </BottomDrawer>
    </li>
  );
}

/**
 * Строки технической информации. Её показывают AboutAppDetails и копирует
 * кнопка внизу шторки — обе монтируются вместе при открытии, подписка на
 * пуши читается одним запросом.
 */
function useTechRows(): TechRow[] {
  const t = useT();
  const loc = useLocalize();
  const { locale } = useI18n();
  const { user } = useAuth();
  const studio = useClientStudio();
  const { data: pushDevice } = useQuery({
    queryKey: ["about-app-push-device"],
    queryFn: readPushDevice,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
  });
  // Снимок на момент открытия: время и сеть — те, что были при проблеме.
  const [now] = useState(() => new Date());

  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const languageName = LOCALES.find((l) => l.code === locale)?.name ?? locale;
  const dash = "—";

  return [
    { label: t("Версия"), value: APP_VERSION },
    { label: t("Почта"), value: user?.email ?? dash },
    { label: IS_PACKAGES ? t("Студия") : t("Клуб"), value: studio ? loc(studio).name : dash },
    { label: t("Язык приложения"), value: `${languageName} (${locale})` },
    { label: t("Язык устройства"), value: navigator.language || dash },
    {
      label: t("Устройство"),
      value: platform === "ios" ? "iOS" : platform === "android" ? "Android" : t("Другое"),
    },
    {
      label: t("Запуск"),
      value: isInstalledDisplay() ? t("Установленное приложение") : t("Вкладка браузера"),
    },
    { label: t("Уведомления"), value: t(PUSH_PERMISSION_LABEL[readPushPermission()]) },
    {
      label: t("Подписка на уведомления"),
      value: pushDevice ? t(PUSH_DEVICE_LABEL[pushDevice]) : "…",
    },
    {
      label: t("Экран"),
      value: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x, ${t("окно")} ${window.innerWidth}×${window.innerHeight}`,
    },
    {
      label: t("Часовой пояс"),
      value: Intl.DateTimeFormat().resolvedOptions().timeZone || dash,
    },
    { label: t("Сеть"), value: navigator.onLine ? t("В сети") : t("Нет сети") },
    { label: t("Время"), value: now.toISOString() },
    { label: t("Браузер"), value: navigator.userAgent },
  ];
}

function AboutAppDetails() {
  const t = useT();
  const rows = useTechRows();

  return (
    <div className="space-y-4">
      {/* Плашка разработчика (решение владельца 2026-10-16) — одна на обе сборки. */}
      <div className="rounded-2xl bg-muted p-4 space-y-3">
        <img
          src={borinLogo}
          alt="borin"
          width={402}
          height={140}
          className="h-9 w-auto rounded-lg"
        />
        <p className="text-sm leading-relaxed">
          {t("Мобильное приложение сделано с любовью в Грузии.")}
          <br />
          {t("Разработчик: {developer}.", { developer: "borin digital team" })}
        </p>
        <a
          href="https://vaborin.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm font-medium text-primary underline underline-offset-4"
        >
          {t("Перейти на сайт разработчика")}
        </a>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("Техническая информация")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Если что-то работает не так, скопируйте эти данные и отправьте администратору — так мы быстрее разберёмся.",
          )}
        </p>
        <dl className="rounded-2xl bg-muted px-3 py-2 text-xs select-text divide-y divide-border">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-3 py-1.5">
              <dt className="w-[40%] shrink-0 text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 flex-1 break-all font-mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** «Скопировать техническую информацию» — закреплена внизу шторки, без иконки. */
function CopyTechInfoButton() {
  const t = useT();
  const rows = useTechRows();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = [
      `${APP_NAME} — ${t("техническая информация")}`,
      ...rows.map((row) => `${row.label}: ${row.value}`),
    ].join("\n");
    if (await copyText(text)) {
      setCopied(true);
      toast.success(t("Техническая информация скопирована"));
    } else {
      toast.error(t("Не удалось скопировать — выделите текст и скопируйте его вручную"));
    }
  };

  return (
    <Button variant="outline" className="w-full shadow-none" onClick={() => void handleCopy()}>
      {copied ? t("Скопировано") : t("Скопировать техническую информацию")}
    </Button>
  );
}
