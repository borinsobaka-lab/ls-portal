import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { CityPicker } from "@/components/analytics/admin/city-picker";
import { useConfirm } from "@/components/confirm-dialog";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { AnalyticsPartnersPageSkeleton } from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableSkeletonRows } from "@/components/skeletons";
import { Badge } from "@/components/ui/badge";
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
import {
  anPartnerCandidatesQuery,
  anPartnerCitiesQuery,
  anPartnerRpc,
  anPartnersQuery,
  invalidatePartners,
  type AnPartner,
} from "@/lib/analytics/admin-data";
import { AN_PARTNER_REPORTS } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import type { SortGetters } from "@/lib/table-sort";

export const Route = createFileRoute("/_authenticated/analytics/admin/partners/")({
  head: () => ({ meta: [{ title: "Партнёры — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsPartnersPageSkeleton,
  component: AnalyticsPartnersPage,
});

const TIPS = {
  cities:
    "Партнёр видит отчёты 1С только по этим городам (их «Мой город»). Город — как в выгрузках 1С.",
  reports:
    "Маркетинг и отзывы, открытые партнёру ролями в «Пользователях и ролях» — по его городам.",
  status:
    "Отключён — человек сейчас не может войти в портал (статус или срок в «Пользователях и ролях»).",
};

const SORT_GETTERS: SortGetters<AnPartner> = {
  name: (p) => p.full_name,
  cities: (p) => p.cities.join(", "),
  status: (p) => p.active,
};

const reportTitle = (key: string) => AN_PARTNER_REPORTS.find((r) => r.key === key)?.title ?? key;

/**
 * «Аналитика» → «Партнёры» (администратору аналитики) — их partners_page_v2:
 * партнёры и их города, переход в карточку партнёра. Учётную запись и роли
 * партнёра заводят в «Пользователях и ролях».
 */
function AnalyticsPartnersPage() {
  const { data: partners, isPending } = useQuery(anPartnersQuery);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AnPartner | null>(null);
  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(partners ?? []), undefined, sort.key);

  return (
    <AdminShell
      title={AN_TITLES.partners}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Добавить партнёра
        </Button>
      }
    >
      <div className="space-y-3">
        <InfoNote>
          Партнёр видит только назначенные ему города: отчёт «Мой город» и выданные ему маркетинг и
          отзывы. Учётную запись партнёра и его роль («Партнёр — аналитика») заводят в{" "}
          <Link to="/access" className="font-medium text-foreground underline underline-offset-2">
            «Пользователях и ролях»
          </Link>
          , здесь — города и карточка с реквизитами.
        </InfoNote>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead {...sort.head("name")}>Партнёр</TableHead>
                <TableHead tip={TIPS.cities} {...sort.head("cities")}>
                  Города
                </TableHead>
                <TableHead tip={TIPS.reports}>Доступ к отчётам</TableHead>
                <TableHead tip={TIPS.status} {...sort.head("status")}>
                  Статус
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableSkeletonRows columns={5} rows={4} />
              ) : (partners ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Партнёров пока нет. Нажмите «Добавить партнёра».
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((p) => (
                  <TableRow key={p.user_id}>
                    <TableCell>
                      <div className="font-medium">{p.full_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[p.position || "Партнёр", p.email].filter(Boolean).join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-md flex-wrap gap-1">
                        {p.cities.map((c) => (
                          <Badge key={c} variant="secondary">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.reports.length ? p.reports.map(reportTitle).join(", ") : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={p.active ? "positive" : "neutral"}>
                        {p.active ? "Активен" : "Отключён"}
                      </StatusChip>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                          Города
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/analytics/admin/partners/$userId"
                            params={{ userId: p.user_id }}
                          >
                            Карточка партнёра
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={isPending} />
        </div>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-xl">
          <AddPartnerForm onClose={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-xl">
          {editing && (
            <EditCitiesForm
              key={editing.user_id}
              partner={editing}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Их «Создать партнёра»: человек портала и разрешённые города. */
function AddPartnerForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: people = [] } = useQuery(anPartnerCandidatesQuery);
  const { data: cities = [] } = useQuery(anPartnerCitiesQuery);
  const [user, setUser] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!user) {
      toast.error("Выберите пользователя");
      return;
    }
    if (picked.length === 0) {
      toast.error("Выберите хотя бы один разрешённый город.");
      return;
    }
    setSaving(true);
    try {
      await anPartnerRpc.add(user, picked);
      await invalidatePartners(qc);
      toast.success("Партнёр добавлен");
      onClose();
    } catch (e) {
      toast.error("Не удалось создать партнёра", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить партнёра</DialogTitle>
        <DialogDescription>
          Партнёр увидит только назначенные города и отчёт «Мой город».
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField
              label="Пользователь"
              required
              tip="Человек из «Пользователей и ролей». Нет в списке — сначала заведите его там."
            >
              <SearchableCombobox
                value={user}
                onChange={setUser}
                options={people.map((p) => ({
                  value: p.user_id,
                  label: p.full_name,
                  hint: p.position ?? undefined,
                  searchText: `${p.full_name} ${p.email ?? ""} ${p.position ?? ""}`,
                }))}
                placeholder="Выберите пользователя"
                searchPlaceholder="Имя или почта"
                emptyText="Никого не нашлось"
              />
            </FormField>
            <FormField label="Разрешённые города" required htmlFor={null}>
              <CityPicker cities={cities} value={picked} onChange={setPicked} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Создать партнёра
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/** Их «Изменить города» (+ «Убрать из партнёров»). */
function EditCitiesForm({ partner, onClose }: { partner: AnPartner; onClose: () => void }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: cities = [] } = useQuery(anPartnerCitiesQuery);
  const [picked, setPicked] = useState<string[]>(partner.cities);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (picked.length === 0) {
      toast.error("Выберите хотя бы один разрешённый город.");
      return;
    }
    setSaving(true);
    try {
      await anPartnerRpc.setCities(partner.user_id, picked);
      await invalidatePartners(qc);
      toast.success("Города сохранены");
      onClose();
    } catch (e) {
      toast.error("Не удалось сохранить города", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Убрать ${partner.full_name} из партнёров?`,
      description:
        "Города снимутся — отчёт «Мой город» партнёру больше не откроется. Карточка с реквизитами и условиями сохранится. Учётная запись и роли — в «Пользователях и ролях».",
      confirmLabel: "Убрать",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await anPartnerRpc.remove(partner.user_id);
      await invalidatePartners(qc);
      toast.success("Партнёр убран");
      onClose();
    } catch (e) {
      toast.error("Не удалось убрать партнёра", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Города · {partner.full_name}</DialogTitle>
        <DialogDescription>
          Партнёр увидит только выбранные города. Сейчас назначено: {partner.cities.join(", ")}.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <FormField label="Разрешённые города" required htmlFor={null}>
            <CityPicker cities={cities} value={picked} onChange={setPicked} disabled={saving} />
          </FormField>
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" className="text-destructive" onClick={remove} disabled={saving}>
            Убрать из партнёров
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Сохранить города
            </Button>
          </div>
        </DialogFooter>
      </DialogForm>
      {confirmDialog}
    </>
  );
}
