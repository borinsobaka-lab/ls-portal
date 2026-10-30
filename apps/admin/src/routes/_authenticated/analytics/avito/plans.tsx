import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsAvitoPlansPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { avitoPlansQuery, avitoRpc, invalidateAvito } from "@/lib/analytics/avito/data";
import { avitoPlanFloat, avitoPlanInt } from "@/lib/analytics/avito/rules";
import { mskToday } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { wholeMoney } from "@/lib/analytics/vk/register";
import { pyG } from "@/lib/analytics/vk/plans";
import { cn } from "@/lib/utils";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const Route = createFileRoute("/_authenticated/analytics/avito/plans")({
  head: () => ({ meta: [{ title: "Планы Авито — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): { month?: string } => ({
    month: typeof s.month === "string" && MONTH.test(s.month) ? s.month : undefined,
  }),
  pendingComponent: AnalyticsAvitoPlansPageSkeleton,
  component: AnalyticsAvitoPlansPage,
});

/**
 * «Аналитика» → «Авито» → «Планы Авито» (администратору аналитики) — их
 * avito_plans_page: месяц, затем для каждого города подключённых кабинетов —
 * план заявок и целевой CPL (плановый бюджет = заявки × CPL). План одного
 * месяца не меняет другие месяцы.
 */
function AnalyticsAvitoPlansPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const month = search.month ?? mskToday().slice(0, 7);
  const { data, error, isPending, isFetching } = useQuery(avitoPlansQuery(month));
  const cities = data?.cities ?? [];
  const plans = new Map((data?.plans ?? []).map((p) => [`${p.brand}|${p.city}`, p]));

  return (
    <AdminShell title={AN_TITLES.avitoPlans}>
      <div className="space-y-4">
        <InfoNote>
          Сначала выберите месяц, затем задайте для каждого подключённого города план заявок и
          целевой CPL. План одного месяца не меняет другие месяцы.
        </InfoNote>
        <TableToolbar>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Месяц</span>
            <Input
              type="month"
              className="w-44"
              value={month}
              required
              onChange={(e) => {
                if (MONTH.test(e.target.value))
                  void navigate({ search: { month: e.target.value } });
              }}
            />
          </label>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <section
            className={cn(
              "rounded-lg border bg-background",
              isFetching && !isPending && "opacity-60 transition-opacity",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="text-lg font-semibold">
                  Планы на {month.slice(5, 7)}.{month.slice(0, 4)}
                </h2>
                <p className="text-sm text-muted-foreground">
                  Города подставлены из подключённых кабинетов Авито.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{cities.length} городов</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Город</TableHead>
                  <TableHead>План заявок и CPL</TableHead>
                  <TableHead className="text-right">Плановый бюджет</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={3} rows={6} />
                ) : cities.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Сначала подключите хотя бы один кабинет Авито.
                    </TableCell>
                  </TableRow>
                ) : (
                  cities.map((c) => {
                    const plan = plans.get(`${c.brand}|${c.city}`);
                    return (
                      <PlanRow
                        key={`${month}|${c.brand}|${c.city}|${plan?.updated_at ?? ""}`}
                        month={month}
                        brand={c.brand}
                        city={c.city}
                        applications={plan ? String(plan.applications_plan) : ""}
                        cpl={plan ? pyG(plan.target_cpl) : ""}
                        budget={plan ? wholeMoney(plan.applications_plan * plan.target_cpl) : "—"}
                      />
                    );
                  })
                )}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
    </AdminShell>
  );
}

/** Их строка плана города: заявки и CPL, «Сохранить». */
function PlanRow(p: {
  month: string;
  brand: string;
  city: string;
  applications: string;
  cpl: string;
  budget: string;
}) {
  const qc = useQueryClient();
  const [apps, setApps] = useState(p.applications);
  const [cpl, setCpl] = useState(p.cpl);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await avitoRpc.savePlan(p.month, p.brand, p.city, avitoPlanInt(apps), avitoPlanFloat(cpl));
      await invalidateAvito(qc);
      toast.success(`План для города «${p.city}» сохранён.`);
    } catch (err) {
      toast.error(`Не удалось сохранить план: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{p.city}</div>
        <div className="text-xs text-muted-foreground">{p.brand}</div>
      </TableCell>
      <TableCell>
        <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
          <Input
            className="w-24"
            inputMode="numeric"
            aria-label="План заявок"
            placeholder="Заявки"
            value={apps}
            required
            onChange={(e) => setApps(e.target.value)}
          />
          <Input
            className="w-28"
            inputMode="decimal"
            aria-label="Целевой CPL, ₽"
            placeholder="CPL, ₽"
            value={cpl}
            required
            onChange={(e) => setCpl(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </form>
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">{p.budget}</TableCell>
    </TableRow>
  );
}
