import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsVkTargetologistsPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
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
import { AN_TITLES } from "@/lib/analytics/labels";
import {
  invalidateVk,
  VK_BRANDS,
  vkRpc,
  vkTargetologistsQuery,
  type VkTargetologists,
} from "@/lib/analytics/vk/data";

export const Route = createFileRoute("/_authenticated/analytics/vk/targetologists")({
  head: () => ({ meta: [{ title: "Таргетологи — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkTargetologistsPageSkeleton,
  component: AnalyticsVkTargetologistsPage,
});

const CITIES_LIST = "vk-targetologist-cities";
const NO_PEOPLE =
  "Сначала выдайте сотруднику роль «Таргетолог» (право «Аналитика: таргетолог») в «Пользователях и ролях».";

type Assignment = VkTargetologists["assignments"][number];

/**
 * «Аналитика» → «VK Ads» → «Таргетологи» (администратору аналитики) — их
 * targetologists_page: таргетолог (человек портала с ролью «Таргетолог») на
 * бренд и город; у Lady Stretch и Lady Jump в одном городе могут быть разные.
 * «Убрать» — город уходит в «Не назначен» реестра таргета.
 */
function AnalyticsVkTargetologistsPage() {
  const qc = useQueryClient();
  const { data, error, isPending } = useQuery(vkTargetologistsQuery);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Assignment | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const people = data?.people ?? [];
  const q = query.trim().toLowerCase();
  const rows = (data?.assignments ?? []).filter(
    (a) => !q || `${a.brand} ${a.city} ${a.targetologist_name}`.toLowerCase().includes(q),
  );

  const remove = async (a: Assignment) => {
    setBusy(`${a.brand}|${a.city}`);
    try {
      await vkRpc.deleteTargetologist(a.brand, a.city);
      await invalidateVk(qc);
      toast.success("Назначение удалено. Город находится в разделе «Не назначен».");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell
      title={AN_TITLES.vkTargetologists}
      actions={
        <Button onClick={() => setEditing("new")} disabled={!people.length}>
          <Plus />
          Назначить таргетолога
        </Button>
      }
    >
      <div className="space-y-3">
        <InfoNote>
          Назначьте сотрудника с ролью «Таргетолог» на бренд и город. Для Lady Stretch и Lady Jump в
          одном городе можно назначить разных ответственных.
        </InfoNote>
        {data && !people.length && <InfoNote variant="warning">{NO_PEOPLE}</InfoNote>}
        <TableToolbar>
          <ToolbarSearch
            value={query}
            onChange={setQuery}
            placeholder="Бренд, город или таргетолог"
          />
          <span className="ml-auto px-1 text-sm text-muted-foreground">
            «Убрать» снимает назначение: город переходит в «Не назначен»
          </span>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Бренд</TableHead>
                  <TableHead>Город</TableHead>
                  <TableHead>Таргетолог</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={4} rows={8} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {query ? "Ничего не найдено" : "Назначений пока нет."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => (
                    <TableRow key={`${a.brand}|${a.city}`}>
                      <TableCell className="font-medium">{a.brand}</TableCell>
                      <TableCell className="font-medium">{a.city}</TableCell>
                      <TableCell>{a.targetologist_name}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(a)}
                          disabled={!people.length}
                        >
                          <Pencil />
                          Изменить таргетолога
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busy === `${a.brand}|${a.city}`}
                          onClick={() => void remove(a)}
                        >
                          {busy === `${a.brand}|${a.city}` && <Loader2 className="animate-spin" />}
                          Убрать
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <datalist id={CITIES_LIST}>
        {(data?.cities ?? []).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing !== null && (
            <TargetologistForm
              current={editing === "new" ? null : editing}
              people={people}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Их форма назначения: бренд, город, таргетолог из людей с ролью. */
function TargetologistForm({
  current,
  people,
  onClose,
}: {
  current: Assignment | null;
  people: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(current?.brand ?? VK_BRANDS[0]);
  const [city, setCity] = useState(current?.city ?? "");
  const [name, setName] = useState(
    current && people.includes(current.targetologist_name) ? current.targetologist_name : "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await vkRpc.saveTargetologist(brand, city, name);
      await invalidateVk(qc);
      toast.success("Таргетолог сохранён.");
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
        <DialogTitle>{current ? "Изменить таргетолога" : "Назначить таргетолога"}</DialogTitle>
        <DialogDescription>
          {current ? `${current.brand} · ${current.city}` : "Ответственный за бренд и город."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="grid gap-3">
            {!current && (
              <>
                <FormField label="Бренд" required>
                  <Select value={brand} onValueChange={setBrand}>
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
                </FormField>
                <FormField label="Город" required>
                  <Input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    list={CITIES_LIST}
                    placeholder="Например, Барнаул"
                    required
                    autoFocus
                  />
                </FormField>
              </>
            )}
            <FormField label="Таргетолог" required>
              <Select value={name} onValueChange={setName}>
                <SelectTrigger aria-label="Таргетолог">
                  <SelectValue placeholder="Выберите сотрудника" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
