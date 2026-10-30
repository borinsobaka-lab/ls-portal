import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Copy, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsApiPageSkeleton } from "@/components/page-skeletons";
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
import { StatusChip } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { anApiQuery, anApiRpc } from "@/lib/analytics/admin-data";
import { formatMsk, newApiKey, sha256Hex } from "@/lib/analytics/core";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { GPT_API_BASE } from "@/lib/analytics/gpt-api";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/admin/api")({
  head: () => ({ meta: [{ title: "API для GPT — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsApiPageSkeleton,
  component: AnalyticsApiPage,
});

const TIPS = {
  active: "Отключённый ключ API не принимает — GPT получит «unauthorized».",
  requests: "Запросы с этим ключом за последние 30 дней.",
};

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Скопировано");
  } catch {
    toast.error("Не удалось скопировать — выделите и скопируйте вручную");
  }
};

/**
 * «Аналитика» → «API для GPT» (администратору аналитики) — их
 * analytics_api_keys / analytics_api_requests: ключи только для чтения
 * (у них ключ создавали командой на сервере) и журнал запросов. Сам API —
 * routes/api/analytics.
 */
function AnalyticsApiPage() {
  const qc = useQueryClient();
  const { data, error, isPending } = useQuery(anApiQuery);
  const [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const schemaUrl = `${origin}${GPT_API_BASE}/openapi.json`;

  const setActive = async (id: number, active: boolean) => {
    try {
      await anApiRpc.setActive(id, active);
      await qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "api"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <AdminShell
      title={AN_TITLES.api}
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Новый ключ
        </Button>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          Только чтение: каталог и агрегированные данные отчётов 1С «Выручка», «Продажи
          абонементов», «Занятия», «Воронка пробных» по всей сети — без персональных данных. В
          Custom GPT: Actions → Import from URL — адрес схемы ниже; Authentication — API Key, тип
          Bearer, ключ отсюда.
        </InfoNote>
        <section className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-muted-foreground">Схема OpenAPI</div>
            <div className="truncate font-mono text-sm">{schemaUrl}</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void copy(schemaUrl)}>
            <Copy />
            Скопировать
          </Button>
        </section>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Ключи</h2>
              <div className="rounded-lg border bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Название</TableHead>
                      <TableHead tip={TIPS.active}>Действует</TableHead>
                      <TableHead>Создан</TableHead>
                      <TableHead>Последнее использование</TableHead>
                      <TableHead tip={TIPS.requests}>Запросов за 30 дней</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isPending ? (
                      <TableSkeletonRows columns={5} rows={2} />
                    ) : (data?.keys ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="py-8 text-center text-sm text-muted-foreground"
                        >
                          Ключей пока нет. Нажмите «Новый ключ».
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.keys ?? []).map((k) => (
                        <TableRow key={k.id}>
                          <TableCell className="font-medium">{k.label}</TableCell>
                          <TableCell>
                            <Switch
                              checked={k.is_active}
                              onCheckedChange={(on) => void setActive(k.id, on)}
                              aria-label={
                                k.is_active ? `Отключить «${k.label}»` : `Включить «${k.label}»`
                              }
                            />
                          </TableCell>
                          <TableCell className="text-sm tabular-nums">
                            {formatMsk(k.created_at)}
                          </TableCell>
                          <TableCell className="text-sm tabular-nums">
                            {formatMsk(k.last_used_at)}
                          </TableCell>
                          <TableCell className="tabular-nums">{k.requests_30d}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Последние запросы</h2>
              <div className="rounded-lg border bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Когда</TableHead>
                      <TableHead>Ключ</TableHead>
                      <TableHead>Запрос</TableHead>
                      <TableHead>Ответ</TableHead>
                      <TableHead>Размер</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isPending ? (
                      <TableSkeletonRows columns={5} rows={3} />
                    ) : (data?.requests ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="py-8 text-center text-sm text-muted-foreground"
                        >
                          Запросов пока не было.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.requests ?? []).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-sm whitespace-nowrap tabular-nums">
                            {formatMsk(r.requested_at)}
                          </TableCell>
                          <TableCell className="text-sm">{r.label ?? "без ключа"}</TableCell>
                          <TableCell className="max-w-md font-mono text-xs break-all">
                            {r.method} {r.path}
                            {r.query ? `?${r.query}` : ""}
                          </TableCell>
                          <TableCell>
                            <StatusChip tone={r.status_code < 400 ? "positive" : "negative"}>
                              {r.status_code}
                            </StatusChip>
                          </TableCell>
                          <TableCell className="text-sm tabular-nums">
                            {formatBytes(r.response_bytes)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          </>
        )}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <NewKeyForm onClose={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

/** Новый ключ: создаёт браузер, в базу уходит только хеш; ключ показывается один раз. */
function NewKeyForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!label.trim()) {
      toast.error("Укажите название ключа.");
      return;
    }
    setSaving(true);
    try {
      const raw = newApiKey();
      await anApiRpc.create(label.trim(), await sha256Hex(raw));
      setKey(raw);
      await qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "api"] });
    } catch (e) {
      toast.error("Не удалось создать ключ", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (key) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Ключ «{label.trim()}» создан</DialogTitle>
          <DialogDescription>
            Скопируйте его сейчас: ключ показывается один раз, в портале хранится только его
            отпечаток.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all">
              {key}
            </div>
            <InfoNote variant="warning">
              Не пересылайте ключ в чатах и почте: с ним можно читать данные отчётов.
            </InfoNote>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy(key)}>
            <Copy />
            Скопировать
          </Button>
          <Button onClick={onClose}>Готово</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новый ключ API</DialogTitle>
        <DialogDescription>Бессрочный ключ только для чтения — для Custom GPT.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={create}>
        <DialogBody>
          <FormField
            label="Название"
            required
            tip="Для кого или для чего ключ — видно в журнале запросов."
          >
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Например, GPT владельца"
              autoFocus
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Создать ключ
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
