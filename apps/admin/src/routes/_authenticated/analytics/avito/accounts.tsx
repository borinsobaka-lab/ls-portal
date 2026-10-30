import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { History, KeyRound, Loader2, Network, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsAvitoAccountsPageSkeleton } from "@/components/page-skeletons";
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
import {
  checkAvito,
  loadAvitoHistory,
  saveAvitoAccount,
  setAvitoCredentials,
  syncAvitoStructureFn,
} from "@/lib/analytics/avito.functions";
import {
  avitoAccountsQuery,
  avitoRpc,
  invalidateAvito,
  type AvitoAccountRow,
} from "@/lib/analytics/avito/data";
import { AVITO_BRANDS, avitoCheckStatus, avitoSummaryText } from "@/lib/analytics/avito/rules";
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/avito/accounts")({
  head: () => ({ meta: [{ title: "Кабинеты Авито — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsAvitoAccountsPageSkeleton,
  component: AnalyticsAvitoAccountsPage,
});

const TIPS = {
  api: "Последняя проверка ключей: токен Авито, аккаунт и списки кампаний, групп и креативов (только чтение).",
  structure: "Сколько кампаний, групп и креативов вернула Авито при последней проверке.",
  stats: "Последний день, за который в портале есть статистика кампаний кабинета.",
};

type Busy = { id: number; action: "check" | "structure" | "history" | "delete" } | null;

/**
 * «Аналитика» → «Авито» → «Кабинеты Авито» (администратору аналитики) — их
 * avito_ads_page: подключение кабинета (client_id и client_secret хранятся
 * зашифрованно и больше не показываются), проверка API, загрузка структуры
 * «кампания → группа → креатив» и истории статистики, замена ключей,
 * удаление подключения (в Авито ничего не меняется). Статистику за вчера
 * собирает фоновая задача раз в час.
 */
function AnalyticsAvitoAccountsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const { data, isPending, error } = useQuery(avitoAccountsQuery);
  const [adding, setAdding] = useState(false);
  const [keys, setKeys] = useState<AvitoAccountRow | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const rows = data ?? [];

  const run = async (
    a: AvitoAccountRow,
    action: NonNullable<Busy>["action"],
    fn: () => Promise<{ message: string; from?: string; to?: string }>,
  ) => {
    setBusy({ id: a.id, action });
    try {
      const r = await fn();
      toast.success(r.message);
      if (action === "history" && r.from && r.to) {
        void navigate({ to: "/analytics/avito/register", search: { from: r.from, to: r.to } });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await invalidateAvito(qc);
      setBusy(null);
    }
  };
  const remove = async (a: AvitoAccountRow) => {
    const ok = await confirm({
      title: `Удалить «${a.name}»?`,
      description:
        "Удалить подключение Авито из портала? Кабинет, кампании и данные в Авито не изменятся.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    await run(a, "delete", async () => {
      await avitoRpc.remove(a.id);
      return { message: "Подключение удалено из портала." };
    });
  };
  const spin = (a: AvitoAccountRow, action: NonNullable<Busy>["action"]) =>
    busy?.id === a.id && busy.action === action;

  return (
    <AdminShell
      title={AN_TITLES.avitoAccounts}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Подключить кабинет
        </Button>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          Безопасное подключение кабинетов для реестра: доступ к API и структура «кампания → группа
          → креатив». Портал хранит client_id и client_secret только в зашифрованном виде. Ключ
          больше не показывается после сохранения. Статистику кампаний за вчера собирает фоновая
          задача раз в час.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <section className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="text-lg font-semibold">Подключённые кабинеты</h2>
                <p className="text-sm text-muted-foreground">
                  Проверка выполняет только чтение. «Структура» сохраняет в портале связку «кампания
                  → группа → креатив» для отдельного реестра.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{rows.length} в справочнике</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Кабинет</TableHead>
                  <TableHead>Направление</TableHead>
                  <TableHead>Город</TableHead>
                  <TableHead tip={TIPS.api}>API</TableHead>
                  <TableHead tip={TIPS.structure}>Структура</TableHead>
                  <TableHead tip={TIPS.stats}>Статистика</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={7} rows={4} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Кабинетов пока нет.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => {
                    const status = avitoCheckStatus(a.last_check_status, a.last_checked_at);
                    return (
                      <TableRow key={a.id}>
                        <TableCell>
                          <div className="font-medium">{a.name}</div>
                          <div className="text-xs text-muted-foreground">
                            ID: {a.avito_account_id}
                          </div>
                        </TableCell>
                        <TableCell>{a.brand}</TableCell>
                        <TableCell>{a.city}</TableCell>
                        <TableCell>
                          <StatusChip
                            tone={
                              status === "проверен"
                                ? "positive"
                                : status === "не проверен"
                                  ? "neutral"
                                  : "negative"
                            }
                          >
                            {status}
                          </StatusChip>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatMsk(a.last_checked_at)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {avitoSummaryText(a.last_check_summary)}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {a.stats_to
                            ? `по ${a.stats_to.slice(8, 10)}.${a.stats_to.slice(5, 7)}.${a.stats_to.slice(0, 4)}`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() => setKeys(a)}
                            >
                              <KeyRound />
                              Заменить API
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(a, "history", () =>
                                  loadAvitoHistory({ data: { id: a.id } }),
                                )
                              }
                            >
                              {spin(a, "history") ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <History />
                              )}
                              Загрузить историю
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(a, "structure", () =>
                                  syncAvitoStructureFn({ data: { id: a.id } }),
                                )
                              }
                            >
                              {spin(a, "structure") ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Network />
                              )}
                              Структура
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(a, "check", () => checkAvito({ data: { id: a.id } }))
                              }
                            >
                              {spin(a, "check") ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <ShieldCheck />
                              )}
                              Проверить API
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Удалить подключение"
                              aria-label="Удалить подключение"
                              disabled={busy !== null}
                              onClick={() => void remove(a)}
                            >
                              {spin(a, "delete") ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Trash2 />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-xl">
          {adding && <AccountForm onClose={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={keys !== null} onOpenChange={(o) => !o && setKeys(null)}>
        <DialogContent className="sm:max-w-md">
          {keys && <KeysForm key={keys.id} account={keys} onClose={() => setKeys(null)} />}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

/** Их «Подключить кабинет Авито». */
function AccountForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    avitoAccountId: "",
    brand: "Lady Stretch",
    city: "",
    clientId: "",
    clientSecret: "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveAvitoAccount({ data: form });
      await invalidateAvito(qc);
      toast.success(r.message);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={save}>
      <DialogHeader>
        <DialogTitle>Подключить кабинет Авито</DialogTitle>
        <DialogDescription>
          Портал хранит client_id и client_secret только в зашифрованном виде. Ключ больше не
          показывается после сохранения. Тот же ID аккаунта — обновление подключения.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Название кабинета" required>
            <Input
              required
              value={form.name}
              onChange={set("name")}
              placeholder="Жуковский Джамп Авито"
            />
          </FormField>
          <FormField label="ID аккаунта Авито" required>
            <Input
              required
              inputMode="numeric"
              value={form.avitoAccountId}
              onChange={set("avitoAccountId")}
            />
          </FormField>
          <FormField label="Направление" required>
            <Select value={form.brand} onValueChange={(v) => setForm((f) => ({ ...f, brand: v }))}>
              <SelectTrigger aria-label="Направление">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVITO_BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Город" required>
            <Input required value={form.city} onChange={set("city")} placeholder="Жуковский" />
          </FormField>
          <FormField label="client_id" required>
            <Input required autoComplete="off" value={form.clientId} onChange={set("clientId")} />
          </FormField>
          <FormField label="client_secret" required>
            <Input
              required
              type="password"
              autoComplete="new-password"
              value={form.clientSecret}
              onChange={set("clientSecret")}
            />
          </FormField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить подключение
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

/** Их «Заменить API»: новые ключи, история и настройки сохранятся. */
function KeysForm({ account, onClose }: { account: AvitoAccountRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const r = await setAvitoCredentials({ data: { id: account.id, clientId, clientSecret } });
      await invalidateAvito(qc);
      toast.success(r.message);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={save}>
      <DialogHeader>
        <DialogTitle>Заменить API · {account.name}</DialogTitle>
        <DialogDescription>
          Новые ключи для этого кабинета. История и настройки сохранятся.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-3">
          <FormField label="Новый client_id" required>
            <Input
              required
              autoComplete="off"
              maxLength={200}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </FormField>
          <FormField label="Новый client_secret" required>
            <Input
              required
              type="password"
              autoComplete="new-password"
              maxLength={200}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </FormField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить новые ключи
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
