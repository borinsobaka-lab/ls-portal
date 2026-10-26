import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardList, Loader2, Trash2, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { RequireFormat } from "@/components/require-format";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import { StudioFilter, StudioLabel } from "@/components/studio-label";
import {
  OPEN_REQUESTS_KEY,
  REQUEST_KIND_LABEL,
  type ClientRequestKind,
} from "@/hooks/use-client-requests";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { useTableSort } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";
import { StatTile } from "@/components/ui/stat-tile";
import { clientName, formatPhone } from "@/lib/format";
import { GOAL_LABELS } from "@/lib/client-profile";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
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
import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { RowContextMenu } from "@/components/row-context-menu";
import { useConfirm } from "@/components/confirm-dialog";
import { CommentCell } from "@/components/comment-cell";
import { ClientNameLink } from "@/components/client-name-link";
import { RequestsPageSkeleton, RequestsStatsSkeleton } from "@/components/page-skeletons";

/**
 * «Заявки» (2026-10-15, «Обратная связь», пакетные клубы): клиент в
 * приложении просит персональные занятия (цели, комментарий) или
 * диагностику — администратор связывается, согласует время с тренером и
 * ставит занятие в «Расписание», потом жмёт «Отработано». Пока заявка не
 * отработана, горит счётчик на «Клубе» в рейке и на «Заявках» в меню.
 * Заявки всех пакетных клубов сотрудника — одним списком, клуб колонкой
 * (решение владельца 2026-10-19: не переключать клуб в шапке).
 * Схема — db/migrations/2026-10-15_zz_diagnostics_client_requests.sql.
 */

/** Подсказки «?» колонок. */
const TIPS = {
  kind: "Персональные занятия — клиент хочет заниматься с тренером; диагностика — записаться на диагностику тела по абонементу.",
  goals: "Цели клиента: из анкеты приложения и те, что он отметил в заявке.",
  balance:
    "Действующие абонементы клиента и их остаток: тренировки, персональные, диагностики. Без остатка — сначала продажа.",
  status: "Пока заявка не отработана, горит счётчик на «Клубе» и «Заявках».",
};

export const Route = createFileRoute("/_authenticated/requests")({
  head: () => ({ meta: [{ title: "Заявки — Base40 Admin" }] }),
  pendingComponent: RequestsPageSkeleton,
  component: RequestsRoute,
});

function RequestsRoute() {
  return (
    <RequireFormat format="packages" title="Заявки">
      <RequestsPage />
    </RequireFormat>
  );
}

type RequestRow = {
  id: string;
  studio_id: string;
  client_id: string;
  kind: ClientRequestKind;
  goals: string[];
  goal_other: string | null;
  comment: string | null;
  created_at: string;
  processed_at: string | null;
  processed_by_name: string | null;
  client: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    full_name: string;
    phone: string | null;
    email: string | null;
  } | null;
};

type MembershipBalance = {
  client_id: string;
  status: string;
  visits_left: number | null;
  personal_left: number | null;
  diagnostics_left: number | null;
  balance_kind: string | null;
  memberships: { name: string | null; kind: string | null } | null;
};

const COLUMNS =
  "id, studio_id, client_id, kind, goals, goal_other, comment, created_at, processed_at, processed_by_name, client:clients(id, first_name, last_name, full_name, phone, email)";

type StatusFilter = "open" | "done" | "all";

/**
 * Сортировка по колонкам (lib/table-sort.ts) — в браузере, после фильтров.
 * «Абонемент» не сортируется: у клиента их может быть несколько.
 * «Статус» по возрастанию — сначала не отработанные.
 */
const SORT_GETTERS = {
  createdAt: (i: RequestRow) => i.created_at,
  client: (i: RequestRow) => (i.client ? clientName(i.client) : null),
  kind: (i: RequestRow) => REQUEST_KIND_LABEL[i.kind] ?? i.kind,
  goals: (i: RequestRow) => goalsText(i),
  comment: (i: RequestRow) => i.comment,
  status: (i: RequestRow) => (i.processed_at ? 1 : 0),
};

function RequestsPage() {
  const studioId = useActiveStudioId();
  const studios = useSectionStudios("requests", "packages");
  const idsKey = studioIdsKey(studios);
  const multi = (studios?.length ?? 0) > 1;
  const studioOf = (id: string) => studios?.find((s) => s.id === id) ?? null;
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  // По умолчанию — все заявки, новые сверху (решение владельца 2026-10-15).
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<"all" | ClientRequestKind>("all");
  const [studioFilter, setStudioFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const queryKey = ["client_requests", idsKey];
  const { data: items = [], isLoading: queryLoading } = useQuery({
    queryKey,
    queryFn: () =>
      unwrap<RequestRow[]>(
        supabase
          .from("client_requests")
          .select(COLUMNS)
          .in("studio_id", idsKey.split(","))
          .order("created_at", { ascending: false })
          .limit(1000),
      ),
    enabled: !!idsKey,
    // Заявки приходят из приложения — список обновляется сам.
    refetchInterval: 60_000,
    meta: { errorMessage: "Не удалось загрузить заявки" },
  });
  const loading = studios === null || queryLoading;

  // Остаток абонементов клиентов — чтобы видеть, есть ли диагностики и
  // персональные, не открывая карточку.
  const clientIds = useMemo(() => [...new Set(items.map((i) => i.client_id))].sort(), [items]);
  const { data: balances } = useQuery({
    queryKey: ["client_memberships", "requests", idsKey, clientIds.join(",")],
    // Частями по 100: сотни id в адрес одного GET-запроса не помещаются.
    queryFn: async () => {
      const parts: string[][] = [];
      for (let i = 0; i < clientIds.length; i += 100) parts.push(clientIds.slice(i, i + 100));
      const rows = await Promise.all(
        parts.map((part) =>
          unwrap<MembershipBalance[]>(
            supabase
              .from("client_memberships")
              .select(
                "client_id, status, visits_left, personal_left, diagnostics_left, balance_kind, memberships(name, kind)",
              )
              .in("client_id", part)
              .in("status", ["active", "frozen", "pending"]),
          ),
        ),
      );
      return rows.flatMap((r) => r ?? []);
    },
    enabled: clientIds.length > 0,
    meta: { errorMessage: "Не удалось загрузить абонементы клиентов" },
  });
  const balancesByClient = useMemo(() => {
    const map = new Map<string, MembershipBalance[]>();
    for (const m of balances ?? []) map.set(m.client_id, [...(map.get(m.client_id) ?? []), m]);
    return map;
  }, [balances]);

  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (studioFilter !== "all" && i.studio_id !== studioFilter) return false;
        if (status === "open" && i.processed_at) return false;
        if (status === "done" && !i.processed_at) return false;
        if (kind !== "all" && i.kind !== kind) return false;
        return true;
      }),
    [items, status, kind, studioFilter],
  );
  const sort = useTableSort({
    ...SORT_GETTERS,
    studio: (i: RequestRow) => studioOf(i.studio_id)?.name,
  });
  const pg = usePagination(sort.apply(filtered), undefined, sort.key);

  const now = new Date();
  const openCount = items.filter((i) => !i.processed_at).length;
  const thisMonth = items.filter((i) => {
    const d = new Date(i.created_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const doneThisMonth = items.filter((i) => {
    if (!i.processed_at) return false;
    const d = new Date(i.processed_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const reload = () => {
    queryClient.invalidateQueries({ queryKey: ["client_requests"] });
    queryClient.invalidateQueries({ queryKey: [OPEN_REQUESTS_KEY] });
  };

  // «Отработано» / «Вернуть в работу»: кто и когда — ставит база.
  const setProcessed = async (item: RequestRow, done: boolean) => {
    setBusyId(item.id);
    try {
      const { error } = await supabase
        .from("client_requests")
        .update({ processed_at: done ? new Date().toISOString() : null })
        .eq("id", item.id);
      if (error) {
        toast.error("Не удалось сохранить: " + error.message);
        return;
      }
      toast.success(done ? "Заявка отработана" : "Заявка возвращена в работу");
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (item: RequestRow) => {
    if (
      !(await confirm({
        title: "Удалить заявку?",
        description: "Клиент сможет отправить новую. Это действие нельзя отменить.",
      }))
    )
      return;
    const { error } = await supabase.from("client_requests").delete().eq("id", item.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Заявка удалена");
    reload();
  };

  const hasFilters = status !== "all" || kind !== "all" || studioFilter !== "all";
  const columns = multi ? 8 : 7;

  return (
    <AdminShell title="Заявки">
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          {loading ? (
            <RequestsStatsSkeleton />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile
                label="Не отработано"
                value={openCount}
                tone={openCount > 0 ? "warning" : "default"}
              />
              <StatTile label="Пришло в этом месяце" value={thisMonth} />
              <StatTile label="Отработано в этом месяце" value={doneThisMonth} />
            </div>
          )}

          <TableToolbar>
            {multi && studios && (
              <StudioFilter studios={studios} value={studioFilter} onChange={setStudioFilter} />
            )}
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger aria-label="Статус заявки" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все заявки</SelectItem>
                <SelectItem value="open">Не отработанные</SelectItem>
                <SelectItem value="done">Отработанные</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as "all" | ClientRequestKind)}>
              <SelectTrigger aria-label="Вид заявки" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все виды</SelectItem>
                {(Object.keys(REQUEST_KIND_LABEL) as ClientRequestKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {REQUEST_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToolbarReset
              active={hasFilters}
              onReset={() => {
                setStatus("all");
                setKind("all");
                setStudioFilter("all");
              }}
            />
          </TableToolbar>

          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead {...sort.head("createdAt")}>Дата</TableHead>
                  <TableHead {...sort.head("client")}>Клиент</TableHead>
                  {multi && <TableHead {...sort.head("studio")}>Клуб</TableHead>}
                  <TableHead tip={TIPS.kind} {...sort.head("kind")}>
                    Заявка
                  </TableHead>
                  <TableHead tip={TIPS.goals} {...sort.head("goals")}>
                    Цели
                  </TableHead>
                  <TableHead {...sort.head("comment")}>Комментарий</TableHead>
                  <TableHead tip={TIPS.balance}>Абонемент</TableHead>
                  <TableHead tip={TIPS.status} {...sort.head("status")}>
                    Статус
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={columns} />
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      <ClipboardList className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                      {status === "open" ? "Новых заявок нет." : "Заявок нет."}
                    </TableCell>
                  </TableRow>
                ) : (
                  pg.paged.map((i) => {
                    const busy = busyId === i.id;
                    return (
                      <RowContextMenu
                        key={i.id}
                        actions={[
                          i.processed_at
                            ? {
                                label: "Вернуть в работу",
                                icon: Undo2,
                                onSelect: () => setProcessed(i, false),
                              }
                            : {
                                label: "Отработано",
                                icon: Check,
                                onSelect: () => setProcessed(i, true),
                              },
                          {
                            label: "Удалить",
                            icon: Trash2,
                            destructive: true,
                            onSelect: () => handleDelete(i),
                          },
                        ]}
                      >
                        <TableRow
                          className={cn(
                            !i.processed_at && "max-md:border-l-4 max-md:border-l-amber-500",
                          )}
                        >
                          <TableCell className="relative whitespace-nowrap text-muted-foreground tabular-nums">
                            {/* Неотработанная — полоска «внимание» слева, как в «Абонементах». */}
                            {!i.processed_at && (
                              <span
                                aria-hidden
                                className="absolute inset-y-0 left-0 w-1 bg-amber-500 max-md:hidden"
                              />
                            )}
                            {format(new Date(i.created_at), "dd.MM.yy HH:mm", { locale: ru })}
                          </TableCell>
                          <TableCell>
                            {i.client ? (
                              <ClientNameLink clientId={i.client_id}>
                                {clientName(i.client)}
                              </ClientNameLink>
                            ) : (
                              "—"
                            )}
                            {(i.client?.phone || i.client?.email) && (
                              <div className="text-xs text-muted-foreground">
                                {[formatPhone(i.client?.phone), i.client?.email]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            )}
                          </TableCell>
                          {multi && (
                            <TableCell>
                              <StudioLabel studio={studioOf(i.studio_id)} />
                            </TableCell>
                          )}
                          <TableCell className="whitespace-nowrap">
                            <KindBadge kind={i.kind} />
                          </TableCell>
                          <TableCell className="max-w-[220px] text-sm">
                            {goalsText(i) || <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell>
                            <CommentCell text={i.comment} />
                          </TableCell>
                          <TableCell className="text-xs">
                            <BalanceCell rows={balancesByClient.get(i.client_id)} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {i.processed_at ? (
                              <div className="text-xs text-muted-foreground">
                                <StatusChip tone="positive">Отработано</StatusChip>
                                <div className="mt-1 tabular-nums">
                                  {i.processed_by_name ? `${i.processed_by_name} · ` : ""}
                                  {format(new Date(i.processed_at), "dd.MM.yy", { locale: ru })}
                                </div>
                              </div>
                            ) : (
                              // outline: тёмная пилюля с галочкой читалась как
                              // готовый статус, а заявка ещё в работе.
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => setProcessed(i, true)}
                                disabled={busy}
                              >
                                {busy ? <Loader2 className="animate-spin" /> : <Check />}
                                Отработано
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      </RowContextMenu>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <DataPagination {...pg} loading={loading} />
          </div>
        </RequireStudio>
      </div>
      {confirmDialog}
    </AdminShell>
  );
}

/** Цели заявки подписями анкеты; «Другое» — текстом клиента. */
function goalsText(i: RequestRow) {
  const goals = (i.goals ?? []).map((g) =>
    g === "other" && i.goal_other ? `Другое: ${i.goal_other}` : (GOAL_LABELS[g] ?? g),
  );
  if (i.goal_other && !i.goals?.includes("other")) goals.push(i.goal_other);
  return goals.join(", ");
}

function KindBadge({ kind }: { kind: ClientRequestKind }) {
  return (
    <StatusChip tone={kind === "diagnostic" ? "neutral" : "info"}>
      {REQUEST_KIND_LABEL[kind] ?? kind}
    </StatusChip>
  );
}

/** «Пакет 24 · трен. 10 · перс. 1 · диагн. 2»; нет — «Нет абонемента». */
function BalanceCell({ rows }: { rows: MembershipBalance[] | undefined }) {
  if (!rows) return <span className="text-muted-foreground">—</span>;
  if (rows.length === 0) return <span className="text-rose-600">Нет абонемента</span>;
  return (
    <div className="space-y-0.5">
      {rows.map((m, idx) => {
        const parts = [
          m.balance_kind !== "personal" &&
            (m.visits_left == null ? "безлимит" : `трен. ${m.visits_left}`),
          (m.personal_left ?? 0) > 0 && `перс. ${m.personal_left}`,
          (m.diagnostics_left ?? 0) > 0 && `диагн. ${m.diagnostics_left}`,
        ].filter(Boolean);
        return (
          <div key={idx}>
            <span className="font-medium">{m.memberships?.name ?? "Абонемент"}</span>
            {m.status === "pending" && <span className="text-muted-foreground"> (продление)</span>}
            {parts.length > 0 && (
              <span className="text-muted-foreground"> · {parts.join(" · ")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
