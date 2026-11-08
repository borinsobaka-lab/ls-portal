/**
 * Меню раздела «Календарь»: «Все события», «Ждут ответа», мои и общие
 * календари (нажатие — показать / скрыть, «⋯» — настройки), «Новый
 * календарь» и слои (сроки задач, дни рождения, отсутствия). Что показано —
 * у человека в браузере (`useCalendarPrefs`). Окна открывает страница по
 * адресу: `?settings=<id|new>`, `?invites=1`.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";

import {
  AddCircle,
  Calendar as CalendarIcon,
  CalendarMinimalistic,
  ClipboardCheck,
  Gift,
  Letter,
  type NavIcon,
} from "@/components/nav-icons";
import {
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavGroup,
  SIDEBAR_NAV_LINK_CLASS,
} from "@/components/sidebar-nav";
import { SidebarContent, SidebarMenuAction, SidebarMenuItem } from "@/components/ui/sidebar";
import { calendarsQuery, useCalCounters, useCalendarPrefs } from "@/lib/calendar/data";
import { calColor } from "@/lib/calendar/logic";
import type { CalLayer, Calendar } from "@/lib/calendar/types";
import { CALENDAR_URL } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";

const LAYERS: { key: CalLayer; title: string; icon: NavIcon }[] = [
  { key: "tasks", title: "Сроки моих задач", icon: ClipboardCheck },
  { key: "birthdays", title: "Дни рождения", icon: Gift },
  { key: "absences", title: "Отсутствия коллег", icon: CalendarMinimalistic },
];

export function CalendarMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { data: calendars = [] } = useQuery(calendarsQuery);
  const { invites } = useCalCounters();
  const prefs = useCalendarPrefs();
  const location = useRouterState({ select: (s) => s.location });
  const search = (location.search ?? {}) as { invites?: boolean };
  const onPage = location.pathname === CALENDAR_URL || location.pathname === `${CALENDAR_URL}/`;
  const mine = calendars.filter((c) => c.kind === "personal");
  const shared = calendars.filter((c) => c.kind === "shared");

  const openSettings = (id: string) => {
    onNavigate?.();
    void navigate({
      to: CALENDAR_URL,
      search: (s: Record<string, unknown>) => ({ ...s, settings: id }),
    });
  };

  const item = (c: Calendar) => {
    const shown = !prefs.hidden.includes(c.id);
    return (
      <SidebarMenuItem key={c.id}>
        <SidebarNavButton active={false}>
          <button
            type="button"
            className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full pr-8 text-left")}
            aria-pressed={shown}
            title={shown ? "Скрыть с сетки" : "Показать на сетке"}
            onClick={() => prefs.toggleCalendar(c.id)}
          >
            <SidebarNavContent
              marker={shown ? calColor(c.color) : "rgba(255,255,255,0.28)"}
              active={false}
              title={<span className={cn(!shown && "text-white/45")}>{c.name}</span>}
            />
          </button>
        </SidebarNavButton>
        <SidebarMenuAction
          showOnHover
          className="text-white/60 hover:bg-white/10 hover:text-white"
          aria-label={`Настройки: ${c.name}`}
          onClick={() => openSettings(c.id)}
        >
          <MoreHorizontal />
        </SidebarMenuAction>
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarContent className="sidebar-scroll gap-1">
      <SidebarNavGroup id="cal-main" label="Календарь">
        <SidebarMenuItem>
          <SidebarNavButton active={onPage && !search.invites}>
            <Link to={CALENDAR_URL} onClick={onNavigate} className={SIDEBAR_NAV_LINK_CLASS}>
              <SidebarNavContent
                icon={CalendarIcon}
                active={onPage && !search.invites}
                title="Все события"
              />
            </Link>
          </SidebarNavButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarNavButton active={onPage && !!search.invites}>
            <Link
              to={CALENDAR_URL}
              search={{ invites: true }}
              onClick={onNavigate}
              className={SIDEBAR_NAV_LINK_CLASS}
            >
              <SidebarNavContent
                icon={Letter}
                active={onPage && !!search.invites}
                title="Ждут ответа"
                badge={invites}
              />
            </Link>
          </SidebarNavButton>
        </SidebarMenuItem>
      </SidebarNavGroup>

      <SidebarNavGroup id="cal-mine" label="Мои календари">
        {mine.map(item)}
      </SidebarNavGroup>

      <SidebarNavGroup id="cal-shared" label="Общие календари">
        {shared.map(item)}
        <SidebarMenuItem>
          <SidebarNavButton active={false}>
            <button
              type="button"
              className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full text-left")}
              onClick={() => openSettings("new")}
            >
              <SidebarNavContent icon={AddCircle} active={false} title="Новый календарь" />
            </button>
          </SidebarNavButton>
        </SidebarMenuItem>
      </SidebarNavGroup>

      <SidebarNavGroup id="cal-layers" label="Также показывать">
        {LAYERS.map((l) => {
          const on = prefs.layers[l.key];
          return (
            <SidebarMenuItem key={l.key}>
              <SidebarNavButton active={false}>
                <button
                  type="button"
                  className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full text-left")}
                  aria-pressed={on}
                  onClick={() => prefs.toggleLayer(l.key)}
                >
                  <SidebarNavContent
                    icon={l.icon}
                    active={false}
                    title={<span className={cn(!on && "text-white/45")}>{l.title}</span>}
                  />
                </button>
              </SidebarNavButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarNavGroup>
    </SidebarContent>
  );
}
