import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ChevronDown, MapPin } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsAvitoRegisterBodySkeleton,
  AnalyticsAvitoRegisterPageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { FieldHint } from "@/components/ui/field-hint";
import { InfoNote } from "@/components/ui/form-field";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { avitoRegisterQuery } from "@/lib/analytics/avito/data";
import {
  AVITO_REGISTER_TEXT,
  avitoRegisterView,
  type AvitoAccountLine,
  type AvitoCampaignLine,
  type AvitoCityBlock,
  type AvitoTone,
} from "@/lib/analytics/avito/register";
import { mskToday } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type RegisterSearch = { from?: string; to?: string };

export const Route = createFileRoute("/_authenticated/analytics/avito/register")({
  head: () => ({ meta: [{ title: "Реестр Авито — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): RegisterSearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
  }),
  pendingComponent: AnalyticsAvitoRegisterPageSkeleton,
  component: AnalyticsAvitoRegisterPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const TIPS = {
  plan: "Месячный план заявок, пропорционально дням периода, округление вверх.",
  fact: "Заявки AmoCRM с UTM Авито или источником «Авито Реклама» по дате создания сделки / план периода.",
  cpl: "Целевой CPL плана / фактический: расход Авито / заявки AmoCRM.",
};

/**
 * «Аналитика» → «Авито» → «Реестр Авито» — их avito_register_page: расход и
 * клики кампаний из Авито, заявки — сделки amoCRM (по UTM креативов, только
 * если набор UTM у одной кампании), план периода. Сначала итог города,
 * раскрывается город → кабинет → РК → группы и креативы с UTM. Право
 * «Реестр Авито»; данные — все города.
 */
function AnalyticsAvitoRegisterPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const today = mskToday();
  const from = search.from ?? `${today.slice(0, 8)}01`;
  const to = search.to ?? today;
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const { data, error, isPending, isFetching } = useQuery(avitoRegisterQuery(from, to));
  const view = data ? avitoRegisterView(data) : null;
  const shownFrom = data?.from ?? from;
  const shownTo = data?.to ?? to;

  return (
    <AdminShell title={AN_TITLES.avitoRegister}>
      <div className="space-y-4">
        <InfoNote>{AVITO_REGISTER_TEXT.lead}</InfoNote>
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(shownFrom), to: toDate(shownTo) }}
            placeholder="Период"
            showLabel={false}
            title="Период реестра"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                void navigate({ search: { from: toIso(r.from), to: toIso(r.to) } });
              } else setDraft(r);
            }}
          />
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !view ? (
          <AnalyticsAvitoRegisterBodySkeleton />
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Расход" value={view.spent} />
              <StatTile label="Клики" value={view.clicks} />
              <StatTile label="Заявки AmoCRM" value={view.leads} note={`CPL: ${view.cpl}`} />
            </div>
            <section className="rounded-lg border bg-background">
              <div
                className={cn(
                  "hidden border-b px-4 py-2 text-xs font-medium text-muted-foreground lg:grid",
                  GRID,
                )}
              >
                <span>Город</span>
                <Head tip={TIPS.plan}>План заявок</Head>
                <Head tip={TIPS.fact}>Факт / план</Head>
                <Head tip={TIPS.cpl}>Цель / факт CPL</Head>
                <span>Клики</span>
                <span>Бюджет</span>
              </div>
              {view.cities.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">{AVITO_REGISTER_TEXT.empty}</p>
              ) : (
                <ul className="divide-y">
                  {view.cities.map((c) => (
                    <CityRow key={c.key} c={c} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

const GRID =
  "lg:grid lg:grid-cols-[minmax(200px,2fr)_repeat(5,minmax(100px,1fr))] lg:items-center lg:gap-3";

function Head({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children} <FieldHint>{tip}</FieldHint>
    </span>
  );
}

const PILL: Record<AvitoTone, string> = {
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function Pill({ label, tone }: { label: string; tone: AvitoTone }) {
  return (
    <span
      className={cn(
        "mt-1 inline-block rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        PILL[tone],
      )}
    >
      {label}
    </span>
  );
}

/** Ячейка строки: на узком экране — с подписью колонки. */
function Cell({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex items-baseline justify-between gap-3 lg:block", className)}>
      <span className="text-xs text-muted-foreground lg:hidden">{label}</span>
      <span className="text-right tabular-nums lg:text-left">{children}</span>
    </span>
  );
}

const SUMMARY =
  "cursor-pointer list-none space-y-1.5 px-4 py-3 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden lg:space-y-0";

/** Их avito-city: итог города, внутри — нераспределённые заявки и кабинеты. */
function CityRow({ c }: { c: AvitoCityBlock }) {
  return (
    <li>
      <details className="group/c">
        <summary className={cn(SUMMARY, GRID)}>
          <span className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <MapPin className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <b className="block text-brand-on-light">{c.title}</b>
              <small className="text-xs text-muted-foreground">{c.cabinets}</small>
            </span>
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open/c:rotate-180 lg:hidden" />
          </span>
          <Cell label="План заявок" className="text-base font-semibold">
            {c.plan}
          </Cell>
          <Cell label="Факт / план">
            {c.fact ? (
              <>
                <b className="block">{c.fact.text}</b>
                <Pill {...c.fact.pill} />
              </>
            ) : (
              "—"
            )}
          </Cell>
          <Cell label="Цель / факт CPL">
            {c.cpl ? (
              <>
                <b className="block whitespace-nowrap">{c.cpl.text}</b>
                <Pill {...c.cpl.pill} />
              </>
            ) : (
              "—"
            )}
          </Cell>
          <Cell label="Клики">{c.clicks}</Cell>
          <Cell label="Бюджет">
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              {c.spent}
              <ChevronDown className="hidden size-4 text-muted-foreground transition-transform group-open/c:rotate-180 lg:block" />
            </span>
          </Cell>
        </summary>
        <div className="space-y-2 bg-muted/30 px-4 py-3 lg:pl-12">
          {c.unmatched > 0 && (
            <div className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
              <p className="text-muted-foreground">{AVITO_REGISTER_TEXT.unmatched(c.unmatched)}</p>
              {c.sourceLeads.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium text-brand-on-light">
                    {AVITO_REGISTER_TEXT.showUtms(c.sourceLeads.length)}
                  </summary>
                  <Table className="mt-2 text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID сделки Amo</TableHead>
                        <TableHead>utm_source</TableHead>
                        <TableHead>utm_medium</TableHead>
                        <TableHead>utm_campaign</TableHead>
                        <TableHead>utm_content</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.sourceLeads.map((l) => (
                        <TableRow key={l.amo_lead_id}>
                          <TableCell>{l.amo_lead_id}</TableCell>
                          <TableCell>{l.utm_source || "—"}</TableCell>
                          <TableCell>{l.utm_medium || "—"}</TableCell>
                          <TableCell>{l.utm_campaign || "—"}</TableCell>
                          <TableCell>{l.utm_content || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              )}
            </div>
          )}
          {c.accounts.map((a) => (
            <AccountRow key={a.id} a={a} />
          ))}
        </div>
      </details>
    </li>
  );
}

/** Их avito-account: кабинет, число РК, клики, расход; внутри — РК. */
function AccountRow({ a }: { a: AvitoAccountLine }) {
  return (
    <details className="group/a rounded-md border bg-background">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <b className="min-w-0 flex-1 text-brand-on-light">{a.name}</b>
        <span className="tabular-nums">{a.campaigns.length} РК</span>
        <span className="tabular-nums">{a.clicks} кликов</span>
        <span className="tabular-nums whitespace-nowrap">{a.spent}</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open/a:rotate-180" />
      </summary>
      <div className="divide-y border-t">
        {a.campaigns.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Нет загруженной статистики РК.</p>
        ) : (
          a.campaigns.map((c) => <CampaignRow key={c.key} c={c} />)
        )}
      </div>
    </details>
  );
}

/** Их avito-campaign: заявки, CPL, клики, расход; внутри — группы и креативы с UTM. */
function CampaignRow({ c }: { c: AvitoCampaignLine }) {
  return (
    <details className="group/k">
      <summary className={cn(SUMMARY, GRID, "py-2.5 text-xs")}>
        <b className="flex items-center gap-2 text-brand-on-light">
          {c.name}
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/k:rotate-180" />
        </b>
        <Cell label="План заявок">—</Cell>
        <Cell label="Заявки">{c.leads}</Cell>
        <Cell label="CPL">{c.cpl}</Cell>
        <Cell label="Клики">{c.clicks}</Cell>
        <Cell label="Бюджет">
          <span className="whitespace-nowrap">{c.spent}</span>
        </Cell>
      </summary>
      <div className="px-3 pb-3">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Группа / креатив</TableHead>
              <TableHead>utm_campaign</TableHead>
              <TableHead>utm_content</TableHead>
              <TableHead className="text-right">Заявки</TableHead>
              <TableHead className="text-right">Квалиф.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  {AVITO_REGISTER_TEXT.noStructure}
                </TableCell>
              </TableRow>
            ) : (
              c.groups.flatMap((g, gi) => [
                <TableRow key={`g${gi}`} className="bg-muted/40">
                  <TableCell className="font-medium text-muted-foreground">▸ {g.name}</TableCell>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    {AVITO_REGISTER_TEXT.group}
                  </TableCell>
                </TableRow>,
                ...(g.creatives.length === 0
                  ? [
                      <TableRow key={`e${gi}`}>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          {AVITO_REGISTER_TEXT.noCreatives}
                        </TableCell>
                      </TableRow>,
                    ]
                  : g.creatives.map((cr, ci) => (
                      <TableRow key={`c${gi}-${ci}`}>
                        <TableCell>↳ {cr.name}</TableCell>
                        <TableCell>{cr.utmCampaign}</TableCell>
                        <TableCell>{cr.utmContent}</TableCell>
                        <TableCell className="text-right tabular-nums">{cr.leads}</TableCell>
                        <TableCell className="text-right tabular-nums">{cr.qualified}</TableCell>
                      </TableRow>
                    ))),
              ])
            )}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}
