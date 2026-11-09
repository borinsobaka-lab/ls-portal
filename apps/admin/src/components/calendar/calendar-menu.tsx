/**
 * Меню раздела «Календарь» (упрощение — UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 2.3 и 5.1): «Все события», мини-месяц (день — сетка переходит к нему,
 * `?date=`), один блок «Календари» — личный первым, затем общие; слева у
 * каждого цветной квадрат-флажок (залит — показан на сетке, пустой —
 * скрыт), «⋯» — настройки (видно всегда); «+ Новый календарь» мелкой
 * строкой. Ниже — «Показывать на календаре»: сроки задач, дни рождения,
 * отсутствия. Что показано — у человека в браузере (`useCalendarPrefs`).
 * «Ждут ответа» — плашкой над сеткой (`?invites=1` по-прежнему работает).
 */
import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, MoreHorizontal, Plus } from "lucide-react";

import { MiniMonth } from "@/components/calendar/mini-month";
import { Calendar as CalendarIcon } from "@/components/nav-icons";
import {
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavGroup,
  SIDEBAR_NAV_LINK_CLASS,
} from "@/components/sidebar-nav";
import { SidebarContent, SidebarMenuAction, SidebarMenuItem } from "@/components/ui/sidebar";
import { calendarsQuery, useCalendarPrefs } from "@/lib/calendar/data";
import { calColor } from "@/lib/calendar/logic";
import type { CalLayer, Calendar } from "@/lib/calendar/types";
import { CALENDAR_URL } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";

/** Цвета слоёв — как плашки на сетке (styles.css, `.cal-ev-*`). */
const LAYERS: { key: CalLayer; title: string; color: string }[] = [
  { key: "tasks", title: "Сроки моих задач", color: "#94a3b8" },
  { key: "birthdays", title: "Дни рождения", color: "#ec4899" },
  { key: "absences", title: "Отсутствия коллег", color: "#f59e0b" },
];

/** Цветной квадрат-флажок: залит — показан, рамка — скрыт. */
function ColorCheck({ color, on }: { color: string; on: boolean }) {
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-2"
      style={{ borderColor: color, backgroundColor: on ? color : "transparent" }}
    >
      {on && <Check className="size-3 text-white" strokeWidth={3} />}
    </span>
  );
}

function ToggleRow({
  color,
  on,
  title,
  note,
  hint,
  onToggle,
  action,
}: {
  color: string;
  on: boolean;
  title: string;
  note?: string;
  hint?: string;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarNavButton active={false}>
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          title={hint ?? (on ? "Скрыть с календаря" : "Показать на календаре")}
          className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full text-left", action && "pr-8")}
          onClick={onToggle}
        >
          <ColorCheck color={color} on={on} />
          <span className={cn("min-w-0 flex-1 truncate", !on && "text-white/60")}>{title}</span>
          {note && <span className="shrink-0 text-xs font-normal text-white/45">{note}</span>}
        </button>
      </SidebarNavButton>
      {action}
    </SidebarMenuItem>
  );
}

export function CalendarMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { data: calendars = [] } = useQuery(calendarsQuery);
  const prefs = useCalendarPrefs();
  const location = useRouterState({ select: (s) => s.location });
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const onPage = location.pathname === CALENDAR_URL || location.pathname === `${CALENDAR_URL}/`;
  const list = [
    ...calendars.filter((c) => c.kind === "personal"),
    ...calendars.filter((c) => c.kind === "shared"),
  ];

  const openSettings = (id: string) => {
    onNavigate?.();
    void navigate({
      to: CALENDAR_URL,
      search: (s: Record<string, unknown>) => ({ ...s, settings: id }),
    });
  };

  const goTo = (day: string) => {
    setPicked(day);
    onNavigate?.();
    void navigate({
      to: CALENDAR_URL,
      search: (s: Record<string, unknown>) => ({ ...s, date: day }),
    });
  };

  const item = (c: Calendar) => {
    const shown = !prefs.hidden.includes(c.id);
    const name = c.kind === "personal" ? "Мой календарь" : c.name;
    return (
      <ToggleRow
        key={c.id}
        color={calColor(c.color)}
        on={shown}
        title={name}
        note={c.kind === "personal" ? "личный" : undefined}
        hint={c.description || undefined}
        onToggle={() => prefs.toggleCalendar(c.id)}
        action={
          <SidebarMenuAction
            className="text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={`Настройки: ${name}`}
            title="Настройки календаря"
            onClick={() => openSettings(c.id)}
          >
            <MoreHorizontal />
          </SidebarMenuAction>
        }
      />
    );
  };

  return (
    <SidebarContent className="sidebar-scroll gap-1">
      <SidebarNavGroup id="cal-main" label="Календарь">
        <SidebarMenuItem>
          <SidebarNavButton active={onPage}>
            <Link to={CALENDAR_URL} onClick={onNavigate} className={SIDEBAR_NAV_LINK_CLASS}>
              <SidebarNavContent icon={CalendarIcon} active={onPage} title="Все события" />
            </Link>
          </SidebarNavButton>
        </SidebarMenuItem>
      </SidebarNavGroup>

      <div className="mx-2 rounded-lg bg-background text-foreground">
        <MiniMonth selected={picked} onSelect={goTo} className="mx-auto p-2" />
      </div>

      <SidebarNavGroup id="cal-list" label="Календари">
        {list.map(item)}
        <SidebarMenuItem>
          <SidebarNavButton active={false} className="text-white/70">
            <button
              type="button"
              className={cn(SIDEBAR_NAV_LINK_CLASS, "w-full text-left text-[13px]")}
              onClick={() => openSettings("new")}
            >
              <Plus className="size-4" />
              <span>Новый календарь</span>
            </button>
          </SidebarNavButton>
        </SidebarMenuItem>
      </SidebarNavGroup>

      <SidebarNavGroup id="cal-layers" label="Показывать на календаре">
        {LAYERS.map((l) => (
          <ToggleRow
            key={l.key}
            color={l.color}
            on={prefs.layers[l.key]}
            title={l.title}
            onToggle={() => prefs.toggleLayer(l.key)}
          />
        ))}
      </SidebarNavGroup>
    </SidebarContent>
  );
}
