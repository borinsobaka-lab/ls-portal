import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsTargetsPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
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
import { analyticsScopeQuery, anRpc, invalidateAnalytics } from "@/lib/analytics/data";
import { ANALYTICS_TITLES } from "@/lib/analytics/labels";
import { cityNames, cityOf, NO_CITY } from "@/lib/analytics/logic";

export const Route = createFileRoute("/_authenticated/analytics/targets")({
  head: () => ({ meta: [{ title: "Точка 0 — Аналитика сети — Lady Stretch" }] }),
  pendingComponent: AnalyticsTargetsPageSkeleton,
  component: TargetsPage,
});

const TIP =
  "Месячная выручка города, при которой его студии выходят в ноль (у Lady Stretch — «точка ноль на все точки города»). В «Выручке» и «Моём городе» с ней сравнивается прогноз месяца.";

/**
 * «Точка 0» — цель города: одна сумма на все его студии (справочник Lady
 * Stretch city_break_even_reference). Пустое поле — точки 0 нет.
 */
function TargetsPage() {
  const qc = useQueryClient();
  const { data: scope, isLoading } = useQuery(analyticsScopeQuery);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const cities = scope ? cityNames(scope.studios, scope.today).filter((c) => c !== NO_CITY) : [];
  const base = (c: string) => (scope?.targets[c] !== undefined ? String(scope.targets[c]) : "");
  const changed = cities.filter((c) => drafts[c] !== undefined && drafts[c].trim() !== base(c));

  const save = async () => {
    const values = changed.map((c) => ({
      city: c,
      raw: drafts[c].trim().replace(/\s/g, "").replace(",", "."),
    }));
    const bad = values.find(
      (v) => v.raw !== "" && (!Number.isFinite(Number(v.raw)) || Number(v.raw) < 0),
    );
    if (bad) {
      toast.error(`Точка 0 города «${bad.city}» — неотрицательное число`);
      return;
    }
    setSaving(true);
    try {
      for (const v of values)
        await anRpc("an_city_target_save", {
          p_city: v.city,
          p_point_zero: v.raw === "" ? null : Number(v.raw),
        });
      setDrafts({});
      await invalidateAnalytics(qc);
      toast.success("Точка 0 сохранена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell
      title={ANALYTICS_TITLES.targets}
      actions={
        changed.length > 0 ? (
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Сохранить ({changed.length})
          </Button>
        ) : undefined
      }
    >
      <div className="max-w-3xl space-y-3">
        <InfoNote>{TIP}</InfoNote>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Город</TableHead>
                <TableHead className="text-right [&>span]:justify-end">Студий</TableHead>
                <TableHead tip={TIP}>Точка 0, ₽ в месяц</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading || !scope ? (
                <TableSkeletonRows columns={3} />
              ) : cities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    Города появятся, когда у студий сети будет указан город
                  </TableCell>
                </TableRow>
              ) : (
                cities.map((c) => (
                  <TableRow key={c}>
                    <TableCell className="font-medium">{c}</TableCell>
                    <TableCell className="text-right">
                      {scope.studios.filter((s) => cityOf(s) === c).length}
                    </TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        aria-label={`Точка 0 — ${c}`}
                        placeholder="Не задана"
                        className="w-44"
                        value={drafts[c] ?? base(c)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AdminShell>
  );
}
