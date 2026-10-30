import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, FileText, Info, MapPin, MessageCircle } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { AnalyticsVkRegisterPageSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { TableToolbar } from "@/components/table-toolbar";
import { FieldHint } from "@/components/ui/field-hint";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mskToday } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { VK_BRANDS, vkRegisterQuery } from "@/lib/analytics/vk/data";
import {
  registerPeriod,
  registerView,
  type RegisterCity,
  type RegisterSummary,
} from "@/lib/analytics/vk/register";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ALL = "__all__";

type RegisterSearch = { from?: string; to?: string; brand?: string; t?: string };

export const Route = createFileRoute("/_authenticated/analytics/vk/register")({
  head: () => ({ meta: [{ title: "Реестр таргета — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): RegisterSearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
    brand:
      typeof s.brand === "string" && (VK_BRANDS as readonly string[]).includes(s.brand)
        ? s.brand
        : undefined,
    t: typeof s.t === "string" && s.t ? s.t : undefined,
  }),
  pendingComponent: AnalyticsVkRegisterPageSkeleton,
  component: AnalyticsVkRegisterPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Их подсказки «?» у колонок и у дней без бюджета. */
const TIPS = {
  plan: "План периода по остатку месячного плана / с учётом простоя. Остаток распределяется на оставшиеся дни месяца, округление вверх.",
  cpl: "Общий расход VK / общие заявки VK.",
  qualification: "Квалифицированные / все лиды VK из AmoCRM, ЛФ + СС.",
  zero: "Простой всех активных кабинетов, включая дни без истории при отсутствии трат и положительного остатка.",
  outage:
    "Дневной бюджет = исходный месячный план заявок × целевой CPL / календарные дни месяца. Если утренний и вечерний остатки выше полного дневного плана, бюджет был независимо от расхода. Расход от 50% дневного плана также означает наличие бюджета. При меньшем расходе день считается без бюджета, если остаток утром ниже 50% плана либо остаток вечером выше дневного плана. Остатки — первый и последний снимки по МСК, суммарно по активным кабинетам города и направления. Кабинет включается в расчёт в день добавления по первому доступному снимку. Без плана или истории применяется прежнее правило. Текущий день не учитывается.",
};

/**
 * «Аналитика» → «VK Ads» → «Реестр таргета» — их target_register_page: итоги
 * периода по бренду и городу (общий расход VK с НДС, заявки ЛФ и СС, план
 * периода по остатку месячного плана, дни без бюджета), сгруппированные по
 * таргетологам; «Не назначен» — свёрнут в конце. Администратору аналитики —
 * выбор таргетолога, таргетологу — только его города, сотруднику с правом
 * «Реестр таргета» — все.
 */
function AnalyticsVkRegisterPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { from, to } = registerPeriod(search.from, search.to, mskToday());
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const { data, error, isPending, isFetching } = useQuery(
    vkRegisterQuery({ from, to, targetologist: search.t ?? "", brand: search.brand ?? "" }),
  );
  const view = data ? registerView(data) : null;
  const go = (patch: Partial<RegisterSearch>) =>
    void navigate({ search: (s: RegisterSearch) => ({ ...s, ...patch }) });

  return (
    <AdminShell title={AN_TITLES.vkRegister}>
      <div className="space-y-4">
        <InfoNote>
          План заявок общий для VK: ЛФ и СС в нём не делятся. План периода учитывает остаток
          месячного плана после уже полученных заявок и оставшиеся дни месяца. Для будущих дат
          учитывается факт по сегодня, для прошедших — до начала периода. При выполненном месячном
          плане остаток равен нулю. Целевой CPL не меняется. Плановый бюджет — план заявок периода,
          округлённый вверх, × целевой CPL.
        </InfoNote>
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период отчёта"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                go({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          <Select
            value={search.brand ?? ALL}
            onValueChange={(v) => go({ brand: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Направление">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все направления</SelectItem>
              {VK_BRANDS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data?.admin && (
            <Select
              value={search.t && data.people.includes(search.t) ? search.t : ALL}
              onValueChange={(v) => go({ t: v === ALL ? undefined : v })}
            >
              <SelectTrigger className="w-56" aria-label="Таргетолог">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все таргетологи</SelectItem>
                {data.people.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </TableToolbar>

        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !view ? (
          <RegisterBodySkeleton />
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <div className="grid gap-3 md:grid-cols-3">
              {view.summary.map((s) => (
                <SummaryCard key={s.kind} s={s} />
              ))}
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">{view.scope}</h2>
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                <CalendarDays className="size-4" aria-hidden />
                {view.period}
              </span>
            </div>
            {view.groups.length === 0 ? (
              <section className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
                За выбранный период нет данных по назначенным городам.
              </section>
            ) : (
              view.groups.map((g) =>
                g.unassigned ? (
                  <details key={g.name} className="group/u rounded-lg border bg-background">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      <h3 className="font-semibold">{g.name}</h3>
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        Городов: <b className="text-foreground">{g.cities.length}</b>
                        <ChevronDown className="size-4 transition-transform group-open/u:rotate-180" />
                      </span>
                    </summary>
                    <CityList cities={g.cities} />
                  </details>
                ) : (
                  <section key={g.name} className="rounded-lg border bg-background">
                    <header className="flex items-center justify-between gap-2 px-4 py-3">
                      <h3 className="font-semibold">{g.name}</h3>
                      <span className="text-sm text-muted-foreground">
                        Городов: <b className="text-foreground">{g.cities.length}</b>
                      </span>
                    </header>
                    <CityList cities={g.cities} />
                  </section>
                ),
              )
            )}
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="size-4 shrink-0" aria-hidden />
              Основная строка — общие показатели VK. Детали по ЛФ и СС раскрываются по клику.
            </p>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

const SUMMARY_ICON: Record<RegisterSummary["kind"], ReactNode> = {
  forms: <FileText className="size-5" aria-hidden />,
  messages: <MessageCircle className="size-5" aria-hidden />,
  total: <span className="text-xs font-bold">VK</span>,
};

/** Их плашка сети: заявки, цена заявки, потраченный бюджет. */
function SummaryCard({ s }: { s: RegisterSummary }) {
  return (
    <section
      className={cn(
        "rounded-lg border bg-background p-4",
        s.kind === "total" && "border-brand/40 bg-brand/5",
      )}
    >
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-brand/10 text-brand-on-light">
          {SUMMARY_ICON[s.kind]}
        </span>
        <div>
          <h3 className="font-semibold">{s.title}</h3>
          {s.subtitle && <p className="text-xs text-muted-foreground">{s.subtitle}</p>}
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Заявки</dt>
          <dd className="text-lg font-semibold tabular-nums">{s.applications}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {s.kind === "total" ? "Средняя цена заявки" : "Цена заявки"}
          </dt>
          <dd className="text-lg font-semibold whitespace-nowrap tabular-nums">{s.price}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Потраченный бюджет</dt>
          <dd className="text-lg font-semibold whitespace-nowrap tabular-nums">{s.spent}</dd>
        </div>
      </dl>
    </section>
  );
}

const GRID =
  "lg:grid lg:grid-cols-[minmax(170px,1.5fr)_minmax(90px,0.8fr)_minmax(120px,1fr)_minmax(130px,1fr)_minmax(100px,0.9fr)_minmax(80px,0.7fr)_minmax(90px,0.7fr)_minmax(80px,0.7fr)_minmax(140px,1fr)] lg:items-center lg:gap-3";

/** Заголовок списка городов — их vk-list-head с подсказками. */
function CityList({ cities }: { cities: RegisterCity[] }) {
  return (
    <div className="border-t">
      <div
        className={cn("hidden px-4 py-2 text-xs font-medium text-muted-foreground lg:grid", GRID)}
      >
        <span>Город</span>
        <span>
          <span className="inline-flex items-center gap-1">
            План VK <FieldHint>{TIPS.plan}</FieldHint>
          </span>
          <small className="block font-normal">/ с учётом простоя</small>
        </span>
        <span>Факт / план</span>
        <span>
          <span className="inline-flex items-center gap-1">
            CPL <FieldHint>{TIPS.cpl}</FieldHint>
          </span>
          <small className="block font-normal">цель / факт</small>
        </span>
        <span>Общий расход VK</span>
        <span>Общие заявки VK</span>
        <span className="flex items-center gap-1">
          Квалификация VK <FieldHint>{TIPS.qualification}</FieldHint>
        </span>
        <span className="flex items-center gap-1">
          Дни без бюджета <FieldHint>{TIPS.zero}</FieldHint>
        </span>
        <span>Статус</span>
      </div>
      <ul className="divide-y">
        {cities.map((c) => (
          <CityRow key={c.key} c={c} />
        ))}
      </ul>
    </div>
  );
}

const STATUS_TONE: Record<RegisterCity["status"]["tone"], string> = {
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  neutral: "bg-muted text-muted-foreground",
};

/** Подпись значения на узком экране (их data-label). */
function Cell({
  label,
  children,
  className,
  title,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn("flex items-baseline justify-between gap-3 lg:block", className)}
      title={title}
    >
      <span className="text-xs text-muted-foreground lg:hidden">{label}</span>
      <span className="text-right tabular-nums lg:text-left">{children}</span>
    </span>
  );
}

function CityRow({ c }: { c: RegisterCity }) {
  const width = Math.min(100, Math.max(0, c.progress));
  return (
    <li>
      <details className="group/c">
        <summary
          className={cn(
            "cursor-pointer list-none space-y-1.5 px-4 py-3 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden lg:space-y-0",
            GRID,
          )}
        >
          <span className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <MapPin className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <b className="block truncate">{c.cityLabel}</b>
              <small className="text-xs text-muted-foreground">
                {c.brand} · {c.accounts} каб.
              </small>
            </span>
          </span>
          <Cell label="План VK / с учётом простоя">
            <strong>{c.ordinary}</strong> / {c.adjusted}
          </Cell>
          <Cell label="Факт / план">
            <span className="block">
              {c.applications} / {c.ordinary}
            </span>
            <span
              className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Выполнение исходного плана"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(width)}
            >
              <i
                className="block h-full rounded-full bg-brand"
                style={{ width: `${width.toFixed(2)}%` }}
              />
            </span>
            <small className="text-xs text-muted-foreground">{c.percentage}</small>
          </Cell>
          <Cell label="CPL цель / факт">
            {c.targetCpl} /{" "}
            <b
              className={cn(
                c.cplTone === "good" && "text-emerald-700 dark:text-emerald-400",
                c.cplTone === "high" && "text-red-600 dark:text-red-400",
              )}
            >
              {c.actualCpl}
            </b>
          </Cell>
          <Cell label="Общий расход VK">{c.total}</Cell>
          <Cell label="Общие заявки VK">{c.applications}</Cell>
          <Cell label="Квалификация VK" title={c.qualificationTitle}>
            {c.qualification}
          </Cell>
          <Cell label="Дни без бюджета" title={TIPS.outage}>
            {c.zeroDays}
          </Cell>
          <span className="flex items-center justify-between gap-2 pt-1 lg:pt-0">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap",
                STATUS_TONE[c.status.tone],
              )}
            >
              <i className="size-1.5 rounded-full bg-current" aria-hidden />
              {c.status.label}
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open/c:rotate-180" />
          </span>
        </summary>
        <div className="space-y-3 bg-muted/30 px-4 py-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Panel icon={<FileText className="size-4" aria-hidden />} title="Лид-формы">
              <Metric label="Расход ЛФ" value={c.leadForms.spent} />
              <Metric label="Заявки ЛФ" value={c.leadForms.applications} />
              <Metric label="Цена ЛФ" value={c.leadForms.price} />
            </Panel>
            <Panel
              icon={<MessageCircle className="size-4" aria-hidden />}
              title="Сообщения сообщества"
            >
              <Metric label="Расход СС" value={c.messages.spent} />
              <Metric label="Лиды СС" value={c.messages.leads} />
              <Metric label="Заявки СС" value={c.messages.applications} />
              <Metric label="Конверсия СС" value={c.messages.conversion} />
              <Metric label="Цена СС" value={c.messages.price} />
            </Panel>
            <Panel
              icon={<span className="text-[10px] font-bold">VK</span>}
              title="Общие показатели"
            >
              <Metric label="Общая цена заявки" value={c.actualCpl} />
              <Metric label="Квалификация VK" value={c.qualification} />
              <Metric label="Дни без бюджета" value={c.zeroDays} />
            </Panel>
          </div>
          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>
              Плановый бюджет: <b className="tabular-nums">{c.planBudget}</b>
            </span>
            {c.assumedDays > 0 && (
              <small className="text-xs text-muted-foreground">
                Без истории: {c.assumedDays} дн.
              </small>
            )}
            {c.volume && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  c.volume.tone === "good" ? STATUS_TONE.good : STATUS_TONE.warning,
                )}
              >
                {c.volume.label}
              </span>
            )}
          </footer>
        </div>
      </details>
    </li>
  );
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border bg-background p-3">
      <header className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-brand/10 text-brand-on-light">
          {icon}
        </span>
        {title}
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">{children}</dl>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium whitespace-nowrap tabular-nums">{value}</dd>
    </div>
  );
}

function RegisterBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
