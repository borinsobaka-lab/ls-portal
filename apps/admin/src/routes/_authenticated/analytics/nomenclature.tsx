import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { AnalyticsNomenclaturePageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoNote } from "@/components/ui/form-field";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTableSort } from "@/hooks/use-table-sort";
import { anNomenclatureQuery, anRpc, invalidateAnalytics } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, CATEGORY_LABEL, SOURCE_LABEL } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/nomenclature")({
  head: () => ({ meta: [{ title: "Номенклатура — Аналитика сети — Lady Stretch" }] }),
  pendingComponent: AnalyticsNomenclaturePageSkeleton,
  component: NomenclaturePage,
});

const TIPS = {
  category:
    "В продажи абонементов идут только «Абонемент», в воронку пробных — только «Пробное занятие». «Требует классификации» и «Не определено» никуда не идут, пока их не разметят.",
  code: "Неизменный код учётной системы; «name:…» — у выгрузки не было кода, позиция узнаётся по названию.",
};

/** Порядок категорий в списке — как в окне классификации Lady Stretch. */
const CATEGORIES = Object.keys(CATEGORY_LABEL);

function NomenclaturePage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(anNomenclatureQuery);
  const pending = (data ?? []).filter(
    (n) => n.category === "unclassified" || n.category === "undefined",
  ).length;
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState("subscription");
  const [saving, setSaving] = useState(false);
  const sort = useTableSort<NonNullable<typeof data>[number]>({
    name: (n) => n.name,
    category: (n) => CATEGORY_LABEL[n.category],
  });

  const rows = (data ?? []).filter(
    (n) =>
      (category === "all" ||
        (category === "pending"
          ? n.category === "unclassified" || n.category === "undefined"
          : n.category === category)) &&
      (!q || n.name.toLowerCase().includes(q) || n.code.toLowerCase().includes(q)),
  );
  const pg = usePagination(sort.apply(rows), 50, `${sort.key}|${category}|${q}`);

  const setCategoryOf = async (ids: string[], value: string) => {
    setSaving(true);
    try {
      await anRpc("an_nomenclature_set", { p_ids: ids, p_category: value });
      await invalidateAnalytics(qc);
      setSelected(new Set());
      toast.success(ids.length > 1 ? `Размечено позиций: ${ids.length}` : "Категория сохранена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const allOnPage = pg.paged.length > 0 && pg.paged.every((n) => selected.has(n.id));

  return (
    <AdminShell title={ANALYTICS_TITLES.nomenclature}>
      <div className="space-y-3">
        {pending > 0 && (
          <InfoNote variant="warning">
            Требуют классификации: {pending}. Пока позиция не размечена, её продажи не входят в
            абонементы, а записи — в воронку пробных.
          </InfoNote>
        )}
        <TableToolbar>
          <ToolbarSearch value={search} onChange={setSearch} placeholder="Название или код" />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Категория" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все категории</SelectItem>
              <SelectItem value="pending">Не размечены ({pending})</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarReset
            active={!!search || category !== "all"}
            onReset={() => {
              setSearch("");
              setCategory("all");
            }}
          />
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Выбрано: {selected.size}</span>
              <Select value={bulk} onValueChange={setBulk}>
                <SelectTrigger aria-label="Назначить категорию" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button disabled={saving} onClick={() => void setCategoryOf([...selected], bulk)}>
                {saving && <Loader2 className="animate-spin" />} Назначить
              </Button>
            </div>
          )}
        </TableToolbar>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Выбрать все на странице"
                    checked={allOnPage}
                    onCheckedChange={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const n of pg.paged) {
                          if (v) next.add(n.id);
                          else next.delete(n.id);
                        }
                        return next;
                      })
                    }
                  />
                </TableHead>
                <TableHead {...sort.head("name")}>Номенклатура</TableHead>
                <TableHead tip={TIPS.code}>Код</TableHead>
                <TableHead>Система</TableHead>
                <TableHead tip={TIPS.category} {...sort.head("category")}>
                  Категория
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableSkeletonRows columns={5} />
              ) : pg.paged.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    {data?.length ? "Ничего не найдено" : "Позиции появятся после загрузки продаж"}
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Выбрать ${n.name}`}
                        checked={selected.has(n.id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(n.id);
                            else next.delete(n.id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">{n.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {n.code.startsWith("name:") ? "—" : n.code}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {SOURCE_LABEL[n.source]}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={n.category}
                        disabled={saving}
                        onValueChange={(v) => void setCategoryOf([n.id], v)}
                      >
                        <SelectTrigger aria-label={`Категория — ${n.name}`} className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {CATEGORY_LABEL[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={isLoading} />
        </div>
      </div>
    </AdminShell>
  );
}
