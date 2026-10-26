import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { addDays, format, startOfDay } from "date-fns";
import { Plus, Pencil, Trash2, Eye } from "lucide-react";
import { AmoCrmLinkIcon } from "@/components/amocrm-icon";
import { clientNameClass } from "@/components/client-name-link";

import { CommentCell } from "@/components/comment-cell";
import { commentSaver } from "@/lib/comment-saver";
import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useNetworkStudioIds, useStudioFormat } from "@/hooks/use-catalog-studios";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
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
import { toast } from "sonner";
import { DataPagination } from "@/components/data-pagination";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ClientCardDialog } from "@/components/client-card-dialog";
import { ClubStatusBadge } from "@/components/club-status-badge";
import {
  CLUB_STATUS_FULL,
  CLUB_STATUS_LABEL,
  CLUB_STATUS_RULE,
  type ClubStatus,
} from "@/lib/client-status";
import { TableSkeletonRows } from "@/components/skeletons";
import { clientName, formatDate, genderLabel, phoneSearchTerm, sanitizeSearch } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { ClientDialog } from "@/components/client-form-dialog";
import { CLIENT_TIPS, clientSourceLabel } from "@/lib/client-fields";
import { GOAL_LABELS, goalOptions } from "@/lib/client-profile";
import { formatPhoneDisplay } from "@/lib/contacts";
import { ClientsPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  ...CLIENT_TIPS,
  status: (
    <span className="block space-y-1.5">
      {(["chk", "bchk", "pchk"] as const).map((s) => (
        <span key={s} className="block">
          <span className="font-semibold">
            {CLUB_STATUS_LABEL[s]} — {CLUB_STATUS_FULL[s].toLowerCase()}:
          </span>{" "}
          {CLUB_STATUS_RULE[s]}
        </span>
      ))}
    </span>
  ),
};

export const Route = createFileRoute("/_authenticated/clients")({
  head: () => ({ meta: [{ title: "Клиенты — Base40 Admin" }] }),
  pendingComponent: ClientsPageSkeleton,
  component: ClientsPage,
});

type Client = {
  id: string;
  studio_id: string;
  // Нужен карточке клиента: по нему грузятся посещения и анкета.
  user_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  notes: string | null;
  registration_date: string | null;
  last_visit_date: string | null;
  crm_link: string | null;
  photo_url: string | null;
  created_at: string;
  // Приходит из вью clients_with_status (см. db/performance_indexes.sql).
  club_status: ClubStatus;
  /** «Добавлен»: admin / import / mobile (db/migrations/2026-10-18_zz_clients_source.sql). */
  source: string | null;
};

// Колонки запрашиваем поимённо: во вью есть ещё search_name, который нужен
// только для фильтрации на сервере и незачем гонять по сети.
const CLIENT_COLUMNS =
  "id, studio_id, user_id, full_name, first_name, last_name, phone, phone2, email, birthday, gender, " +
  "notes, registration_date, last_visit_date, crm_link, photo_url, created_at, club_status, source";

/** Колонки сортировки (lib/table-sort.ts): ключ заголовка → колонки вью. */
const SORT_COLUMNS = {
  name: ["last_name", "first_name", "full_name"],
  status: "club_status",
  phone: "phone",
  email: "email",
  gender: "gender",
  birthday: "birthday",
  registration: "registration_date",
  source: "source",
  lastVisit: "last_visit_date",
  notes: "notes",
};

const CLUB_STATUSES = Object.keys(CLUB_STATUS_FULL) as ClubStatus[];

// Локальная дата (YYYY-MM-DD): даты регистрации/визита хранятся без времени.
function toISODate(d: Date | undefined) {
  return d ? format(d, "yyyy-MM-dd") : null;
}

// Граница периода для времени (app_last_seen_at): начало дня `d` по часам
// браузера; конец периода — начало следующего дня (фильтр «меньше»).
function dayStart(d: Date | undefined, nextDay = false) {
  return d ? addDays(startOfDay(d), nextDay ? 1 : 0).toISOString() : null;
}

function ClientsPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [goalFilter, setGoalFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [regRange, setRegRange] = useState<DateRange | undefined>();
  const [visitRange, setVisitRange] = useState<DateRange | undefined>();
  const [appRange, setAppRange] = useState<DateRange | undefined>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardClient, setCardClient] = useState<Client | null>(null);
  const sort = useTableSort();

  const openCard = (c: Client) => {
    setCardClient(c);
    setCardOpen(true);
  };

  const term = sanitizeSearch(useDebouncedValue(search));
  // Диапазоны — строками: DateRange новый объект на каждый выбор, а строки
  // годятся и для фильтра запроса, и для ключа кэша.
  const regFrom = toISODate(regRange?.from);
  const regTo = toISODate(regRange?.to);
  const visitFrom = toISODate(visitRange?.from);
  const visitTo = toISODate(visitRange?.to);
  const appFrom = dayStart(appRange?.from);
  const appTo = dayStart(appRange?.to, true);
  const hasFilters = Boolean(
    term ||
    goalFilter ||
    statusFilter ||
    regFrom ||
    regTo ||
    visitFrom ||
    visitTo ||
    appFrom ||
    appTo,
  );
  // Цели — из анкеты приложения формата клуба (у пакетного — свои).
  const goals = goalOptions(useStudioFormat(studioId));

  // Пакетный клуб — общая база клиентов всех пакетных клубов (2026-10-17).
  const networkIds = useNetworkStudioIds(studioId);
  const table = useServerTable<Client>({
    queryKey: [
      "clients_with_status",
      studioId,
      networkIds?.join(","),
      term,
      goalFilter,
      statusFilter,
      regFrom,
      regTo,
      visitFrom,
      visitTo,
      appFrom,
      appTo,
      sort.key,
    ],
    queryFn: ({ from, to }) => {
      let query = supabase
        .from("clients_with_status")
        .select(CLIENT_COLUMNS, { count: "exact" })
        .in("studio_id", networkIds!);
      if (term) {
        query = query.or(
          `search_name.ilike.%${term}%,phone.ilike.%${phoneSearchTerm(term)}%,phone2.ilike.%${phoneSearchTerm(term)}%,email.ilike.%${term}%`,
        );
      }
      if (goalFilter) query = query.eq("primary_goal", goalFilter);
      if (statusFilter) query = query.eq("club_status", statusFilter);
      if (regFrom) query = query.gte("registration_date", regFrom);
      if (regTo) query = query.lte("registration_date", regTo);
      if (visitFrom) query = query.gte("last_visit_date", visitFrom);
      if (visitTo) query = query.lte("last_visit_date", visitTo);
      if (appFrom) query = query.gte("app_last_seen_at", appFrom);
      if (appTo) query = query.lt("app_last_seen_at", appTo);
      return orderBy(query, sort.sort, SORT_COLUMNS, (q) =>
        q.order("created_at", { ascending: false }),
      ).range(from, to);
    },
    enabled: !!studioId && !!networkIds,
    errorMessage: "Не удалось загрузить клиентов",
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["clients_with_status"] });

  const handleDelete = async (c: Client) => {
    if (
      !(await confirm({
        title: "Удалить клиента?",
        // Вместе с карточкой база стирает и учётную запись приложения: анкету,
        // оценки, вход (db/migrations/2026-10-12_client_account_wipe.sql).
        description: `«${clientName(c)}» будет удалён вместе с историей записей и учётной записью в приложении. Действие необратимо.`,
      }))
    )
      return;
    const { data, error } = await supabase.from("clients").delete().eq("id", c.id).select("id");
    if (error) {
      // Продажи абонементов держат клиента внешним ключом (on delete restrict);
      // у клиента общей базы они могут быть и в другом клубе сети.
      toast.error(
        error.code === "23503"
          ? "Клиента нельзя удалить: у него есть продажи абонементов (в этом или другом клубе). Сначала удалите их."
          : "Ошибка удаления: " + error.message,
      );
      return;
    }
    // RLS не пустил — строка не удалена, хотя ошибки нет.
    if (!data?.length) {
      toast.error("Клиента не удалось удалить: нет прав в его клубе");
      return;
    }
    toast.success("Клиент удалён");
    reload();
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (c: Client) => {
    setEditing(c);
    setOpen(true);
  };

  const resetFilters = () => {
    setSearch("");
    setGoalFilter("");
    setStatusFilter("");
    setRegRange(undefined);
    setVisitRange(undefined);
    setAppRange(undefined);
  };

  return (
    <AdminShell
      title="Клиенты"
      actions={
        <Button onClick={openCreate} disabled={!studioId}>
          <Plus />
          Добавить клиента
        </Button>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Поиск по имени, телефону, email"
            />
            <Select value={goalFilter} onValueChange={setGoalFilter}>
              <SelectTrigger aria-label="Цель клиента" className="w-48">
                <SelectValue placeholder="Цель клиента" />
              </SelectTrigger>
              <SelectContent>
                {goals.map((g) => (
                  <SelectItem key={g} value={g}>
                    {GOAL_LABELS[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger aria-label="Статус клиента" className="w-48">
                <SelectValue placeholder="Статус" />
              </SelectTrigger>
              <SelectContent>
                {CLUB_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CLUB_STATUS_LABEL[s]} — {CLUB_STATUS_FULL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DateRangeFilter placeholder="Регистрация" value={regRange} onChange={setRegRange} />
            <DateRangeFilter
              placeholder="Последний визит"
              value={visitRange}
              onChange={setVisitRange}
            />
            <DateRangeFilter
              placeholder="Последний раз в приложении"
              title="Когда клиент последний раз открывал приложение клуба"
              className="w-48"
              value={appRange}
              onChange={setAppRange}
            />
            <ToolbarReset active={hasFilters} onReset={resetFilters} />
          </TableToolbar>

          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[240px]" {...sort.head("name")}>
                    Клиент
                  </TableHead>
                  <TableHead className="w-[80px]" tip={TIPS.status} {...sort.head("status")}>
                    Статус
                  </TableHead>
                  <TableHead {...sort.head("phone")}>Телефон</TableHead>
                  <TableHead tip={TIPS.email} {...sort.head("email")}>
                    Email
                  </TableHead>
                  <TableHead tip={TIPS.notes} {...sort.head("notes")}>
                    Заметки
                  </TableHead>
                  <TableHead tip={TIPS.lastVisit} {...sort.head("lastVisit")}>
                    Последний визит
                  </TableHead>
                  <TableHead {...sort.head("gender")}>Пол</TableHead>
                  <TableHead {...sort.head("birthday")}>Дата рождения</TableHead>
                  <TableHead tip={TIPS.registration} {...sort.head("registration")}>
                    Регистрация
                  </TableHead>
                  <TableHead tip={TIPS.source} {...sort.head("source")}>
                    Добавлен
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.loading ? (
                  <TableSkeletonRows columns={10} />
                ) : table.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {hasFilters
                        ? "Ничего не найдено."
                        : "Пока нет клиентов. Нажмите «Добавить клиента»."}
                    </TableCell>
                  </TableRow>
                ) : (
                  table.rows.map((c) => (
                    <RowContextMenu
                      key={c.id}
                      actions={[
                        { label: "Открыть карточку", icon: Eye, onSelect: () => openCard(c) },
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(c) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(c),
                        },
                      ]}
                    >
                      <TableRow>
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => openCard(c)}
                              className={clientNameClass}
                            >
                              {clientName(c)}
                            </button>
                            {c.crm_link && <AmoCrmLinkIcon href={c.crm_link} />}
                          </span>
                        </TableCell>
                        <TableCell>
                          <ClubStatusBadge status={c.club_status ?? "pchk"} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatPhoneDisplay(c.phone) || "—"}
                          {c.phone2 && (
                            <div className="text-xs text-muted-foreground">
                              {formatPhoneDisplay(c.phone2)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{c.email ?? "—"}</TableCell>
                        <TableCell>
                          <CommentCell
                            text={c.notes}
                            onSave={commentSaver("clients", c.id, "notes")}
                            onSaved={reload}
                          />
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDate(c.last_visit_date)}
                        </TableCell>
                        <TableCell>{genderLabel(c.gender)}</TableCell>
                        <TableCell className="tabular-nums">{formatDate(c.birthday)}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatDate(c.registration_date)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {clientSourceLabel(c.source)}
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination {...table.pagination} />
          </div>
        </RequireStudio>
      </div>

      <ClientDialog
        open={open}
        onOpenChange={setOpen}
        studioId={studioId}
        client={editing}
        onSaved={reload}
      />

      <ClientCardDialog open={cardOpen} onOpenChange={setCardOpen} client={cardClient} />
      {confirmDialog}
    </AdminShell>
  );
}
