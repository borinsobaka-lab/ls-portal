/**
 * Сетка календаря — FullCalendar (MIT, свободные плагины: день и неделя по
 * часам, месяц, список). Отдельный чанк: грузится только с «Календарём».
 *
 * Время: FullCalendar работает в `timeZone: "UTC"`, а события ему отдаются
 * «стенным» временем пояса человека (`wallClock`) — так сетка показывает его
 * пояс из настроек портала, даже если у компьютера другой. Обратно (выбор
 * промежутка, перетаскивание) — `fromWallClock`.
 */
import { useEffect, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import type { DateSelectArg, EventChangeArg, EventClickArg, EventInput } from "@fullcalendar/core";
import ruLocale from "@fullcalendar/core/locales/ru";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import timeGridPlugin from "@fullcalendar/timegrid";

import { wallClock } from "@/lib/calendar/logic";
import type { CalView } from "@/lib/calendar/types";

export type GridApi = { prev: () => void; next: () => void; today: () => void };

export default function CalendarGrid({
  view,
  tz,
  events,
  onRange,
  onSelect,
  onEventClick,
  onEventChange,
  apiRef,
}: {
  view: CalView;
  tz: string;
  events: EventInput[];
  onRange: (r: { start: Date; end: Date; title: string }) => void;
  onSelect: (arg: DateSelectArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  onEventChange: (arg: EventChangeArg) => void;
  apiRef: { current: GridApi | null };
}) {
  const ref = useRef<FullCalendar>(null);

  useEffect(() => {
    const api = ref.current?.getApi();
    if (!api) return;
    if (api.view.type !== view) api.changeView(view);
  }, [view]);

  useEffect(() => {
    apiRef.current = {
      prev: () => ref.current?.getApi().prev(),
      next: () => ref.current?.getApi().next(),
      today: () => ref.current?.getApi().today(),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  return (
    <FullCalendar
      ref={ref}
      plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
      locale={ruLocale}
      timeZone="UTC"
      now={() => wallClock(new Date(), tz)}
      initialView={view}
      headerToolbar={false}
      height="100%"
      firstDay={1}
      nowIndicator
      scrollTime="08:00:00"
      allDayText="Весь день"
      dayMaxEvents
      slotEventOverlap={false}
      selectable
      selectMirror
      selectLongPressDelay={400}
      eventLongPressDelay={400}
      eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
      slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
      noEventsText="Событий нет"
      events={events}
      datesSet={(arg) => onRange({ start: arg.start, end: arg.end, title: arg.view.title })}
      select={(arg) => {
        onSelect(arg);
        ref.current?.getApi().unselect();
      }}
      eventClick={onEventClick}
      eventChange={onEventChange}
    />
  );
}
