import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { DataPagination, DEFAULT_PAGE_SIZE } from "@/components/data-pagination";
import { AnalyticsQuizLeadsPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
  invalidateQuiz,
  quizLeadsQuery,
  quizRpc,
  type QuizLeadRow,
} from "@/lib/analytics/quiz/data";
import { QUIZ_UTM_FIELDS } from "@/lib/analytics/quiz/rules";
import { cn } from "@/lib/utils";

type LeadStatus = "all" | "pending" | "sent" | "error";
const STATUSES: { value: LeadStatus; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "pending", label: "Ждут" },
  { value: "sent", label: "В таблице" },
  { value: "error", label: "С ошибкой" },
];
const isStatus = (v: unknown): v is LeadStatus => STATUSES.some((s) => s.value === v);
const ALL_CITIES = "__all";

export const Route = createFileRoute("/_authenticated/analytics/quiz/leads")({
  head: () => ({ meta: [{ title: "Заявки квиза — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): { city?: string; status?: LeadStatus } => ({
    city: typeof s.city === "string" && s.city ? s.city : undefined,
    status: isStatus(s.status) && s.status !== "all" ? s.status : undefined,
  }),
  pendingComponent: AnalyticsQuizLeadsPageSkeleton,
  component: AnalyticsQuizLeadsPage,
});

const TIPS = {
  answers: "Ответы на три вопроса теста: запрос, длительность, барьер.",
  utm: "UTM-метки из ссылки, по которой открыли лендинг.",
  sheet:
    "Записана ли заявка в Google-таблицу города. Ошибка — текст от Google или «не настроена таблица»; заявка уйдёт со следующим запуском задачи.",
};

/**
 * «Аналитика» → «Квиз» → «Заявки квиза» (администратору аналитики): их
 * quiz_leads — заявки лендинга новыми сверху, состояние записи в таблицу
 * города (sheet_synced_at / sheet_error). У них заявки видны только в
 * таблицах; здесь — чтобы видеть их до включения записи и убирать тестовые.
 */
function AnalyticsQuizLeadsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const city = search.city ?? "";
  const status = search.status ?? "all";
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [busy, setBusy] = useState<number | null>(null);
  const { data, error, isPending, isFetching } = useQuery(
    quizLeadsQuery(city, status === "all" ? "" : status, page, pageSize),
  );
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const cities = data?.cities ?? [];

  const setFilters = (next: { city?: string; status?: LeadStatus }) => {
    setPage(1);
    void navigate({
      search: (prev) => {
        const merged = { ...prev, ...next };
        return {
          city: merged.city || undefined,
          status: merged.status && merged.status !== "all" ? merged.status : undefined,
        };
      },
    });
  };
  const remove = async (lead: QuizLeadRow) => {
    const ok = await confirm({
      title: `Удалить заявку №${lead.id}?`,
      description: `${lead.name}, ${lead.city}. Заявка удалится с портала${
        lead.sheet_synced_at ? "; в Google-таблице её строка останется" : " и не уйдёт в таблицу"
      }.`,
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setBusy(lead.id);
    try {
      await quizRpc.removeLead(lead.id);
      await invalidateQuiz(qc);
      toast.success("Заявка удалена.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell title={AN_TITLES.quizLeads}>
      <div className="space-y-4">
        <InfoNote>
          Заявки квиз-лендинга, новые сверху; время — московское, как в их таблицах. Заявка с
          ошибкой записи останавливает отправку следующих (как у них) — настройте таблицу города или
          удалите заявку.
        </InfoNote>
        <TableToolbar>
          <Select
            value={city || ALL_CITIES}
            onValueChange={(v) => setFilters({ city: v === ALL_CITIES ? "" : v })}
          >
            <SelectTrigger className="w-52" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CITIES}>Все города</SelectItem>
              {(city && !cities.includes(city) ? [city, ...cities] : cities).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SegmentedControl
            aria-label="Запись в таблицу"
            value={status}
            onChange={(v) => setFilters({ status: v })}
            options={STATUSES}
          />
          <ToolbarReset
            active={Boolean(city) || status !== "all"}
            onReset={() => setFilters({ city: "", status: "all" })}
          />
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div
            className={cn(
              "rounded-lg border bg-background",
              isFetching && !isPending && "opacity-60 transition-opacity",
            )}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата и время</TableHead>
                  <TableHead>Город</TableHead>
                  <TableHead>Имя и телефон</TableHead>
                  <TableHead>Рекомендация</TableHead>
                  <TableHead tip={TIPS.answers}>Ответы</TableHead>
                  <TableHead tip={TIPS.utm}>UTM</TableHead>
                  <TableHead tip={TIPS.sheet}>Таблица</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={8} rows={8} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Заявок нет
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm whitespace-nowrap tabular-nums">
                        {formatMsk(r.created_at)}
                        <div className="text-xs text-muted-foreground">№{r.id}</div>
                      </TableCell>
                      <TableCell className="text-sm">{r.city}</TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium">{r.name}</div>
                        <div className="whitespace-nowrap tabular-nums">{r.phone}</div>
                      </TableCell>
                      <TableCell className="max-w-56 text-sm">{r.recommendation || "—"}</TableCell>
                      <TableCell className="max-w-64 text-xs text-muted-foreground">
                        {[r.pain, r.duration, r.barrier].filter(Boolean).map((a, i) => (
                          <div key={i}>{a}</div>
                        ))}
                      </TableCell>
                      <TableCell className="max-w-56 text-xs break-words text-muted-foreground">
                        <UtmList utm={r.utm} />
                      </TableCell>
                      <TableCell className="max-w-56 text-sm">
                        {r.sheet_synced_at ? (
                          <>
                            <StatusChip tone="positive">в таблице</StatusChip>
                            <div className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
                              {formatMsk(r.sheet_synced_at)}
                            </div>
                          </>
                        ) : r.sheet_error ? (
                          <>
                            <StatusChip tone="negative">ошибка</StatusChip>
                            <div className="mt-1 text-xs break-words text-muted-foreground">
                              {r.sheet_error}
                            </div>
                          </>
                        ) : (
                          <StatusChip tone="neutral">ждёт</StatusChip>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Удалить заявку"
                          aria-label="Удалить заявку"
                          disabled={busy !== null}
                          onClick={() => void remove(r)}
                        >
                          {busy === r.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination
              page={page}
              pageCount={Math.max(1, Math.ceil(total / pageSize))}
              pageSize={pageSize}
              total={total}
              setPage={setPage}
              setPageSize={(s) => {
                setPageSize(s);
                setPage(1);
              }}
              loading={isPending}
            />
          </div>
        )}
      </div>
      {confirmDialog}
    </AdminShell>
  );
}

/** UTM заявки: сначала их шесть полей по порядку таблицы, затем прочие utm_*. */
function UtmList({ utm }: { utm: Record<string, string> }) {
  const keys = [
    ...QUIZ_UTM_FIELDS.filter((k) => k in utm),
    ...Object.keys(utm).filter((k) => !(QUIZ_UTM_FIELDS as readonly string[]).includes(k)),
  ];
  if (!keys.length) return <>—</>;
  return (
    <>
      {keys.map((k) => (
        <div key={k}>
          {k}: {utm[k]}
        </div>
      ))}
    </>
  );
}
