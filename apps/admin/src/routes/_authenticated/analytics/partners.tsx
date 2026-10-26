import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsPartnersPageSkeleton } from "@/components/page-skeletons";
import { RowContextMenu } from "@/components/row-context-menu";
import { TableSkeletonRows } from "@/components/skeletons";
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
import { CheckboxOption, InfoNote } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  analyticsScopeQuery,
  anPartnersQuery,
  anRpc,
  invalidateAnalytics,
  type AnPartner,
} from "@/lib/analytics/data";
import { ANALYTICS_TITLES } from "@/lib/analytics/labels";
import { cityNames, NO_CITY } from "@/lib/analytics/logic";

export const Route = createFileRoute("/_authenticated/analytics/partners")({
  head: () => ({ meta: [{ title: "Доступ партнёров — Аналитика сети — Lady Stretch" }] }),
  pendingComponent: AnalyticsPartnersPageSkeleton,
  component: PartnersPage,
});

/**
 * Города партнёров: партнёр (человек портала с правом «Аналитика сети: свои
 * города») видит отчёты только по назначенным здесь городам — как
 * user_partner_cities в портале Lady Stretch. Само право выдаётся ролью
 * («Партнёр — аналитика») в «Пользователях и ролях».
 */
function PartnersPage() {
  const qc = useQueryClient();
  const partners = useQuery(anPartnersQuery);
  const scope = useQuery(analyticsScopeQuery);
  const [edit, setEdit] = useState<AnPartner | null>(null);
  const cities = scope.data
    ? cityNames(scope.data.studios, scope.data.today).filter((c) => c !== NO_CITY)
    : [];

  return (
    <AdminShell title={ANALYTICS_TITLES.partners}>
      <div className="space-y-3">
        <InfoNote>
          Здесь — люди с ролью, где есть право «Аналитика сети: свои города» (стартовая роль
          «Партнёр — аналитика»). Роль выдаётся в{" "}
          <Link to="/access" className="font-medium underline">
            «Пользователях и ролях»
          </Link>
          , города — здесь: партнёр видит «Мой город» и отчёты только по ним.
        </InfoNote>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Партнёр</TableHead>
                <TableHead>Почта</TableHead>
                <TableHead>Города</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.isLoading ? (
                <TableSkeletonRows columns={3} />
              ) : (partners.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    Пока ни у кого нет права «Аналитика сети: свои города»
                  </TableCell>
                </TableRow>
              ) : (
                (partners.data ?? []).map((p) => (
                  <RowContextMenu
                    key={p.user_id}
                    actions={[{ label: "Города", icon: MapPin, onSelect: () => setEdit(p) }]}
                  >
                    <TableRow>
                      <TableCell className="font-medium">{p.name ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{p.email}</TableCell>
                      <TableCell>
                        {p.cities.length ? (
                          p.cities.join(", ")
                        ) : (
                          <span className="text-amber-700">не назначены — отчётов не видит</span>
                        )}
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
        <DialogContent className="max-w-lg">
          {edit && (
            <CitiesForm
              key={edit.user_id}
              partner={edit}
              cities={cities}
              onClose={() => setEdit(null)}
              onSaved={() => void invalidateAnalytics(qc)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function CitiesForm({
  partner,
  cities,
  onClose,
  onSaved,
}: {
  partner: AnPartner;
  cities: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [picked, setPicked] = useState(new Set(partner.cities));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  // Назначенный город, которого пока нет у студий, тоже показываем.
  const all = [...new Set([...cities, ...partner.cities])];
  const shown = all.filter((c) => c.toLowerCase().includes(search.trim().toLowerCase()));

  const save = async () => {
    setSaving(true);
    try {
      await anRpc("an_partner_cities_save", { p_user_id: partner.user_id, p_cities: [...picked] });
      toast.success("Города сохранены");
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
        <DialogTitle>Города: {partner.name ?? partner.email}</DialogTitle>
        <DialogDescription>
          Отчёты «Аналитики сети» — только по студиям этих городов.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Город"
              aria-label="Поиск города"
            />
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {shown.map((c) => (
                <CheckboxOption
                  key={c}
                  checked={picked.has(c)}
                  onCheckedChange={(v) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(c);
                      else next.delete(c);
                      return next;
                    })
                  }
                  className="rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  {c}
                </CheckboxOption>
              ))}
              {shown.length === 0 && (
                <p className="px-2 py-4 text-sm text-muted-foreground">Городов не найдено</p>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить ({picked.size})
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
