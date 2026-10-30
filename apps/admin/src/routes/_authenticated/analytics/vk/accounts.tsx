import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { AnalyticsVkAccountsPageSkeleton } from "@/components/page-skeletons";
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
import { invalidateVk, VK_BRANDS, vkAccountsQuery, vkRpc } from "@/lib/analytics/vk/data";
import {
  vkAccountMatches,
  vkBalanceSort,
  vkVerification,
  type VkAccountRow,
} from "@/lib/analytics/vk/view";
import {
  createVkAccount,
  setVkAccountToken,
  syncVkAccountPeriod,
} from "@/lib/analytics/vk.functions";

export const Route = createFileRoute("/_authenticated/analytics/vk/accounts")({
  head: () => ({ meta: [{ title: "Рекламные кабинеты — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkAccountsPageSkeleton,
  component: AnalyticsVkAccountsPage,
});

const ALL = "__all__";
const CITIES_LIST = "vk-cities";
const PARTNERS_LIST = "vk-partners";

const TIPS = {
  balance: "Последний снимок остатка кабинета из VK Ads (сбор — раз в час).",
  key: "Проверка ключа последним сбором: «ключ проверен» — VK Ads ответил, иначе код ошибки.",
};

/**
 * «Аналитика» → «VK Ads» → «Рекламные кабинеты» (администратору
 * аналитики) — их vk_ads_page: кабинеты, их бренд, город и партнёр, ключи
 * (хранятся зашифрованно и не показываются), остатки; «Ключ и загрузка» —
 * новый ключ и загрузка периода, «Отключить» / «Включить», удаление со всей
 * историей. Расходы и остатки собирает фоновая задача раз в час.
 */
function AnalyticsVkAccountsPage() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data, isPending, error } = useQuery(vkAccountsQuery);
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [partner, setPartner] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<VkAccountRow | null>(null);
  const [tools, setTools] = useState<VkAccountRow | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const sort = useTableSort<VkAccountRow>({ balance: vkBalanceSort });
  const accounts = data?.accounts ?? [];
  const cities = data?.cities ?? [];
  const partners = data?.partners ?? [];
  const rows = sort.apply(accounts.filter((a) => vkAccountMatches(a, { query, city, partner })));

  const toggle = async (a: VkAccountRow) => {
    setBusy(a.id);
    try {
      await vkRpc.toggle(a.id);
      await invalidateVk(qc);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (a: VkAccountRow) => {
    const ok = await confirm({
      title: `Удалить «${a.name}»?`,
      description: "Удалить кабинет и всю его историю? Это действие нельзя отменить.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setBusy(a.id);
    try {
      await vkRpc.remove(a.id);
      await invalidateVk(qc);
      toast.success("Кабинет удалён.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell
      title={AN_TITLES.vkAccounts}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Добавить кабинет
        </Button>
      }
    >
      <div className="space-y-3">
        <InfoNote>
          Только администраторы управляют кабинетами, их городами и ключами. Расходы и остатки
          собирает фоновая задача раз в час. Ключ сохраняется зашифрованно и больше не показывается.
        </InfoNote>
        <TableToolbar>
          <ToolbarSearch value={query} onChange={setQuery} placeholder="Название или ID кабинета" />
          <Select value={city || ALL} onValueChange={(v) => setCity(v === ALL ? "" : v)}>
            <SelectTrigger className="w-48" aria-label="Фильтр по городу">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все города</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={partner || ALL} onValueChange={(v) => setPartner(v === ALL ? "" : v)}>
            <SelectTrigger className="w-48" aria-label="Фильтр по партнёру">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все партнёры</SelectItem>
              {partners.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto px-1 text-sm text-muted-foreground">
            {accounts.length} в справочнике
          </span>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Кабинет</TableHead>
                  <TableHead>Город и партнёр</TableHead>
                  <TableHead className="text-right" tip={TIPS.balance} {...sort.head("balance")}>
                    Остаток
                  </TableHead>
                  <TableHead>Обновлён</TableHead>
                  <TableHead tip={TIPS.key}>Ключ</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={7} rows={10} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {accounts.length ? "Ничего не найдено." : "Кабинетов пока нет"}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">ID: {a.vk_account_id}</div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="group flex items-start gap-2 text-left"
                          onClick={() => setEditing(a)}
                          title="Изменить бренд, город и партнёра"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm">
                              <span className="text-muted-foreground">{a.brand} · </span>
                              {a.city || (
                                <span className="text-muted-foreground">Город не назначен</span>
                              )}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {a.partner_name || "Партнёр не назначен"}
                            </span>
                          </span>
                          <Pencil className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {a.last_balance ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap tabular-nums">
                        {formatMsk(a.last_balance_at)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        <StatusChip
                          size="sm"
                          tone={
                            a.last_verification_status === 200
                              ? "positive"
                              : a.last_verification_status
                                ? "negative"
                                : "neutral"
                          }
                        >
                          {vkVerification(a.last_verification_status)}
                        </StatusChip>
                      </TableCell>
                      <TableCell>
                        <StatusChip size="sm" tone={a.is_active ? "positive" : "neutral"}>
                          {a.is_active ? "Активен" : "Отключён"}
                        </StatusChip>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => setTools(a)}>
                            <KeyRound />
                            Ключ и загрузка
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === a.id}
                            onClick={() => void toggle(a)}
                          >
                            {busy === a.id && <Loader2 className="animate-spin" />}
                            {a.is_active ? "Отключить" : "Включить"}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Удалить ${a.name}`}
                            title="Удалить кабинет"
                            disabled={busy === a.id}
                            onClick={() => void remove(a)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
        <datalist id={CITIES_LIST}>
          {cities.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <datalist id={PARTNERS_LIST}>
          {partners.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-xl">
          <AddAccountForm onClose={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          {editing && (
            <EditAccountForm key={editing.id} account={editing} onClose={() => setEditing(null)} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!!tools} onOpenChange={(o) => !o && setTools(null)}>
        <DialogContent className="max-w-lg">
          {tools && (
            <KeyAndLoadForm key={tools.id} account={tools} onClose={() => setTools(null)} />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
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

/** Их «Добавить рекламный кабинет». */
function AddAccountForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [vkId, setVkId] = useState("");
  const [brand, setBrand] = useState<string>(VK_BRANDS[0]);
  const [city, setCity] = useState("");
  const [partner, setPartner] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await createVkAccount({
        data: { name, vkAccountId: vkId, city, partnerName: partner, brand, token },
      });
      await invalidateVk(qc);
      toast.success("Кабинет сохранён.");
      onClose();
    } catch (e) {
      toast.error(`Не удалось сохранить кабинет: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить рекламный кабинет</DialogTitle>
        <DialogDescription>
          Ключ сохраняется зашифрованно и больше не показывается.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Название кабинета" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormField>
            <FormField label="ID VK Ads" required>
              <Input value={vkId} onChange={(e) => setVkId(e.target.value)} />
            </FormField>
            <FormField label="Бренд" required>
              <BrandSelect value={brand} onChange={setBrand} />
            </FormField>
            <FormField label="Город" required>
              <Input value={city} onChange={(e) => setCity(e.target.value)} list={CITIES_LIST} />
            </FormField>
            <FormField label="Партнёр" optional>
              <Input
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
                placeholder="Необязательно"
                list={PARTNERS_LIST}
              />
            </FormField>
            <FormField label="API-ключ" required className="sm:col-span-2">
              <Input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
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
            Сохранить кабинет
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/** Их форма «Город и партнёр» в строке кабинета: бренд, город, партнёр. */
function EditAccountForm({ account, onClose }: { account: VkAccountRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState(account.brand);
  const [city, setCity] = useState(account.city);
  const [partner, setPartner] = useState(account.partner_name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await vkRpc.update(account.id, city, partner, brand);
      await invalidateVk(qc);
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
        <DialogTitle>{account.name}</DialogTitle>
        <DialogDescription>Бренд, город и партнёр кабинета.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-3">
            <FormField label="Бренд" required>
              <BrandSelect value={brand} onChange={setBrand} />
            </FormField>
            <FormField label="Город">
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Найти город"
                list={CITIES_LIST}
              />
            </FormField>
            <FormField label="Партнёр">
              <Input
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
                placeholder="Найти партнёра"
                list={PARTNERS_LIST}
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
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Их «Ключ и загрузка»: новый API-ключ (история не меняется) и «Проверить
 * и загрузить» — ключ, расходы, кампании и связи ЛФ за период (по
 * умолчанию — с 1-го числа по сегодня, Москва).
 */
function KeyAndLoadForm({ account, onClose }: { account: VkAccountRow; onClose: () => void }) {
  const qc = useQueryClient();
  const today = mskToday();
  const [token, setToken] = useState("");
  const [range, setRange] = useState<DateRange | undefined>({
    from: toDate(`${today.slice(0, 8)}01`),
    to: toDate(today),
  });
  const [savingKey, setSavingKey] = useState(false);
  const [loading, setLoading] = useState(false);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      await setVkAccountToken({ data: { id: account.id, token } });
      setToken("");
      await invalidateVk(qc);
      toast.success("Ключ сохранён. Теперь запустите проверку и загрузку периода.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingKey(false);
    }
  };
  const load = async () => {
    if (!range?.from || !range.to) {
      toast.error("Выберите период.");
      return;
    }
    setLoading(true);
    try {
      const r = await syncVkAccountPeriod({
        data: { id: account.id, from: toIso(range.from), to: toIso(range.to) },
      });
      await invalidateVk(qc);
      toast.success(r.message);
    } catch (e) {
      toast.error((e as Error).message);
      await invalidateVk(qc);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Ключ и загрузка</DialogTitle>
        <DialogDescription>
          {account.name} · ID {account.vk_account_id}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <FormField label="Новый API-ключ VK Ads" required>
              <Input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </FormField>
            <Button type="submit" variant="outline" disabled={savingKey || loading}>
              {savingKey && <Loader2 className="animate-spin" />}
              Сохранить ключ
            </Button>
          </form>
          <div className="space-y-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Проверит ключ и загрузит расходы, кампании и связи ЛФ. История не удаляется.
            </p>
            <DateRangeFilter
              value={range}
              onChange={setRange}
              placeholder="Период"
              showLabel={false}
              title="Период загрузки"
            />
            <div>
              <Button onClick={() => void load()} disabled={loading || savingKey}>
                {loading && <Loader2 className="animate-spin" />}
                Проверить и загрузить
              </Button>
            </div>
            {loading && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Загружаю данные VK Ads — длинный период занимает до минуты.
              </p>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Закрыть
        </Button>
      </DialogFooter>
    </>
  );
}
