import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Drawer as DrawerPrimitive } from "vaul";
import { AltArrowDown, CheckCircle, CloseCircle, Star } from "@solar-icons/react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
} from "@/components/ui/squircle-avatar";
import { supabase } from "@/integrations/supabase/client";
import { settlePackageMemberships } from "@/lib/packages-memberships";
import { PageShell } from "@/components/page-shell";
import { UnderlineTabs } from "@/components/underline-tabs";
import { WorkoutDrawer, type WorkoutDrawerData } from "@/components/workout-drawer";
import { RescheduleOfferDialog } from "@/components/reschedule-offer-dialog";
import { useClubSettings } from "@/hooks/use-club-settings";
import { useFormatStudios, useViewedStudioId } from "@/hooks/use-viewed-studio";
import { msg, useLocalize, useT, type Translator } from "@/i18n";
import { useAuth } from "@/hooks/use-auth";
import { ScheduleListSkeleton } from "@/components/content-skeletons";
import { ScheduleDayList } from "@/components/schedule-day-list";
import {
  entryColor,
  entryTrainers,
  packEntryToDrawerData,
  trainerInitials,
  trainerPhoto,
  trainerRating,
  type PackEntry,
} from "./entries";
import { formatRating } from "./trainer-rating";
import { PackWorkoutCard } from "./workout-card";
import { StudioSwitcher } from "./studio-switcher";
import { DiagnosticsTab, PersonalRequestTab } from "./schedule-requests";
import {
  SCHEDULE_DAYS,
  SCHEDULE_DAYS_BEFORE,
  addDays,
  packMyBookingsQuery,
  packScheduleQuery,
  startOfDay,
  type MyScheduleBookings,
} from "./queries";

/**
 * «Расписание» пакетного приложения (до 2026-10-11 — «Бронь», общий экран с
 * подписочным). Студия — смотримая (переключатель на главной и под
 * заголовком расписания); записаться можно в любую студию сети, в том числе
 * без действующего абонемента (2026-10-19: абонемент выберут в студии).
 * Вкладки «Персональные» и «Диагностика» — заявки администратору и свои
 * диагностики (schedule-requests.tsx). Фильтры — по тренировкам и по тренерам
 * (у пакетных тренировок нет типа, прежний фильтр по типу был пустым).
 */

const TABS = [
  { key: "class", label: msg("Тренировки") },
  { key: "personal", label: msg("Персональные") },
  { key: "diagnostics", label: msg("Диагностика") },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type FilterKind = "workout" | "trainer";
type FilterOption = {
  id: string;
  label: string;
  color?: string | null;
  photo?: string | null;
  /** Средний рейтинг тренера (без числа оценок). */
  rating?: number | null;
};

export function PackagesSchedulePage() {
  const t = useT();
  const loc = useLocalize();
  const navigate = useNavigate();
  const today = useMemo(() => startOfDay(new Date()), []);
  const days = useMemo(
    () => Array.from({ length: SCHEDULE_DAYS }, (_, i) => addDays(today, i - SCHEDULE_DAYS_BEFORE)),
    [today],
  );
  const [activeIdx, setActiveIdx] = useState(SCHEDULE_DAYS_BEFORE);
  const [activeTab, setActiveTab] = useState<TabKey>("class");

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<WorkoutDrawerData | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [workoutFilter, setWorkoutFilter] = useState<string | null>(null);
  const [trainerFilter, setTrainerFilter] = useState<string | null>(null);
  const [filterSheet, setFilterSheet] = useState<FilterKind | null>(null);
  const clubSettings = useClubSettings("home");
  const { user } = useAuth();
  const { studioId, studioReady, isHome } = useViewedStudioId();
  const { data: studios = [] } = useFormatStudios();
  const viewedStudioName = loc(studios.find((s) => s.id === studioId))?.name ?? null;
  const tabs = useMemo(() => TABS.map((x) => ({ ...x, label: t(x.label) })), [t]);
  const daysContainerRef = useRef<HTMLDivElement>(null);
  const dayBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const gestureStartRef = useRef<{ x: number; y: number; idx: number } | null>(null);
  const suppressedSwipeClickRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const wheelLockedRef = useRef(false);
  const wheelReleaseRef = useRef<number | null>(null);
  const swipeAreaRef = useRef<HTMLDivElement>(null);

  const selectDay = useCallback(
    (idx: number) => setActiveIdx(Math.max(0, Math.min(days.length - 1, idx))),
    [days.length],
  );
  const shiftDay = useCallback(
    (delta: -1 | 1) => setActiveIdx((idx) => Math.max(0, Math.min(days.length - 1, idx + delta))),
    [days.length],
  );

  // Другая студия — другие тренировки и тренеры: фильтры сбрасываем.
  useEffect(() => {
    setWorkoutFilter(null);
    setTrainerFilter(null);
  }, [studioId]);

  // Занятия и свои записи — из кэша React Query (src/formats/packages/queries.ts):
  // повторный переход на «Расписание» открывается сразу, свежие данные — фоном.
  const queryClient = useQueryClient();
  const scheduleQuery = packScheduleQuery(studioId, today, studioReady);
  const myBookingsQuery = packMyBookingsQuery(user?.id ?? null, today);
  const schedule = useQuery(scheduleQuery);
  const myBookings = useQuery(myBookingsQuery);
  const entries = useMemo(() => schedule.data ?? [], [schedule.data]);
  // Как и раньше, список — вместе с отметками своих записей: иначе карточка
  // на миг предлагала «Записаться» на занятие, где клиент уже записан.
  const loading = schedule.isPending || (!!user && myBookings.isPending);
  const error = !schedule.data && schedule.error ? schedule.error.message : null;
  const bookedIds = useMemo(() => new Set(myBookings.data?.booked ?? []), [myBookings.data]);
  const waitlistedIds = useMemo(() => new Set(myBookings.data?.waitlist ?? []), [myBookings.data]);

  const bookingsError = myBookings.error?.message;
  useEffect(() => {
    if (bookingsError)
      toast.error(t("Не удалось загрузить ваши записи: {error}", { error: bookingsError }));
  }, [bookingsError, t]);

  const updateMine = (fn: (m: MyScheduleBookings) => MyScheduleBookings) =>
    queryClient.setQueryData(myBookingsQuery.queryKey, (prev) =>
      fn(prev ?? { booked: [], waitlist: [] }),
    );
  const addTo = (list: "booked" | "waitlist", entryId: string) =>
    updateMine((m) => (m[list].includes(entryId) ? m : { ...m, [list]: [...m[list], entryId] }));

  useEffect(() => {
    const container = daysContainerRef.current;
    const btn = dayBtnRefs.current[activeIdx];
    if (!container || !btn) return;
    const padLeft = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    container.scrollTo({ left: Math.max(0, btn.offsetLeft - padLeft), behavior: "smooth" });
  }, [activeIdx]);

  useEffect(() => {
    return () => {
      if (wheelReleaseRef.current !== null) window.clearTimeout(wheelReleaseRef.current);
    };
  }, []);

  // Горизонтальный свайп тачпадом/колесом листает дни (passive: false — иначе
  // preventDefault игнорируется), как в подписочном расписании.
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
    const wasBooked = bookedIds.has(entryId);
    const wasWaitlisted = waitlistedIds.has(entryId);
    const isActive = wasBooked || wasWaitlisted;
    setPendingId(entryId);
    const fn = isActive ? ("cancel_schedule_booking" as const) : ("book_schedule_entry" as const);
    // Продление могло стать действующим — иначе запись ответила бы «нет абонемента».
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
      no_membership: t("Нет действующего абонемента — обратитесь к администратору студии."),
      no_visits_left: t("На абонементе закончились тренировки"),
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
      /** false — записан без действующего абонемента (2026-10-19). */
      has_membership?: boolean;
    } | null;
    const setCount = (count: (e: PackEntry) => number) =>
      queryClient.setQueryData(scheduleQuery.queryKey, (prev) =>
        prev?.map((e) => (e.id === entryId ? { ...e, booked_count: count(e) } : e)),
      );
    // Без действующего абонемента запись проходит (решение владельца
    // 2026-10-19), клиента предупреждаем: абонемент выберут в студии.
    const noMembershipNote =
      res?.ok && res.has_membership === false
        ? {
            description: t(
              "Сейчас у вас нет действующего абонемента — выбрать его можно в студии.",
            ),
            duration: 8000,
          }
        : undefined;
    if (res?.ok) {
      // Записи на главной — из другого запроса: обновятся при возврате на неё.
      queryClient.invalidateQueries({ queryKey: ["home-bookings"] });
      if (isActive) {
        updateMine((m) => ({
          booked: m.booked.filter((id) => id !== entryId),
          waitlist: m.waitlist.filter((id) => id !== entryId),
        }));
        if (wasBooked) {
          setCount((e) =>
            typeof res.booked_count === "number"
              ? res.booked_count
              : Math.max(0, e.booked_count - 1),
          );
        }
        // Отменил запись — предложить другое время; вышел из очереди — тост.
        if (wasWaitlisted) toast.success(t("Вы вышли из листа ожидания"));
        else setRescheduleOpen(true);
      } else if (res.waitlisted) {
        addTo("waitlist", entryId);
        toast.success(t("Мест нет — вы в листе ожидания"), noMembershipNote);
      } else {
        addTo("booked", entryId);
        setCount((e) =>
          typeof res.booked_count === "number" ? res.booked_count : e.booked_count + 1,
        );
        // Абонемент действует во всех пакетных студиях — запись в другую
        // студию спишется с него же; называем студию, чтобы не перепутать адрес.
        toast.success(
          !isHome && viewedStudioName
            ? t("Вы записаны на тренировку в студии «{name}»", { name: viewedStudioName })
            : t("Вы записаны на тренировку"),
          noMembershipNote,
        );
      }
    } else if (res?.reason === "already_booked") {
      addTo("booked", entryId);
      if (typeof res.booked_count === "number") {
        const n = res.booked_count;
        setCount(() => n);
      }
    } else if (res?.reason === "already_waitlisted") {
      addTo("waitlist", entryId);
    } else if (res?.reason === "no_membership" || res?.reason === "no_visits_left") {
      toast.info(reasonMessages[res.reason]);
      navigate({ to: "/memberships" });
    } else if (res?.reason) {
      // Места разобрали, пока расписание было открыто: показать занятие
      // заполненным, чтобы не нажимали «Записаться» снова.
      if (res.reason === "full")
        queryClient.invalidateQueries({ queryKey: scheduleQuery.queryKey });
      toast.error(
        reasonMessages[res.reason] ??
          t("Не удалось выполнить действие: {reason}", { reason: res.reason }),
      );
    }
  }

  // Варианты фильтров — из загруженных занятий (тренировки и тренеры этих дней).
  const workoutOptions = useMemo<FilterOption[]>(() => {
    const map = new Map<string, FilterOption>();
    for (const e of entries) {
      if (e.workout && !map.has(e.workout.id)) {
        map.set(e.workout.id, {
          id: e.workout.id,
          label: loc(e.workout).name,
          color: entryColor(e),
        });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, t.intl));
  }, [entries, loc, t]);
  const trainerOptions = useMemo<FilterOption[]>(() => {
    const map = new Map<string, FilterOption>();
    for (const e of entries) {
      for (const tr of entryTrainers(e)) {
        if (!map.has(tr.id)) {
          map.set(tr.id, {
            id: tr.id,
            label: loc(tr).full_name ?? t("Тренер"),
            photo: trainerPhoto(tr),
            rating: trainerRating(tr),
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, t.intl));
  }, [entries, loc, t]);

  const entriesByDay = useMemo(
    () =>
      days.map((day) =>
        entries.filter((e) => {
          if (startOfDay(new Date(e.starts_at)).getTime() !== day.getTime()) return false;
          if (workoutFilter && e.workout?.id !== workoutFilter) return false;
          if (trainerFilter && !entryTrainers(e).some((tr) => tr.id === trainerFilter))
            return false;
          return true;
        }),
      ),
    [days, entries, workoutFilter, trainerFilter],
  );

  const workoutLabel = workoutOptions.find((o) => o.id === workoutFilter)?.label;
  const trainerLabel = trainerOptions.find((o) => o.id === trainerFilter)?.label;
  const filtered = !!workoutFilter || !!trainerFilter;

  const openEntryRow = openEntry ? entries.find((x) => x.id === openEntry.id) : undefined;

  return (
    <PageShell
      scrollKey="schedule"
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Расписание")}</h1>
          <p className="text-sm text-white/70">{t("Выберите день и запишитесь на тренировку")}</p>
          {/* Смена студии прямо из расписания — та же плашка, что на главной
              (решение владельца 2026-10-19). */}
          <div className="mt-4">
            <StudioSwitcher />
          </div>
        </div>
      }
    >
      <UnderlineTabs
        tabs={tabs}
        value={activeTab}
        onChange={setActiveTab}
        className="px-4 pt-4"
        gapClass="gap-3"
      />

      {/* Персональные и диагностика — заявки администратору (2026-10-15). */}
      {activeTab === "personal" ? (
        <PersonalRequestTab />
      ) : activeTab === "diagnostics" ? (
        <DiagnosticsTab />
      ) : (
        <div className="p-4 space-y-4">
          <div
            ref={daysContainerRef}
            className="sticky top-0 z-20 bg-background flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pt-2 pb-2"
          >
            {days.map((d, i) => {
              const isPastDay = d.getTime() < today.getTime();
              const active = i === activeIdx;
              return (
                <button
                  key={d.toISOString()}
                  ref={(el) => {
                    dayBtnRefs.current[i] = el;
                  }}
                  onClick={() => selectDay(i)}
                  className={`flex flex-col items-center justify-center min-w-14 h-16 rounded-xl transition-colors ${
                    active ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground"
                  } ${isPastDay ? "opacity-20" : ""}`}
                >
                  <span
                    className={`text-xs font-medium ${active ? "text-primary-foreground" : "text-muted-foreground"}`}
                  >
                    {dayName(d, t)}
                  </span>
                  <span className="text-lg font-bold">{d.getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
            <FilterChip
              label={workoutLabel ?? t("Все тренировки")}
              active={!!workoutFilter}
              onClick={() => setFilterSheet("workout")}
            />
            <FilterChip
              label={trainerLabel ?? t("Все тренеры")}
              active={!!trainerFilter}
              onClick={() => setFilterSheet("trainer")}
            />
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setWorkoutFilter(null);
                  setTrainerFilter(null);
                }}
                className="shrink-0 inline-flex items-center gap-1 px-3 h-8 rounded-full text-xs font-medium text-muted-foreground"
              >
                <CloseCircle className="h-4 w-4" weight="BoldDuotone" />
                {t("Сбросить")}
              </button>
            )}
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
                        {filtered
                          ? t("На этот день таких тренировок нет")
                          : t("На этот день тренировок пока нет")}
                      </Card>
                    ) : (
                      <ScheduleDayList
                        entries={dayList}
                        pastDay={days[dayIdx].getTime() < today.getTime()}
                        renderEntry={(c) => (
                          <PackWorkoutCard
                            entry={c}
                            isBooked={bookedIds.has(c.id)}
                            isWaitlisted={waitlistedIds.has(c.id)}
                            onOpen={() => setOpenEntry(packEntryToDrawerData(c, t))}
                          />
                        )}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <FilterSheet
        kind={filterSheet}
        options={filterSheet === "trainer" ? trainerOptions : workoutOptions}
        value={filterSheet === "trainer" ? trainerFilter : workoutFilter}
        onChange={(id) => {
          if (filterSheet === "trainer") setTrainerFilter(id);
          else setWorkoutFilter(id);
          setFilterSheet(null);
        }}
        onClose={() => setFilterSheet(null)}
      />

      <WorkoutDrawer
        data={openEntryRow ? packEntryToDrawerData(openEntryRow, t) : openEntry}
        open={openEntry !== null}
        onOpenChange={(o) => {
          if (!o) setOpenEntry(null);
        }}
        isBooked={openEntry ? bookedIds.has(openEntry.id) : false}
        isWaitlisted={openEntry ? waitlistedIds.has(openEntry.id) : false}
        isFull={openEntryRow ? packEntryToDrawerData(openEntryRow, t).spotsLeft === 0 : false}
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

/** «Пн» / «Mon» / «ორშ» — короткий день недели на языке клиента. */
function dayName(d: Date, t: Translator) {
  const raw = t.date(d, { weekday: "short" });
  return t.capitalize(raw);
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 inline-flex max-w-[60%] items-center gap-1 px-3 h-8 rounded-full border text-xs font-medium transition-colors ${
        active
          ? "bg-foreground text-background border-foreground"
          : "bg-transparent text-muted-foreground border-border"
      }`}
    >
      <span className="truncate">{label}</span>
      <AltArrowDown className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

function FilterSheet({
  kind,
  options,
  value,
  onChange,
  onClose,
}: {
  kind: FilterKind | null;
  options: FilterOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const all = kind === "trainer" ? t("Все тренеры") : t("Все тренировки");
  const rows: (FilterOption | null)[] = [null, ...options];
  return (
    <DrawerPrimitive.Root
      open={kind !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      shouldScaleBackground
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-1 mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3">
            <DrawerPrimitive.Title className="text-xl font-semibold">
              {kind === "trainer" ? t("Тренер") : t("Тренировка")}
            </DrawerPrimitive.Title>
            {options.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">
                {t("В ближайшие дни в расписании пусто.")}
              </p>
            )}
            <ul className="mt-3 divide-y divide-border">
              {rows.map((o) => {
                const id = o?.id ?? null;
                const active = id === value;
                return (
                  <li key={id ?? "all"}>
                    <button
                      type="button"
                      onClick={() => onChange(id)}
                      className="flex w-full items-center gap-3 py-3 text-left"
                    >
                      {kind === "trainer" && o ? (
                        <SquircleAvatar size={32} className="shrink-0">
                          {o.photo && <SquircleAvatarImage src={o.photo} alt={o.label} />}
                          <SquircleAvatarFallback className="bg-muted text-xs font-semibold text-muted-foreground">
                            {trainerInitials(o.label)}
                          </SquircleAvatarFallback>
                        </SquircleAvatar>
                      ) : kind === "workout" && o ? (
                        <span
                          className={`h-3 w-3 shrink-0 rounded-full ${o.color ? "" : "bg-muted-foreground/40"}`}
                          style={o.color ? { backgroundColor: o.color } : undefined}
                        />
                      ) : null}
                      <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold" : ""}`}>
                        {o?.label ?? all}
                      </span>
                      {o?.rating != null && (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 text-sm font-semibold tabular-nums"
                          aria-label={t("Рейтинг {value} из 5", {
                            value: formatRating(o.rating, t),
                          })}
                        >
                          <Star className="h-4 w-4 text-amber-400" weight="Bold" />
                          {formatRating(o.rating, t)}
                        </span>
                      )}
                      {active && (
                        <CheckCircle className="h-5 w-5 shrink-0 text-primary" weight="Bold" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
