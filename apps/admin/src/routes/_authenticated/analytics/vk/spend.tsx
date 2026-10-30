import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsVkSpendPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { formatMsk, mskToday } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { vkSpendQuery } from "@/lib/analytics/vk/data";
import { vkNumber, vkSpendCells, vkSpendTotals, type VkSpendRow } from "@/lib/analytics/vk/view";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const Route = createFileRoute("/_authenticated/analytics/vk/spend")({
  head: () => ({ meta: [{ title: "Расходы по кабинетам — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): { date?: string } => ({
    date: typeof s.date === "string" && ISO.test(s.date) ? s.date : undefined,
  }),
  pendingComponent: AnalyticsVkSpendPageSkeleton,
  component: AnalyticsVkSpendPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Их дата по умолчанию — вчера по Москве. */
function mskYesterday(): string {
  const d = toDate(mskToday());
  d.setDate(d.getDate() - 1);
  return toIso(d);
}

/**
 * «Аналитика» → «VK Ads» → «Расходы по кабинетам» (администратору
 * аналитики) — их vk_ads_spend_page: расход каждого кабинета за выбранный
 * день с НДС; ЛФ — кампании, прямо связанные с лид-формой (связь отдаёт
 * VK), СС — остаток: весь расход минус ЛФ.
 */
function AnalyticsVkSpendPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const date = search.date ?? mskYesterday();
  const { data, error, isPending, isFetching } = useQuery(vkSpendQuery(date));
  const sort = useTableSort<VkSpendRow>({ spent: (r) => vkSpendCells(r).sortValue });
  const rows = sort.apply(data ?? []);
  const totals = vkSpendTotals(data ?? []);

  return (
    <AdminShell title={AN_TITLES.vkSpend}>
      <div className="space-y-4">
        <InfoNote>
          Расход ЛФ определяется по прямой связке лид-формы и кампании, которую возвращает VK.
          Расход СС — это остаток: весь расход кабинета минус расход ЛФ.
        </InfoNote>
        <TableToolbar>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Дата расходов</span>
            <Input
              type="date"
              className="w-44"
              value={date}
              max={mskToday()}
              required
              onChange={(e) => {
                if (ISO.test(e.target.value)) void navigate({ search: { date: e.target.value } });
              }}
            />
          </label>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            <div
              className={cn(
                "grid gap-3 sm:grid-cols-2 lg:grid-cols-4",
                isFetching && !isPending && "opacity-60 transition-opacity",
              )}
            >
              <StatTile
                label={`Всего за ${ruDate(date)}`}
                value={`${vkNumber(totals.total, 2)} ₽`}
                loading={isPending}
              />
              <StatTile
                label="Расход ЛФ"
                value={`${vkNumber(totals.leadForms, 2)} ₽`}
                loading={isPending}
              />
              <StatTile
                label="Расход СС — остаток после ЛФ"
                value={`${vkNumber(totals.messages, 2)} ₽`}
                loading={isPending}
              />
              <StatTile
                label="Кабинетов с данными"
                value={`${totals.withData} из ${totals.accounts}`}
                loading={isPending}
              />
            </div>
            <section className="rounded-lg border bg-background">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
                <h2 className="text-lg font-semibold">Все рекламные кабинеты</h2>
                <span className="text-xs text-muted-foreground">Расходы в рублях</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Кабинет</TableHead>
                    <TableHead>Город</TableHead>
                    <TableHead>Партнёр</TableHead>
                    <TableHead className="text-right" {...sort.head("spent")}>
                      Всего
                    </TableHead>
                    <TableHead className="text-right">ЛФ</TableHead>
                    <TableHead className="text-right">СС (остаток)</TableHead>
                    <TableHead className="text-right">Кампаний</TableHead>
                    <TableHead>Обновлено</TableHead>
                    <TableHead>Статус</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    <TableSkeletonRows columns={9} rows={10} />
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Кабинетов пока нет
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => {
                      const c = vkSpendCells(r);
                      return (
                        <TableRow key={r.account_id}>
                          <TableCell>
                            <div className="font-medium">{r.name}</div>
                            <div className="text-xs text-muted-foreground">
                              ID: {r.vk_account_id}
                            </div>
                          </TableCell>
                          <TableCell>{r.city || "Город не назначен"}</TableCell>
                          <TableCell>{r.partner_name || "—"}</TableCell>
                          <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                            {c.total}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums">
                            {c.leadForms}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums">
                            {c.messages}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.has ? r.campaign_rows : "—"}
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap tabular-nums">
                            {c.has ? formatMsk(r.updated_at) : "Нет данных"}
                          </TableCell>
                          <TableCell>
                            <StatusChip size="sm" tone={r.is_active ? "positive" : "neutral"}>
                              {r.is_active ? "Активен" : "Отключён"}
                            </StatusChip>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </section>
          </>
        )}
      </div>
    </AdminShell>
  );
}
