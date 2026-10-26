import { useEffect, useMemo, useState } from "react";
import { Copy, DownloadMinimalistic, Refresh } from "@solar-icons/react";
import { Check } from "lucide-react";

import packagesLogo from "@/assets/packages-logo.svg";
import androidChromeMenuRu from "@/assets/install/android-chrome-menu-ru.webp";
import chromeIcon from "@/assets/install/chrome-icon.webp";
import iosHomeScreenEn from "@/assets/install/ios-home-screen-en.webp";
import iosHomeScreenRu from "@/assets/install/ios-home-screen-ru.webp";
import iosShareButton from "@/assets/install/ios-share-button.webp";
import iosShareMoreEn from "@/assets/install/ios-share-more-en.webp";
import iosShareMoreRu from "@/assets/install/ios-share-more-ru.webp";
import safariIcon from "@/assets/install/safari-icon.webp";
import { LanguageSwitcher } from "@/components/language-switcher";
import { UnderlineTabs } from "@/components/underline-tabs";
import { Button } from "@/components/ui/button";
import { DarkFrame } from "@/formats/packages/dark-frame";
import { useInstallPrompt } from "@/hooks/use-pwa-install";
import { msg, useI18n, useT } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import {
  detectIosGuide,
  detectPlatform,
  isAndroidChrome,
  splitStepText,
  type InstallPlatform,
  type IosGuide,
} from "@/lib/pwa-install";
import { IS_PACKAGES } from "@/lib/terms";

/**
 * Инструкция по установке приложения на телефон — вместо приложения, пока
 * оно открыто во вкладке браузера (решение владельца 2026-10-15: без
 * установки приложение не открывается; заслон — InstallGate в __root.tsx).
 *
 * iPhone — две вкладки: iOS 26+ («Поделиться» спрятан под три точки) и
 * ранние версии; первой открывается та, что подходит по версии Safari
 * (lib/pwa-install.ts). Android — одна инструкция для Chrome, а в самом
 * Chrome, если он разрешает установку в одно нажатие, — ещё и кнопка
 * «Установить приложение» (в других браузерах её нет: работает не везде).
 * Компьютер — переключатель iPhone / Android: ссылку открывают на телефоне.
 *
 * Тексты шагов — от владельца; названия кнопок телефона — в кавычках, на
 * экране они жирные, названия браузеров — жирные со значком. Скриншоты —
 * src/assets/install/ (≈720×364 от владельца): у русского свои, у
 * английского и грузинского — английские (грузинского интерфейса у iOS нет).
 */
type Screenshot = { ru: string; en?: string };

type Step = {
  text: string;
  /** Подсказка мелким шрифтом под шагом. */
  hint?: string;
  image?: Screenshot;
  /** Под шагом — адрес приложения и кнопка «Скопировать ссылку». */
  copyLink?: boolean;
};

const SCREENSHOT_SIZE = { width: 720, height: 364 };

const IOS_SHARE_BUTTON: Screenshot = { ru: iosShareButton, en: iosShareButton };
const IOS_SHARE_MORE: Screenshot = { ru: iosShareMoreRu, en: iosShareMoreEn };
const IOS_HOME_SCREEN: Screenshot = { ru: iosHomeScreenRu, en: iosHomeScreenEn };
// Без надписей — один на все языки.
const ANDROID_CHROME_MENU: Screenshot = { ru: androidChromeMenuRu, en: androidChromeMenuRu };

const BROWSER_ICONS: Record<string, string> = { Safari: safariIcon, Chrome: chromeIcon };

const IOS26_STEPS: Step[] = [
  { text: msg("Откройте эту ссылку в браузере Safari"), copyLink: true },
  {
    text: msg("Нажмите на три точки справа внизу — «Поделиться» — «Показать больше»"),
    image: IOS_SHARE_MORE,
  },
  {
    text: msg(
      "Выберите «На экран „Домой“», включите опцию «Открыть как веб-приложение» и нажмите «Добавить»",
    ),
    image: IOS_HOME_SCREEN,
  },
];

const IOS_LEGACY_STEPS: Step[] = [
  { text: msg("Откройте эту ссылку в браузере Safari"), copyLink: true },
  { text: msg("Перейдите на сайт и нажмите на иконку «Поделиться»"), image: IOS_SHARE_BUTTON },
  { text: msg("Выберите пункт «На экран „Домой“» и нажмите «Добавить»"), image: IOS_HOME_SCREEN },
];

const ANDROID_STEPS: Step[] = [
  { text: msg("Откройте эту ссылку в браузере Chrome"), copyLink: true },
  {
    text: msg("Перейдите на сайт и нажмите на три точки в правом верхнем углу Chrome"),
    image: ANDROID_CHROME_MENU,
  },
  {
    text: msg("Выберите «Добавить на главный экран»"),
    hint: msg(
      "Иногда пункт называется «Установить приложение» или «Установить и создать ярлык». Если появится выбор — нажмите «Установить».",
    ),
  },
];

export function InstallScreen() {
  const t = useT();
  const title = t("Установите приложение");
  const subtitle = t(
    "Приложение открывается только после установки на телефон. Это займёт минуту.",
  );
  const note = (
    <p className="text-center text-sm text-muted-foreground">
      {t("Уже установили? Откройте приложение с главного экрана телефона.")}
    </p>
  );

  // Пакетное — в оформлении входа (тёмная шапка с огоньками, белая панель).
  if (IS_PACKAGES) {
    return (
      <DarkFrame
        top={
          <div className="mx-6 mt-4 flex items-center justify-between gap-3">
            <img src={packagesLogo} alt={t("Логотип студии")} className="h-auto w-[150px]" />
            <LanguageSwitcher />
          </div>
        }
        header={
          <div className="px-6 pt-5 pb-7">
            <h1 className="text-3xl font-semibold leading-tight">{title}</h1>
            <p className="mt-2 text-sm text-white/70">{subtitle}</p>
          </div>
        }
        footer={null}
      >
        <InstallGuide />
        <div className="px-6 pb-2">{note}</div>
      </DarkFrame>
    );
  }

  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--primary) 28%, transparent), color-mix(in srgb, var(--primary) 8%, transparent) 55%, transparent 75%)",
        }}
      />
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-md flex-col pt-16 pb-[max(env(safe-area-inset-bottom),2rem)]">
        <LanguageSwitcher tone="light" className="absolute right-4 top-4" />
        <div className="mb-8 text-center text-2xl font-black tracking-widest">
          Base<span className="text-primary">40</span>
        </div>
        <div className="px-6 text-center">
          <h1 className="text-3xl font-semibold leading-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="mt-4">
          <InstallGuide />
        </div>
        <div className="mt-auto px-6 pt-4">{note}</div>
      </div>
    </div>
  );
}

function InstallGuide() {
  const t = useT();
  // Экран рисуется только в браузере (после гидратации) — navigator есть.
  const detected = useMemo(() => {
    const ua = navigator.userAgent;
    return {
      platform: detectPlatform(ua, navigator.maxTouchPoints),
      iosGuide: detectIosGuide(ua),
      oneTapInstall: isAndroidChrome(ua),
    };
  }, []);
  const [platform, setPlatform] = useState<Exclude<InstallPlatform, "other">>(
    detected.platform === "android" ? "android" : "ios",
  );
  const [iosGuide, setIosGuide] = useState<IosGuide>(detected.iosGuide);

  const platformTabs = useMemo(
    () => [
      { key: "ios" as const, label: "iPhone" },
      { key: "android" as const, label: "Android" },
    ],
    [],
  );
  const iosTabs = useMemo(
    () => [
      { key: "ios26" as const, label: "iOS 26+" },
      { key: "legacy" as const, label: t("Ранние версии") },
    ],
    [t],
  );

  const steps =
    platform === "android" ? ANDROID_STEPS : iosGuide === "ios26" ? IOS26_STEPS : IOS_LEGACY_STEPS;

  return (
    <div className="px-4 pt-4 pb-4">
      {detected.platform === "other" && (
        <>
          <p className="px-1 text-sm text-muted-foreground">
            {t(
              "Приложение работает на телефоне: откройте эту ссылку на iPhone или Android и установите его по инструкции.",
            )}
          </p>
          <UnderlineTabs
            tabs={platformTabs}
            value={platform}
            onChange={setPlatform}
            className="mt-2 px-1"
          />
        </>
      )}
      {platform === "ios" && (
        <UnderlineTabs tabs={iosTabs} value={iosGuide} onChange={setIosGuide} className="px-1" />
      )}

      {platform === "android" && detected.oneTapInstall && <OneTapInstall />}

      <ol className="mt-6 space-y-6">
        {steps.map((step, i) => (
          <StepItem key={step.text} n={i + 1} step={step} last={i === steps.length - 1} />
        ))}
      </ol>

      {platform === "android" ? (
        <Finish
          title={t("Готово!")}
          text={t(
            "Мобильное приложение установлено. Иконка приложения создана на вашем главном экране.",
          )}
          className="mt-6"
        />
      ) : (
        <Finish
          text={t("Значок приложения появится на домашнем экране — откройте приложение с него.")}
          className="mt-6"
        />
      )}
    </div>
  );
}

function StepItem({ n, step, last }: { n: number; step: Step; last: boolean }) {
  const { t, locale } = useI18n();
  return (
    <li className="relative flex gap-3">
      {/* Линия от кружка к кружку следующего шага (зазор 4px с обеих сторон;
          между шагами space-y-6 = 24px). */}
      {!last && (
        <span
          aria-hidden="true"
          className="absolute top-8 -bottom-5 left-[13px] w-0.5 rounded-full bg-primary/40"
        />
      )}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-base leading-snug">
          <StepText text={t(step.text)} />
        </p>
        {step.hint && (
          <p className="mt-1.5 text-sm leading-snug text-muted-foreground">
            <StepText text={t(step.hint)} />
          </p>
        )}
        {step.copyLink && <CopyLink />}
        {step.image && (
          <img
            src={locale === "ru" ? step.image.ru : (step.image.en ?? step.image.ru)}
            alt=""
            {...SCREENSHOT_SIZE}
            loading="lazy"
            decoding="async"
            className="mt-3 h-auto w-full rounded-2xl ring-1 ring-black/10"
          />
        )}
      </div>
    </li>
  );
}

/** Названия кнопок телефона («Поделиться», “Share”) — жирным, браузер — со значком. */
function StepText({ text }: { text: string }) {
  return (
    <>
      {splitStepText(text).map((part, i) =>
        part.kind === "browser" ? (
          <span key={i} className="whitespace-nowrap font-semibold">
            <img
              src={BROWSER_ICONS[part.text]}
              alt=""
              width={20}
              height={20}
              className="mr-1 inline-block h-5 w-5 align-[-0.3em]"
            />
            {part.text}
          </span>
        ) : part.kind === "quoted" ? (
          <span key={i} className="font-semibold">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * Установка в одно нажатие (только Chrome на Android, hooks/use-pwa-install.ts):
 * кнопка → окно Chrome → крутилка, пока Chrome ставит приложение
 * (INSTALL_SECONDS) → «Готово».
 */
function OneTapInstall() {
  const t = useT();
  const prompt = useInstallPrompt();

  if (prompt.phase === "installed") {
    return (
      <Finish
        title={t("Готово!")}
        text={t("Приложение установлено — откройте его с главного экрана телефона.")}
        className="mt-4"
        // Зелёный «готово» после жёлтой крутилки (решение владельца 2026-10-15).
        iconClassName="bg-emerald-500 text-white"
      />
    );
  }
  if (prompt.phase === "installing") {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-2xl bg-muted p-4">
        {/* Жёлтая, пока Chrome ставит приложение (решение владельца 2026-10-15). */}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-yellow-950">
          <Refresh className="h-4 w-4 animate-spin" weight="Bold" />
        </span>
        <p className="text-sm font-medium leading-snug">
          {t("Приложение будет установлено в течение 10 секунд")}
        </p>
      </div>
    );
  }
  // Кнопка с подсказкой — на своей плашке, чтобы не сливаться с шагами.
  if (prompt.phase === "prompting" || prompt.canInstall) {
    return (
      <div className="mt-2 rounded-2xl bg-muted p-4">
        <Button
          type="button"
          onClick={() => void prompt.install()}
          disabled={prompt.phase === "prompting"}
          className="w-full"
        >
          {prompt.phase === "prompting" ? (
            <Refresh className="animate-spin" weight="BoldDuotone" />
          ) : (
            <DownloadMinimalistic />
          )}
          {t("Установить приложение")}
        </Button>
        <p className="mt-3 text-center text-sm text-muted-foreground">
          {prompt.phase === "failed"
            ? t("Не удалось открыть установку — установите приложение по шагам ниже")
            : t("Или установите вручную по шагам ниже")}
        </p>
      </div>
    );
  }
  if (prompt.phase === "failed") {
    return (
      <p className="mt-2 rounded-2xl bg-muted p-4 text-center text-sm text-muted-foreground">
        {t("Не удалось открыть установку — установите приложение по шагам ниже")}
      </p>
    );
  }
  return null;
}

function Finish({
  title,
  text,
  className = "",
  iconClassName = "bg-primary text-primary-foreground",
}: {
  title?: string;
  text: string;
  className?: string;
  /** Цвет кружка с галочкой (по умолчанию — фирменный). */
  iconClassName?: string;
}) {
  return (
    <div className={`flex gap-3 rounded-2xl bg-muted p-4 ${className}`}>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${iconClassName}`}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {title && <p className="text-base font-semibold">{title}</p>}
        <p className={title ? "mt-0.5 text-sm text-muted-foreground" : "text-sm leading-snug"}>
          {text}
        </p>
      </div>
    </div>
  );
}

/**
 * Адрес приложения и кнопка «Скопировать ссылку»: клиент часто открывает
 * ссылку во встроенном браузере мессенджера или Instagram, а установить
 * приложение можно только из Safari (iPhone) или Chrome (Android).
 */
function CopyLink() {
  const t = useT();
  const url = `${window.location.origin}/`;
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const id = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(id);
  }, [state]);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex min-h-12 select-all items-center break-all rounded-2xl bg-field px-4 py-2 text-base font-medium">
        {window.location.host}
      </div>
      <Button
        type="button"
        onClick={async () => setState((await copyText(url)) ? "copied" : "failed")}
        className="w-full"
      >
        {state === "copied" ? <Check strokeWidth={3} /> : <Copy />}
        {state === "copied" ? t("Ссылка скопирована") : t("Скопировать ссылку")}
      </Button>
      {state === "failed" && (
        <p className="text-sm text-destructive">
          {t("Не удалось скопировать — выделите ссылку и скопируйте её вручную")}
        </p>
      )}
    </div>
  );
}
