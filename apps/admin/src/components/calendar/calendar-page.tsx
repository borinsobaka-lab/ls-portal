/**
 * «Календарь» (TASKS_CHATS_PLAN.md, этап 2, раздел 4 брифа): личный и общие
 * календари, встречи с приглашениями, повторы, напоминания, видеовстреча в
 * чате события. Поверх событий — слои: сроки моих задач, дни рождения и
 * отсутствия коллег. Схема — db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql.
 * Упрощение для новичков — UI_REVIEW_CHATS_TASKS_CALENDAR.md, 5.1–5.2:
 * плашка «N приглашений ждут ответа», мини-месяц у заголовка периода,
 * быстрое создание, «Перенесено · Отменить», легенда, пояс словами.
 *
 * Адрес: `?event=<id>&at=<событие серии>` — карточка (ссылка из
 * уведомления; `from=invites` — после неё вернуться к приглашениям),
 * `?settings=<id|new>` — настройки календаря, `?invites=1` — «Ждут
 * ответа», `?date=` — перейти к дню (мини-месяц меню), `?new=1&with=<id>`
 * — новое событие с этим участником (карточка сотрудника → «Встреча»).
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DateSelectArg, EventChangeArg, EventClickArg, EventInput } from "@fullcalendar/core";
import { ChevronDown, ChevronLeft, ChevronRight, HelpCircle, Mail, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { CalendarDialog } from "@/components/calendar/calendar-dialog";
import type { GridApi } from "@/components/calendar/calendar-grid";
import { EventCardDialog } from "@/components/calendar/event-card";
import { EventFormDialog, type EventDraft, type EventPick } from "@/components/calendar/event-form";
import { InvitesDialog } from "@/components/calendar/invites-dialog";
import { MiniMonth } from "@/components/calendar/mini-month";
import { QuickEventDialog } from "@/components/calendar/quick-event";
import { PersonButton, PersonCardDialog } from "@/components/people/person-card";
import { TableToolbar } from "@/components/table-toolbar";
import { PersonLine } from "@/components/tasks/task-bits";
import { TaskSheet } from "@/components/tasks/task-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  calendarsQuery,
  saveEvent,
  useCalCounters,
  useCalendarEvents,
  useCalendarOverlays,
  useCalendarPrefs,
} from "@/lib/calendar/data";
import {
  calColor,
  calErrorText,
  dayTitle,
  defaultCalendarId,
  emptyPeriodText,
  fromWallClock,
  invitesText,
  newEventForm,
  quickSlotTime,
  wallClock,
  wallDay,
  type CalendarSearchParams,
} from "@/lib/calendar/logic";
import type { CalOccurrence, CalOverlays, CalView } from "@/lib/calendar/types";
import { usePeople } from "@/lib/chats/people";
import { NOTIFICATIONS_SETTINGS_URL } from "@/lib/nav-sections";
import { timezoneByText } from "@/lib/notifications/settings-logic";
import {
  ABSENCE_KIND_LABEL,
  absenceText,
  type Absence,
  type AbsenceKind,
} from "@/lib/people-calendar";
import { useAbsences, useTodayISO } from "@/lib/people-calendar-data";
import { useTaskClock } from "@/lib/tasks/data";
import { addDays, localDay, localTime, plural, zoned } from "@/lib/tasks/logic";

const CalendarGrid = lazy(() => import("@/components/calendar/calendar-grid"));

export type CalendarSearch = CalendarSearchParams;

const VIEWS: { value: CalView; label: string; short: string }[] = [
  { value: "timeGridDay", label: "День", short: "День" },
  { value: "timeGridWeek", label: "Неделя", short: "Нед." },
  { value: "dayGridMonth", label: "Месяц", short: "Мес." },
  { value: "listWeek", label: "Список", short: "Список" },
];
const VIEW_KEY = "calendar_view";
const HINT_KEY = "calendar_hint_longpress";

function readView(mobile: boolean): CalView {
  try {
    const v = window.localStorage.getItem(VIEW_KEY) as CalView | null;
    if (v && VIEWS.some((x) => x.value === v)) return v;
  } catch {
    // нет хранилища — вид по умолчанию
  }
  return mobile ? "listWeek" : "timeGridWeek";
}

function readHintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

/** Время события из сетки (стенное время) — для базы. */
function gridTimes(
  ev: { start: Date | null; end: Date | null; allDay: boolean },
  tz: string,
): { all_day: boolean; starts_at: string; ends_at: string } | null {
  if (!ev.start) return null;
  if (ev.allDay) {
    return {
      all_day: true,
      starts_at: zoned(wallDay(ev.start), "00:00", tz).toISOString(),
      ends_at: zoned(
        ev.end ? wallDay(ev.end) : addDays(wallDay(ev.start), 1),
        "00:00",
        tz,
      ).toISOString(),
    };
  }
  // Из «весь день» в часы — час по умолчанию.
  const end = ev.end ?? new Date(ev.start.getTime() + 60 * 60_000);
  return {
    all_day: false,
    starts_at: fromWallClock(ev.start, tz).toISOString(),
    ends_at: fromWallClock(end, tz).toISOString(),
  };
}

export function CalendarPage({
  search,
  setSearch,
}: {
  search: CalendarSearch;
  setSearch: (patch: Partial<CalendarSearch>) => void;
}) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const mobile = useIsMobile();
  const { name } = usePeople();
  const { data: calendars, isPending: calendarsPending } = useQuery(calendarsQuery);
  const prefs = useCalendarPrefs();
  const { invites } = useCalCounters();
  const absences = useAbsences();
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<CalView>("timeGridWeek");
  const [range, setRange] = useState<{ from: string; to: string; title: string } | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [quick, setQuick] = useState<EventPick | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [task, setTask] = useState<number | undefined>(undefined);
  const [awayDay, setAwayDay] = useState<string | null>(null);
  const [hintSeen, setHintSeen] = useState(true);
  const [monthOpen, setMonthOpen] = useState(false);
  const [initialDate] = useState(search.date);
  const api = useRef<GridApi | null>(null);

  useEffect(() => {
    setView(readView(window.matchMedia("(max-width: 767px)").matches));
    setHintSeen(readHintSeen());
    setMounted(true);
  }, []);

  // Мини-месяц меню: перейти сеткой к дню и убрать день из адреса.
  useEffect(() => {
    if (!search.date || !range) return;
    api.current?.gotoDate(search.date);
    setSearch({ date: undefined });
  }, [search.date, range, setSearch]);

  // Карточка сотрудника → «Встреча»: новое событие с этим человеком.
  useEffect(() => {
    if (!search.new || calendarsPending) return;
    const form = newEventForm(defaultCalendarId(calendars ?? []), tz);
    if (search.with) form.attendees = [search.with];
    setDraft({ mode: "new", form });
    setSearch({ new: undefined, with: undefined });
  }, [search.new, search.with, calendarsPending, calendars, tz, setSearch]);

  const changeView = (v: CalView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // не страшно
    }
  };

  const hideHint = () => {
    setHintSeen(true);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // приватный режим — подсказка вернётся после перезагрузки
    }
  };

  const visibleIds = useMemo(
    () => (calendars ?? []).filter((c) => !prefs.hidden.includes(c.id)).map((c) => c.id),
    [calendars, prefs.hidden],
  );
  const eventsQuery = useCalendarEvents(range?.from ?? null, range?.to ?? null, visibleIds);
  const occurrences = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const anyLayer = prefs.layers.tasks || prefs.layers.birthdays || prefs.layers.absences;
  const { data: overlays } = useCalendarOverlays(range?.from ?? null, range?.to ?? null, anyLayer);

  const events = useMemo<EventInput[]>(
    () => [
      ...occurrences.map((o) => toInput(o, tz)),
      ...overlayInputs(overlays, prefs.layers, tz, name),
    ],
    [occurrences, overlays, prefs.layers, tz, name],
  );
  const empty = eventsQuery.isSuccess && events.length === 0;

  // Отсутствия выключены слоем — число в шапке дня (только недели и дни).
  const awayOn = (day: string) => absences.filter((a) => a.starts_on <= day && a.ends_on >= day);
  const dayHeaderExtra = prefs.layers.absences
    ? undefined
    : (day: string) => {
        const n = awayOn(day).length;
        if (!n) return null;
        return (
          <button
            type="button"
            className="cursor-pointer text-[11px] font-normal text-amber-700 hover:underline"
            title="Кто отсутствует в этот день"
            onClick={(e) => {
              e.stopPropagation();
              setAwayDay(day);
            }}
          >
            {n} {plural(n, "отсутствует", "отсутствуют", "отсутствуют")}
          </button>
        );
      };

  const onRange = (r: { start: Date; end: Date; title: string }) => {
    // Запас в день по краям: события «весь день» в других поясах.
    const from = fromWallClock(r.start, tz);
    const to = fromWallClock(r.end, tz);
    from.setUTCDate(from.getUTCDate() - 1);
    to.setUTCDate(to.getUTCDate() + 1);
    setRange({ from: from.toISOString(), to: to.toISOString(), title: r.title });
  };

  const onSelect = (arg: DateSelectArg) => {
    const startDay = wallDay(arg.start);
    if (arg.allDay) {
      const endDay = addDays(wallDay(arg.end), -1);
      setQuick(
        endDay > startDay
          ? { day: startDay, endDay, allDay: true }
          : // Нажатие на день месяца — встреча в этот день: ближайший час рабочего дня.
            { day: startDay, time: quickSlotTime(startDay, tz) },
      );
      return;
    }
    const s = arg.start.toISOString();
    const e = arg.end.toISOString();
    setQuick({
      day: s.slice(0, 10),
      time: s.slice(11, 16),
      endDay: e.slice(0, 10),
      endTime: e.slice(11, 16),
    });
  };

  const onEventClick = (arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    const p = arg.event.extendedProps as Extended;
    if (p.kind === "event") setSearch({ event: p.eventId, at: p.recurring ? p.occ : undefined });
    else if (p.kind === "task") setTask(p.number);
    else if (p.kind === "person") setPerson(p.userId);
  };

  const onEventChange = (arg: EventChangeArg) => {
    const p = arg.event.extendedProps as Extended;
    if (p.kind !== "event") {
      arg.revert();
      return;
    }
    if (p.recurring) {
      arg.revert();
      toast.info("Повторяющееся событие переносится в карточке", {
        description:
          "Откройте событие → «Изменить» → «Только это событие» или «Все события серии».",
      });
      return;
    }
    const next = gridTimes(arg.event, tz);
    const prev = gridTimes(arg.oldEvent, tz);
    if (!next || !prev) {
      arg.revert();
      return;
    }
    void saveEvent(qc, p.eventId, next)
      .then(() =>
        toast.success("Перенесено", {
          description: "Участники получат уведомление.",
          action: {
            label: "Отменить",
            onClick: () =>
              void saveEvent(qc, p.eventId, prev).then(
                () => toast.success("Перенос отменён"),
                (e) => toast.error(calErrorText(e)),
              ),
          },
        }),
      )
      .catch((e) => {
        arg.revert();
        toast.error(calErrorText(e));
      });
  };

  const showHint = mounted && mobile && !hintSeen && view !== "listWeek";
  const gridDay = () => api.current?.getDate() ?? localDay(new Date(), tz);

  return (
    <AdminShell
      title="Календарь"
      actions={
        <Button onClick={() => setDraft({ mode: "new" })}>
          <Plus /> Новое событие
        </Button>
      }
    >
      {/* Высота — до кнопок в правом нижнем углу: они не закрывают сетку. */}
      <div className="flex h-[calc(100dvh-15rem)] min-h-[28rem] flex-col gap-3 max-md:h-[calc(100dvh-14rem)]">
        {/* Период и вид — на белой плашке, как фильтры во всех разделах. */}
        <TableToolbar>
          <div className="toolbar-full flex min-w-0 flex-1 items-center gap-2">
            <Button variant="outline" onClick={() => api.current?.today()}>
              Сегодня
            </Button>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Назад"
                title="Назад"
                onClick={() => api.current?.prev()}
              >
                <ChevronLeft className="size-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Вперёд"
                title="Вперёд"
                onClick={() => api.current?.next()}
              >
                <ChevronRight className="size-5" />
              </Button>
            </div>
            <Popover open={monthOpen} onOpenChange={setMonthOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-10 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 text-base font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-lg"
                  title="Выбрать день"
                >
                  <span className="truncate first-letter:uppercase">{range?.title ?? ""}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0">
                {monthOpen && (
                  <MiniMonth
                    selected={gridDay()}
                    onSelect={(day) => {
                      api.current?.gotoDate(day);
                      setMonthOpen(false);
                    }}
                  />
                )}
              </PopoverContent>
            </Popover>
            <Legend />
          </div>
          <SegmentedControl
            aria-label="Вид"
            value={view}
            onChange={changeView}
            options={VIEWS.map((v) => ({ value: v.value, label: mobile ? v.short : v.label }))}
          />
        </TableToolbar>

        {invites > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-200">
            <Mail className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{invitesText(invites)}</span>
            <Button variant="link" size="inline" onClick={() => setSearch({ invites: true })}>
              Посмотреть
            </Button>
          </div>
        )}

        {showHint && (
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              Нажмите и удерживайте свободное время, чтобы создать событие.
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Понятно, скрыть подсказку"
              title="Скрыть"
              onClick={hideHint}
            >
              <X />
            </Button>
          </div>
        )}

        <div className="cal-grid relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
          {mounted && !calendarsPending ? (
            <Suspense fallback={<GridSkeleton />}>
              <CalendarGrid
                key={tz}
                view={view}
                tz={tz}
                events={events}
                apiRef={api}
                initialDate={initialDate}
                noEventsText={`${emptyPeriodText("timeGridWeek")}. Нажмите «Новое событие».`}
                dayHeaderExtra={dayHeaderExtra}
                onRange={onRange}
                onSelect={onSelect}
                onEventClick={onEventClick}
                onEventChange={onEventChange}
              />
            </Suspense>
          ) : (
            <GridSkeleton />
          )}
          {empty && view !== "listWeek" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
              <p className="rounded-full border bg-background/95 px-4 py-2 text-center text-sm text-muted-foreground shadow-sm">
                {emptyPeriodText(view)}. Нажмите на свободное время или «Новое событие».
              </p>
            </div>
          )}
        </div>
        <p className="flex flex-wrap gap-x-1 text-xs text-muted-foreground">
          <span className="max-md:hidden">
            Выделите время на сетке — новое событие; перетащите своё событие — перенести.
          </span>
          <span>
            Время показано {timezoneByText(tz)} ·{" "}
            <Link
              to={NOTIFICATIONS_SETTINGS_URL}
              className="font-medium text-foreground underline underline-offset-2"
            >
              Изменить
            </Link>
          </span>
        </p>
      </div>

      <QuickEventDialog
        pick={quick}
        onClose={() => setQuick(null)}
        onMore={(form) => {
          setQuick(null);
          setDraft({ mode: "new", form });
        }}
        onSaved={(calendarId) => prefs.showCalendar(calendarId)}
      />
      <EventFormDialog
        draft={draft}
        onClose={() => setDraft(null)}
        onSaved={(_id, calendarId) => {
          // Событие в скрытом календаре — показать календарь.
          if (calendarId) prefs.showCalendar(calendarId);
        }}
      />
      <EventCardDialog
        target={search.event ? { id: search.event, occ: search.at ?? null } : null}
        onClose={() =>
          setSearch({
            event: undefined,
            at: undefined,
            from: undefined,
            ...(search.from === "invites" ? { invites: true } : {}),
          })
        }
        onEdit={(d) => {
          setSearch({ event: undefined, at: undefined, from: undefined });
          setDraft(d);
        }}
        onSettings={(id) =>
          setSearch({ event: undefined, at: undefined, from: undefined, settings: id })
        }
      />
      <CalendarDialog
        target={search.settings ?? null}
        onClose={() => setSearch({ settings: undefined })}
        onCreated={(id) => prefs.showCalendar(id)}
      />
      <InvitesDialog
        open={!!search.invites}
        onClose={() => setSearch({ invites: undefined })}
        onOpen={(id) => setSearch({ invites: undefined, event: id, from: "invites" })}
      />
      <AwayDialog
        day={awayDay}
        list={awayDay ? awayOn(awayDay) : []}
        onClose={() => setAwayDay(null)}
      />
      <PersonCardDialog userId={person} onClose={() => setPerson(null)} />
      <TaskSheet number={task} onClose={() => setTask(undefined)} />
    </AdminShell>
  );
}

/** Что значат виды плашек на сетке. */
function Legend() {
  const row = (swatch: ReactNode, text: string) => (
    <li className="flex items-center gap-2.5">
      <span className="flex w-8 shrink-0 justify-center">{swatch}</span>
      <span>{text}</span>
    </li>
  );
  const box = "h-4 w-7 rounded-[5px]";
  const blue = calColor("blue");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0"
          aria-label="Что значат цвета на календаре"
          title="Что значат цвета"
        >
          <HelpCircle />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="mb-2 font-medium">Что значат плашки</p>
        <ul className="space-y-2">
          {row(<span className={box} style={{ background: blue }} />, "Событие — цветом календаря")}
          {row(
            <span className={box} style={{ border: `1.5px dashed ${blue}` }} />,
            "Пунктир — вы ещё не ответили на приглашение",
          )}
          {row(
            <span className={box} style={{ background: blue, opacity: 0.55 }} />,
            "Бледное — вы ответили «Возможно»",
          )}
          {row(
            <span className={`${box} border-l-[3px] border-muted-foreground bg-muted`} />,
            "Серое — срок вашей задачи (красная полоска — срочная)",
          )}
          {row(
            <span
              className={box}
              style={{ background: "color-mix(in oklab, #ec4899 22%, white)" }}
            />,
            "Розовое — день рождения коллеги",
          )}
          {row(
            <span
              className={box}
              style={{ background: "color-mix(in oklab, #f59e0b 24%, white)" }}
            />,
            "Жёлтое — коллега отсутствует",
          )}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">Что показывать — флажки в меню слева.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Кто отсутствует в день (число в шапке дня, когда слой выключен). */
function AwayDialog({
  day,
  list,
  onClose,
}: {
  day: string | null;
  list: Absence[];
  onClose: () => void;
}) {
  const today = useTodayISO();
  return (
    <Dialog open={!!day} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>Отсутствуют</DialogTitle>
          <DialogDescription>{day ? dayTitle(day) : ""}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="space-y-2">
            {list.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <PersonButton userId={a.user_id} className="min-w-0 flex-1">
                  <PersonLine id={a.user_id} size="xs" />
                </PersonButton>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {absenceText(a, today)}
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type Extended =
  | { kind: "event"; eventId: string; occ: string; recurring: boolean }
  | { kind: "task"; number: number }
  | { kind: "person"; userId: string };

function toInput(o: CalOccurrence, tz: string): EventInput {
  const color = calColor(o.color);
  const pending = o.my_response === "pending";
  return {
    id: `${o.id}|${o.occ}`,
    title: o.title,
    start: o.all_day ? o.day_from : wallClock(o.start, tz),
    end: o.all_day ? addDays(o.day_to, 1) : wallClock(o.end, tz),
    allDay: o.all_day,
    backgroundColor: pending ? "transparent" : color,
    borderColor: color,
    textColor: pending ? color : "#fff",
    classNames: [
      pending ? "cal-ev-pending" : "",
      o.my_response === "maybe" ? "cal-ev-maybe" : "",
    ].filter(Boolean),
    // Повторяющееся тоже тянется — и объясняет тостом, где его переносят.
    editable: o.can_edit,
    extendedProps: {
      kind: "event",
      eventId: o.id,
      occ: o.occ,
      recurring: o.recurring,
    } satisfies Extended,
  };
}

function overlayInputs(
  o: CalOverlays | undefined,
  layers: { tasks: boolean; birthdays: boolean; absences: boolean },
  tz: string,
  name: (id: string) => string,
): EventInput[] {
  if (!o) return [];
  const out: EventInput[] = [];
  if (layers.tasks) {
    for (const t of o.tasks) {
      const d = new Date(t.deadline);
      const time = localTime(d, tz);
      // Срок со временем — короткое событие на полчаса до срока; «конец
      // суток» (00:00, 23:59) — в строке «весь день».
      const timed = time !== "00:00" && time !== "23:59";
      out.push({
        id: `task|${t.number}`,
        title: timed ? `Срок · #${t.number} ${t.title}` : `#${t.number} ${t.title}`,
        ...(timed
          ? { start: wallClock(new Date(d.getTime() - 30 * 60_000), tz), end: wallClock(d, tz) }
          : { start: localDay(d, tz), allDay: true }),
        editable: false,
        classNames: ["cal-ev-task", t.urgent ? "cal-ev-urgent" : ""].filter(Boolean),
        extendedProps: { kind: "task", number: t.number } satisfies Extended,
      });
    }
  }
  if (layers.birthdays) {
    for (const b of o.birthdays) {
      out.push({
        id: `bd|${b.user_id}|${b.day}`,
        title: `День рождения: ${name(b.user_id)}`,
        start: b.day,
        allDay: true,
        editable: false,
        classNames: ["cal-ev-birthday"],
        extendedProps: { kind: "person", userId: b.user_id } satisfies Extended,
      });
    }
  }
  if (layers.absences) {
    for (const a of o.absences) {
      out.push({
        id: `abs|${a.user_id}|${a.starts_on}`,
        title: `${name(a.user_id)} — ${
          a.kind === "other"
            ? "нет на месте"
            : (ABSENCE_KIND_LABEL[a.kind as AbsenceKind] ?? "нет на месте").toLowerCase()
        }`,
        start: a.starts_on,
        end: addDays(a.ends_on, 1),
        allDay: true,
        editable: false,
        classNames: ["cal-ev-absence"],
        extendedProps: { kind: "person", userId: a.user_id } satisfies Extended,
      });
    }
  }
  return out;
}

function GridSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-5" />
        ))}
      </div>
      <Skeleton className="min-h-0 flex-1" />
    </div>
  );
}
