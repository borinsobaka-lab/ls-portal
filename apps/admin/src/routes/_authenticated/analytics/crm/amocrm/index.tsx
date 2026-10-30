import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Loader2, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsAmoPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createAmoConnection, verifyAmoConnection } from "@/lib/analytics/amo.functions";
import {
  amoConnectionsQuery,
  invalidateAmo,
  type AmoConnectionRow,
} from "@/lib/analytics/amo/data";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/crm/amocrm/")({
  head: () => ({ meta: [{ title: "Интеграция amoCRM — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsAmoPageSkeleton,
  component: AnalyticsAmoPage,
});

/**
 * «Аналитика» → «CRM» → «Интеграция amoCRM» (администратору аналитики) —
 * их amocrm_page: подключение — только адрес amoCRM и долгоживущий токен
 * интеграции (зашифрованно, больше не показывается); города, партнёры,
 * направления и воронки настраиваются в подключении по ответственным.
 */
function AnalyticsAmoPage() {
  const { data, error, isPending } = useQuery(amoConnectionsQuery);
  return (
    <AdminShell title={AN_TITLES.amo}>
      <div className="max-w-5xl space-y-4">
        <InfoNote>
          Административная настройка подключения. Новый портал подключается к amoCRM сам — токены
          старого портала не используются.
        </InfoNote>
        <CreateCard />
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <ConnectionsCard rows={data ?? []} loading={isPending} />
        )}
      </div>
    </AdminShell>
  );
}

/** Их «Подключить AmoCRM». */
function CreateCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", baseUrl: "", token: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await createAmoConnection({ data: form });
      setForm({ name: "", baseUrl: "", token: "" });
      await invalidateAmo(qc);
      toast.success(r.message);
    } catch (err) {
      toast.error(`Не удалось сохранить подключение: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div>
        <h2 className="font-semibold">Подключить amoCRM</h2>
        <p className="text-sm text-muted-foreground">
          Подключение содержит только CRM и ключ доступа. Города, партнёры, направления и воронки
          настраиваются отдельно по ответственным amoCRM.
        </p>
      </div>
      <form className="space-y-3" onSubmit={(e) => void save(e)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Название подключения" required>
            <Input
              required
              value={form.name}
              onChange={set("name")}
              placeholder="Например, Общая amoCRM партнёров"
            />
          </FormField>
          <FormField label="Адрес amoCRM" required>
            <Input
              required
              type="url"
              autoComplete="url"
              value={form.baseUrl}
              onChange={set("baseUrl")}
              placeholder="https://ваш-поддомен.amocrm.ru"
            />
          </FormField>
          <FormField
            label="Долгоживущий токен интеграции"
            required
            className="sm:col-span-2"
            hint="Токен сохраняется в зашифрованном виде. Он не выводится в интерфейсе, журнале действий или исходном коде."
          >
            <Input
              required
              type="password"
              autoComplete="new-password"
              value={form.token}
              onChange={set("token")}
              placeholder="Токен не будет показан после сохранения"
            />
          </FormField>
        </div>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Сохранить подключение
        </Button>
      </form>
    </section>
  );
}

function verificationOf(r: AmoConnectionRow) {
  if (r.last_verification_status === 200) {
    return {
      chip: <StatusChip tone="positive">Подключено</StatusChip>,
      detail: r.last_verification_details || "Доступ подтверждён",
    };
  }
  if (r.last_verification_status) {
    return {
      chip: <StatusChip tone="negative">Ошибка проверки</StatusChip>,
      detail: r.last_verification_details || `HTTP ${r.last_verification_status}`,
    };
  }
  return {
    chip: <StatusChip tone="neutral">Не проверено</StatusChip>,
    detail: "После сохранения проверьте соединение.",
  };
}

/** Их «Подключения AmoCRM». */
function ConnectionsCard({ rows, loading }: { rows: AmoConnectionRow[]; loading: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const verify = async (id: number) => {
    setBusy(id);
    try {
      const r = await verifyAmoConnection({ data: { id } });
      toast.success(r.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await invalidateAmo(qc);
      setBusy(null);
    }
  };
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Подключения amoCRM</h2>
        <span className="text-xs text-muted-foreground">{rows.length} в справочнике</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Подключение</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={3} rows={3} />
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                Подключений пока нет.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const v = verificationOf(r);
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{r.base_url}</div>
                  </TableCell>
                  <TableCell>
                    {v.chip}
                    <div className="mt-1 text-xs text-muted-foreground">{v.detail}</div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        to="/analytics/crm/amocrm/$connectionId"
                        params={{ connectionId: String(r.id) }}
                      >
                        <Settings2 />
                        Настроить
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void verify(r.id)}
                    >
                      {busy === r.id ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                      Проверить
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </section>
  );
}
