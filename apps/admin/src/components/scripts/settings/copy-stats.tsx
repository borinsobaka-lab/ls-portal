/**
 * Статистика копирований: какие скрипты в ходу.
 *
 * Каждое нажатие «Копировать» у текста скрипта — одна отметка: кто, когда, на
 * каком языке. Здесь они складываются в рейтинг скриптов — за период, у всех
 * или у одного сотрудника, на всех языках или на одном. Скрипты, которые не
 * копируют месяцами, — кандидаты на переписывание или удаление.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { TableSkeletonRows } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { usePlaybook } from "@/lib/scripts/data";
import { findById, LANGS, plural } from "@/lib/scripts/logic";
import { defaultPeriod, periodBounds, type Period } from "@/lib/scripts/period";
import type { CopyStats, LangCounts, ScriptLang } from "@/lib/scripts/types";
import { cn } from "@/lib/utils";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { PeriodFilter } from "./period-filter";
import { Bar, ScriptTitle, StatTile } from "./shared";
import { useOpenScript } from "./use-open-script";

/** «Все» в Select: пустое значение Radix не принимает. */
const ALL = "all";

type ItemRow = CopyStats["items"][number] & { rank: number };
type UserRow = CopyStats["users"][number];

/** Колонки языков — общие у обеих таблиц. */
const LANG_GETTERS: SortGetters<LangCounts> = Object.fromEntries(
  LANGS.map((l) => [l.key, (r: LangCounts) => r[l.key] || null]),
);
const ITEM_GETTERS: SortGetters<ItemRow> = {
  ...LANG_GETTERS,
  title: (r) => r.title || "Без названия",
  total: (r) => r.total,
};
const USER_GETTERS: SortGetters<UserRow> = {
  ...LANG_GETTERS,
  name: (r) => r.name || "Без имени",
  total: (r) => r.total,
};

export function CopyStatsTab() {
  const { data: sections = [] } = usePlaybook();
  const openScript = useOpenScript();
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [user, setUser] = useState("");
  const [lang, setLang] = useState<ScriptLang | "">("");
  // Имена выбранных раньше — чтобы выбранный не пропал из списка, если в
  // новом периоде он ничего не копировал.
  const [knownUsers, setKnownUsers] = useState<Record<string, string>>({});

  const bounds = periodBounds(period);
  const { data, isPending, isFetching, isError } = useQuery({
    queryKey: ["scripts_copy_stats", bounds.from ?? "", bounds.to ?? "", user, lang],
    queryFn: () =>
      unwrap<CopyStats>(
        supabase.rpc("scripts_copy_stats", {
          _from: bounds.from,
          _to: bounds.to,
          _user: user || null,
          _lang: lang || null,
        }),
      ),
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить статистику копирований" },
  });

  useEffect(() => {
    if (!data?.users.length) return;
    setKnownUsers((known) => {
      const next = { ...known };
      for (const u of data.users) next[u.user_id] = u.name;
      return next;
    });
  }, [data]);

  const max = useMemo(() => Math.max(1, ...(data?.items.map((i) => i.total) ?? [])), [data]);
  const userName = user ? knownUsers[user] || "сотрудник" : "";
  const userOptions = Object.entries(knownUsers).sort((a, b) => a[1].localeCompare(b[1], "ru"));
  const filtered = !!user || !!lang;

  const dimLang = (key: ScriptLang) => !!lang && lang !== key;
  // «#» — место по числу копирований (порядок базы), сортировка его не меняет.
  const itemSort = useTableSort(ITEM_GETTERS);
  const userSort = useTableSort(USER_GETTERS);
  const items = itemSort.apply((data?.items ?? []).map((row, i) => ({ ...row, rank: i + 1 })));
  const users = userSort.apply(data?.users ?? []);

  return (
    <div className="space-y-3">
      <TableToolbar>
        <PeriodFilter value={period} onChange={setPeriod} />
        <Select value={user || ALL} onValueChange={(v) => setUser(v === ALL ? "" : v)}>
          <SelectTrigger className="w-48" aria-label="Сотрудник">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Все сотрудники</SelectItem>
            {userOptions.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name || "Без имени"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SegmentedControl
          aria-label="Язык"
          value={lang || ALL}
          onChange={(v) => setLang(v === ALL ? "" : (v as ScriptLang))}
          options={[
            { value: ALL, label: "Все языки" },
            ...LANGS.map((l) => ({ value: l.key as string, label: l.label })),
          ]}
          className="toolbar-full"
        />
        <ToolbarReset
          active={filtered}
          onReset={() => {
            setUser("");
            setLang("");
          }}
        />
      </TableToolbar>

      <div className={cn("space-y-3 transition-opacity", isFetching && !isPending && "opacity-60")}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={`Копирований${userName ? ` · ${userName}` : ""}`}
            value={isPending ? <Skeleton className="h-8 w-16" /> : (data?.totals.total ?? 0)}
          />
          {LANGS.map((l) => (
            <StatTile
              key={l.key}
              label={`${l.label} · ${l.name}`}
              value={isPending ? <Skeleton className="h-8 w-16" /> : (data?.totals[l.key] ?? 0)}
              dim={dimLang(l.key)}
            />
          ))}
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            Скрипты{userName ? ` — ${userName}` : ""}
            {!!data?.items.length && (
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                · {data.items.length} {plural(data.items.length, "скрипт", "скрипта", "скриптов")}
              </span>
            )}
          </h2>
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-right">#</TableHead>
                  <TableHead {...itemSort.head("title")}>Скрипт</TableHead>
                  <TableHead className="w-40">Доля</TableHead>
                  <TableHead className="text-right" {...itemSort.head("total")}>
                    Всего
                  </TableHead>
                  {LANGS.map((l) => (
                    <TableHead key={l.key} className="text-right" {...itemSort.head(l.key)}>
                      {l.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={7} rows={5} />
                ) : !data?.items.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {isError && !data
                        ? "Статистика не загрузилась — нажмите «Обновить» в шапке."
                        : filtered
                          ? "Ничего не найдено — у выбранного сотрудника или на этом языке копирований за период нет."
                          : "За этот период копирований нет. Отметка появляется, когда сотрудник нажимает «Копировать» у текста скрипта."}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((row) => {
                    const live = row.item_id ? findById(sections, row.item_id) : null;
                    return (
                      <TableRow key={row.item_id ?? `gone-${row.rank}`}>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {row.rank}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <ScriptTitle
                              title={row.title || "Без названия"}
                              onOpen={
                                !row.deleted && live
                                  ? () => openScript(live.section.id, live.item.id)
                                  : null
                              }
                            />
                            {row.section && (
                              <span className="text-xs text-muted-foreground">{row.section}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Bar value={row.total} max={max} />
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {row.total}
                        </TableCell>
                        <LangCells row={row} dim={dimLang} />
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {!user && !!data?.users.length && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">
              Сотрудники
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                · нажмите, чтобы посмотреть его скрипты
              </span>
            </h2>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead {...userSort.head("name")}>Сотрудник</TableHead>
                    <TableHead className="text-right" {...userSort.head("total")}>
                      Всего
                    </TableHead>
                    {LANGS.map((l) => (
                      <TableHead key={l.key} className="text-right" {...userSort.head(l.key)}>
                        {l.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow
                      key={u.user_id}
                      className="cursor-pointer"
                      onClick={() => setUser(u.user_id)}
                    >
                      <TableCell className="font-medium">{u.name || "Без имени"}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {u.total}
                      </TableCell>
                      <LangCells row={u} dim={dimLang} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LangCells({ row, dim }: { row: LangCounts; dim: (key: ScriptLang) => boolean }) {
  return (
    <>
      {LANGS.map((l) => (
        <TableCell
          key={l.key}
          className={cn("text-right tabular-nums", dim(l.key) && "text-muted-foreground/50")}
        >
          {row[l.key] || "—"}
        </TableCell>
      ))}
    </>
  );
}
