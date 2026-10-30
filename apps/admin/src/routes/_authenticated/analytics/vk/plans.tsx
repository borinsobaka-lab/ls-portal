import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { FileUp, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsVkPlansPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMsk, mskToday } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import {
  invalidateVk,
  VK_BRANDS,
  vkPlansQuery,
  vkRpc,
  type VkPlanRow,
} from "@/lib/analytics/vk/data";
import { browserInflate } from "@/lib/analytics/vk/import";
import {
  formFloat,
  formInt,
  planBudget,
  planFromXlsx,
  planMoney,
  plansFromMultiMonthXlsx,
  pyG,
  type PlanInput,
} from "@/lib/analytics/vk/plans";
import { cn } from "@/lib/utils";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CITIES_LIST = "vk-plan-cities";

export const Route = createFileRoute("/_authenticated/analytics/vk/plans")({
  head: () => ({ meta: [{ title: "Планы таргета — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): { month?: string } => ({
    month: typeof s.month === "string" && MONTH.test(s.month) ? s.month : undefined,
  }),
  pendingComponent: AnalyticsVkPlansPageSkeleton,
  component: AnalyticsVkPlansPage,
});

/**
 * Число из поля формы для RPC: не число — NaN не уходит в JSON (там он
 * null), база ответит своим текстом про заявки или стоимость.
 */
function manualPlan(city: string, apps: string, cpl: string): PlanInput {
  const a = formInt(apps);
  const c = formFloat(cpl);
  return {
    city,
    applications_plan: a === null ? 0.5 : a,
    target_cpl: c === null || !Number.isFinite(c) ? 0 : c,
  };
}

/**
 * «Аналитика» → «VK Ads» → «Планы таргета» (администратору аналитики) — их
 * target_plans_page: план по бренду и городу на месяц (заявки VK и целевая
 * цена заявки; ЛФ и СС в плане не делятся), ручной план города, импорт из
 * Excel (один месяц или все листы-месяцы), правка в строке, удаление,
 * история корректировок.
 */
function AnalyticsVkPlansPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const month = search.month ?? mskToday().slice(0, 7);
  const { data, error, isPending, isFetching } = useQuery(vkPlansQuery(month));
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const plans = data?.plans ?? [];
  const changes = data?.changes ?? [];
  const label = `${month.slice(5, 7)}.${month.slice(0, 4)}`;

  return (
    <AdminShell
      title={AN_TITLES.vkPlans}
      actions={
        <>
          <Button variant="outline" onClick={() => setImporting(true)}>
            <FileUp />
            Импорт из Excel
          </Button>
          <Button onClick={() => setAdding(true)}>
            <Plus />
            План города
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          План задаётся по бренду и городу на весь месяц: общее число заявок VK и целевая цена
          заявки. ЛФ и СС не делятся в плане.
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
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <section className="rounded-lg border bg-background">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
                <h2 className="text-lg font-semibold">Планы на {label}</h2>
                <span className="text-xs text-muted-foreground">{plans.length} направлений</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Бренд</TableHead>
                    <TableHead>Город</TableHead>
                    <TableHead>Заявки и целевой CPL</TableHead>
                    <TableHead className="text-right">Плановый бюджет</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    <TableSkeletonRows columns={4} rows={8} />
                  ) : plans.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Для этого месяца планы ещё не загружены.
                      </TableCell>
                    </TableRow>
                  ) : (
                    plans.map((p) => (
                      <PlanRow key={`${p.brand}|${p.city}`} plan={p} month={month} />
                    ))
                  )}
                </TableBody>
              </Table>
            </section>
            <section className="rounded-lg border bg-background">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
                <h2 className="text-lg font-semibold">История корректировок</h2>
                <span className="text-xs text-muted-foreground">Последние {changes.length}</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Бренд</TableHead>
                    <TableHead>Город</TableHead>
                    <TableHead className="text-right">Было заявок</TableHead>
                    <TableHead className="text-right">Был CPL</TableHead>
                    <TableHead className="text-right">Стало заявок</TableHead>
                    <TableHead className="text-right">Стал CPL</TableHead>
                    <TableHead>Администратор</TableHead>
                    <TableHead>Когда</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    <TableSkeletonRows columns={8} rows={3} />
                  ) : changes.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Корректировок пока нет.
                      </TableCell>
                    </TableRow>
                  ) : (
                    changes.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell>{c.brand}</TableCell>
                        <TableCell>{c.city}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.previous_applications_plan ?? "—"}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {planMoney(c.previous_target_cpl)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.applications_plan}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {planMoney(c.target_cpl)}
                        </TableCell>
                        <TableCell>{c.changed_by || "Администратор"}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatMsk(c.changed_at)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </section>
          </div>
        )}
      </div>
      <datalist id={CITIES_LIST}>
        {(data?.cities ?? []).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-lg">
          {adding && <ManualPlanForm month={month} onClose={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="sm:max-w-lg">
          {importing && (
            <ImportPlansForm
              month={month}
              onClose={() => setImporting(false)}
              onMonth={(m) => void navigate({ search: { month: m } })}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Их строка плана: заявки и CPL правятся на месте, «Удалить» — с подтверждением. */
function PlanRow({ plan, month }: { plan: VkPlanRow; month: string }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [apps, setApps] = useState(String(plan.applications_plan));
  const [cpl, setCpl] = useState(pyG(plan.target_cpl));
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await vkRpc.savePlans(
        plan.brand,
        [{ month, plans: [manualPlan(plan.city, apps, cpl)] }],
        "manual",
      );
      await invalidateVk(qc);
      toast.success(r.changed ? "План сохранён." : "План не изменился.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Удалить план «${plan.brand} · ${plan.city}»?`,
      description: "Удалить этот план за выбранный месяц?",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const deleted = await vkRpc.deletePlan(month, plan.brand, plan.city);
      await invalidateVk(qc);
      toast.success(deleted ? "План удалён." : "Этот план уже удалён.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{plan.brand}</TableCell>
      <TableCell className="font-medium">{plan.city}</TableCell>
      <TableCell>
        <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
          <Input
            className="w-24"
            inputMode="numeric"
            aria-label="План заявок"
            value={apps}
            required
            onChange={(e) => setApps(e.target.value)}
          />
          <Input
            className="w-28"
            inputMode="decimal"
            aria-label="Целевая цена заявки, ₽"
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
      <TableCell className="text-right">
        <span className="inline-flex items-center gap-2 whitespace-nowrap tabular-nums">
          {planBudget(plan.applications_plan, plan.target_cpl)}
          <Button
            size="icon"
            variant="ghost"
            title="Удалить"
            aria-label="Удалить план"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 />
          </Button>
        </span>
        {confirmDialog}
      </TableCell>
    </TableRow>
  );
}

function BrandSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Бренд">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VK_BRANDS.map((b) => (
          <SelectItem key={b} value={b}>
            {b}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Их «Добавить план города вручную». */
function ManualPlanForm({ month, onClose }: { month: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [m, setM] = useState(month);
  const [brand, setBrand] = useState<string>(VK_BRANDS[0]);
  const [city, setCity] = useState("");
  const [apps, setApps] = useState("");
  const [cpl, setCpl] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const r = await vkRpc.savePlans(
        brand,
        [{ month: m, plans: [manualPlan(city, apps, cpl)] }],
        "manual",
      );
      await invalidateVk(qc);
      toast.success(r.changed ? "План сохранён." : "План не изменился.");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить план города вручную</DialogTitle>
        <DialogDescription>
          Сохраняется только выбранный город и бренд за указанный месяц. Если план уже существует,
          он будет обновлён.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Месяц" required>
              <Input type="month" value={m} onChange={(e) => setM(e.target.value)} required />
            </FormField>
            <FormField label="Бренд" required>
              <BrandSelect value={brand} onChange={setBrand} />
            </FormField>
            <FormField label="Город" required className="sm:col-span-2">
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                list={CITIES_LIST}
                placeholder="Выберите или введите город"
                required
                autoFocus
              />
            </FormField>
            <FormField label="План заявок" required>
              <Input
                type="number"
                min={0}
                step={1}
                value={apps}
                onChange={(e) => setApps(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Целевая цена заявки, ₽" required>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={cpl}
                onChange={(e) => setCpl(e.target.value)}
                required
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить план города
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/** Их «Импорт из Excel»: бренд — на все строки; один месяц или все листы. */
function ImportPlansForm({
  month,
  onClose,
  onMonth,
}: {
  month: string;
  onClose: () => void;
  onMonth: (m: string) => void;
}) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(VK_BRANDS[0]);
  const [m, setM] = useState(month);
  const [year, setYear] = useState(month.slice(0, 4));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"single" | "all" | null>(null);

  const run = async (mode: "single" | "all") => {
    setBusy(mode);
    try {
      if (!/^\d{4}-\d{2}$/.test(m)) throw new Error("Выберите месяц для плана.");
      if (!file || !file.name.toLowerCase().endsWith(".xlsx")) {
        throw new Error("Загрузите файл Excel в формате .xlsx.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mode === "all") {
        const y = formInt(year);
        const months = await plansFromMultiMonthXlsx(bytes, y ?? Number.NaN, browserInflate);
        const r = await vkRpc.savePlans(brand, months, "all");
        await invalidateVk(qc);
        toast.success(`Импорт завершён: месяцев — ${r.months}, изменено планов — ${r.changed}.`);
      } else {
        const plans = await planFromXlsx(bytes, m, browserInflate);
        const r = await vkRpc.savePlans(brand, [{ month: m, plans }], "single");
        await invalidateVk(qc);
        toast.success(
          `Импорт завершён: изменено планов — ${r.changed}, прочитано строк — ${plans.length}.`,
        );
      }
      if (m !== month) onMonth(m);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Импорт из Excel</DialogTitle>
        <DialogDescription>Колонки: Город, Заявки, Стоимость заявки.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => run("single")}>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Бренд" required className="sm:col-span-2">
              <BrandSelect value={brand} onChange={setBrand} />
            </FormField>
            <FormField label="Месяц для одного листа" required>
              <Input type="month" value={m} onChange={(e) => setM(e.target.value)} required />
            </FormField>
            <FormField label="Год для всех листов" required>
              <Input
                type="number"
                min={2020}
                max={2100}
                value={year}
                onChange={(e) => setYear(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Файл Excel" required className="sm:col-span-2">
              <Input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
            </FormField>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Выбранный бренд применяется ко всем строкам файла. Для обычного ежемесячного файла
            используйте «Импортировать выбранный месяц». Для файла с листами-месяцами («Август»,
            «Сентябрь»…) нажмите «Импортировать все листы» — все месяцы загрузятся за один раз.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => void run("all")} disabled={busy !== null}>
            {busy === "all" && <Loader2 className="animate-spin" />}
            Импортировать все листы
          </Button>
          <Button type="submit" disabled={busy !== null}>
            {busy === "single" && <Loader2 className="animate-spin" />}
            Импортировать выбранный месяц
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
