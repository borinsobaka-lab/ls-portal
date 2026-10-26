import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsStudiosPageSkeleton } from "@/components/page-skeletons";
import { RowContextMenu } from "@/components/row-context-menu";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orgBrandsQuery } from "@/lib/access/data";
import {
  anRpc,
  anStudiosListQuery,
  invalidateAnalytics,
  type AnStudioRow,
} from "@/lib/analytics/data";
import { ANALYTICS_TITLES, SOURCE_LABEL, STUDIOS_COLUMNS } from "@/lib/analytics/labels";
import { formatDate, todayISO } from "@/lib/format";
import { sortRows } from "@/lib/table-sort";

export const Route = createFileRoute("/_authenticated/analytics/studios")({
  head: () => ({ meta: [{ title: "Студии сети — Аналитика сети — Lady Stretch" }] }),
  pendingComponent: AnalyticsStudiosPageSkeleton,
  component: StudiosPage,
});

const TIPS = {
  name: "Как студия названа в учётной системе — по нему узнаются строки выгрузок. Новая студия появляется сама при загрузке.",
  city: "Город для отчётов и «Моего города». Точка 0 задаётся на город; партнёр видит города, назначенные ему.",
  partner: "Партнёр (ИП) студии — для справки.",
  brand: "Бренд сети: Lady Stretch, Lady Jump…",
  closed:
    "С этого дня студия считается закрытой: в отчётах — внизу города, фильтр «Статус». История остаётся.",
  status: "«Проверить» — пришла из загрузки, город ещё не указан.",
  data: "Первый и последний день выручки, загруженной по студии.",
};

type ReviewFilter = "all" | "review";

function StudiosPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(anStudiosListQuery);
  const [search, setSearch] = useState("");
  const [review, setReview] = useState<ReviewFilter>("all");
  const [edit, setEdit] = useState<AnStudioRow | null>(null);
  const sort = useTableSort();
  const today = todayISO();

  const q = search.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (s) =>
      (review === "all" || s.needsReview) &&
      (!q || [s.name, s.city ?? "", s.partner ?? ""].some((v) => v.toLowerCase().includes(q))),
  );
  const sorted = sortRows(rows, sort.sort, {
    name: (s) => s.name,
    city: (s) => s.city,
    partner: (s) => s.partner,
    data: (s) => s.lastDay,
  });
  const toReview = (data ?? []).filter((s) => s.needsReview).length;
  const keys = ["name", "city", "partner", null, "data"];

  return (
    <AdminShell title={ANALYTICS_TITLES.studios}>
      <div className="space-y-3">
        <TableToolbar>
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Студия, город или партнёр"
          />
          <Select value={review} onValueChange={(v) => setReview(v as ReviewFilter)}>
            <SelectTrigger aria-label="Какие студии" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все студии</SelectItem>
              <SelectItem value="review">Проверить ({toReview})</SelectItem>
            </SelectContent>
          </Select>
          <ToolbarReset
            active={!!search || review !== "all"}
            onReset={() => {
              setSearch("");
              setReview("all");
            }}
          />
        </TableToolbar>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                {STUDIOS_COLUMNS.map((c, i) => (
                  <TableHead
                    key={c}
                    tip={[TIPS.name, TIPS.city, TIPS.partner, TIPS.status, TIPS.data][i]}
                    {...(keys[i] ? sort.head(keys[i]!) : {})}
                  >
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableSkeletonRows columns={STUDIOS_COLUMNS.length} />
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={STUDIOS_COLUMNS.length}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    {data?.length
                      ? "Ничего не найдено"
                      : "Студии появятся после первой загрузки данных"}
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((s) => (
                  <RowContextMenu
                    key={s.id}
                    actions={[{ label: "Изменить", icon: Pencil, onSelect: () => setEdit(s) }]}
                  >
                    <TableRow>
                      <TableCell className="font-medium">
                        {s.name}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {SOURCE_LABEL[s.source]}
                        </span>
                      </TableCell>
                      <TableCell>{s.city ?? "—"}</TableCell>
                      <TableCell>{s.partner ?? "—"}</TableCell>
                      <TableCell>
                        {s.needsReview ? (
                          <StatusChip tone="warning">Проверить</StatusChip>
                        ) : s.closedOn && s.closedOn <= today ? (
                          <StatusChip tone="neutral">Закрыта с {formatDate(s.closedOn)}</StatusChip>
                        ) : (
                          <StatusChip tone="positive">Открыта</StatusChip>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.firstDay ? `${formatDate(s.firstDay)} – ${formatDate(s.lastDay)}` : "—"}
                      </TableCell>
                    </TableRow>
                  </RowContextMenu>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl">
          {edit && (
            <StudioForm
              key={edit.id}
              studio={edit}
              onClose={() => setEdit(null)}
              onSaved={() => void invalidateAnalytics(qc)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function StudioForm({
  studio,
  onClose,
  onSaved,
}: {
  studio: AnStudioRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const brands = useQuery(orgBrandsQuery);
  const [city, setCity] = useState(studio.city ?? "");
  const [partner, setPartner] = useState(studio.partner ?? "");
  const [brandId, setBrandId] = useState(studio.brandId ?? "none");
  const [closedOn, setClosedOn] = useState(studio.closedOn ?? "");
  const [note, setNote] = useState(studio.note ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!city.trim()) {
      toast.error("Укажите город: без него студия не попадёт в отчёты по городам");
      return;
    }
    setSaving(true);
    try {
      await anRpc("an_studio_save", {
        p_id: studio.id,
        p_city: city,
        p_partner: partner,
        p_brand_id: brandId === "none" ? null : brandId,
        p_closed_on: closedOn || null,
        p_note: note,
      });
      toast.success("Студия сохранена");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{studio.name}</DialogTitle>
        <DialogDescription>
          {SOURCE_LABEL[studio.source]} · название — как в учётной системе
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Город" tip={TIPS.city} required>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Барнаул" />
            </FormField>
            <FormField label="Партнёр" tip={TIPS.partner}>
              <Input
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
                placeholder="ИП Иванова"
              />
            </FormField>
            <FormField label="Бренд" tip={TIPS.brand}>
              <Select value={brandId} onValueChange={setBrandId}>
                <SelectTrigger aria-label="Бренд">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— не указан —</SelectItem>
                  {(brands.data ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Закрыта с" tip={TIPS.closed}>
              <Input
                type="date"
                value={closedOn}
                onChange={(e) => setClosedOn(e.target.value)}
                className="w-48"
              />
            </FormField>
            <FormField label="Заметка">
              <Textarea note value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
