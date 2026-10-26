import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, CheckCircle2, AlertTriangle, Plus, Loader2, Check, Undo2 } from "lucide-react";
import { format, parseISO, subMonths, startOfMonth, endOfMonth, isWithinInterval } from "date-fns";
import { ru } from "date-fns/locale";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import type { Studio } from "@/hooks/use-studios";
import { StudioFilter, StudioLabel, StudioSelect } from "@/components/studio-label";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { CountBadge, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogForm,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/row-context-menu";
import { useConfirm } from "@/components/confirm-dialog";
import { NpsPageSkeleton, NpsStatsSkeleton, NpsSurveysSkeleton } from "@/components/page-skeletons";
import { ClientNameLink } from "@/components/client-name-link";
import { CommentCell } from "@/components/comment-cell";
import { useCrmLinks } from "@/hooks/use-crm-links";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  surveyType: "Момент, когда задан вопрос: NPS считается по каждому типу отдельно.",
  score: "9–10 — промоутер, 7–8 — нейтрал, 0–6 — критик. NPS = % промоутеров − % критиков.",
  read: "Новый ответ из приложения — в счётчике у «NPS-опросов» в меню, пока его не отметят прочитанным. Внесённые вручную — сразу прочитаны.",
};

export const Route = createFileRoute("/_authenticated/nps")({
  head: () => ({ meta: [{ title: "NPS-опросы — Lady Stretch" }] }),
  pendingComponent: NpsPageSkeleton,
  component: NpsPage,
});

type SurveyType = "first_lessons" | "first_month" | "before_renewal" | "after_return" | "general";

type NpsResponse = {
  id: string;
  /** Клуб ответа; старые строки без привязки — null. */
  studio_id: string | null;
  score: number;
  client_name: string | null;
  comment: string | null;
  language: string | null;
  survey_type: SurveyType;
  handled: boolean;
  created_at: string;
  /** Карточка клиента, ответившего в приложении; внесённые вручную — null. */
  client_id: string | null;
  /** Прочитан сотрудником (кто и когда — ставит база); null — новый. */
  read_at: string | null;
  read_by_name: string | null;
};

/** Показы опроса в приложении (RPC nps_prompt_stats). */
type PromptStats = { survey_type: SurveyType; shown: number; answered: number; closed: number };

/**
 * Когда опрос показывается в приложении — db/migrations/2026-10-15_zz_nps_surveys.sql
 * (nps_pending_survey). «Общий» приложение не показывает (inApp: false).
 */
const SURVEY_TYPES: { type: SurveyType; label: string; hint: string; inApp: boolean }[] = [
  {
    type: "first_lessons",
    label: "Первые занятия",
    hint: "Когда закончилась 4-я тренировка клиента",
    inApp: true,
  },
  {
    type: "first_month",
    label: "Первый месяц",
    hint: "Через 30 дней после начала первого абонемента (пробное не в счёт)",
    inApp: true,
  },
  {
    type: "before_renewal",
    label: "Перед продлением",
    hint: "За 10 дней до окончания абонемента, в пакетных клубах — и когда осталось 2 тренировки; кто уже купил продление — не получает",
    inApp: true,
  },
  {
    type: "after_return",
    label: "После возобновления",
    hint: "Вернувшимся из БЧК (без абонемента дольше 14 дней) — после 2-й тренировки",
    inApp: true,
  },
  { type: "general", label: "Общий", hint: "Любой контекст", inApp: false },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  SURVEY_TYPES.map((s) => [s.type, s.label]),
);

type NpsBucket = "promoter" | "passive" | "detractor";

/** Категория NPS по оценке 0–10: 9–10 промоутер, 7–8 пассивный, 0–6 критик. */
function npsBucket(score: number): NpsBucket {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

const BUCKET: Record<NpsBucket, { label: string; tone: StatusTone; order: number }> = {
  // order — порядок в таблице: сначала критики, им нужно ответить первыми.
  detractor: { label: "Критик", tone: "negative", order: 0 },
  passive: { label: "Пассивный", tone: "warning", order: 1 },
  promoter: { label: "Промоутер", tone: "positive", order: 2 },
};

/** Категория ответа NPS — чип статуса по оценке. */
function NpsBucketBadge({ score }: { score: number }) {
  const b = BUCKET[npsBucket(score)];
  return <StatusChip tone={b.tone}>{b.label}</StatusChip>;
}

/** Сортировка колонок (lib/table-sort.ts); «Прочитано» по возрастанию — новые первыми. */
const SORT_GETTERS: SortGetters<NpsResponse> = {
  date: (r) => r.created_at,
  client: (r) => r.client_name,
  score: (r) => r.score,
  category: (r) => BUCKET[npsBucket(r.score)].order,
  comment: (r) => r.comment,
  survey: (r) => TYPE_LABEL[r.survey_type],
  read: (r) => Boolean(r.read_at),
};

/** NPS = % промоутеров − % критиков; без ответов — null. */
function npsStats(rows: NpsResponse[]) {
  const counts: Record<NpsBucket, number> = { promoter: 0, passive: 0, detractor: 0 };
  for (const r of rows) counts[npsBucket(r.score)]++;
  const total = rows.length;
  const nps = total > 0 ? Math.round(((counts.promoter - counts.detractor) / total) * 100) : null;
  return {
    total,
    promoters: counts.promoter,
    passives: counts.passive,
    detractors: counts.detractor,
    nps,
  };
}

const byNewest = (a: NpsResponse, b: NpsResponse) =>
  new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

// Токены темы (src/styles.css) заданы в oklch, поэтому в графиках var(--…)
// подставляется как есть: обёртка hsl(var(--…)) давала невалидный цвет —
// линия NPS и сетка пропадали, у подсказки не было фона.
const tooltipStyle = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
};

function NpsPage() {
  const studioId = useActiveStudioId();
  // Ответы всех клубов сотрудника сразу, клуб — колонкой (решение владельца
  // 2026-10-19: не переключать клуб в шапке).
  const studios = useSectionStudios("nps");
  const idsKey = studioIdsKey(studios);
  const multi = (studios?.length ?? 0) > 1;
  const studioOf = (id: string | null) => studios?.find((s) => s.id === id) ?? null;
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<"surveys" | "stats">("surveys");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [studioFilter, setStudioFilter] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const queryKey = ["nps_responses", idsKey];
  const { data: allResponses = [], isLoading: queryLoading } = useQuery({
    queryKey,
    queryFn: () => {
      let q = supabase.from("nps_responses").select("*");
      // Ответы клубов раздела + строки без привязки (см. db/feedback_nps_studio.sql).
      if (idsKey) q = q.or(`studio_id.in.(${idsKey}),studio_id.is.null`);
      return unwrap<NpsResponse[]>(q.order("created_at", { ascending: false }));
    },
    enabled: studios !== null,
    meta: { errorMessage: "Не удалось загрузить ответы NPS" },
  });
  const loading = studios === null || queryLoading;
  const reload = () => queryClient.invalidateQueries({ queryKey: ["nps_responses"] });
  // Фильтр «Клуб» — для обеих вкладок: NPS и показы считаются по выбранным.
  const responses = useMemo(
    () =>
      studioFilter === "all"
        ? allResponses
        : allResponses.filter((r) => r.studio_id === studioFilter),
    [allResponses, studioFilter],
  );

  // Показы опросов — по клубу (RPC nps_prompt_stats), складываются по типу.
  const promptIds = studioFilter === "all" ? idsKey : studioFilter;
  const { data: promptStats = [], isLoading: promptsQueryLoading } = useQuery({
    queryKey: ["nps_survey_prompts", promptIds],
    queryFn: async () => {
      const parts = await Promise.all(
        promptIds
          .split(",")
          .map((id) =>
            unwrap<PromptStats[]>(supabase.rpc("nps_prompt_stats", { p_studio_id: id })),
          ),
      );
      const byType = new Map<SurveyType, PromptStats>();
      for (const row of parts.flat()) {
        const cur = byType.get(row.survey_type);
        byType.set(
          row.survey_type,
          cur
            ? {
                survey_type: row.survey_type,
                shown: Number(cur.shown) + Number(row.shown),
                answered: Number(cur.answered) + Number(row.answered),
                closed: Number(cur.closed) + Number(row.closed),
              }
            : row,
        );
      }
      return [...byType.values()];
    },
    enabled: !!promptIds,
    meta: { errorMessage: "Не удалось загрузить показы опросов" },
  });
  const promptsLoading = studios === null || (!!promptIds && promptsQueryLoading);

  const toggleHandled = async (id: string, current: boolean) => {
    const { error } = await supabase
      .from("nps_responses")
      .update({ handled: !current })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    queryClient.setQueryData<NpsResponse[]>(queryKey, (prev) =>
      prev?.map((r) => (r.id === id ? { ...r, handled: !current } : r)),
    );
  };

  // «Прочитано» / «Отметить непрочитанным»: кто и когда — ставит база
  // (db/migrations/2026-10-15_zzz_nps_read_renewal.sql). Счётчик в меню —
  // тот же ключ ["nps_responses", idsKey, …].
  const setRead = async (r: NpsResponse, read: boolean) => {
    setBusyId(r.id);
    try {
      const { data, error } = await supabase
        .from("nps_responses")
        .update({ read_at: read ? new Date().toISOString() : null })
        .eq("id", r.id)
        .select("read_at, read_by_name")
        .single();
      if (error) {
        toast.error("Не удалось сохранить: " + error.message);
        return;
      }
      queryClient.setQueryData<NpsResponse[]>(queryKey, (prev) =>
        prev?.map((x) => (x.id === r.id ? { ...x, ...data } : x)),
      );
      queryClient.invalidateQueries({ queryKey: ["nps_responses", idsKey, "unread-count"] });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: "Удалить ответ?",
        description: "Это действие нельзя отменить.",
      }))
    )
      return;
    const { error } = await supabase.from("nps_responses").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    queryClient.setQueryData<NpsResponse[]>(queryKey, (prev) => prev?.filter((r) => r.id !== id));
    queryClient.invalidateQueries({ queryKey: ["nps_responses", idsKey, "unread-count"] });
    toast.success("Ответ удалён");
  };

  const byType = useMemo(
    () =>
      typeFilter === "all" ? responses : responses.filter((r) => r.survey_type === typeFilter),
    [responses, typeFilter],
  );

  const monthly = useMemo(() => {
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = subMonths(new Date(), 5 - i);
      return {
        label: format(d, "LLL yy", { locale: ru }),
        start: startOfMonth(d),
        end: endOfMonth(d),
      };
    });
    return months.map((m) => {
      const inMonth = byType.filter((r) =>
        isWithinInterval(parseISO(r.created_at), { start: m.start, end: m.end }),
      );
      return { month: m.label, NPS: npsStats(inMonth).nps };
    });
  }, [byType]);

  const global = useMemo(() => npsStats(byType), [byType]);

  const distribution = [
    // Цвета статусов (emerald / amber / rose -500), как у чипов категорий.
    { name: "Промоутеры", count: global.promoters, color: "#10b981" },
    { name: "Пассивные", count: global.passives, color: "#f59e0b" },
    { name: "Критики", count: global.detractors, color: "#f43f5e" },
  ];

  const tableData = useMemo(() => {
    const d =
      clientFilter === "all" ? byType : byType.filter((r) => npsBucket(r.score) === clientFilter);
    // Сначала непрочитанные — их нужно отметить, потом критики.
    return [...d].sort((a, b) => {
      if (!a.read_at !== !b.read_at) return a.read_at ? 1 : -1;
      const ac = BUCKET[npsBucket(a.score)].order;
      const bc = BUCKET[npsBucket(b.score)].order;
      if (ac !== bc) return ac - bc;
      return byNewest(a, b);
    });
  }, [byType, clientFilter]);

  const unhandled = useMemo(
    () => byType.filter((r) => npsBucket(r.score) === "detractor" && !r.handled).sort(byNewest),
    [byType],
  );

  const sort = useTableSort({
    ...SORT_GETTERS,
    studio: (r: NpsResponse) => studioOf(r.studio_id)?.name,
  });
  const pg = usePagination(sort.apply(tableData), undefined, sort.key);
  const unreadCount = useMemo(() => allResponses.filter((r) => !r.read_at).length, [allResponses]);
  const crmLinkOf = useCrmLinks(studioId, "id", [
    ...pg.paged.map((r) => r.client_id),
    ...unhandled.map((r) => r.client_id),
  ]);
  const clientCell = (r: NpsResponse) =>
    r.client_id ? (
      <ClientNameLink clientId={r.client_id} crmLink={crmLinkOf(r.client_id)}>
        {r.client_name || "—"}
      </ClientNameLink>
    ) : (
      r.client_name || "—"
    );

  return (
    <AdminShell
      title="NPS-опросы"
      actions={
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus /> Добавить ответ
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
            <NewResponseForm
              studioId={studioId}
              studios={studios ?? []}
              onClose={() => setAddOpen(false)}
              onSaved={reload}
            />
          </DialogContent>
        </Dialog>
      }
    >
      <div className="space-y-3">
        {/* Табы и фильтры «Статистики» — на одной белой плашке, не на канве. */}
        <TableToolbar>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "surveys" | "stats")}
            className="toolbar-full"
          >
            <TabsList>
              <TabsTrigger value="surveys">Опросы</TabsTrigger>
              <TabsTrigger value="stats">
                Статистика
                {unreadCount > 0 && (
                  <CountBadge
                    count={unreadCount}
                    tone="quiet"
                    aria-label={`Непрочитанных: ${unreadCount}`}
                    className="ml-1.5"
                  />
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {multi && studios && (
            <StudioFilter studios={studios} value={studioFilter} onChange={setStudioFilter} />
          )}
          {tab === "stats" && (
            <>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger aria-label="Опрос" className="w-48">
                  <SelectValue placeholder="Все опросы" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все опросы</SelectItem>
                  {SURVEY_TYPES.map((s) => (
                    <SelectItem key={s.type} value={s.type}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={clientFilter} onValueChange={setClientFilter}>
                <SelectTrigger aria-label="Категория" className="w-40">
                  <SelectValue placeholder="Все категории" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все категории</SelectItem>
                  <SelectItem value="promoter">Промоутеры</SelectItem>
                  <SelectItem value="passive">Пассивные</SelectItem>
                  <SelectItem value="detractor">Критики</SelectItem>
                </SelectContent>
              </Select>
              <ToolbarReset
                active={typeFilter !== "all" || clientFilter !== "all" || studioFilter !== "all"}
                onReset={() => {
                  setTypeFilter("all");
                  setClientFilter("all");
                  setStudioFilter("all");
                }}
              />
            </>
          )}
        </TableToolbar>

        {tab === "surveys" && (
          <InfoNote>
            Опросы первых занятий, первого месяца, перед продлением и после возобновления
            показываются клиенту окном на главной мобильного приложения, когда наступает момент;
            клиент может закрыть окно крестиком и не отвечать — тогда этот опрос больше не
            показывается. Не чаще одного опроса в 14 дней, «Перед продлением» — не чаще раза в 90
            дней и не раньше чем через 30 дней после другого опроса. Новые ответы — в счётчике у
            «NPS-опросов» в меню: отметьте каждый прочитанным во вкладке «Статистика».
          </InfoNote>
        )}

        {/* Болванка своей вкладки: у «Опросов» и «Статистики» разная раскладка. */}
        {loading || (tab === "surveys" && promptsLoading) ? (
          tab === "surveys" ? (
            <NpsSurveysSkeleton />
          ) : (
            <NpsStatsSkeleton />
          )
        ) : tab === "surveys" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {SURVEY_TYPES.map((s) => {
              const st = npsStats(responses.filter((r) => r.survey_type === s.type));
              const shows = promptStats.find((p) => p.survey_type === s.type);
              return (
                <div key={s.type} className="rounded-lg border bg-background p-5">
                  <h3 className="text-sm font-semibold">{s.label}</h3>
                  <p className="mb-4 text-xs text-muted-foreground">{s.hint}</p>
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <Stat label="NPS" value={st.nps ?? "—"} />
                    <Stat label="Ответов" value={st.total} />
                    <Stat label="Промо" value={st.promoters} cls="text-emerald-700" />
                    <Stat label="Критики" value={st.detractors} cls="text-destructive" />
                  </div>
                  {s.inApp ? (
                    <p className="mt-4 text-xs text-muted-foreground">
                      В приложении: показан клиентам — {shows?.shown ?? 0}, ответили —{" "}
                      {shows?.answered ?? 0}, закрыли без ответа — {shows?.closed ?? 0}
                    </p>
                  ) : (
                    <InfoNote variant="warning" className="mt-4">
                      Не реализовано: в приложении не показывается — нужно продумать механику
                      отправки. Ответы можно внести вручную («Добавить ответ»).
                    </InfoNote>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <KPI label="NPS" value={global.nps ?? "—"} />
              <KPI label="Ответов" value={global.total} />
              <KPI label="Промоутеры" value={global.promoters} cls="text-emerald-700" />
              <KPI label="Пассивные" value={global.passives} cls="text-amber-700" />
              <KPI label="Критики" value={global.detractors} cls="text-destructive" />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border bg-background p-5">
                <h3 className="mb-4 text-sm font-semibold">Динамика NPS по месяцам</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={monthly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis domain={[-100, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line
                      type="monotone"
                      dataKey="NPS"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-lg border bg-background p-5">
                <h3 className="mb-4 text-sm font-semibold">Распределение</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={distribution} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                      {distribution.map((e, i) => (
                        <Cell key={i} fill={e.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {unhandled.length > 0 && (
              <div className="rounded-lg border bg-background p-5">
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <h3 className="text-sm font-semibold">Требуют внимания ({unhandled.length})</h3>
                </div>
                <div className="space-y-2">
                  {unhandled.map((r) => (
                    <div key={r.id} className="flex items-start gap-3 rounded-md border p-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{clientCell(r)}</span>
                          <StatusChip tone="negative" className="tabular-nums">
                            {r.score}
                          </StatusChip>
                          <span className="text-xs text-muted-foreground">
                            {TYPE_LABEL[r.survey_type]}
                          </span>
                          {multi && (
                            <StudioLabel
                              studio={studioOf(r.studio_id)}
                              className="text-xs text-muted-foreground"
                            />
                          )}
                        </div>
                        <p className="truncate text-sm text-muted-foreground">{r.comment || "—"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {format(parseISO(r.created_at), "d MMM yyyy, HH:mm", { locale: ru })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleHandled(r.id, r.handled)}
                      >
                        <CheckCircle2 /> Обработан
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead {...sort.head("date")}>Дата</TableHead>
                    <TableHead {...sort.head("client")}>Клиент</TableHead>
                    {multi && <TableHead {...sort.head("studio")}>Клуб</TableHead>}
                    <TableHead className="w-[80px]" tip={TIPS.score} {...sort.head("score")}>
                      Оценка
                    </TableHead>
                    <TableHead {...sort.head("category")}>Категория</TableHead>
                    <TableHead {...sort.head("comment")}>Комментарий</TableHead>
                    <TableHead tip={TIPS.surveyType} {...sort.head("survey")}>
                      Опрос
                    </TableHead>
                    <TableHead tip={TIPS.read} {...sort.head("read")}>
                      Прочитано
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pg.total === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={multi ? 8 : 7}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Нет ответов.
                      </TableCell>
                    </TableRow>
                  ) : (
                    pg.paged.map((r) => {
                      const busy = busyId === r.id;
                      return (
                        <RowContextMenu
                          key={r.id}
                          actions={[
                            r.read_at
                              ? {
                                  label: "Отметить непрочитанным",
                                  icon: Undo2,
                                  onSelect: () => setRead(r, false),
                                }
                              : {
                                  label: "Прочитано",
                                  icon: Check,
                                  onSelect: () => setRead(r, true),
                                },
                            {
                              label: "Удалить",
                              icon: Trash2,
                              destructive: true,
                              onSelect: () => handleDelete(r.id),
                            },
                          ]}
                        >
                          <TableRow
                            className={cn(
                              !r.read_at && "max-md:border-l-4 max-md:border-l-rose-500",
                            )}
                          >
                            <TableCell className="relative whitespace-nowrap text-muted-foreground tabular-nums">
                              {/* Непрочитанный — красная полоска слева, как у «Заявок». */}
                              {!r.read_at && (
                                <span
                                  aria-hidden
                                  className="absolute inset-y-0 left-0 w-1 bg-rose-500 max-md:hidden"
                                />
                              )}
                              {format(parseISO(r.created_at), "d MMM, HH:mm", { locale: ru })}
                            </TableCell>
                            <TableCell className="font-medium">{clientCell(r)}</TableCell>
                            {multi && (
                              <TableCell>
                                <StudioLabel studio={studioOf(r.studio_id)} />
                              </TableCell>
                            )}
                            <TableCell className="text-center font-semibold tabular-nums">
                              {r.score}
                            </TableCell>
                            <TableCell>
                              <NpsBucketBadge score={r.score} />
                            </TableCell>
                            <TableCell>
                              <CommentCell text={r.comment} />
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {TYPE_LABEL[r.survey_type]}
                            </TableCell>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              {r.read_at ? (
                                <div className="text-xs text-muted-foreground">
                                  <StatusChip tone="positive">Прочитано</StatusChip>
                                  <div className="mt-1">
                                    {r.read_by_name ? `${r.read_by_name} · ` : ""}
                                    {format(parseISO(r.read_at), "dd.MM.yy", { locale: ru })}
                                  </div>
                                </div>
                              ) : (
                                <Button size="sm" onClick={() => setRead(r, true)} disabled={busy}>
                                  {busy ? <Loader2 className="animate-spin" /> : <Check />}
                                  Прочитано
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
          </div>
        )}
      </div>

      {confirmDialog}
    </AdminShell>
  );
}

function NewResponseForm({
  studioId,
  studios,
  onClose,
  onSaved,
}: {
  studioId: string | null;
  /** Клубы раздела: при нескольких — поле «Клуб», по умолчанию клуб из шапки. */
  studios: Studio[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [studio, setStudio] = useState(
    () => studios.find((s) => s.id === studioId)?.id ?? studios[0]?.id ?? studioId ?? "",
  );
  const [surveyType, setSurveyType] = useState<SurveyType>("general");
  // Строкой: поле можно очистить и набрать заново, проверка — при сохранении.
  const [score, setScore] = useState("9");
  const [clientName, setClientName] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const value = Number(score.trim());
    if (!score.trim() || !Number.isInteger(value) || value < 0 || value > 10) {
      toast.error("Укажите оценку — целое число от 0 до 10");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("nps_responses").insert({
        studio_id: studio || null,
        score: value,
        client_name: clientName.trim() || null,
        comment: comment.trim() || null,
        survey_type: surveyType,
        language: "ru",
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Ответ добавлен");
      onClose();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новый ответ NPS</DialogTitle>
        <DialogDescription>Заполните данные ответа клиента.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={submit}>
        <DialogBody>
          <div className="space-y-4">
            {studios.length > 1 && (
              <FormField label="Клуб" required>
                <StudioSelect studios={studios} value={studio} onChange={setStudio} />
              </FormField>
            )}
            <FormField label="Тип опроса" tip={TIPS.surveyType} required>
              <Select value={surveyType} onValueChange={(v) => setSurveyType(v as SurveyType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SURVEY_TYPES.map((s) => (
                    <SelectItem key={s.type} value={s.type}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Оценка" tip={TIPS.score} hint="От 0 до 10." required>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={10}
                step={1}
                value={score}
                onChange={(e) => setScore(e.target.value)}
              />
            </FormField>
            <FormField label="Имя клиента" optional>
              <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </FormField>
            <FormField label="Комментарий" optional>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * Цвет у числа — только когда оно есть: красный «0» у «Критиков» и зелёный
 * «0» у «Промо» сигналили о том, чего нет.
 */
function toneIfAny(value: number | string, cls: string) {
  return typeof value === "number" && value <= 0 ? "" : cls;
}

function Stat({ label, value, cls = "" }: { label: string; value: number | string; cls?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold tabular-nums", toneIfAny(value, cls))}>{value}</p>
    </div>
  );
}

function KPI({ label, value, cls = "" }: { label: string; value: number | string; cls?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", toneIfAny(value, cls))}>
        {value}
      </p>
    </div>
  );
}
