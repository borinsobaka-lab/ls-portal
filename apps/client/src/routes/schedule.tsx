import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Refresh, Fire, CloseCircle } from "@solar-icons/react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { settlePackageMemberships } from "@/lib/packages-memberships";
import { PageShell } from "@/components/page-shell";
import { WorkoutDrawer, type WorkoutDrawerData } from "@/components/workout-drawer";
import { RescheduleOfferDialog } from "@/components/reschedule-offer-dialog";
import { entryToDrawerData, workoutTypeMeta, TYPE_ORDER } from "@/lib/workout-types";
import { useClubSettings } from "@/hooks/use-club-settings";
import { useClientStudioId } from "@/hooks/use-client-studio";
import { useAuth } from "@/hooks/use-auth";
import { ScheduleListSkeleton } from "@/components/content-skeletons";
import { ScheduleDayList } from "@/components/schedule-day-list";
import { APP_BRAND, IS_PACKAGES, SCHEDULE_TITLE } from "@/lib/terms";
import { PackagesSchedulePage } from "@/formats/packages/schedule-page";
import {
  type ContentTranslations,
  type Translator,
  currentT,
  getTranslator,
  msg,
  useLocalize,
  useT,
} from "@/i18n";

export const Route = createFileRoute("/schedule")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: `${t(SCHEDULE_TITLE)} — ${APP_BRAND}` },
        {
          name: "description",
          content: t("Расписание и запись на занятия {brand}.", { brand: APP_BRAND }),
        },
      ],
    };
  },
  // Пакетное приложение — свой экран (src/formats/packages/).
  component: IS_PACKAGES ? PackagesSchedulePage : SchedulePage,
});

const TABS = [
  { key: "class", label: msg("Классы") },
  { key: "personal", label: msg("Персональные") },
  { key: "diagnostics", label: msg("Диагностика") },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Trainer = {
  id: string;
  full_name: string | null;
  photo_url: string | null;
  translations?: ContentTranslations | null;
};
type Workout = {
  name: string;
  type: string | null;
  description: string | null;
  photo_url: string | null;
  capacity: number | null;
  translations?: ContentTranslations | null;
};
type Entry = {
  id: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  booked_count: number;
  workout: Workout | null;
  trainers: { trainer: Trainer | null }[] | null;
};

/** «Пн» / «Mon» / «ორშ» — короткое название дня недели на языке клиента. */
function dayName(d: Date, t: Translator) {
  const name = t.date(d, { weekday: "short" });
  return t.capitalize(name);
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtTime(iso: string, t: Translator) {
  return t.time(iso);
}
// Вместимость null или 0 — без ограничения (как в RPC записи).
function remainingSpots(capacity: number | null, booked: number) {
  if (capacity == null || capacity <= 0) return null;
  return Math.max(0, capacity - booked);
}
function SchedulePage() {
  const t = useT();
  const loc = useLocalize();
  const navigate = useNavigate();
  const today = useMemo(() => startOfDay(new Date()), []);
  const days = useMemo(() => Array.from({ length: 10 }, (_, i) => addDays(today, i - 3)), [today]);
  const [activeIdx, setActiveIdx] = useState(3);
  const [activeTab, setActiveTab] = useState<TabKey>("class");

  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookedIds, setBookedIds] = useState<Set<string>>(new Set());
  const [waitlistedIds, setWaitlistedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<WorkoutDrawerData | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const clubSettings = useClubSettings();
  const { user } = useAuth();
  const { studioId, studioReady } = useClientStudioId();
  const daysContainerRef = useRef<HTMLDivElement>(null);
  const dayBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const gestureStartRef = useRef<{ x: number; y: number; idx: number } | null>(null);
  const suppressedSwipeClickRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const wheelLockedRef = useRef(false);
  const wheelReleaseRef = useRef<number | null>(null);
  const swipeAreaRef = useRef<HTMLDivElement>(null);

  const selectDay = useCallback(
    (idx: number) => {
      setActiveIdx(Math.max(0, Math.min(days.length - 1, idx)));
    },
    [days.length],
  );

  const shiftDay = useCallback(
    (delta: -1 | 1) => {
      setActiveIdx((idx) => Math.max(0, Math.min(days.length - 1, idx + delta)));
    },
    [days.length],
  );

  useEffect(() => {
    // Ждём, пока определится студия клиента, чтобы не делать двойной запрос
    // (нефильтрованный + повторный с фильтром).
    if (!studioReady) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const from = addDays(today, -3).toISOString();
      const to = addDays(today, 7).toISOString();
      let query = supabase
        .from("schedule_entries")
        .select(
          "id, starts_at, ends_at, capacity, booked_count, workout:workouts(name, type, description, photo_url, capacity, translations), trainers:schedule_entry_trainers(trainer:trainers(id, full_name, photo_url, translations))",
        )
        .gte("starts_at", from)
        .lt("starts_at", to)
        // Клиентам RLS и так отдаёт только групповые неотменённые занятия, а
        // сотруднику в клиентском приложении — все: персональные, прочую
        // активность и отменённые фильтруем явно.
        .eq("kind", "group")
        .is("cancelled_at", null);
      if (studioId) query = query.eq("studio_id", studioId);

      // Брони клиента на те же дни — параллельно с занятиями. Явный фильтр по
      // user_id: RLS позволяет тренеру видеть все брони студии, и без фильтра
      // у сотрудника, зашедшего в клиентское приложение, чужие записи выглядели
      // бы как его собственные. Диапазон дат (через !inner-связь с занятием)
      // — чтобы не тянуть всю историю броней клиента.
      // types.ts ещё без 'waitlist' в enum брони (регенерация ждёт токен) —
      // приводим клиент к any для этого запроса, как в остальном коде репозитория.
      const bookingsQuery = user
        ? untypedDb
            .from("schedule_bookings")
            .select("entry_id, status, schedule_entries!inner(starts_at)")
            .eq("user_id", user.id)
            .in("status", ["booked", "waitlist"])
            .gte("schedule_entries.starts_at", from)
            .lt("schedule_entries.starts_at", to)
        : null;

      const [{ data, error }, bookings] = await Promise.all([
        query.order("starts_at"),
        bookingsQuery,
      ]);
      if (cancelled) return;
      if (error) setError(error.message);
      else setEntries((data as unknown as Entry[]) ?? []);
      setLoading(false);

      // Ошибка броней — не «вы никуда не записаны»: говорим о ней, а не молчим.
      if (bookings?.error) {
        const t = currentT();
        toast.error(
          t("Не удалось загрузить ваши записи: {error}", { error: bookings.error.message }),
        );
      }
      const rows = bookings?.data as { entry_id: string; status: string }[] | null | undefined;
      if (rows) {
        setBookedIds(new Set(rows.filter((r) => r.status === "booked").map((r) => r.entry_id)));
        setWaitlistedIds(
          new Set(rows.filter((r) => r.status === "waitlist").map((r) => r.entry_id)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [today, studioReady, studioId, user]);

  useEffect(() => {
    const container = daysContainerRef.current;
    const btn = dayBtnRefs.current[activeIdx];
    if (!container || !btn) return;
    const padLeft = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    container.scrollTo({
      left: Math.max(0, btn.offsetLeft - padLeft),
      behavior: "smooth",
    });
  }, [activeIdx]);

  useEffect(() => {
    return () => {
      if (wheelReleaseRef.current !== null) window.clearTimeout(wheelReleaseRef.current);
    };
  }, []);

  // Горизонтальный свайп тачпадом/колесом листает дни. Слушатель вешаем сами
  // с passive: false: React регистрирует onWheel пассивным, и preventDefault()
  // в нём игнорировался (браузер продолжал жест «назад» и т.п.). Область
  // свайпа появляется только после загрузки, поэтому эффект зависит от неё.
  useEffect(() => {
    const el = swipeAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (wheelReleaseRef.current !== null) window.clearTimeout(wheelReleaseRef.current);
      wheelReleaseRef.current = window.setTimeout(() => {
        wheelLockedRef.current = false;
      }, 420);
      if (wheelLockedRef.current) return;
      wheelLockedRef.current = true;
      shiftDay(e.deltaX > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loading, error, activeTab, shiftDay]);

  async function toggleBooking(entryId: string) {
    if (pendingId) return;
    setPendingId(entryId);
    const wasBooked = bookedIds.has(entryId);
    const wasWaitlisted = waitlistedIds.has(entryId);
    const isActive = wasBooked || wasWaitlisted;
    const fn = isActive ? ("cancel_schedule_booking" as const) : ("book_schedule_entry" as const);
    // Пакетный формат: продление могло стать действующим — иначе запись
    // ответила бы «нет абонемента».
    if (!isActive) await settlePackageMemberships();
    const { data, error } = await supabase.rpc(
      fn,
      // Причину отмены не спрашиваем (2026-10-21); p_reason — явно: та же
      // перегрузка функции в базе, что и раньше.
      isActive ? { p_entry_id: entryId, p_reason: null } : { p_entry_id: entryId },
    );
    setPendingId(null);
    if (error) {
      toast.error(
        isActive
          ? t("Не удалось отменить запись: {error}", { error: error.message })
          : t("Не удалось записаться: {error}", { error: error.message }),
      );
      return;
    }
    const reasonMessages: Record<string, string> = {
      unauthorized: t("Войдите в аккаунт, чтобы записаться"),
      no_client: t("Профиль клиента не найден. Обратитесь к администратору."),
      no_membership: t("Нет активного абонемента. Купите абонемент, чтобы записаться."),
      no_visits_left: t("На абонементе закончились посещения"),
      not_found: t("Тренировка не найдена"),
      past: t("Эта тренировка уже прошла"),
      full: t("Свободных мест больше нет"),
      not_booked: t("Вы не были записаны на эту тренировку"),
    };
    const res = data as {
      ok: boolean;
      reason?: string;
      waitlisted?: boolean;
      booked_count?: number;
      capacity?: number | null;
    } | null;
    if (res?.ok) {
      if (isActive) {
        // отмена записи или выход из очереди
        setBookedIds((prev) => {
          const next = new Set(prev);
          next.delete(entryId);
          return next;
        });
        setWaitlistedIds((prev) => {
          const next = new Set(prev);
          next.delete(entryId);
          return next;
        });
        if (wasBooked) {
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entryId
                ? {
                    ...e,
                    booked_count:
                      typeof res.booked_count === "number"
                        ? res.booked_count
                        : Math.max(0, e.booked_count - 1),
                  }
                : e,
            ),
          );
        }
        // Отменил запись — предложить другое время; вышел из очереди — тост.
        if (wasWaitlisted) toast.success(t("Вы вышли из листа ожидания"));
        else setRescheduleOpen(true);
      } else if (res.waitlisted) {
        setWaitlistedIds((prev) => new Set(prev).add(entryId));
        toast.success(t("Мест нет — вы в листе ожидания"));
      } else {
        setBookedIds((prev) => new Set(prev).add(entryId));
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entryId
              ? {
                  ...e,
                  booked_count:
                    typeof res.booked_count === "number" ? res.booked_count : e.booked_count + 1,
                }
              : e,
          ),
        );
        toast.success(t("Вы записаны на тренировку"));
      }
    } else if (res?.reason === "already_booked") {
      setBookedIds((prev) => new Set(prev).add(entryId));
      if (typeof res.booked_count === "number") {
        const newCount = res.booked_count;
        setEntries((prev) =>
          prev.map((e) => (e.id === entryId ? { ...e, booked_count: newCount } : e)),
        );
      }
    } else if (res?.reason === "already_waitlisted") {
      setWaitlistedIds((prev) => new Set(prev).add(entryId));
    } else if (res?.reason === "no_membership" || res?.reason === "no_visits_left") {
      toast.info(reasonMessages[res.reason]);
      navigate({ to: "/memberships" });
    } else if (res?.reason) {
      toast.error(
        reasonMessages[res.reason] ??
          t("Не удалось выполнить действие: {reason}", { reason: res.reason }),
      );
    }
  }

  const [activeType, setActiveType] = useState<string>("all");

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      const type = e.workout?.type?.toLowerCase().trim();
      if (type) set.add(type);
    });
    return TYPE_ORDER.filter((type) => set.has(type));
  }, [entries]);

  // Название тренировки и имена тренеров — на языке клиента (контент админки).
  const shownEntries = useMemo(
    () =>
      entries.map((e) => ({
        ...e,
        workout: loc(e.workout),
        trainers: e.trainers?.map((row) => ({ trainer: loc(row.trainer) })) ?? null,
      })),
    [entries, loc],
  );

  const entriesByDay = useMemo(
    () =>
      days.map((day) =>
        shownEntries.filter((e) => {
          const d = startOfDay(new Date(e.starts_at));
          if (d.getTime() !== day.getTime()) return false;
          if (activeType === "all") return true;
          return (e.workout?.type?.toLowerCase().trim() ?? "") === activeType;
        }),
      ),
    [days, shownEntries, activeType],
  );

  const typeFilters = [
    { key: "all", label: t("Все") },
    ...availableTypes.map((type) => ({ key: type, label: t(workoutTypeMeta(type).label) })),
  ];

  return (
    <PageShell
      scrollKey="schedule"
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t(SCHEDULE_TITLE)}</h1>
          <p className="text-sm text-white/70">{t("Выберите день и забронируйте тренировку")}</p>
        </div>
      }
    >
      <div className="flex gap-3 overflow-x-auto no-scrollbar px-4 pt-4 pb-0">
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`shrink-0 relative pt-3 pb-1 text-base font-semibold transition-colors ${
                active ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {t(tab.label)}
              {active && (
                <span className="absolute left-0 right-0 -bottom-px h-1 bg-primary rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {activeTab === "personal" ? (
        <div className="p-4">
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {t("Совсем скоро мы начнем принимать заявки на персональные тренировки")}
          </Card>
        </div>
      ) : activeTab !== "class" ? (
        <div className="p-4">
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {t("Функционал скоро будет доступен")}
          </Card>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          <div
            ref={daysContainerRef}
            className="sticky top-0 z-20 bg-background flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pt-2 pb-2"
          >
            {days.map((d, i) => {
              const isPastDay = d.getTime() < today.getTime();
              return (
                <button
                  key={d.toISOString()}
                  ref={(el) => {
                    dayBtnRefs.current[i] = el;
                  }}
                  onClick={() => selectDay(i)}
                  className={`flex flex-col items-center justify-center min-w-14 h-16 rounded-xl transition-colors ${
                    i === activeIdx
                      ? "bg-primary-foreground text-primary"
                      : "bg-card text-card-foreground"
                  } ${isPastDay ? "opacity-20" : ""}`}
                >
                  <span
                    className={`text-xs font-medium ${i === activeIdx ? "" : "text-muted-foreground"}`}
                  >
                    {dayName(d, t)}
                  </span>
                  <span className="text-lg font-bold">{d.getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
            {typeFilters.map((filter) => {
              const active = activeType === filter.key;
              const meta = filter.key === "all" ? null : workoutTypeMeta(filter.key);
              const Icon = meta?.icon;
              return (
                <button
                  key={filter.key}
                  onClick={() => setActiveType(filter.key)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-3 h-7 rounded-full border text-xs font-medium transition-colors ${
                    active
                      ? "bg-foreground text-background border-foreground"
                      : "bg-transparent text-muted-foreground border-border"
                  }`}
                >
                  {Icon && <Icon className={`h-3.5 w-3.5 ${meta!.color}`} />}
                  {filter.label}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="px-4">
              <ScheduleListSkeleton />
            </div>
          ) : error ? (
            <Card className="p-4 text-sm text-destructive">
              {t("Ошибка загрузки: {error}", { error })}
            </Card>
          ) : (
            <div
              ref={swipeAreaRef}
              onPointerDown={(e) => {
                if (e.pointerType === "mouse") return;
                gestureStartRef.current = { x: e.clientX, y: e.clientY, idx: activeIdx };
              }}
              onPointerUp={(e) => {
                const start = gestureStartRef.current;
                gestureStartRef.current = null;
                if (!start) return;
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                const isSwipe = Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.2;
                if (isSwipe) {
                  const swipeClick = { x: e.clientX, y: e.clientY, time: performance.now() };
                  suppressedSwipeClickRef.current = swipeClick;
                  selectDay(start.idx + (dx < 0 ? 1 : -1));
                  window.setTimeout(() => {
                    if (suppressedSwipeClickRef.current === swipeClick) {
                      suppressedSwipeClickRef.current = null;
                    }
                  }, 120);
                }
              }}
              onPointerCancel={() => {
                gestureStartRef.current = null;
                suppressedSwipeClickRef.current = null;
              }}
              onClickCapture={(e) => {
                const swipeClick = suppressedSwipeClickRef.current;
                if (!swipeClick) return;
                suppressedSwipeClickRef.current = null;
                const age = performance.now() - swipeClick.time;
                const distance = Math.hypot(e.clientX - swipeClick.x, e.clientY - swipeClick.y);
                if (age <= 180 && distance <= 32) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              className="-mx-4 overflow-hidden touch-pan-y"
              style={{ touchAction: "pan-y" }}
            >
              <div
                className="flex transition-transform duration-300 ease-out"
                style={{ transform: `translate3d(-${activeIdx * 100}%, 0, 0)` }}
              >
                {entriesByDay.map((dayList, dayIdx) => (
                  <div key={days[dayIdx].toISOString()} className="w-full shrink-0 px-4">
                    {dayList.length === 0 ? (
                      <Card className="p-6 text-center text-sm text-muted-foreground">
                        {t("На этот день тренировок пока нет")}
                      </Card>
                    ) : (
                      <ScheduleDayList
                        entries={dayList}
                        pastDay={days[dayIdx].getTime() < today.getTime()}
                        renderEntry={(c) => {
                          const meta = workoutTypeMeta(c.workout?.type);
                          const isBooked = bookedIds.has(c.id);
                          const isWaitlisted = waitlistedIds.has(c.id);
                          const isActive = isBooked || isWaitlisted;
                          const isPending = pendingId === c.id;
                          return (
                            <Card
                              className={`relative p-3 pl-4 flex items-center gap-3 w-full overflow-hidden rounded-lg transition-colors ${
                                isBooked
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : isWaitlisted
                                    ? "border-blue-400 bg-blue-50 dark:bg-blue-950/40"
                                    : ""
                              }`}
                            >
                              <span
                                className={`absolute left-0 top-0 bottom-0 w-1.5 ${meta.stripe}`}
                              />
                              <button
                                type="button"
                                onClick={() => setOpenEntry(entryToDrawerData(c, t))}
                                className="flex flex-1 min-w-0 items-center gap-3 text-left active:opacity-80 transition-opacity"
                              >
                                <div className="flex flex-col items-center justify-center w-12 shrink-0">
                                  <div className="text-base font-black tabular-nums leading-tight text-center">
                                    {fmtTime(c.starts_at, t)}
                                  </div>
                                </div>
                                <div className="flex-1 min-w-0 ml-1">
                                  <div className="font-medium break-words leading-snug">
                                    {c.workout?.name ?? t("Занятие")}
                                  </div>
                                  {isWaitlisted && (
                                    <div className="text-xs mt-0.5 font-semibold text-blue-600 dark:text-blue-400">
                                      {t("В листе ожидания")}
                                    </div>
                                  )}
                                  {(() => {
                                    const names = (c.trainers ?? [])
                                      .map((row) => row.trainer?.full_name)
                                      .filter((n): n is string => !!n);
                                    if (names.length === 0) return null;
                                    return (
                                      <div
                                        className={`text-xs mt-0.5 truncate ${isBooked ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                                      >
                                        {names.join(", ")}
                                      </div>
                                    );
                                  })()}
                                  {(() => {
                                    const effectiveCapacity =
                                      c.capacity ?? c.workout?.capacity ?? null;
                                    const left = remainingSpots(effectiveCapacity, c.booked_count);
                                    if (left === null || left > 5) return null;
                                    if (left === 0) {
                                      return (
                                        <div className="flex items-center gap-1 text-xs mt-0.5 text-red-500 leading-none">
                                          <CloseCircle
                                            className="h-3.5 w-3.5 shrink-0"
                                            weight="BoldDuotone"
                                          />
                                          <span className="leading-none mt-0.5">
                                            {t("Мест нет")}
                                          </span>
                                        </div>
                                      );
                                    }
                                    return (
                                      <div className="flex items-center gap-1 text-xs mt-0.5 text-orange-500 leading-none">
                                        <Fire
                                          className="h-3.5 w-3.5 shrink-0"
                                          weight="BoldDuotone"
                                        />
                                        <span className="leading-none mt-0.5">
                                          {t.plural(
                                            left,
                                            "Осталось {n} место|Осталось {n} места|Осталось {n} мест",
                                          )}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                </div>
                              </button>
                              {!isActive && (
                                <button
                                  type="button"
                                  disabled={isPending}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleBooking(c.id);
                                  }}
                                  className={`shrink-0 h-10 w-10 rounded-full flex items-center justify-center transition-colors bg-primary text-primary-foreground ${
                                    isPending ? "opacity-60" : ""
                                  }`}
                                  aria-label={t("Записаться")}
                                >
                                  {isPending ? (
                                    <Refresh
                                      className="h-5 w-5 animate-spin"
                                      weight="BoldDuotone"
                                    />
                                  ) : (
                                    <svg
                                      width="20"
                                      height="20"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      xmlns="http://www.w3.org/2000/svg"
                                      className="text-primary-foreground"
                                    >
                                      <path
                                        d="M12 5V19M5 12H19"
                                        stroke="currentColor"
                                        strokeWidth="2.5"
                                        strokeLinecap="round"
                                      />
                                    </svg>
                                  )}
                                </button>
                              )}
                            </Card>
                          );
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <WorkoutDrawer
        data={openEntry}
        open={openEntry !== null}
        onOpenChange={(o) => {
          if (!o) setOpenEntry(null);
        }}
        isBooked={openEntry ? bookedIds.has(openEntry.id) : false}
        isWaitlisted={openEntry ? waitlistedIds.has(openEntry.id) : false}
        isFull={(() => {
          if (!openEntry) return false;
          const e = entries.find((x) => x.id === openEntry.id);
          const cap = e?.capacity ?? e?.workout?.capacity ?? null;
          return cap != null && cap > 0 && (e?.booked_count ?? 0) >= cap;
        })()}
        isPending={openEntry ? pendingId === openEntry.id : false}
        cancelMinutes={clubSettings.cancel_booking_minutes}
        onBook={() => {
          if (openEntry) toggleBooking(openEntry.id);
        }}
      />
      {/* Уже в расписании: «Выбрать время» закрывает шторку тренировки. */}
      <RescheduleOfferDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        onPick={() => setOpenEntry(null)}
      />
    </PageShell>
  );
}
