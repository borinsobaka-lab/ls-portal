import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Fire,
  DumbbellLargeMinimalistic,
  ChartSquare,
  Cup,
  Fire as FireIcon,
  ChartSquare as DonutIcon,
} from "@solar-icons/react";
import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { fetchMyDiagnosticEntryIds } from "@/lib/home-queries";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { IS_PACKAGES } from "@/lib/terms";
import { msg, useLocalize, useT, type ContentTranslations, type Translator } from "@/i18n";

// ---- Types ----

type BookingRow = {
  entry_id: string | null;
  starts_at: string;
  duration_min: number | null;
  calories: number | null;
  workout_id: string | null;
  workout_name: string | null;
  workout_type: string | null;
  studio_id: string | null;
};

/**
 * Сравнение со студией (пакетное приложение) — RPC my_studio_visit_stats
 * (db/migrations/2026-10-12_zz_packages_app_fixes.sql): только агрегаты, при
 * малой выборке поля пустые.
 */
type StudioCompare = {
  /** Топ N % студии по посещениям за всё время. */
  total_top_pct: number | null;
  /** Среднее посещений за месяц среди тех, кто в этом месяце занимался. */
  month_avg: number | null;
  /** Активнее, чем N % занимавшихся в этом месяце. */
  month_better_pct: number | null;
};

type StatsMv = {
  studio_id: string;
  user_id: string;
  visits_30d: number;
  calories_30d: number;
  visits_percentile: number | null;
  calories_percentile: number | null;
  cohort_size: number;
};

type WorkoutType = "cardio" | "strength" | "hybrid" | "recovery" | "unknown";

const TYPE_LABEL: Record<WorkoutType, string> = {
  cardio: msg("Кардио"),
  strength: msg("Сила"),
  hybrid: msg("Гибрид"),
  recovery: msg("Восст."),
  unknown: msg("Прочее"),
};

const TYPE_COLOR: Record<WorkoutType, string> = {
  cardio: "bg-red-500",
  strength: "bg-blue-500",
  hybrid: "bg-violet-500",
  recovery: "bg-emerald-500",
  unknown: "bg-muted-foreground",
};

/** Тренировка студии (пакетное приложение): цвет полоски и имя с переводами. */
type WorkoutInfo = {
  id: string;
  color: string | null;
  name: string;
  translations?: ContentTranslations | null;
};

/** Тренировка студии (пакетное приложение): вместо типа — сама тренировка и её цвет. */
type WorkoutPart = { key: string; label: string; count: number; color: string | null };

const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
function nextMilestone(total: number) {
  return MILESTONES.find((m) => m > total) ?? total + 100;
}

function normalizeType(t: string | null | undefined): WorkoutType {
  const v = (t ?? "").toLowerCase();
  if (v === "cardio" || v === "strength" || v === "hybrid" || v === "recovery") return v;
  return "unknown";
}

function startOfWeek(d: Date): Date {
  // ISO week start = Monday
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function weekKey(d: Date) {
  const w = startOfWeek(d);
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, "0")}-${String(w.getDate()).padStart(2, "0")}`;
}

// ---- Small UI helpers ----

function Sparkline({ data }: { data: number[] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data);
  const w = 64;
  const h = 22;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="opacity-80">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function WorkoutBar({ parts }: { parts: WorkoutPart[] }) {
  const total = parts.reduce((s, p) => s + p.count, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
      {parts.map((p) => (
        <div
          key={p.key}
          className={p.color ? "" : "bg-muted-foreground/40"}
          style={{
            width: `${(p.count / total) * 100}%`,
            ...(p.color ? { backgroundColor: p.color } : {}),
          }}
        />
      ))}
    </div>
  );
}

function TypeBar({ parts }: { parts: { type: WorkoutType; count: number }[] }) {
  const total = parts.reduce((s, p) => s + p.count, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {parts.map((p) => (
        <div
          key={p.type}
          className={TYPE_COLOR[p.type]}
          style={{ width: `${(p.count / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  hint,
  right,
  accent,
  footer,
  className = "",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string | null;
  right?: React.ReactNode;
  accent?: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl bg-card border border-border/40 p-4 flex flex-col gap-2 ${className}`}
    >
      <div className="flex items-center gap-2">
        <div
          className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full ${accent ?? "bg-primary/10 text-primary"}`}
        >
          {icon}
        </div>
        <div className="text-2xl font-bold leading-tight">{value}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {hint ? <div className="text-[11px] text-muted-foreground/80 mt-0.5">{hint}</div> : null}
      </div>
      {right}
      {footer}
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="mx-4 rounded-2xl bg-card border border-border/40 p-5 text-center">
      <div className="text-sm text-muted-foreground">
        {t("Чтобы увидеть прогресс, посети первый класс — статистика появится автоматически.")}
      </div>
    </div>
  );
}

// ---- Aggregation ----

type Aggregated = {
  total: number;
  thisMonth: number;
  bestMonth: number;
  streakWeeks: number;
  sparkline: number[]; // last 8 weeks
  byType: { type: WorkoutType; count: number }[];
  /** Пакетное приложение: посещения по тренировкам студии (по убыванию). */
  byWorkout: WorkoutPart[];
  /** Первое посещение — «с нами с …». */
  firstVisit: Date | null;
  calories30d: number;
  calories30dHasNull: boolean;
};

/**
 * names — имя тренировки на языке клиента, если у неё есть перевод; иначе —
 * снимок workout_name из журнала (как раньше).
 */
function aggregate(
  rows: BookingRow[],
  t: Translator,
  colors: Record<string, string | null> = {},
  names: Record<string, string> = {},
): Aggregated {
  const now = new Date();
  const monthCounts = new Map<string, number>();
  const weekSet = new Set<string>();
  const typeCounts = new Map<WorkoutType, number>();
  const workoutCounts = new Map<string, WorkoutPart>();
  let firstVisit: Date | null = null;

  const sparkBuckets: number[] = Array(8).fill(0);
  const sparkAnchors: string[] = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    sparkAnchors.push(weekKey(d));
  }

  let total = 0;
  let thisMonth = 0;
  let calories30d = 0;
  let calories30dHasNull = false;

  const thisMonthKey = monthKey(now);
  const cutoff30 = new Date(now);
  cutoff30.setDate(cutoff30.getDate() - 30);

  for (const r of rows) {
    const d = new Date(r.starts_at);
    if (d > now) continue; // only past
    total += 1;
    const mk = monthKey(d);
    monthCounts.set(mk, (monthCounts.get(mk) ?? 0) + 1);
    if (mk === thisMonthKey) thisMonth += 1;
    weekSet.add(weekKey(d));
    const type = normalizeType(r.workout_type);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (!firstVisit || d < firstVisit) firstVisit = d;
    // Занятие без тренировки (персональное) — отдельной строкой.
    const wKey = r.workout_id ?? "other";
    const part = workoutCounts.get(wKey);
    if (part) part.count += 1;
    else
      workoutCounts.set(wKey, {
        key: wKey,
        label: r.workout_id
          ? (names[r.workout_id] ?? r.workout_name ?? t("Тренировка"))
          : t("Персональные"),
        count: 1,
        color: r.workout_id ? (colors[r.workout_id] ?? null) : null,
      });

    const wk = weekKey(d);
    const idx = sparkAnchors.indexOf(wk);
    if (idx >= 0) sparkBuckets[idx] += 1;

    if (d >= cutoff30) {
      if (r.calories == null) calories30dHasNull = true;
      else calories30d += r.calories;
    }
  }

  let bestMonth = 0;
  monthCounts.forEach((v) => {
    if (v > bestMonth) bestMonth = v;
  });

  // Weekly streak — consecutive ISO weeks ending at current/last week with >=1 visit
  let streak = 0;
  for (let i = 0; i < 520; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const wk = weekKey(d);
    const has = weekSet.has(wk);
    if (i === 0 && !has) continue; // allow skipping current week if empty
    if (has) streak += 1;
    else break;
  }

  const byType: { type: WorkoutType; count: number }[] = [];
  (["cardio", "strength", "hybrid", "recovery", "unknown"] as WorkoutType[]).forEach((type) => {
    const c = typeCounts.get(type) ?? 0;
    if (c > 0) byType.push({ type, count: c });
  });

  return {
    total,
    thisMonth,
    bestMonth,
    streakWeeks: streak,
    sparkline: sparkBuckets,
    byType,
    byWorkout: [...workoutCounts.values()].sort((a, b) => b.count - a.count),
    firstVisit,
    calories30d,
    calories30dHasNull,
  };
}

// ---- Main component ----

export function StatsSection() {
  const { user } = useAuth();
  const t = useT();
  const loc = useLocalize();
  const userId = user?.id ?? null;
  // Кэш React Query (и между запусками): статистика на главной видна сразу.
  const stats = useQuery({
    queryKey: ["stats", userId],
    queryFn: async () => {
      // Только посещения (attended): отменённые, пропуски и записи без отметки
      // администратора в статистику — и в серию недель — не идут.
      const [logs, mvRes, profile, compareRes, diagnostics] = await Promise.all([
        (supabase as unknown as { from: (t: string) => any })
          .from("bookings_log")
          .select(
            "entry_id,starts_at,duration_min,calories,workout_id,workout_name,workout_type,studio_id",
          )
          .eq("user_id", userId)
          .eq("status", "attended")
          .order("starts_at", { ascending: false })
          .limit(2000),
        // Матвью закрыта для клиентов (RLS на материализованных вью не
        // работает, а select был выдан всем вошедшим). Свою строку получаем
        // через SECURITY DEFINER-функцию my_stats_30d.
        (supabase as unknown as { rpc: (fn: string) => any }).rpc("my_stats_30d").maybeSingle(),
        supabase.from("member_profiles").select("weight_kg").eq("user_id", userId!).maybeSingle(),
        IS_PACKAGES
          ? untypedDb.rpc("my_studio_visit_stats")
          : Promise.resolve({ data: null, error: null }),
        fetchMyDiagnosticEntryIds(userId!),
      ]);
      // Без истории статистика пустая — это ошибка, а не ноль тренировок.
      // Матвью и профиль необязательны: без них карточки работают.
      if (logs.error) throw logs.error;
      // Диагностика тела — не тренировка: в статистику не идёт.
      const rows = ((logs.data ?? []) as BookingRow[]).filter(
        (r) => !r.entry_id || !diagnostics.has(r.entry_id),
      );
      // Пакетное: цвета тренировок — для полоски «Тренировки» (как в расписании),
      // имена с переводами — для подписей под ней.
      let workouts: WorkoutInfo[] = [];
      if (IS_PACKAGES) {
        const ids = [...new Set(rows.map((r) => r.workout_id).filter(Boolean))] as string[];
        if (ids.length > 0) {
          const { data } = await untypedDb
            .from("workouts")
            .select("id, color, name, translations")
            .in("id", ids);
          workouts = (data as WorkoutInfo[] | null) ?? [];
        }
      }
      return {
        rows,
        workouts,
        mv: (mvRes.data ?? null) as StatsMv | null,
        hasWeight: profile.data?.weight_kg != null,
        // Нет RPC (миграция ещё не выкачена) — просто без сравнения.
        compare: (compareRes.error ? null : compareRes.data) as StudioCompare | null,
      };
    },
    enabled: !!userId,
    // Посещения меняются, только когда администратор отметит занятие, а
    // запрос тяжёлый (5–6 обращений к базе, сравнение со студией — по всей
    // её истории): обновлять не чаще раза в 10 минут, а не при каждом
    // возвращении на главную (2026-10-16, запуск).
    staleTime: 10 * 60_000,
  });
  const rows = stats.data?.rows ?? null;
  const mv = stats.data?.mv ?? null;
  const hasWeight = stats.data?.hasWeight ?? null;
  const loading = !!userId && stats.isPending;
  // Ошибка истории посещений — не «пока нет тренировок».
  const failed = !stats.data && stats.isError;

  const workouts = stats.data?.workouts;
  const colors = useMemo(
    () =>
      Object.fromEntries(
        (workouts ?? []).map((w) => [
          w.id,
          w.color && /^#[0-9a-f]{6}$/i.test(w.color.trim()) ? w.color.trim() : null,
        ]),
      ),
    [workouts],
  );
  // Имя — только если для языка клиента есть перевод (loc вернул новую
  // строку); иначе остаётся снимок из журнала, как было.
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const w of workouts ?? []) {
      const lw = loc(w);
      if (lw !== w && lw.name) out[w.id] = lw.name;
    }
    return out;
  }, [workouts, loc]);
  const compare = stats.data?.compare ?? null;
  const agg = useMemo(
    () => (rows ? aggregate(rows, t, colors, names) : null),
    [rows, t, colors, names],
  );

  const cohortOk = !!mv && mv.cohort_size >= 11;
  const visitsPct =
    cohortOk && mv?.visits_percentile != null
      ? Math.min(99, Math.round(mv.visits_percentile * 100))
      : null;
  const caloriesPct =
    cohortOk && mv?.calories_percentile != null
      ? Math.min(99, Math.round(mv.calories_percentile * 100))
      : null;

  if (!user) {
    return (
      <section className="bg-background rounded-t-[14px] rounded-b-[14px] pt-5 pb-5">
        <h2 className="px-4 text-2xl font-semibold">{t("Статистика")}</h2>
        <p className="px-4 text-sm text-muted-foreground mb-3">
          {t("Прогресс, рекорды и ориентиры")}
        </p>
        <p className="px-4 text-sm text-muted-foreground">
          {t("Войдите, чтобы видеть свою персональную статистику тренировок.")}
        </p>
      </section>
    );
  }

  return (
    <section className="bg-background rounded-t-[14px] rounded-b-[14px] pt-5 pb-5">
      <h2 className="px-4 text-2xl font-semibold">{t("Статистика")}</h2>
      <p className="px-4 text-sm text-muted-foreground mb-3">
        {t("Прогресс, рекорды и ориентиры")}
      </p>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl bg-card border border-border/40 h-[112px] animate-pulse"
            />
          ))}
        </div>
      ) : failed ? (
        <p className="px-4 text-sm text-destructive">
          {t("Не удалось загрузить статистику. Обновите страницу.")}
        </p>
      ) : !agg || agg.total === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 px-4">
            {/* Стрик */}
            <Card
              icon={<Fire size={18} weight="Bold" />}
              accent="bg-orange-500/15 text-orange-500"
              value={t.plural(agg.streakWeeks, "{n} нед.")}
              label={
                agg.streakWeeks > 0
                  ? t("недель подряд с тренировками 🔥")
                  : t("начни новую серию недель")
              }
              right={<Sparkline data={agg.sparkline} />}
            />

            {/* Всего тренировок */}
            <Card
              icon={<DumbbellLargeMinimalistic size={18} weight="Bold" />}
              value={`${agg.total}`}
              label={t("тренировок за всё время")}
              hint={
                IS_PACKAGES
                  ? packTotalHint(compare, agg.firstVisit, t)
                  : t("до {goal} осталось {left}", {
                      goal: nextMilestone(agg.total),
                      left: nextMilestone(agg.total) - agg.total,
                    })
              }
            />

            {/* За месяц + бенчмарк */}
            <Card
              icon={<ChartSquare size={18} weight="Bold" />}
              accent="bg-blue-500/15 text-blue-500"
              value={`${agg.thisMonth}`}
              label={t("тренировок в этом месяце")}
              hint={
                IS_PACKAGES
                  ? packMonthHint(compare, agg.thisMonth, t)
                  : visitsPct !== null
                    ? t("активнее, чем {pct}% клиентов клуба", { pct: visitsPct })
                    : t("сравнение с клубом появится позже")
              }
            />

            {/* Калории за 30 дней. Пакетное: во всю ширину и в конец сетки —
                карточек там нечётное число, иначе в сетке оставалась дыра. */}
            <Card
              className={IS_PACKAGES ? "order-last col-span-2" : ""}
              icon={<FireIcon size={18} weight="Bold" />}
              accent="bg-amber-500/15 text-amber-600"
              value={
                hasWeight === false && agg.calories30d === 0
                  ? "—"
                  : `≈ ${t.number(agg.calories30d)}`
              }
              label={t("ккал сожжено за 30 дней")}
              hint={
                hasWeight === false
                  ? t("укажите вес в профиле для расчёта")
                  : caloriesPct !== null
                    ? IS_PACKAGES
                      ? t("больше, чем у {pct}% клиентов студии", { pct: caloriesPct })
                      : t("больше, чем у {pct}% клиентов клуба", { pct: caloriesPct })
                    : IS_PACKAGES
                      ? t("оценка по интенсивности и длительности тренировок")
                      : t("оценка по типу и длительности тренировки")
              }
              footer={
                hasWeight === false ? (
                  <Link
                    to="/profile"
                    className="mt-2 text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t("Перейти в профиль →")}
                  </Link>
                ) : null
              }
            />

            {/* Распределение по типам */}
            {!IS_PACKAGES && agg.byType.length > 0 ? (
              <Card
                icon={<DonutIcon size={18} weight="Bold" />}
                accent="bg-violet-500/15 text-violet-500"
                value={t.plural(agg.byType.length, "{n} тип|{n} типа|{n} типов")}
                label={t("разных видов тренировок")}
                footer={
                  <div className="mt-2 flex flex-col gap-1.5">
                    <TypeBar parts={agg.byType} />
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      {agg.byType.map((p) => (
                        <span key={p.type} className="inline-flex items-center gap-1">
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${TYPE_COLOR[p.type]}`}
                          />
                          {t(TYPE_LABEL[p.type])} {p.count}
                        </span>
                      ))}
                    </div>
                  </div>
                }
              />
            ) : null}

            {/* Лучший месяц */}
            <Card
              icon={<Cup size={18} weight="Bold" />}
              accent="bg-emerald-500/15 text-emerald-500"
              value={`${agg.bestMonth}`}
              label={t("тренировок в лучшем месяце")}
              hint={
                agg.thisMonth >= agg.bestMonth && agg.bestMonth > 0
                  ? t("это твой личный рекорд!")
                  : t("до рекорда осталось {n}", {
                      n: Math.max(0, agg.bestMonth - agg.thisMonth + 1),
                    })
              }
            />

            {/* Пакетное: тренировки студии (вместо типов прежнего приложения) */}
            {IS_PACKAGES && agg.byWorkout.length > 0 ? (
              <Card
                className="order-last col-span-2"
                icon={<DonutIcon size={18} weight="Bold" />}
                accent="bg-violet-500/15 text-violet-500"
                value={`${agg.byWorkout.length}`}
                label={t.plural(
                  agg.byWorkout.length,
                  "вид тренировок|вида тренировок|видов тренировок",
                )}
                footer={
                  <div className="mt-1 flex flex-col gap-2">
                    <WorkoutBar parts={agg.byWorkout} />
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {agg.byWorkout.map((p) => (
                        <span key={p.key} className="inline-flex items-center gap-1.5">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${p.color ? "" : "bg-muted-foreground/40"}`}
                            style={p.color ? { backgroundColor: p.color } : undefined}
                          />
                          {p.label} · {p.count}
                        </span>
                      ))}
                    </div>
                  </div>
                }
              />
            ) : null}
          </div>

          <p className="px-4 mt-3 text-center text-xs text-muted-foreground/80">
            <CaloriesInfoLink />
          </p>
        </>
      )}
    </section>
  );
}

/**
 * «Тренировок за всё время» в пакетном приложении (решение владельца
 * 2026-10-12: вместо «до 10 осталось 9» — место в студии): топ N % по
 * посещениям, если клиентка в верхней половине; иначе — «с нами с …».
 */
function packTotalHint(compare: StudioCompare | null, firstVisit: Date | null, t: Translator) {
  const top = compare?.total_top_pct;
  if (top != null && top <= 50) return t("вы в топ-{pct}% студии по посещениям", { pct: top });
  if (firstVisit) {
    // Год отдельно: у ru-RU с year Intl добавляет «г.».
    const dayMonth = t.date(firstVisit, { day: "numeric", month: "long" });
    return t("с нами с {date}", { date: `${dayMonth} ${firstVisit.getFullYear()}` });
  }
  return null;
}

/** «Тренировок в этом месяце» — сравнение со студией за этот же месяц. */
function packMonthHint(compare: StudioCompare | null, thisMonth: number, t: Translator) {
  const avg = compare?.month_avg;
  if (avg == null) return t("сравнение со студией появится, когда наберётся статистика за месяц");
  const pct = compare?.month_better_pct;
  if (thisMonth > 0 && pct != null && pct >= 50) {
    return t("активнее, чем {pct}% клиенток студии", { pct });
  }
  const avgText = t.number(avg, { maximumFractionDigits: 1 });
  return t("в среднем по студии — {avg} за месяц", { avg: avgText });
}

/** Текст с <b>…</b> из словаря — жирные части как <strong>. */
function rich(text: string) {
  return text
    .split(/<b>(.*?)<\/b>/g)
    .map((part, i) =>
      i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>,
    );
}

function CaloriesInfoLink() {
  const t = useT();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="hover:text-foreground transition-colors">
          {t("Как считаются калории?")}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>{t("Как мы считаем калории")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-foreground text-[15px] leading-relaxed">
          <p>
            {t(
              "Калории в приложении — это оценка. Точную цифру может дать только пульсометр или умные часы, но даже без них можно посчитать расход достаточно близко по проверенной методике, которую используют большинство фитнес-приложений.",
            )}
          </p>
          <p>
            {rich(
              IS_PACKAGES
                ? t(
                    "Мы опираемся на три параметра: <b>интенсивность тренировки</b>, её <b>длительность</b> и ваш <b>вес из профиля</b>. У каждой тренировки студии своя интенсивность — коэффициент <b>MET</b> (Metabolic Equivalent of Task), который показывает, во сколько раз активнее работает организм по сравнению с состоянием покоя. Чем выше интенсивность и дольше занятие — тем больше расход.",
                  )
                : t(
                    "Мы опираемся на три параметра: <b>тип тренировки</b>, её <b>длительность</b> и ваш <b>вес из профиля</b>. У каждого типа занятия (кардио, силовая, гибрид, восстановление) своя интенсивность — коэффициент <b>MET</b> (Metabolic Equivalent of Task), который показывает, во сколько раз активнее работает организм по сравнению с состоянием покоя. Чем выше интенсивность и дольше занятие — тем больше расход.",
                  ),
            )}
          </p>
          <p>
            {rich(
              t(
                "Важно, что калории фиксируются <b>персонально для вас</b> в момент каждой тренировки и <b>навсегда сохраняются в истории</b>. То есть если вы измените вес в профиле, прошлые тренировки не пересчитаются — каждая запись хранит ваш реальный показатель на тот день. Именно из этой истории и складывается вся ваша статистика.",
              ),
            )}
          </p>
          <p>
            {rich(
              IS_PACKAGES
                ? t(
                    "Сравнение со средним по студии полностью <b>анонимно</b> — мы показываем только обобщённые цифры, без чьих-либо имён, и обновляем их раз в сутки.",
                  )
                : t(
                    "Сравнение со средним по клубу полностью <b>анонимно</b> — мы показываем только обобщённые цифры, без чьих-либо имён, и обновляем их раз в сутки.",
                  ),
            )}
          </p>
          <p>
            {rich(
              t(
                "Помните: это <b>ориентир</b>, а не точное измерение. Реальный расход зависит ещё и от вашего пульса, состава тела и того, насколько вы выкладываетесь. Но для отслеживания динамики и сравнения с собой прошлым этой оценки более чем достаточно.",
              ),
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
