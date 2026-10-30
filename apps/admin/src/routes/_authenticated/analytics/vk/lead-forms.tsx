import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsVkLeadFormsPageSkeleton } from "@/components/page-skeletons";
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
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { invalidateVk, vkLfOverviewQuery, type VkLfOverview } from "@/lib/analytics/vk/data";
import {
  createLeadFormSheets,
  finishDriveConnect,
  saveDriveClient,
  startDriveConnect,
} from "@/lib/analytics/vk-lf.functions";

type LfSearch = { code?: string; state?: string; error?: string };

export const Route = createFileRoute("/_authenticated/analytics/vk/lead-forms")({
  head: () => ({ meta: [{ title: "Сбор лид-форм — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): LfSearch => ({
    code: typeof s.code === "string" ? s.code : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  pendingComponent: AnalyticsVkLeadFormsPageSkeleton,
  component: AnalyticsVkLeadFormsPage,
});

/**
 * «Аналитика» → «VK Ads» → «Сбор лид-форм» (администратору аналитики) — их
 * lead_forms_page: для каждого рекламного кабинета — своя Google-таблица в
 * общей папке Drive; новые заявки (с момента создания таблицы, без истории)
 * записываются каждые 5 минут. Google возвращает сюда после входа
 * (?code=&state=) — подключение завершает сервер.
 */
function AnalyticsVkLeadFormsPage() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, error, isPending } = useQuery(vkLfOverviewQuery);
  const finishing = useRef(false);
  const [connecting, setConnecting] = useState(false);

  // Возврат из Google: завершить подключение и убрать код из адреса.
  useEffect(() => {
    if (finishing.current || (!search.code && !search.error && !search.state)) return;
    finishing.current = true;
    const { code, state, error: denied } = search;
    void navigate({ search: {}, replace: true });
    if (denied || !code || !state) {
      toast.error("Google Drive не подтвердил подключение.");
      return;
    }
    setConnecting(true);
    finishDriveConnect({ data: { code, state } })
      .then(async (r) => {
        await invalidateVk(qc);
        toast.success(r.message);
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setConnecting(false));
  }, [search, navigate, qc]);

  return (
    <AdminShell title={AN_TITLES.vkLeadForms}>
      <div className="max-w-5xl space-y-4">
        <InfoNote>
          Для каждого рекламного кабинета создаётся отдельная таблица. Исторические заявки не
          загружаются: сбор начнётся с момента создания.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            <DriveCard data={data} loading={isPending || connecting} />
            <CreateCard data={data} />
            <SourcesCard data={data} loading={isPending} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

/** Их «1. Подключение Google Drive» (+ OAuth-клиент — у них файл на сервере). */
function DriveCard({ data, loading }: { data?: VkLfOverview; loading: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"client" | "connect" | null>(null);
  const drive = data?.drive;
  const status = !drive ? "…" : drive.connected ? "подключён" : "не подключён";

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy("client");
    try {
      await saveDriveClient({ data: { json: await file.text() } });
      await invalidateVk(qc);
      toast.success("OAuth-клиент Google Drive сохранён.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };
  const connect = async () => {
    setBusy("connect");
    try {
      const { url } = await startDriveConnect();
      window.location.assign(url);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div>
        <h2 className="font-semibold">1. Подключение Google Drive</h2>
        <p className="text-sm text-muted-foreground">
          Статус: <b className="text-foreground">{loading ? "проверяем…" : status}</b>. Google
          откроет знакомое окно входа один раз.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Сначала — OAuth-клиент из Google Cloud (тип «Веб-приложение», JSON): адрес возврата —
          страница «Сбор лид-форм» портала (адрес портала + /analytics/vk/lead-forms).{" "}
          {drive?.client ? "Клиент загружен." : "Клиент не загружен."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <Button variant="outline" disabled={busy !== null} onClick={() => input.current?.click()}>
          {busy === "client" ? <Loader2 className="animate-spin" /> : <FileUp />}
          {drive?.client ? "Заменить OAuth-клиент" : "Загрузить OAuth-клиент"}
        </Button>
        <Button disabled={busy !== null || !drive?.client} onClick={() => void connect()}>
          {busy === "connect" && <Loader2 className="animate-spin" />}
          {drive?.connected ? "Переподключить Google Drive" : "Подключить Google Drive"}
        </Button>
      </div>
    </section>
  );
}

/** Их «2. Создание таблиц». */
function CreateCard({ data }: { data?: VkLfOverview }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const folder = data?.drive.folder_id
    ? `https://drive.google.com/drive/folders/${data.drive.folder_id}`
    : "";
  const value = url || folder;

  const create = async () => {
    setBusy(true);
    try {
      const r = await createLeadFormSheets({ data: { folderUrl: value } });
      await invalidateVk(qc);
      toast.success(r.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <h2 className="font-semibold">2. Создание таблиц</h2>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <FormField label="Ссылка на общую папку Drive" required>
          <Input
            type="url"
            required
            value={value}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
          />
        </FormField>
        <p className="text-sm text-muted-foreground">
          Папка уже должна быть расшарена редактором на сервисный аккаунт (его почта — на странице{" "}
          <Link
            to="/analytics/vk/sources"
            className="font-medium text-foreground underline underline-offset-2"
          >
            «Источники СС»
          </Link>
          ). Существующие таблицы не заменяются.
        </p>
        {data && !data.sheets_key && (
          <InfoNote variant="warning">
            Ключ сервисного аккаунта Google не загружен — без него заявки не записать.
          </InfoNote>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !data?.drive.connected}>
            {busy && <Loader2 className="animate-spin" />}
            Создать таблицы для всех кабинетов
          </Button>
          <span className="text-sm text-muted-foreground">
            Активных кабинетов: {data?.active_accounts ?? "…"}
          </span>
        </div>
      </form>
    </section>
  );
}

/** Их «Подключённые таблицы» + сколько заявок записано, ждут, с ошибкой. */
function SourcesCard({ data, loading }: { data?: VkLfOverview; loading: boolean }) {
  const sources = data?.sources ?? [];
  const last = data?.collector_last;
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Подключённые таблицы</h2>
        <span className="text-xs text-muted-foreground">
          Новые заявки записываются каждые 5 минут
        </span>
      </div>
      {data && !data.collector_enabled && (
        <div className="border-b px-4 py-3">
          <InfoNote variant="warning">
            Запись заявок в таблицы выключена: старый портал аналитики пишет заявки в свои таблицы
            параллельно. Включите задачу «VK Ads: новые заявки лид-форм в Google-таблицы» на{" "}
            <Link to="/analytics/admin/jobs" className="font-medium underline underline-offset-2">
              «Фоновых задачах»
            </Link>
            , когда эти таблицы должны начать заполняться. Счётчики заявок ЛФ для реестра таргета
            считаются отдельно и без неё.
          </InfoNote>
        </div>
      )}
      {data?.collector_enabled && last?.at && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Последний сбор: {formatMsk(last.at)} — {last.message}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Город</TableHead>
            <TableHead>Кабинет</TableHead>
            <TableHead>Таблица</TableHead>
            <TableHead>Старт сбора</TableHead>
            <TableHead tip="Записано в таблицу / ждут записи / с ошибкой записи.">Заявки</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={5} rows={6} />
          ) : sources.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                Таблицы ещё не созданы.
              </TableCell>
            </TableRow>
          ) : (
            sources.map((s) => (
              <TableRow key={s.account_id}>
                <TableCell className="font-medium">{s.city || "Город не назначен"}</TableCell>
                <TableCell>
                  {s.name}
                  {!s.is_active && (
                    <StatusChip size="sm" tone="neutral" className="ml-2">
                      Отключён
                    </StatusChip>
                  )}
                </TableCell>
                <TableCell>
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-brand-on-light underline-offset-4 hover:underline"
                  >
                    Открыть
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatMsk(s.starts_at)}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap tabular-nums"
                  title={s.last_error ?? undefined}
                >
                  {s.sent} / {s.pending} /{" "}
                  <span className={s.errors ? "font-medium text-destructive" : undefined}>
                    {s.errors}
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}
