/**
 * Статистика звонков: докуда разговор доходит по сценарию и где
 * заканчивается — у всех или у одного администратора.
 *
 * Каждый звонок, который администратор ведёт по разделу-звонку, тихо пишет
 * свой путь по блокам (тестовые прогоны — нет). Два вида:
 * - «Сводка»: воронка — сколько звонков дошли до каждого этапа и сколько на
 *   нём закончились, и блоки, на которых звонки заканчивались; конец
 *   сценария отмечен отдельно от обрыва;
 * - «Звонки»: история — каждый звонок с датой и временем, кто звонил, до
 *   какого этапа дошёл и на каком блоке закончился, весь путь по клику.
 *
 * Все числа видны текстом — полосы только помогают глазу.
 */
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyCard } from "@/components/scripts/empty-card";
import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { TableCardSkeleton, TableSkeletonRows } from "@/components/skeletons";
import { CallStatsSummarySkeleton } from "@/components/page-skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  buildCallStats,
  duration,
  flowNodes,
  pct,
  runProgress,
  type CallStats,
  type EndStat,
  type FunnelStep,
} from "@/lib/scripts/call-stats";
import { usePlaybook } from "@/lib/scripts/data";
import { formatWhen, plural } from "@/lib/scripts/logic";
import { defaultPeriod, periodBounds, type Period } from "@/lib/scripts/period";
import type { CallNode, CallRunRow, CallStatsRaw } from "@/lib/scripts/types";
import { cn } from "@/lib/utils";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { PeriodFilter } from "./period-filter";
import { Bar, LoadMore, StatTile } from "./shared";
import { afterCursor, PAGE_SIZE, usePaged, type Cursor } from "./use-paged";

const ALL = "all";

type View = "summary" | "calls";

export function CallStatsTab() {
  const { data: sections } = usePlaybook();
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [section, setSection] = useState("");
  const [user, setUser] = useState("");
  const [view, setView] = useState<View>("summary");

  const bounds = periodBounds(period);
  const {
    data: raw,
    isPending,
    isFetching,
  } = useQuery({
    queryKey: ["scripts_call_stats", section, bounds.from ?? "", bounds.to ?? "", user],
    queryFn: () =>
      unwrap<CallStatsRaw>(
        supabase.rpc("scripts_call_stats", {
          _section: section || null,
          _from: bounds.from,
          _to: bounds.to,
          _user: user || null,
        }),
      ),
    placeholderData: keepPreviousData,
    meta: { errorMessage: "Не удалось загрузить статистику звонков" },
  });

  // Этапы — из живого сценария; удалён — восстанавливаются по самим звонкам.
  const liveNodes = useMemo<CallNode[] | null>(
    () => sections?.find((s) => s.id === raw?.section_id)?.flow?.nodes ?? null,
    [sections, raw?.section_id],
  );
  const data = useMemo(() => (raw ? buildCallStats(raw, liveNodes) : null), [raw, liveNodes]);

  return (
    <div className="space-y-3">
      <TableToolbar>
        <PeriodFilter value={period} onChange={setPeriod} />
        {data && data.sections.length > 1 && (
          <Select value={data.section_id ?? ""} onValueChange={setSection}>
            <SelectTrigger className="w-48" aria-label="Сценарий">
              <SelectValue placeholder="Сценарий" />
            </SelectTrigger>
            <SelectContent>
              {data.sections.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.title}
                  {s.deleted ? " (удалён)" : ""} · {s.runs}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Выбирать есть из кого — только тому, кто видит звонки всех. */}
        {data && (data.users.length > 1 || user) && (
          <Select value={user || ALL} onValueChange={(v) => setUser(v === ALL ? "" : v)}>
            <SelectTrigger className="w-48" aria-label="Администратор">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все администраторы</SelectItem>
              {data.users.map((u) => (
                <SelectItem key={u.user_id} value={u.user_id}>
                  {u.name || "Без имени"} · {u.runs}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ToolbarReset
          active={!!section || !!user}
          onReset={() => {
            setSection("");
            setUser("");
          }}
        />
        {/* «Сводка / Звонки» — на той же плашке, не прямо на канве. */}
        <Tabs
          value={view}
          onValueChange={(v) => setView(v as View)}
          className="toolbar-full sm:ml-auto"
        >
          <TabsList aria-label="Вид">
            <TabsTrigger value="summary">Сводка</TabsTrigger>
            <TabsTrigger value="calls">Звонки</TabsTrigger>
          </TabsList>
        </Tabs>
      </TableToolbar>

      <p className="text-sm text-muted-foreground">
        {view === "summary"
          ? "До какого этапа доходит разговор и на каком блоке заканчивается — где сценарий теряет клиентов."
          : "Каждый звонок: когда, кто, до какого этапа дошёл и где закончился. Нажмите — весь путь."}
      </p>

      {isPending ? (
        view === "summary" ? (
          <CallStatsSummarySkeleton />
        ) : (
          <TableCardSkeleton
            rows={5}
            headers={["Когда", "Кто", "Дошёл до этапа", "Закончил на", "Шаги"]}
          />
        )
      ) : !data ? (
        <EmptyCard title="Статистика не загрузилась">Нажмите «Обновить» в шапке.</EmptyCard>
      ) : !data.sections.length ? (
        <EmptyCard title="Сценариев звонков пока нет">
          Звонки появятся здесь, когда в «Скриптах LS» будет раздел-звонок и администраторы начнут
          вести по нему разговоры.
        </EmptyCard>
      ) : (
        <div className={cn("space-y-3 transition-opacity", isFetching && "opacity-60")}>
          {data.totals.runs === 0 ? (
            <EmptyCard title="За этот период звонков нет">
              Звонок попадает сюда, когда администратор отвечает на первом шаге сценария.
            </EmptyCard>
          ) : view === "calls" ? (
            <CallHistory
              sectionId={data.section_id ?? ""}
              period={period}
              user={user}
              nodes={flowNodes(liveNodes, raw?.seen)}
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatTile label="Звонков за период" value={data.totals.runs} />
                <StatTile
                  label={`Дошли до конца сценария · ${data.totals.completed}`}
                  value={pct(data.totals.completed, data.totals.runs)}
                />
                <StatTile
                  label="Шагов сценария в среднем"
                  value={
                    data.totals.avg_steps == null
                      ? "—"
                      : data.totals.avg_steps.toFixed(1).replace(".", ",")
                  }
                />
              </div>
              <Funnel data={data} />
              <Ends data={data} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <h2 className="text-lg font-semibold">
      {title}
      <span className="text-sm font-normal text-muted-foreground"> · {hint}</span>
    </h2>
  );
}

/* --- Воронка ------------------------------------------------------------- */

type FunnelRow = FunnelStep & { step: number };
const FUNNEL_GETTERS: SortGetters<FunnelRow> = {
  step: (s) => s.step,
  title: (s) => s.title,
  reached: (s) => s.reached,
  ended: (s) => s.ended_here || null,
};
const ENDS_GETTERS: SortGetters<EndStat> = {
  title: (e) => e.title,
  count: (e) => e.count,
};

function Funnel({ data }: { data: CallStats }) {
  const sort = useTableSort(FUNNEL_GETTERS);
  if (!data.funnel.length) return null;
  const total = data.totals.runs;
  const endIds = new Set(data.ends.filter((e) => e.script_end).map((e) => e.node_id));
  // Где чаще всего обрываются — среди этапов, которые не конец сценария.
  const drops = data.funnel.filter((s) => s.ended_here && !endIds.has(s.node_id));
  const worst = drops.length
    ? drops.reduce((a, b) => (b.ended_here > a.ended_here ? b : a)).node_id
    : "";
  return (
    <div className="space-y-2">
      <SectionTitle
        title="Воронка по этапам"
        hint="сколько звонков дошли до этапа и сколько на нём закончились"
      />
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-right" {...sort.head("step")}>
                #
              </TableHead>
              <TableHead {...sort.head("title")}>Этап</TableHead>
              <TableHead className="w-56">Доля дошедших</TableHead>
              <TableHead className="text-right" {...sort.head("reached")}>
                Дошли
              </TableHead>
              <TableHead className="text-right" {...sort.head("ended")}>
                Закончились здесь
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.apply(data.funnel.map((s, i) => ({ ...s, step: i + 1 }))).map((s) => {
              const isEnd = endIds.has(s.node_id);
              const isWorst = worst === s.node_id;
              return (
                <TableRow
                  key={s.node_id}
                  className={cn(!s.reached && "text-muted-foreground")}
                  title={`${s.title}: дошли ${s.reached} из ${total}, закончились здесь ${s.ended_here}`}
                >
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {s.step}
                  </TableCell>
                  <TableCell className="font-medium">{s.title}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Bar value={s.reached} max={total} className="flex-1" />
                      <span className="w-12 text-right text-xs tabular-nums">
                        {pct(s.reached, total)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.reached}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.ended_here ? (
                      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                        {isWorst && <StatusChip tone="negative">больше всего обрывов</StatusChip>}
                        {isEnd && <StatusChip tone="positive">конец сценария</StatusChip>}
                        <span className={cn(isWorst && "font-semibold text-rose-700")}>
                          {s.ended_here}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* --- Где заканчивались звонки --------------------------------------------- */

function Ends({ data }: { data: CallStats }) {
  const sort = useTableSort(ENDS_GETTERS);
  if (!data.ends.length) return null;
  const total = data.totals.runs;
  const max = Math.max(1, ...data.ends.map((e) => e.count));
  return (
    <div className="space-y-2">
      <SectionTitle
        title="Где заканчивались звонки"
        hint="последний блок разговора — включая возражения"
      />
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("title")}>Блок</TableHead>
              <TableHead className="w-56">Доля</TableHead>
              <TableHead className="text-right" {...sort.head("count")}>
                Звонков
              </TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.apply(data.ends).map((e) => (
              <TableRow key={e.node_id} title={`${e.title}: ${e.count} из ${total}`}>
                <TableCell>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.title}</span>
                    {e.script_end ? (
                      <StatusChip tone="positive">конец сценария</StatusChip>
                    ) : (
                      e.group === "objection" && <StatusChip tone="warning">возражение</StatusChip>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Bar value={e.count} max={max} tone={e.script_end ? "emerald" : "blue"} />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{e.count}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {pct(e.count, total)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* --- История звонков ------------------------------------------------------ */

const RUN_COLUMNS = "id, section_id, user_id, user_name, path, started_at, updated_at, ended_at";

function CallHistory({
  sectionId,
  period,
  user,
  nodes,
}: {
  sectionId: string;
  period: Period;
  user: string;
  nodes: ReturnType<typeof flowNodes>;
}) {
  const bounds = periodBounds(period);
  const [open, setOpen] = useState("");
  const { items, loading, hasMore, loadingMore, more, sentinel } = usePaged({
    queryKey: ["scripts_call_runs", sectionId, bounds.from ?? "", bounds.to ?? "", user],
    load: async (cursor: Cursor | null) => {
      let q = supabase.from("scripts_call_runs").select(RUN_COLUMNS).eq("section_id", sectionId);
      if (bounds.from) q = q.gte("started_at", bounds.from);
      if (bounds.to) q = q.lt("started_at", bounds.to);
      if (user) q = q.eq("user_id", user);
      if (cursor) q = q.or(afterCursor("started_at", cursor));
      return unwrap<CallRunRow[]>(
        q
          .order("started_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(PAGE_SIZE),
      );
    },
    cursorOf: (r: CallRunRow) => ({ at: r.started_at, id: r.id }),
    errorMessage: "Не удалось загрузить звонки",
    enabled: !!sectionId,
  });

  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Когда</TableHead>
              <TableHead>Кто</TableHead>
              <TableHead>Дошёл до этапа</TableHead>
              <TableHead>Закончил на</TableHead>
              <TableHead className="text-right">Шаги</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableSkeletonRows columns={5} rows={5} />
            ) : !items.length ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  Звонков нет
                </TableCell>
              </TableRow>
            ) : (
              items.map((r) => {
                const p = runProgress(r, nodes, now);
                const expanded = open === r.id;
                const meta = [
                  `${p.steps} ${plural(p.steps, "шаг", "шага", "шагов")}`,
                  duration(p.seconds),
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <Fragment key={r.id}>
                    <TableRow
                      className="cursor-pointer"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? "" : r.id)}
                    >
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatWhen(r.started_at)}
                      </TableCell>
                      <TableCell className="font-medium">{r.user_name || "—"}</TableCell>
                      <TableCell>
                        <div
                          className="min-w-40 space-y-1"
                          title={`Дошёл до этапа ${p.reached} из ${p.stages}`}
                        >
                          <Bar value={p.reached} max={p.stages} />
                          <p className="text-xs">
                            <span className="tabular-nums">
                              {p.reached}/{p.stages}
                            </span>{" "}
                            {p.reached_title}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                          <span className="text-muted-foreground">
                            {p.live ? "сейчас на" : "закончил на"}
                          </span>
                          <span>{p.last_title || "—"}</span>
                          {p.live ? (
                            <StatusChip tone="info">идёт сейчас</StatusChip>
                          ) : p.script_end ? (
                            <StatusChip tone="positive">конец сценария</StatusChip>
                          ) : (
                            p.last_group === "objection" && (
                              <StatusChip tone="warning">возражение</StatusChip>
                            )
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground tabular-nums">
                        {meta}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="bg-muted/30">
                          <RunPath run={r} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <LoadMore sentinel={sentinel} hasMore={hasMore} loading={loadingMore} onMore={more} />
    </div>
  );
}

/** Весь путь звонка: блоки по порядку и что ответил клиент. */
function RunPath({ run }: { run: CallRunRow }) {
  if (!run.path?.length) return <p className="text-sm text-muted-foreground">Шагов нет</p>;
  return (
    <ol className="space-y-1.5 py-1">
      {run.path.map((step, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">
            {i + 1}.
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{step.title || "—"}</span>
              {step.group === "objection" && <StatusChip tone="warning">возражение</StatusChip>}
            </span>
            {step.answer && (
              <span className="block text-muted-foreground">Клиент: {step.answer}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
