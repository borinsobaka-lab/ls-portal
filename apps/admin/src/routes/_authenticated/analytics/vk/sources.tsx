import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsVkSourcesPageSkeleton } from "@/components/page-skeletons";
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
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import {
  invalidateVk,
  VK_BRANDS,
  vkRpc,
  vkSsSourcesQuery,
  type VkSsSource,
} from "@/lib/analytics/vk/data";
import {
  deleteGoogleServiceAccount,
  saveGoogleServiceAccount,
  syncSs,
  verifySs,
} from "@/lib/analytics/vk-ss.functions";

export const Route = createFileRoute("/_authenticated/analytics/vk/sources")({
  head: () => ({ meta: [{ title: "Источники СС — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkSourcesPageSkeleton,
  component: AnalyticsVkSourcesPage,
});

const CITIES_LIST = "vk-ss-cities";

/**
 * «Аналитика» → «VK Ads» → «Источники СС» (администратору аналитики) — их
 * community_sources_page: на бренд и город две Google-таблицы (лиды СС —
 * лист «Сбор лидов», заявки СС — лист «Номера»); из них раз в час берутся
 * только счётчики строк по дням для реестра таргета, сами таблицы не
 * меняются. Доступ к таблицам — через сервисный аккаунт Google (его ключ
 * загружается здесь и хранится зашифрованно).
 */
function AnalyticsVkSourcesPage() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data, error, isPending } = useQuery(vkSsSourcesQuery);
  const [adding, setAdding] = useState<VkSsSource | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sources = data?.sources ?? [];

  const act = async (s: VkSsSource, kind: "sync" | "verify" | "delete") => {
    if (kind === "delete") {
      const ok = await confirm({
        title: `Удалить источники «${s.brand} · ${s.city}»?`,
        description: "Загруженные счётчики СС в реестре останутся.",
        confirmLabel: "Удалить",
      });
      if (!ok) return;
    }
    setBusy(`${kind}|${s.brand}|${s.city}`);
    try {
      if (kind === "delete") {
        await vkRpc.deleteSsSource(s.brand, s.city);
        toast.success("Источники СС удалены.");
      } else {
        const fn = kind === "sync" ? syncSs : verifySs;
        const r = await fn({ data: { brand: s.brand, city: s.city } });
        toast.success(r.message);
      }
      await invalidateVk(qc);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const spin = (k: string) => busy === k && <Loader2 className="animate-spin" />;

  return (
    <AdminShell
      title={AN_TITLES.vkSources}
      actions={
        <Button onClick={() => setAdding("new")}>
          <Plus />
          Добавить источник
        </Button>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          Закрытые настройки для администратора. На каждый бренд и город укажите две таблицы: лиды
          СС и заявки СС. Исходные таблицы не изменяются: раз в час из них берутся только счётчики
          строк по дням (лиды — лист «Сбор лидов», дата в колонке C; заявки — лист «Номера», дата в
          колонке D).
        </InfoNote>
        <GoogleKeyCard google={data?.google ?? null} loading={isPending} />
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <section className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-lg font-semibold">Подключённые источники</h2>
              <span className="text-xs text-muted-foreground">
                Повторное сохранение бренда и города заменит их ссылки
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Бренд</TableHead>
                  <TableHead>Город</TableHead>
                  <TableHead>Лиды СС</TableHead>
                  <TableHead>Заявки СС</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={5} rows={6} />
                ) : sources.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Источники пока не добавлены.
                    </TableCell>
                  </TableRow>
                ) : (
                  sources.map((s) => {
                    const k = `${s.brand}|${s.city}`;
                    return (
                      <TableRow key={k}>
                        <TableCell className="font-medium whitespace-nowrap">{s.brand}</TableCell>
                        <TableCell className="font-medium">
                          {s.city}
                          {!s.is_active && (
                            <StatusChip size="sm" tone="neutral" className="ml-2">
                              Выключен
                            </StatusChip>
                          )}
                        </TableCell>
                        <TableCell>
                          <SheetLink url={s.leads_sheet_url}>Открыть таблицу лидов</SheetLink>
                        </TableCell>
                        <TableCell>
                          <SheetLink url={s.applications_sheet_url}>
                            Открыть таблицу заявок
                          </SheetLink>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => void act(s, "sync")}
                          >
                            {spin(`sync|${k}`) || <RefreshCw />}
                            Загрузить данные СС
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void act(s, "verify")}
                          >
                            {spin(`verify|${k}`) || <ShieldCheck />}
                            Проверить доступ
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Изменить ссылки"
                            onClick={() => setAdding(s)}
                          >
                            Ссылки
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Удалить"
                            aria-label="Удалить источники"
                            disabled={busy !== null}
                            onClick={() => void act(s, "delete")}
                          >
                            {spin(`delete|${k}`) || <Trash2 />}
                          </Button>
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
      <datalist id={CITIES_LIST}>
        {(data?.cities ?? []).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent className="sm:max-w-lg">
          {adding !== null && (
            <SourceForm
              current={adding === "new" ? null : adding}
              onClose={() => setAdding(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

function SheetLink({ url, children }: { url: string; children: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-brand-on-light underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

/** Ключ сервисного аккаунта Google: почта аккаунта, загрузка JSON, удаление. */
function GoogleKeyCard({
  google,
  loading,
}: {
  google: { client_email: string; updated_at: string | null } | null;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 20_000)
        throw new Error("Ключ Google Sheets повреждён: нужен JSON-файл сервисного аккаунта.");
      const r = await saveGoogleServiceAccount({ data: { json: await file.text() } });
      await invalidateVk(qc);
      toast.success(`Ключ сохранён: ${r.clientEmail}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: "Удалить ключ Google?",
      description: "Без ключа источники СС не загружаются.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteGoogleServiceAccount();
      await invalidateVk(qc);
      toast.success("Ключ удалён.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 font-semibold">
            <KeyRound className="size-4" aria-hidden />
            Сервисный аккаунт Google
          </h2>
          {loading ? (
            <p className="text-sm text-muted-foreground">Загрузка…</p>
          ) : google ? (
            <p className="text-sm">
              <span className="font-medium break-all">{google.client_email}</span>
              <span className="text-muted-foreground">
                {" "}
                · обновлён {formatMsk(google.updated_at)}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ключ не загружен — источники СС не читаются.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            JSON-ключ сервисного аккаунта из Google Cloud (Sheets API). Откройте этому аккаунту
            доступ к таблицам лидов и заявок (читателем или редактором). Ключ хранится зашифрованно
            и больше не показывается.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            {busy && <Loader2 className="animate-spin" />}
            {google ? "Заменить ключ" : "Загрузить ключ"}
          </Button>
          {google && (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              Удалить
            </Button>
          )}
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

/** Их «Добавить или обновить источник». */
function SourceForm({ current, onClose }: { current: VkSsSource | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(current?.brand ?? VK_BRANDS[0]);
  const [city, setCity] = useState(current?.city ?? "");
  const [leads, setLeads] = useState(current?.leads_sheet_url ?? "");
  const [apps, setApps] = useState(current?.applications_sheet_url ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await vkRpc.saveSsSource(brand, city, leads, apps);
      await invalidateVk(qc);
      toast.success("Источники СС сохранены.");
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
        <DialogTitle>{current ? "Ссылки источника" : "Добавить или обновить источник"}</DialogTitle>
        <DialogDescription>
          Повторное сохранение бренда и города заменит их ссылки.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Бренд" required>
              <Select value={brand} onValueChange={setBrand} disabled={!!current}>
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
                disabled={!!current}
                required
                autoFocus={!current}
              />
            </FormField>
            <FormField label="Ссылка на таблицу лидов СС" required className="sm:col-span-2">
              <Input
                type="url"
                value={leads}
                onChange={(e) => setLeads(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                required
              />
            </FormField>
            <FormField label="Ссылка на таблицу заявок СС" required className="sm:col-span-2">
              <Input
                type="url"
                value={apps}
                onChange={(e) => setApps(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
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
            Сохранить источники
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
