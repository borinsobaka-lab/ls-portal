import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { KeyRound } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { FitbaseCityBoard } from "@/components/analytics/fitbase/mycity-board";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbMyCityBodySkeleton,
  AnalyticsFbMyCityPageSkeleton,
} from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mskToday } from "@/lib/analytics/core";
import { fbMyCityQuery } from "@/lib/analytics/fitbase/data";
import { fbMyCityPayload } from "@/lib/analytics/fitbase/mycity";
import { fbDefaultPeriod } from "@/lib/analytics/fitbase/reports";
import { AN_TITLES } from "@/lib/analytics/labels";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ALL = "__all__";
const CITY_FIELD_ID = "fb-mycity-city";

type MyCitySearch = { from?: string; to?: string; city?: string; studio?: string };

export const Route = createFileRoute("/_authenticated/analytics/fitbase/mycity")({
  head: () => ({ meta: [{ title: "Мой город · FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): MyCitySearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
    city: typeof s.city === "string" && s.city.trim() ? s.city.slice(0, 200) : undefined,
    // Адрес, набранный руками (?studio=7), роутер читает числом.
    studio: /^\d+$/.test(String(s.studio ?? "")) ? String(s.studio) : undefined,
  }),
  pendingComponent: AnalyticsFbMyCityPageSkeleton,
  component: AnalyticsFbMyCityPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * «Аналитика» → «FitBase» → «Мой город · FitBase» — их fitbase_partner
 * (/fitbase/my-city): доска «Мой город» на фактах FitBase только назначенных
 * человеку студий (администратору аналитики — все). Период — с даты по дату
 * (по умолчанию с первого числа по сегодня, МСК), город — один из городов
 * его студий, студия — одна из студий города или все. Открытие отчёта не
 * запускает загрузку FitBase.
 */
function AnalyticsFbMyCityPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const def = fbDefaultPeriod(mskToday());
  const filters = {
    from: search.from ?? def.from,
    to: search.to ?? def.to,
    city: search.city ?? "",
    studio: search.studio ?? "",
  };
  const { data, error, isFetching } = useQuery({
    ...fbMyCityQuery(filters),
    placeholderData: keepPreviousData,
  });
  const payload = useMemo(() => (data ? fbMyCityPayload(data) : null), [data]);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const set = (patch: Partial<MyCitySearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });

  return (
    <AdminShell title={AN_TITLES.fbMyCity}>
      <div className="space-y-4">
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(filters.from), to: toDate(filters.to) }}
            placeholder="Период"
            showLabel={false}
            title="Период отчёта"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                set({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          {data && (
            <>
              <div className="w-48">
                <label htmlFor={CITY_FIELD_ID} className="sr-only">
                  Город
                </label>
                <SearchableCombobox
                  id={CITY_FIELD_ID}
                  value={data.city}
                  // Их смена города: прежняя студия сбрасывается.
                  onChange={(c) => set({ city: c, studio: undefined })}
                  options={data.cities.map((c) => ({ value: c, label: c, searchText: c }))}
                  placeholder="Выберите город"
                  searchPlaceholder="Найти город"
                  emptyText="Город не найден"
                />
              </div>
              <Select
                value={data.studio || ALL}
                onValueChange={(v) => set({ city: data.city, studio: v === ALL ? undefined : v })}
              >
                <SelectTrigger className="w-56" aria-label="Студия">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все доступные студии</SelectItem>
                  {data.options.map(([id, label]) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </TableToolbar>

        {error && !data ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !payload ? (
          <AnalyticsFbMyCityBodySkeleton />
        ) : (
          <>
            {error && <InfoNote variant="warning">{(error as Error).message}</InfoNote>}
            <FitbaseCityBoard payload={payload} pending={isFetching} />
            {data?.admin && (
              <Button variant="outline" asChild>
                <Link to="/analytics/crm/fitbase/partners">
                  <KeyRound />
                  Доступ партнёров FitBase
                </Link>
              </Button>
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}
