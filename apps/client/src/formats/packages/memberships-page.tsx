import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AddCircle, SaleSquare, Ticket } from "@solar-icons/react";

import { PageShell } from "@/components/page-shell";
import { UnderlineTabs } from "@/components/underline-tabs";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MembershipCardsSkeleton } from "@/components/content-skeletons";
import { useAuth } from "@/hooks/use-auth";
import { useFormatStudios, useViewedStudioId } from "@/hooks/use-viewed-studio";
import { msg, useLocalize, useT, type Translator } from "@/i18n";
import { clientCardQuery, type ClientCard } from "@/lib/client-card";
import { FormattedText } from "@/lib/formatted-text";
import { cn } from "@/lib/utils";
import {
  hasActivePackage,
  packCatalogQuery,
  packMyMembershipsQuery,
  type MyMembership,
  type Pack,
} from "./queries";
import { studioWhatsAppLink, WhatsAppIcon } from "./studio-contacts";
import { isOverdue, tbilisiToday } from "./upcoming-payments";

/**
 * «Абонементы» пакетного приложения (решение владельца 2026-10-11): вкладки
 * «Абонементы» (пакеты тренировок; пробное не показывается) и «Персональные занятия»
 * (номенклатура типа personal), в порядке из админки (memberships.sort_order,
 * перетаскивание в «Номенклатурах»), описание — с разметкой. Покупки в
 * приложении пока нет — витрина, свои действующие абонементы и кнопка
 * «Оформить у администратора» (решение владельца 2026-10-13): чат WhatsApp
 * студии с готовым текстом на языке приложения — имя клиента и пакет.
 * Номенклатура — смотримой студии (переключатель на главной).
 * Клиенту с действующим пакетом тренировок под ценой пакета — зелёная
 * плашка: цена полная, продление для него дешевле (решение владельца
 * 2026-10-15; только вкладка пакетов, пробное и персональные не в счёт).
 */

const TABS = [
  { key: "packages", label: msg("Абонементы") },
  { key: "personal", label: msg("Персональные занятия") },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function durationLabel(days: number | null, t: Translator) {
  if (!days) return null;
  if (days % 30 === 0) return t.plural(days / 30, "{n} месяц|{n} месяца|{n} месяцев");
  return t.plural(days, "{n} день|{n} дня|{n} дней");
}

/** Имя клиента для сообщения администратору: «Имя Фамилия». */
function clientName(c: ClientCard | null | undefined) {
  if (!c) return null;
  const composed = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return composed || c.full_name?.trim() || null;
}

/** «12 октября 2026»; дату YYYY-MM-DD читаем как местную. */
function formatLongDate(value: string, t: Translator) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return t.date(d, { day: "numeric", month: "long", year: "numeric" });
}

export function PackagesMembershipsPage() {
  const t = useT();
  const loc = useLocalize();
  const [tab, setTab] = useState<TabKey>("packages");
  const { user, loading: authLoading } = useAuth();
  const { studioId } = useViewedStudioId();
  const { data: studios = [] } = useFormatStudios();
  const studioName = loc(studios.find((s) => s.id === studioId))?.name ?? null;
  const tabs = useMemo(() => TABS.map((x) => ({ ...x, label: t(x.label) })), [t]);

  const catalog = useQuery(packCatalogQuery());
  const mine = useQuery(packMyMembershipsQuery(user?.id ?? null));
  const card = useQuery(clientCardQuery(user?.id ?? null));
  const name = clientName(card.data);
  const renewalPrice = tab === "packages" && hasActivePackage(mine.data ?? []);

  const items = (catalog.data ?? []).filter((m) =>
    // Пробное посещение в приложении не показываем (решение владельца 2026-10-11).
    tab === "personal" ? m.kind === "personal" : (m.kind ?? "package") === "package",
  );

  return (
    // scrollKey не зависит от вкладки: иначе смена вкладки пересоздавала
    // страницу — прокрутка прыгала наверх, подчёркивание табов не перетекало.
    <PageShell
      scrollKey="memberships"
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Абонементы")}</h1>
          <p className="text-sm text-white/70">
            {studioName
              ? t("Пакеты тренировок студии «{name}»", { name: studioName })
              : t("Пакеты тренировок")}
          </p>
          {(mine.data ?? []).length > 0 && (
            <div className="mt-4 space-y-2">
              {mine.data!.map((m) => (
                <MyMembershipCard key={m.id} m={m} />
              ))}
            </div>
          )}
        </div>
      }
    >
      <UnderlineTabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        className="px-4 pt-4"
        gapClass="gap-6"
      />

      <div className="space-y-3 p-4 pb-24">
        {!user && !authLoading ? (
          <Card className="p-4 text-sm text-muted-foreground">
            {t("Войдите в аккаунт, чтобы увидеть абонементы.")}
          </Card>
        ) : catalog.isPending ? (
          <MembershipCardsSkeleton />
        ) : catalog.error ? (
          <Card className="p-4 text-sm text-destructive">
            {t("Не удалось загрузить абонементы. Обновите страницу.")}
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {tab === "personal"
              ? t("Пакетов персональных занятий пока нет")
              : t("Абонементов пока нет")}
          </Card>
        ) : (
          items.map((m) => (
            <PackCard key={m.id} m={m} clientName={name} renewalPrice={renewalPrice} />
          ))
        )}
      </div>
    </PageShell>
  );
}

/**
 * Карточка пакета (вёрстка по прайсу студии, решение владельца 2026-10-12):
 * название и тег справа (бледный / яркий — у яркого и рамка карточки),
 * описание — под названием до цены, «Что входит» (пункты из админки, без
 * них — тренировки и рассрочка),
 * тёмный блок «В подарок» (текст из админки) и срок действия внизу.
 * Подарочные персональные в «Что входит» не пишутся — их пишут в «В подарок».
 * renewalPrice — под ценой плашка «для вас продление дешевле».
 */
function PackCard({
  m: row,
  clientName,
  renewalPrice,
}: {
  m: Pack;
  clientName: string | null;
  renewalPrice: boolean;
}) {
  const t = useT();
  const loc = useLocalize();
  const m = loc(row);
  const visits = m.visits_count ?? 0;
  const personal = m.personal_count ?? 0;
  // «Что входит» задают в админке по пунктам; не задано — число тренировок
  // и рассрочка, как раньше.
  const custom = (m.benefits ?? []).map((b) => b.trim()).filter(Boolean);
  const auto = [
    m.kind === "personal"
      ? t.plural(
          personal,
          "{n} персональная тренировка|{n} персональные тренировки|{n} персональных тренировок",
        )
      : m.kind === "trial"
        ? t("Пробное посещение")
        : t.plural(visits, "{n} тренировка|{n} тренировки|{n} тренировок"),
    (m.max_payments ?? 1) > 1
      ? t("Можно оплатить частями — до {n} платежей", { n: m.max_payments ?? 1 })
      : null,
  ].filter(Boolean) as string[];
  const features = custom.length > 0 ? custom : auto;
  const tag = m.tag_text?.trim();
  const bright = !!tag && m.tag_style === "bright";
  const duration = durationLabel(m.duration_days, t);
  const message = clientName
    ? t("Здравствуйте! Я {name}, клиент студии. Хочу оформить абонемент «{membership}».", {
        name: clientName,
        membership: m.name,
      })
    : t("Здравствуйте! Хочу оформить абонемент «{membership}».", { membership: m.name });

  return (
    <Card
      className={`overflow-hidden rounded-2xl p-5 ${bright ? "border-primary ring-1 ring-primary" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-xl font-semibold leading-tight">{m.name}</h3>
        {tag && (
          <span
            className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
              bright ? "bg-primary text-primary-foreground" : "bg-primary/15 text-foreground"
            }`}
          >
            {tag}
          </span>
        )}
      </div>
      {m.description?.trim() && (
        <FormattedText
          text={m.description}
          className="mt-1.5 text-sm leading-snug text-muted-foreground"
          linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
        />
      )}
      <div className="mt-3 text-4xl font-black tracking-tight tabular-nums">
        {t.number(Number(m.price))} ₾
      </div>
      {renewalPrice && (
        <div className="mt-3 flex items-start gap-3 rounded-xl bg-emerald-50 p-3 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100">
          <SaleSquare
            className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400"
            weight="Bold"
          />
          <div className="min-w-0 text-sm leading-snug">
            <div className="font-semibold">{t("Для вас — выгоднее")}</div>
            <div className="mt-0.5 text-emerald-800 dark:text-emerald-200">
              {t(
                "Здесь указана полная стоимость. Вы уже наш клиент, поэтому продление обойдётся дешевле — подробности у администратора.",
              )}
            </div>
          </div>
        </div>
      )}
      <div className="mt-4 border-t border-border pt-4">
        <div className="text-sm font-semibold">{t("Что входит:")}</div>
        <ul className="mt-2 space-y-1.5">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm">
              <AddCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" weight="Bold" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>
      {m.gift_text?.trim() && (
        <div className="mt-4 rounded-xl bg-[#2A2B2F] p-4 text-white">
          <div className="text-xs text-white/60">{t("В подарок")}</div>
          <FormattedText
            text={m.gift_text}
            className="mt-1.5 text-sm leading-snug"
            linkClass="font-medium text-white underline decoration-primary decoration-2 underline-offset-2"
          />
        </div>
      )}
      {duration && (
        <div className="mt-4 text-sm text-muted-foreground">
          {t("Срок действия — {duration}", { duration })}
        </div>
      )}
      <a
        href={studioWhatsAppLink(message)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: "outline" }), "mt-4 w-full shadow-none")}
      >
        <WhatsAppIcon />
        {t("Оформить у администратора")}
      </a>
    </Card>
  );
}

function MyMembershipCard({ m }: { m: MyMembership }) {
  const t = useT();
  const loc = useLocalize();
  const isPersonal = m.balance_kind === "personal";
  const left = isPersonal ? (m.personal_left ?? 0) : (m.visits_left ?? 0);
  const balance = isPersonal
    ? t.plural(left, "{n} персональная|{n} персональные|{n} персональных")
    : t.plural(left, "{n} тренировка|{n} тренировки|{n} тренировок");
  const gift =
    !isPersonal && (m.personal_left ?? 0) > 0
      ? " + " + t.plural(m.personal_left!, "{n} персональная|{n} персональные|{n} персональных")
      : "";
  // Диагностики тела (2026-10-15) — тоже остаток абонемента.
  const diagnostics =
    (m.diagnostics_left ?? 0) > 0
      ? " + " + t.plural(m.diagnostics_left!, "{n} диагностика|{n} диагностики|{n} диагностик")
      : "";
  const status =
    m.status === "pending"
      ? t("Продление — начнётся, когда закончится текущий")
      : m.status === "frozen"
        ? t("Заморожен")
        : m.ends_at
          ? t("Действует до {date}", { date: formatLongDate(m.ends_at, t) })
          : t("Срок — с первого посещения");
  return (
    <Card className="flex items-center gap-3 border-0 bg-background p-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15">
        <Ticket className="h-7 w-7 text-primary" weight="BoldDuotone" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold text-foreground">
          {loc(m.memberships)?.name ?? t("Абонемент")}
        </div>
        <div className="text-sm font-medium text-foreground">
          {t("Осталось: {balance}", { balance: balance + gift + diagnostics })}
        </div>
        <div className="text-xs text-muted-foreground">{status}</div>
        {m.upcomingPayments.length > 0 && <UpcomingPayments payments={m.upcomingPayments} />}
      </div>
    </Card>
  );
}

/** Следующие платежи по графику рассрочки: дата и сумма; просроченный — красным. */
function UpcomingPayments({ payments }: { payments: MyMembership["upcomingPayments"] }) {
  const t = useT();
  const today = tbilisiToday();
  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <div className="text-xs font-medium text-muted-foreground">
        {payments.length === 1 ? t("Следующий платёж") : t("Следующие платежи")}
      </div>
      <ul className="mt-1 space-y-0.5">
        {payments.map((p, i) => {
          const overdue = isOverdue(p, today);
          return (
            <li
              key={i}
              className={`flex items-baseline justify-between gap-3 text-sm ${
                overdue ? "text-red-500" : "text-foreground"
              }`}
            >
              <span>
                {formatLongDate(p.due_date, t)}
                {overdue && <span className="text-xs"> · {t("просрочен")}</span>}
              </span>
              <span className="font-semibold tabular-nums">{t.number(p.amount)} ₾</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
