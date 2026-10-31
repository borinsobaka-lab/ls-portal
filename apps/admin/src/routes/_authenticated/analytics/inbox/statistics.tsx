import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Download, RotateCcw, Search, X } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { AnalyticsInboxStatsPageSkeleton } from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableToolbar } from "@/components/table-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { mskToday } from "@/lib/analytics/core";
import { INBOX_KEY } from "@/lib/analytics/inbox/data";
import { loadInboxStatistics } from "@/lib/analytics/inbox.functions";
import {
  statCsv,
  statNormalize,
  statSort,
  type InboxStatsView,
  type StatTable,
} from "@/lib/analytics/inbox/stats";
import { AN_TITLES } from "@/lib/analytics/labels";

type StatsSearch = { from?: string; to?: string; manager?: string[]; group?: string[] };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const list = (v: unknown) =>
  (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
    .map((x) => String(x))
    .filter((x) => x.length <= 60)
    .slice(0, 200);

export const Route = createFileRoute("/_authenticated/analytics/inbox/statistics")({
  head: () => ({ meta: [{ title: "Статистика менеджеров — Диалоги VK — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): StatsSearch => {
    const manager = list(s.manager);
    const group = list(s.group);
    return {
      from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
      to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
      manager: manager.length ? manager : undefined,
      group: group.length ? group : undefined,
    };
  },
  pendingComponent: AnalyticsInboxStatsPageSkeleton,
  component: AnalyticsInboxStatsPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const TEXT = {
  scope:
    "Статистика по менеджерам считается по текущим назначенным группам. Если группа назначена нескольким сотрудникам, её показатели входят в строку каждого; строки сотрудников не нужно суммировать. Скорость ответа — по фактическим ответам сотрудника.",
  managers:
    "Одна строка на лид-менеджера. Новые лиды и уникальные номера от них суммируются по всем назначенным группам за выбранный период, независимо от автора ответа. Конверсия «Лид → телефон» = номера от новых лидов / новые лиды × 100%. «Всего получено номеров» — все уникальные номера, впервые полученные за выбранный период в назначенных группах, независимо от даты первого обращения или входа в бота. «Все номера / новые лиды» = всего получено номеров / новые лиды × 100%; результат может превышать 100%. Повтор номера в истории одного диалога не учитывается.",
  groups:
    "Конверсия — количество уникальных телефонов от новых лидов периода / количество этих лидов × 100%. Учитывается каждый разный номер, полученный до конца периода; результат может превышать 100%. Телефоны старых лидов входят только в «Получены телефоны». При выборе менеджера показываются назначенные ему группы; при выборе нескольких — объединение их групп без повторов.",
  activity1:
    "Диалоги с ответами менеджера за период. Учитывается каждый уникальный номер, полученный менеджером в этих диалогах за период. Два разных номера из одного диалога дают 200%. Всего телефонов включает и диалоги, где менеджер отвечал до начала периода.",
  activity2:
    "Уникальные номера после сообщения бота, до любого ответа менеджера. При фильтре по менеджеру эти случаи не включаются. Расчёт предполагает, что менеджеры отвечают только через портал.",
  rules: [
    "Дата нового лида — дата первого доступного сообщения в истории VK конкретной группы, а не дата подключения или появления диалога в Inbox. Старт с сообщения бота учитывается, даже если клиент ещё ничего не написал. Исходящее менеджера само по себе нового лида не создаёт. Повторные сообщения не создают нового лида. Один клиент в двух группах — два лида. Телефоны — разные российские номера из входящего текста в одном диалоге. Каждый номер считается один раз за всю сохранённую историю; учитываются все номера в сообщении. Форматы 8, +7 и 7 приводятся к одному виду: +7, 7, 8 и мобильный номер из 10 цифр с 9. Номер клиента и другой номер подруги дают два телефона. Конверсия — уникальные телефоны / лиды или диалоги × 100%; один диалог с двумя номерами даёт 200%. Повтор того же номера не увеличивает счётчик; телефоны из исходящих сообщений не учитываются.",
    "В таблице менеджеров лиды и номера от новых лидов относятся к текущим назначенным группам, независимо от того, кто отвечал. Номера старых лидов в эту конверсию не входят. В отдельном блоке фактических ответов авторство сохраняется. Каждый уникальный телефон — к последнему менеджеру, ответившему перед первым появлением именно этого номера; ответ после номера не меняет результат. Конверсия новых лидов относится к владельцу лида, независимо от того, кто получил телефон. Для включения лида в строку менеджера его ответ или рабочий день не требуется. Если одна группа назначена нескольким сотрудникам, она учитывается у каждого. Используются текущие назначения; история передачи групп не восстанавливается.",
    "Скорость первого ответа — медиана времени от первого сообщения клиента до первого ответа, по дню ответа. «Скорость ответа» — медиана ожидания всех ответов: от первого сообщения клиента после предыдущего ответа до следующего ответа менеджера. Несколько входящих подряд — одно измерение. Несколько исходящих подряд не добавляют измерений. Учитываются и первые, и последующие ответы; каждый относится к фактически ответившему менеджеру и дню его ответа. Ответ напрямую из VK закрывает ожидание, но не приписывается менеджеру. Сообщения без ответа пока не входят в расчёт. Если первый ответ отправлен напрямую из VK, измерение исключается. Ночное время входит в длительность. История начинается с сообщений, сохранённых порталом; номера на картинках, голосом и написанные словами не распознаются.",
  ],
};

/**
 * «Диалоги VK» → «Статистика» — их /admin/vk-inbox/statistics: период,
 * менеджеры и группы; плитки воронки, «Статистика по менеджерам»,
 * «Конверсия по группам», администратору — «Диалоги и телефоны менеджеров»
 * и правила подсчёта. Таблицы — поиск, сортировка по колонке, CSV.
 */
function AnalyticsInboxStatsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = {
    from: search.from,
    to: search.to,
    managers: search.manager ?? [],
    groups: search.group ?? [],
  };
  const { data, error, isFetching } = useQuery({
    queryKey: [
      ...INBOX_KEY,
      "stats",
      filters.from ?? "",
      filters.to ?? "",
      filters.managers.join(","),
      filters.groups.join(","),
    ],
    queryFn: () => loadInboxStatistics({ data: filters }),
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить статистику диалогов" },
  });
  return (
    <AdminShell title={AN_TITLES.inboxStats}>
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/inbox">
            <ArrowLeft />К диалогам
          </Link>
        </Button>
        {error && !data ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <>
            <Filters
              key={`${data.from}|${data.to}|${filters.managers.join(",")}|${filters.groups.join(",")}`}
              view={data}
              selected={filters}
              pending={isFetching}
              onApply={(next) =>
                void navigate({
                  search: {
                    from: next.from,
                    to: next.to,
                    manager: next.managers.length ? next.managers : undefined,
                    group: next.groups.length ? next.groups : undefined,
                  },
                })
              }
              onReset={() => void navigate({ search: {} })}
            />
            {data.error ? null : <Report view={data} />}
          </>
        )}
      </div>
    </AdminShell>
  );
}

type Selected = { from?: string; to?: string; managers: string[]; groups: string[] };

function Filters({
  view,
  selected,
  pending,
  onApply,
  onReset,
}: {
  view: InboxStatsView;
  selected: Selected;
  pending: boolean;
  onApply: (s: Selected) => void;
  onReset: () => void;
}) {
  const [range, setRange] = useState<DateRange | undefined>({
    from: toDate(view.from),
    to: toDate(view.to),
  });
  const [managers, setManagers] = useState(selected.managers);
  const [groups, setGroups] = useState(selected.groups);
  const managerName = new Map(view.managers.map((m) => [m.id, m.name]));
  const groupName = new Map(view.groups.map((g) => [String(g.id), g.name]));
  const today = mskToday();
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Фильтры статистики</h2>
          <p className="text-sm text-muted-foreground">
            Выберите период, менеджеров и группы для анализа.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onReset}>
          <RotateCcw />
          Сбросить фильтры
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <FormField label="Период">
          <DateRangeFilter
            value={range}
            placeholder="Период"
            showLabel={false}
            title="Период статистики"
            onChange={setRange}
          />
        </FormField>
        <MultiPick
          label="Менеджеры"
          all="Все менеджеры"
          options={view.managers.map((m) => ({ value: m.id, label: m.name }))}
          value={managers}
          names={managerName}
          onChange={setManagers}
        />
        <MultiPick
          label="Группа VK"
          all="Все группы"
          options={view.groups.map((g) => ({ value: String(g.id), label: g.name }))}
          value={groups}
          names={groupName}
          onChange={setGroups}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            onApply({
              from: range?.from ? toIso(range.from) : today.slice(0, 8) + "01",
              to: range?.to ? toIso(range.to) : range?.from ? toIso(range.from) : today,
              managers,
              groups,
            })
          }
        >
          <Search />
          Показать
        </Button>
      </div>
      {view.error && (
        <p className="text-sm text-destructive" role="alert">
          {view.error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{TEXT.scope}</p>
    </section>
  );
}

function MultiPick({
  label,
  all,
  options,
  value,
  names,
  onChange,
}: {
  label: string;
  all: string;
  options: { value: string; label: string }[];
  value: string[];
  names: Map<string, string>;
  onChange: (v: string[]) => void;
}) {
  return (
    <FormField label={label}>
      <div className="space-y-2">
        <SearchableCombobox
          value=""
          onChange={(v) => v && !value.includes(v) && onChange([...value, v])}
          options={options
            .filter((o) => !value.includes(o.value))
            .map((o) => ({ ...o, searchText: o.label }))}
          placeholder={value.length ? "Добавить ещё" : all}
          searchPlaceholder="Поиск..."
          emptyText="Нет доступных значений"
        />
        {value.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.map((v) => (
              <Badge key={v} variant="secondary" className="gap-1 pr-1">
                {names.get(v) ?? v}
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={`Убрать ${names.get(v) ?? v}`}
                  onClick={() => onChange(value.filter((x) => x !== v))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </FormField>
  );
}

function Report({ view }: { view: InboxStatsView }) {
  return (
    <div className="space-y-4">
      {view.pending > 0 && (
        <InfoNote variant="info">
          <b>Идёт сверка первых сообщений с VK.</b> Ещё не подтверждена дата у {view.pending}{" "}
          диалогов выбранной выборки. Они пока исключены из новых лидов и их конверсии; итоги
          предварительные. Сверка выполняется в фоне. Обновите отчёт позднее.
        </InfoNote>
      )}
      {view.empty && (
        <InfoNote variant="empty">
          <b>За выбранный период данных нет.</b> Попробуйте изменить период или выбрать других
          менеджеров.
        </InfoNote>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Новые лиды" value={view.kpi.leads} />
        <StatTile label="Получены уникальные телефоны" value={view.kpi.phones} />
        <StatTile label="Телефоны от новых лидов" value={view.kpi.converted} />
        <StatTile label="Конверсия лид → телефон" value={view.kpi.conversion} />
      </div>
      <StatTableCard
        title="Статистика по менеджерам"
        description={TEXT.managers}
        table={view.managerTable}
        kind="days"
        emptyText="Нет пользователей с ролью лид-менеджера в выбранном фильтре."
        searchPlaceholder="Поиск по менеджеру..."
        searchColumns={[1]}
        defaultSort={2}
      />
      <StatTableCard
        title="Конверсия по группам"
        description={TEXT.groups}
        table={view.groupTable}
        kind="groups"
        emptyText="За этот период нет лидов или телефонов."
        searchPlaceholder="Поиск по группе или городу..."
        searchColumns={[0, 1]}
        cityColumn={1}
        defaultSort={view.groupTable.headers.length - 1}
      />
      {view.activity && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Диалоги и телефоны менеджеров</h2>
          <div className="rounded-lg border bg-background">
            <PlainTable
              table={view.activity}
              emptyText="За период нет ответов или полученных телефонов."
            />
          </div>
          <p className="text-xs text-muted-foreground">{TEXT.activity1}</p>
          <p className="text-xs text-muted-foreground">{TEXT.activity2}</p>
        </section>
      )}
      {view.admin && (
        <details className="rounded-lg border bg-background p-4">
          <summary className="cursor-pointer font-semibold">Правила подсчёта</summary>
          <div className="mt-2 space-y-2 text-sm text-muted-foreground">
            {TEXT.rules.map((p) => (
              <p key={p.slice(0, 20)}>{p}</p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PlainTable({ table, emptyText }: { table: StatTable; emptyText: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {table.headers.map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map((r) => (
          <TableRow key={r.key}>
            {r.cells.map((c, i) => (
              <TableCell key={i} className={i ? "tabular-nums" : "font-medium"}>
                {c.text}
              </TableCell>
            ))}
          </TableRow>
        ))}
        {!table.rows.length && (
          <TableRow>
            <TableCell
              colSpan={table.headers.length}
              className="py-6 text-center text-muted-foreground"
            >
              {emptyText}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

const ALL = "__all__";

/** Их stat-table-controls.js: поиск, город, сортировка по колонке, страницы, CSV. */
function StatTableCard({
  title,
  description,
  table,
  kind,
  emptyText,
  searchPlaceholder,
  searchColumns,
  cityColumn,
  defaultSort,
}: {
  title: string;
  description: string;
  table: StatTable;
  kind: "days" | "groups";
  emptyText: string;
  searchPlaceholder: string;
  searchColumns: number[];
  cityColumn?: number;
  defaultSort: number;
}) {
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [sort, setSort] = useState({ column: defaultSort, direction: "desc" as "asc" | "desc" });
  const rows = useMemo(() => table.rows.map((r, index) => ({ ...r, index })), [table]);
  const cities = useMemo(
    () =>
      cityColumn === undefined
        ? []
        : [...new Set(rows.map((r) => r.cells[cityColumn].text))].sort((a, b) =>
            a.localeCompare(b, "ru"),
          ),
    [rows, cityColumn],
  );
  const filtered = useMemo(() => {
    const q = statNormalize(query);
    const hit = rows.filter(
      (r) =>
        (!city || (cityColumn !== undefined && r.cells[cityColumn].text === city)) &&
        statNormalize(searchColumns.map((c) => r.cells[c].text).join(" ")).includes(q),
    );
    return statSort(hit, sort.column, sort.direction);
  }, [rows, query, city, sort, searchColumns, cityColumn]);
  const { paged, ...pagination } = usePagination(
    filtered,
    25,
    `${query}|${city}|${sort.column}|${sort.direction}`,
  );
  const download = () => {
    const csv = statCsv(
      table.headers,
      filtered.map((r) => r.cells.map((c) => c.text)),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vk-inbox-${kind}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="max-w-4xl">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!filtered.length} onClick={download}>
          <Download />
          Скачать таблицу
        </Button>
      </div>
      <TableToolbar>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        {cityColumn !== undefined && (
          <Select value={city || ALL} onValueChange={(v) => setCity(v === ALL ? "" : v)}>
            <SelectTrigger className="w-48" aria-label="Город">
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
        )}
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {table.headers.map((h, i) => (
                <TableHead
                  key={h}
                  aria-sort={
                    sort.column === i
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-left font-medium"
                    onClick={() =>
                      setSort((s) => ({
                        column: i,
                        direction: s.column === i && s.direction === "asc" ? "desc" : "asc",
                      }))
                    }
                  >
                    {h}
                    {sort.column === i &&
                      (sort.direction === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      ))}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((r) => (
              <TableRow key={r.key}>
                {r.cells.map((c, i) => (
                  <TableCell
                    key={i}
                    className={i === (kind === "days" ? 1 : 0) ? "font-medium" : "tabular-nums"}
                  >
                    {c.text}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!paged.length && (
              <TableRow>
                <TableCell
                  colSpan={table.headers.length}
                  className="py-6 text-center text-muted-foreground"
                >
                  {table.rows.length ? "По выбранным фильтрам ничего не найдено" : emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <DataPagination {...pagination} />
      </div>
    </section>
  );
}
