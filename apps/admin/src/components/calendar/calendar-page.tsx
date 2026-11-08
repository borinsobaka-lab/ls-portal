/**
 * «Календарь» (TASKS_CHATS_PLAN.md, этап 2, раздел 4 брифа): личный и общие
 * календари, встречи с приглашениями, повторы, напоминания, видеовстреча в
 * чате события. Поверх событий — слои: сроки моих задач, дни рождения и
 * отсутствия коллег. Схема — db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql.
 *
 * Адрес: `?event=<id>&at=<повторение>` — карточка события (ссылка из
 * уведомления), `?settings=<id|new>` — настройки календаря, `?invites=1` —
 * «Ждут ответа».
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DateSelectArg, EventChangeArg, EventClickArg, EventInput } from "@fullcalendar/core";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { CalendarDialog } from "@/components/calendar/calendar-dialog";
import type { GridApi } from "@/components/calendar/calendar-grid";
import { EventCardDialog } from "@/components/calendar/event-card";
import { EventFormDialog, type EventDraft } from "@/components/calendar/event-form";
import { InvitesDialog } from "@/components/calendar/invites-dialog";
import { PersonCardDialog } from "@/components/people/person-card";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  calendarsQuery,
  saveEvent,
  useCalendarEvents,
  useCalendarOverlays,
  useCalendarPrefs,
} from "@/lib/calendar/data";
import { calColor, calErrorText, fromWallClock, wallClock, wallDay } from "@/lib/calendar/logic";
import type { CalOccurrence, CalOverlays, CalView } from "@/lib/calendar/types";
import { usePeople } from "@/lib/chats/people";
import { ABSENCE_KIND_LABEL, type AbsenceKind } from "@/lib/people-calendar";
import { addDays, localDay, localTime, zoned } from "@/lib/tasks/logic";
import { useTaskClock } from "@/lib/tasks/data";
import { useNavigate } from "@tanstack/react-router";

const CalendarGrid = lazy(() => import("@/components/calendar/calendar-grid"));

export type CalendarSearch = {
  event?: string;
  at?: string;
  settings?: string;
  invites?: boolean;
};

const VIEWS: { value: CalView; label: string; short: string }[] = [
  { value: "timeGridDay", label: "День", short: "День" },
  { value: "timeGridWeek", label: "Неделя", short: "Нед." },
  { value: "dayGridMonth", label: "Месяц", short: "Мес." },
  { value: "listWeek", label: "Список", short: "Список" },
];
const VIEW_KEY = "calendar_view";

function readView(mobile: boolean): CalView {
  try {
    const v = window.localStorage.getItem(VIEW_KEY) as CalView | null;
    if (v && VIEWS.some((x) => x.value === v)) return v;
  } catch {
    // нет хранилища — вид по умолчанию
  }
  return mobile ? "listWeek" : "timeGridWeek";
}

export function CalendarPage({
  search,
  setSearch,
}: {
  search: CalendarSearch;
  setSearch: (patch: Partial<CalendarSearch>) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { tz } = useTaskClock();
  const mobile = useIsMobile();
  const { name } = usePeople();
  const { data: calendars, isPending: calendarsPending } = useQuery(calendarsQuery);
  const prefs = useCalendarPrefs();
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<CalView>("timeGridWeek");
  const [range, setRange] = useState<{ from: string; to: string; title: string } | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const api = useRef<GridApi | null>(null);

  useEffect(() => {
    setView(readView(window.matchMedia("(max-width: 767px)").matches));
    setMounted(true);
  }, []);

  const changeView = (v: CalView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // не страшно
    }
  };

  const visibleIds = useMemo(
    () => (calendars ?? []).filter((c) => !prefs.hidden.includes(c.id)).map((c) => c.id),
    [calendars, prefs.hidden],
  );
  const { data: occurrences = [] } = useCalendarEvents(
    range?.from ?? null,
    range?.to ?? null,
    visibleIds,
  );
  const anyLayer = prefs.layers.tasks || prefs.layers.birthdays || prefs.layers.absences;
  const { data: overlays } = useCalendarOverlays(range?.from ?? null, range?.to ?? null, anyLayer);

  const events = useMemo<EventInput[]>(
    () => [
      ...occurrences.map((o) => toInput(o, tz)),
      ...overlayInputs(overlays, prefs.layers, tz, name),
    ],
    [occurrences, overlays, prefs.layers, tz, name],
  );

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
      setDraft({
        mode: "new",
        pick:
          endDay > startDay
            ? { day: startDay, endDay, allDay: true }
            : // Нажатие на день месяца — встреча в этот день, а не «весь день».
              { day: startDay, time: "10:00" },
      });
      return;
    }
    const s = arg.start.toISOString();
    const e = arg.end.toISOString();
    setDraft({
      mode: "new",
      pick: {
        day: s.slice(0, 10),
        time: s.slice(11, 16),
        endDay: e.slice(0, 10),
        endTime: e.slice(11, 16),
      },
    });
  };

  const onEventClick = (arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    const p = arg.event.extendedProps as Extended;
    if (p.kind === "event") setSearch({ event: p.eventId, at: p.recurring ? p.occ : undefined });
    else if (p.kind === "task")
      void navigate({ to: "/tasks/$number", params: { number: String(p.number) } });
    else if (p.kind === "person") setPerson(p.userId);
  };

  const onEventChange = (arg: EventChangeArg) => {
    const p = arg.event.extendedProps as Extended;
    if (p.kind !== "event" || !arg.event.start) {
      arg.revert();
      return;
    }
    const allDay = arg.event.allDay;
    const start = arg.event.start;
    let end = arg.event.end;
    let startsAt: Date;
    let endsAt: Date;
    if (allDay) {
      startsAt = zoned(wallDay(start), "00:00", tz);
      endsAt = zoned(end ? wallDay(end) : addDays(wallDay(start), 1), "00:00", tz);
    } else {
      // Из «весь день» в часы — час по умолчанию.
      if (!end) end = new Date(start.getTime() + 60 * 60_000);
      startsAt = fromWallClock(start, tz);
      endsAt = fromWallClock(end, tz);
    }
    void saveEvent(qc, p.eventId, {
      all_day: allDay,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
      .then(() => toast.success("Перенесено"))
      .catch((e) => {
        arg.revert();
        toast.error(calErrorText(e));
      });
  };

  const today = localDay(new Date(), tz);

  return (
    <AdminShell
      title="Календарь"
      actions={
        <Button onClick={() => setDraft({ mode: "new" })}>
          <Plus className="size-4" /> Новое событие
        </Button>
      }
    >
      {/* Высота — до кнопок в правом нижнем углу: они не закрывают сетку. */}
      <div className="flex h-[calc(100dvh-15rem)] min-h-[28rem] flex-col gap-3 max-md:h-[calc(100dvh-14rem)]">
        {/* Период и вид — на белой плашке, как фильтры во всех разделах. */}
        <TableToolbar>
          <div className="toolbar-full flex min-w-0 flex-1 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => api.current?.today()}>
              Сегодня
            </Button>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                aria-label="Назад"
                onClick={() => api.current?.prev()}
              >
                <ChevronLeft className="size-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                aria-label="Вперёд"
                onClick={() => api.current?.next()}
              >
                <ChevronRight className="size-5" />
              </Button>
            </div>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold first-letter:uppercase sm:text-lg">
              {range?.title ?? ""}
            </h2>
          </div>
          <SegmentedControl
            aria-label="Вид"
            value={view}
            onChange={changeView}
            options={VIEWS.map((v) => ({ value: v.value, label: mobile ? v.short : v.label }))}
          />
        </TableToolbar>
        <div className="cal-grid min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
          {mounted && !calendarsPending ? (
            <Suspense fallback={<GridSkeleton />}>
              <CalendarGrid
                key={tz}
                view={view}
                tz={tz}
                events={events}
                apiRef={api}
                onRange={onRange}
                onSelect={onSelect}
                onEventClick={onEventClick}
                onEventChange={onEventChange}
              />
            </Suspense>
          ) : (
            <GridSkeleton />
          )}
        </div>
        <p className="text-xs text-muted-foreground max-md:hidden">
          Выделите время на сетке — новое событие; перетащите своё событие — перенести. Время — по
          поясу из настроек уведомлений ({tz}), сегодня {today.split("-").reverse().join(".")}.
        </p>
      </div>

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
        onClose={() => setSearch({ event: undefined, at: undefined })}
        onEdit={(d) => {
          setSearch({ event: undefined, at: undefined });
          setDraft(d);
        }}
      />
      <CalendarDialog
        target={search.settings ?? null}
        onClose={() => setSearch({ settings: undefined })}
        onCreated={(id) => prefs.showCalendar(id)}
      />
      <InvitesDialog
        open={!!search.invites}
        onClose={() => setSearch({ invites: undefined })}
        onOpen={(id) => setSearch({ invites: undefined, event: id })}
      />
      <PersonCardDialog userId={person} onClose={() => setPerson(null)} />
    </AdminShell>
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
    editable: o.can_edit && !o.recurring,
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
      out.push({
        id: `task|${t.number}`,
        title: `${localTime(d, tz)} · #${t.number} ${t.title}`,
        start: localDay(d, tz),
        allDay: true,
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
        title: `${name(a.user_id)} — ${(ABSENCE_KIND_LABEL[a.kind as AbsenceKind] ?? "нет на месте").toLowerCase()}`,
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
