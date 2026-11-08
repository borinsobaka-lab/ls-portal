/**
 * Общий вид меню второго уровня (боковая панель справа от рейки): блоки и
 * пункты. Им пользуются меню клуба и разделов (`app-sidebar.tsx`) и свои меню
 * разделов — «Чаты», «Задачи», чтобы все меню выглядели одинаково:
 *
 * - блок — подпись, горизонтальная линия и шеврон; по нажатию сворачивается,
 *   свёрнутые блоки помнятся (localStorage);
 * - пункт — иконка Solar: обычная контуром, при наведении — белое свечение;
 *   у активного иконка залитая (BoldDuotone) цветом клуба с цветным
 *   свечением, ярче под курсором.
 */
import { useCallback, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronUp } from "lucide-react";

import type { NavIcon } from "@/components/nav-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { CountBadge } from "@/components/ui/status-chip";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "sidebar_groups";

/** Свёрнутые блоки переживают перезагрузку — иначе меню каждый раз раскрывается заново. */
function readCollapsedGroups(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// Одно хранилище на все меню: блоки разных разделов не затирают друг друга.
let closedGroups: Record<string, boolean> | null = null;
const listeners = new Set<() => void>();
const EMPTY: Record<string, boolean> = {};

function getClosedGroups() {
  if (closedGroups === null) closedGroups = readCollapsedGroups();
  return closedGroups;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setGroupClosed(key: string, closed: boolean) {
  closedGroups = { ...getClosedGroups(), [key]: closed };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(closedGroups));
  } catch {
    // приватный режим / переполненное хранилище — не повод ломать меню
  }
  listeners.forEach((l) => l());
}

/** Открыт ли блок меню `key` и как его свернуть / раскрыть. */
function useGroupOpen(key: string): [boolean, (open: boolean) => void] {
  // На сервере и при гидратации все блоки раскрыты — как в разметке сервера.
  const closed = useSyncExternalStore(subscribe, getClosedGroups, () => EMPTY);
  const setOpen = useCallback((open: boolean) => setGroupClosed(key, !open), [key]);
  return [!closed[key], setOpen];
}

/**
 * Блок меню: подпись, линия до края и шеврон. Свёрнутость — по `id`
 * (уникален на всё меню: «chats-folders», «tasks-roles»…).
 */
export function SidebarNavGroup({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useGroupOpen(id);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarGroup className="py-1">
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="group/label h-7 w-full cursor-pointer gap-2 text-[13px] text-white/50 hover:text-white/70">
            <span className="shrink-0">{label}</span>
            <span className="h-px flex-1 bg-white/15" />
            <ChevronUp className="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-data-[state=closed]/label:rotate-180" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>{children}</SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

/**
 * Свечение за иконкой — размытый круг цвета currentColor. У обычного пункта
 * белое и только при наведении; у активного цвета клуба, как и сама иконка,
 * горит всегда и ярче под курсором. `color` — свой цвет значка (точка
 * проекта): тогда и свечение его цвета.
 */
export function NavIconGlow({
  active,
  color,
  children,
}: {
  active: boolean;
  color?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative isolate inline-flex size-[18px] shrink-0 items-center justify-center before:absolute before:-inset-1 before:-z-10 before:rounded-full before:bg-current before:opacity-0 before:blur-[6px] before:transition-opacity before:duration-200",
        active
          ? "before:opacity-45 group-hover/nav:before:opacity-70"
          : "group-hover/nav:before:opacity-45",
        !color && (active ? "text-brand-on-dark" : "text-white"),
      )}
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Кнопка пункта меню — вид пункта без ссылки внутри (`asChild`): ссылка или
 * кнопка передаётся дочерним элементом.
 *
 * active: перекрывать обязательно — в базовых стилях shadcn нажатая кнопка
 * красится в `sidebar-accent`, а это почти белый: на тёмной панели получалась
 * вспышка под курсором на каждый клик.
 */
export function SidebarNavButton({
  active,
  className,
  ...props
}: ComponentProps<typeof SidebarMenuButton> & { active: boolean }) {
  return (
    <SidebarMenuButton
      asChild
      isActive={active}
      className={cn(
        "group/nav font-medium text-white hover:bg-white/10 hover:text-white active:bg-white/10 active:text-white data-[active=true]:bg-white/10 data-[active=true]:font-semibold data-[active=true]:text-white",
        className,
      )}
      {...props}
    />
  );
}

/** Содержимое пункта: иконка со свечением, название, счётчик. */
export function SidebarNavContent({
  icon: Icon,
  marker,
  active,
  title,
  badge,
  badgeTone = "urgent",
}: {
  icon?: NavIcon;
  /** Вместо иконки — цветная точка (проект). */
  marker?: string;
  active: boolean;
  title: ReactNode;
  badge?: number;
  badgeTone?: "urgent" | "quiet";
}) {
  return (
    <>
      <NavIconGlow active={active} color={marker}>
        {Icon ? (
          <Icon active={active} className="size-[18px]" />
        ) : (
          <span className="size-2.5 rounded-full bg-current" />
        )}
      </NavIconGlow>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {!!badge && <CountBadge count={badge} tone={badgeTone} />}
    </>
  );
}

/** Класс ссылки внутри `SidebarNavButton`. */
export const SIDEBAR_NAV_LINK_CLASS = "flex items-center gap-2";

/**
 * Пункт-ссылка меню второго уровня по простому пути. Ссылке с `search` или
 * `params` (их типы TanStack выводит из самой ссылки) — `SidebarNavButton` +
 * `Link className={SIDEBAR_NAV_LINK_CLASS}` + `SidebarNavContent`.
 */
export function SidebarNavLink({
  active,
  icon,
  marker,
  title,
  badge,
  badgeTone,
  onClick,
  to,
}: {
  to: string;
  onClick?: () => void;
  active: boolean;
  icon?: NavIcon;
  marker?: string;
  title: ReactNode;
  badge?: number;
  badgeTone?: "urgent" | "quiet";
}) {
  return (
    <SidebarNavButton active={active}>
      <Link to={to} className={SIDEBAR_NAV_LINK_CLASS} onClick={onClick}>
        <SidebarNavContent
          icon={icon}
          marker={marker}
          active={active}
          title={title}
          badge={badge}
          badgeTone={badgeTone}
        />
      </Link>
    </SidebarNavButton>
  );
}
