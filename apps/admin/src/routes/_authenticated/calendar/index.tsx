import { createFileRoute } from "@tanstack/react-router";

import { CalendarPage } from "@/components/calendar/calendar-page";
import { CalendarPageSkeleton } from "@/components/page-skeletons";
import { PORTAL_NAME } from "@/lib/brand";
import { calendarSearch } from "@/lib/calendar/logic";

/**
 * «Календарь» (TASKS_CHATS_PLAN.md, этап 2): личный и общие календари,
 * встречи. `?event=<id>&at=<событие серии>` — карточка события, `?settings=` —
 * настройки календаря, `?invites=1` — «Ждут ответа», `?date=` — перейти к
 * дню, `?new=1&with=<id>` — новое событие с участником.
 */
export const Route = createFileRoute("/_authenticated/calendar/")({
  head: () => ({ meta: [{ title: `Календарь — ${PORTAL_NAME}` }] }),
  validateSearch: calendarSearch,
  pendingComponent: CalendarPageSkeleton,
  component: CalendarRoute,
});

function CalendarRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CalendarPage
      search={search}
      setSearch={(patch) => void navigate({ search: (s) => clean({ ...s, ...patch }) })}
    />
  );
}

function clean<T extends Record<string, unknown>>(s: T): T {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as T;
}
