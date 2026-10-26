import { createFileRoute, Link } from "@tanstack/react-router";
import { Children, type ReactNode } from "react";
import { APP_BRAND } from "@/lib/terms";
import { useQuery } from "@tanstack/react-query";
import { AltArrowLeft, Copy, Share } from "@solar-icons/react";
import { toast } from "sonner";

import inviteGift from "@/assets/invite-gift.webp";
import { buttonVariants } from "@/components/ui/button";
import { GlowBlobs, PageShell } from "@/components/page-shell";
import { useAuth } from "@/hooks/use-auth";
import { useHomeStudioName } from "@/hooks/use-viewed-studio";
import { clientCardQuery } from "@/lib/client-card";
import { cn } from "@/lib/utils";
import { getTranslator, useT, type Translator } from "@/i18n";

export const Route = createFileRoute("/invite")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Пригласи подругу — {brand}", { brand: APP_BRAND }) },
        {
          name: "description",
          content: t("Приведите подругу в студию — и вы обе получите по 2 тренировки в подарок."),
        },
      ],
    };
  },
  component: InvitePage,
});

/** Сколько тренировок в подарок — и пригласившей, и подруге. */
const GIFT_TRAININGS = 2;

/** Ссылка в приглашении — страница записи студии (VITE_INVITE_URL; пусто — без ссылки). */
const INVITE_URL: string = import.meta.env.VITE_INVITE_URL ?? "";

/**
 * Текст приглашения (шаблон владельца 2026-10-12): студия, имя и фамилия
 * пригласившей — чтобы администратор точно понял, от кого подруга, — и
 * ссылка последней строкой.
 */
function inviteMessage(t: Translator, studio: string, name: string): string {
  return [
    t("Привет! 💗"),
    "",
    t("Приглашаю тебя в {studio}!", { studio }),
    "",
    name
      ? t(
          "Если при покупке абонемента скажешь, что ты от меня ({name}), нам обеим подарят по {n} тренировки 🎁",
          { name, n: GIFT_TRAININGS },
        )
      : t(
          "Если при покупке абонемента скажешь, что ты от меня, нам обеим подарят по {n} тренировки 🎁",
          { n: GIFT_TRAININGS },
        ),
    ...(INVITE_URL ? ["", INVITE_URL] : []),
  ].join("\n");
}

async function copy(text: string, t: Translator) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("Приглашение скопировано — вставьте его в чат с подругой"));
  } catch {
    toast.error(t("Не удалось скопировать приглашение"));
  }
}

/**
 * Сразу в мессенджер: откроется выбор чата с готовым текстом. Telegram
 * получает весь текст в url: с отдельными url и text он ставит ссылку перед
 * текстом, а нужно — в конце, как в системном «Поделиться».
 */
const MESSENGERS: {
  name: string;
  color: string;
  icon: ReactNode;
  href: (message: string) => string;
}[] = [
  {
    name: "WhatsApp",
    color: "#25D366",
    icon: <WhatsAppGlyph />,
    href: (m) => `https://wa.me/?text=${encodeURIComponent(m)}`,
  },
  {
    name: "Telegram",
    color: "#2AABEE",
    icon: <TelegramGlyph />,
    href: (m) => `https://t.me/share/url?url=${encodeURIComponent(m)}`,
  },
  {
    name: "Viber",
    color: "#7360F2",
    icon: <ViberGlyph />,
    href: (m) => `viber://forward?text=${encodeURIComponent(m)}`,
  },
];

/**
 * Огоньки шапки — мелкие (.blobs-small), вразброс и поверх картинки, в том
 * числе на самом подарке (решение владельца 2026-10-12: без ореола вокруг
 * подарка — иначе видно, что он в круге). Левый верхний угол огонька, %
 * шапки.
 */
const HEADER_BLOBS = [
  { top: "4%", left: "70%" },
  { top: "18%", left: "6%" },
  { top: "30%", left: "52%" },
  { top: "46%", left: "24%" },
  { top: "58%", left: "72%" },
  { top: "74%", left: "40%" },
  { top: "2%", left: "34%" },
];

/**
 * «Пригласи подругу» (пакетное приложение, решение владельца 2026-10-12):
 * открывается кнопкой-подарком на главной. Сверху — тёмная зона с огоньками
 * и иллюстрацией подарка, как на онбординге (края картинки растворяются в
 * фоне, .art-fade), ниже — белая панель с описанием акции, она прокручивается
 * поверх шапки (PageShell). Акция: подруга пришла по приглашению и оформила
 * абонемент — обе получают по 2 тренировки. Начисляет администратор студии,
 * в приложении — только описание и «Пригласить» (системное «Поделиться»).
 */
function InvitePage() {
  const t = useT();
  const { user } = useAuth();
  const studioName = useHomeStudioName();
  const { data: client } = useQuery(clientCardQuery(user?.id ?? null));
  const fullName =
    [client?.first_name?.trim(), client?.last_name?.trim()].filter(Boolean).join(" ") ||
    client?.full_name?.trim() ||
    "";

  const message = inviteMessage(t, studioName ?? "Lady Stretch", fullName);

  // Системное «Поделиться» (на телефоне — выбор мессенджера и сразу
  // человека); где его нет — копируем текст.
  const shareNative = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text: message });
        return;
      }
      await copy(message, t);
    } catch (e) {
      // Закрытое окно «Поделиться» — не ошибка.
      if (e instanceof DOMException && e.name === "AbortError") return;
      await copy(message, t);
    }
  };

  return (
    <PageShell
      header={
        <div className="relative bg-[#2A2B2F] pb-8">
          {/* Свой слой огоньков поверх картинки (фон шапки непрозрачный —
              общие огоньки каркаса здесь не видны, иначе их вдвое больше). */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1]">
            <GlowBlobs positions={HEADER_BLOBS} className="blobs-small" />
          </div>
          <div className="relative z-[2] px-4 pt-2">
            <Link
              to="/"
              className="-ml-2 inline-flex h-10 items-center gap-1 rounded-full px-2 text-sm font-medium text-white/80 transition-colors active:bg-white/10"
            >
              <AltArrowLeft className="h-5 w-5" />
              {t("Назад")}
            </Link>
          </div>
          <div className="mx-auto h-60 w-60">
            <img src={inviteGift} alt="" className="art-fade-soft h-full w-full object-contain" />
          </div>
          <div className="relative z-[2] px-4">
            <h1 className="text-3xl font-semibold leading-tight">{t("Пригласи подругу")}</h1>
            <p className="mt-1 text-sm text-white/70">
              {t("Вам и подруге — по {n} тренировки в подарок", { n: GIFT_TRAININGS })}
            </p>
          </div>
        </div>
      }
    >
      <Blocks>
        <Block>
          <p className="text-[15px] leading-relaxed text-foreground/90">
            {t(
              "Тренироваться вместе веселее. Приведите подругу в студию — и, когда она оформит абонемент, мы подарим по {n} тренировки и ей, и вам.",
              { n: GIFT_TRAININGS },
            )}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Reward label={t("тренировки вам")} />
            <Reward label={t("тренировки подруге")} />
          </div>
        </Block>

        <Block title={t("Как это работает")}>
          <ol className="space-y-4">
            <Step n={1} title={t("Пригласите подругу")}>
              {t(
                "Нажмите «Пригласить» и отправьте ей приглашение — или просто расскажите о студии.",
              )}
            </Step>
            <Step n={2} title={t("Подруга приходит в студию")}>
              {t("Пусть скажет администратору, что пришла от вас, — назовёт ваше имя.")}
            </Step>
            <Step n={3} title={t("Подарок обеим")} last>
              {t(
                "Когда подруга оформит абонемент, вам и ей начислят по {n} бесплатные тренировки.",
                { n: GIFT_TRAININGS },
              )}
            </Step>
          </ol>
        </Block>

        <Block title={t("Условия")}>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <Dot />
              {t("Подарок начисляется, когда приглашённая подруга оформит абонемент.")}
            </li>
            <li className="flex gap-2">
              <Dot />
              {t("Подруга — новая клиентка студии: раньше у нас не занималась.")}
            </li>
            <li className="flex gap-2">
              <Dot />
              {t("Тренировки добавляет администратор студии — подробности можно уточнить у него.")}
            </li>
          </ul>
          <button
            type="button"
            onClick={shareNative}
            className={cn(buttonVariants(), "mt-6 w-full")}
          >
            <Share weight="BoldDuotone" />
            {t("Пригласить подругу")}
          </button>
          <div className="mt-4 text-center text-xs text-muted-foreground">
            {t("Или отправьте сразу в мессенджер")}
          </div>
          <div className="mt-2 flex justify-center gap-4">
            {MESSENGERS.map((m) => (
              <a
                key={m.name}
                href={m.href(message)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-16 flex-col items-center gap-1 text-[11px] text-muted-foreground"
              >
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-full text-white transition active:scale-95"
                  style={{ backgroundColor: m.color }}
                >
                  {m.icon}
                </span>
                {m.name}
              </a>
            ))}
            <button
              type="button"
              onClick={() => copy(message, t)}
              className="flex w-16 flex-col items-center gap-1 text-[11px] text-muted-foreground"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-foreground transition active:scale-95">
                <Copy className="h-5 w-5" weight="BoldDuotone" />
              </span>
              {t("Скопировать")}
            </button>
          </div>
        </Block>
      </Blocks>
    </PageShell>
  );
}

/** Смысловые блоки с серыми разделителями — как на главной и в анкете. */
function Blocks({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="overflow-hidden rounded-t-3xl bg-muted">
      {items.map((child, i) => {
        const first = i === 0;
        const last = i === items.length - 1;
        return (
          <div
            key={i}
            className={`bg-background ${first ? "" : "mt-3 rounded-t-[14px]"} ${
              last ? "" : "rounded-b-[14px]"
            }`}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="px-4 pb-5 pt-5">
      {title && <h2 className="mb-4 text-xl font-semibold leading-tight">{title}</h2>}
      {children}
    </section>
  );
}

function Reward({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2">
      <span className="text-xl font-black leading-none text-primary tabular-nums">
        +{GIFT_TRAININGS}
      </span>
      <span className="text-xs font-medium leading-tight">{label}</span>
    </div>
  );
}

function Step({
  n,
  title,
  last = false,
  children,
}: {
  n: number;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3">
      {/* Линия к следующему шагу. */}
      {!last && (
        <span
          aria-hidden="true"
          className="absolute bottom-[-1rem] left-[15px] top-9 w-0.5 rounded-full bg-primary/20"
        />
      )}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 pt-1">
        <div className="font-semibold leading-tight">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

function Dot() {
  return <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />;
}

function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M12 2.2a9.7 9.7 0 0 0-8.4 14.6L2.3 21.8l5.1-1.3A9.7 9.7 0 1 0 12 2.2zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z" />
    </svg>
  );
}

function TelegramGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M20.7 3.6 2.9 10.5c-1.2.5-1.2 1.2-.2 1.5l4.6 1.4 1.7 5.3c.2.6.4.8.8.8s.6-.2.9-.5l2.2-2.1 4.6 3.4c.8.5 1.4.2 1.6-.8l2.9-13.9c.3-1.3-.4-1.9-1.3-1.5zM9.6 14.2l-.4 3.9-1.3-4.3 9.5-6-7.8 6.4z" />
    </svg>
  );
}

function ViberGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5c5.2 0 8.5 2.6 8.5 7.8s-3.3 7.8-8.5 7.8h-1.3L7.5 21v-3.4c-2.6-1.1-4-3.6-4-7.3 0-5.2 3.3-7.8 8.5-7.8z" />
      <path
        d="M9.3 7.3c.3-.3.7-.3.9 0l.9 1.2c.2.3.2.7-.1.9l-.4.4c.4 1 1.2 1.8 2.2 2.2l.4-.4c.2-.3.6-.3.9-.1l1.2.9c.3.2.3.6 0 .9l-.6.6c-.5.5-1.3.6-1.9.3a7.5 7.5 0 0 1-3.8-3.8c-.3-.6-.2-1.4.3-1.9z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
