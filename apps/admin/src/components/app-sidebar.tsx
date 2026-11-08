import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Notebook, Settings } from "@/components/nav-icons";
import { AppRail } from "@/components/app-rail";
import {
  ACADEMY_ITEMS,
  ANALYTICS_GROUPS,
  CLUB_GROUPS,
  COMPANY_ITEMS,
  DASHBOARD_ITEMS,
  BUG_REPORTS_URL,
  MANAGE_GROUPS,
  MOBILE_APP_ITEMS,
  NOTIFICATIONS_ITEMS,
  REQUESTS_URL,
  SCRIPTS_SETTINGS_URL,
  SCRIPTS_URL,
  STAFF_CLUB_GROUP,
  STAFF_NAV_ITEM,
  canOpenPath,
  hasAcademyRight,
  kbBaseIdOf,
  railSectionKey,
  type NavGroup,
  type NavItem,
  type RailSectionKey,
} from "@/lib/nav-sections";
import { usePlaybook, useScriptAccess, useUnreadSuggestions } from "@/lib/scripts/data";
import { kbBasesQuery } from "@/lib/kb/data";
import { KbSidebarResize } from "@/components/kb/kb-sidebar-resize";
import { ChatFoldersMenu } from "@/components/chats/chat-folders-menu";
import { CalendarMenu } from "@/components/calendar/calendar-menu";
import { TasksMenu } from "@/components/tasks/tasks-menu";
import { useKbSidebarWidth } from "@/components/kb/use-kb-sidebar-width";
import { sectionIcon } from "@/lib/scripts/icons";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useClubRequestsBadge } from "@/hooks/use-client-requests";
import { useOpenBugReports } from "@/hooks/use-bug-reports";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import { canOpenClubSection, canOpenRail, hasRight, type AdminAccess } from "@/lib/admin-access";
import { StudioSwitcher } from "@/components/studio-switcher";
import { useActiveStudio, useStudios } from "@/hooks/use-studios";
import { MenuSkeleton } from "@/components/skeletons";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { useStorageUrl } from "@/lib/storage";
import type { StudioFormat } from "@/lib/studio-formats";
import { SidebarNavGroup, SidebarNavLink } from "@/components/sidebar-nav";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { CLUBS_HIDDEN } from "@/lib/launch";

/** Пункты меню, чей счётчик — «новое», а не «ждёт действия»: серый CountBadge. */
const QUIET_BADGES = new Set(["/nps"]);

/**
 * Разделы рейки со своим меню вместо меню клуба: оно общее для всех студий,
 * поэтому в шапке меню — название раздела, а не логотип студии. Название
 * раздела — в шапке, группе хватит нейтральной подписи.
 */
const SECTION_MENUS: Partial<Record<RailSectionKey, { title: string; groups: NavGroup[] }>> = {
  dashboard: {
    title: "Дашборд",
    groups: [{ key: "dashboard", label: "Разделы", items: DASHBOARD_ITEMS }],
  },
  app: {
    title: "Мобильное приложение",
    groups: [{ key: "mobile", label: "Разделы", items: MOBILE_APP_ITEMS }],
  },
  company: {
    title: "Компания",
    groups: [{ key: "company", label: "Разделы", items: COMPANY_ITEMS }],
  },
  chats: { title: "Чаты", groups: [] },
  tasks: { title: "Задачи", groups: [] },
  calendar: { title: "Календарь", groups: [] },
  notifications: {
    title: "Уведомления",
    groups: [{ key: "notifications", label: "Разделы", items: NOTIFICATIONS_ITEMS }],
  },
};

/**
 * Пункты клуба для формата активной студии и прав сотрудника («Доступы»);
 * опустевшие группы не показываем. Пока права грузятся — меню пустое, чтобы
 * закрытые пункты не мелькали.
 */
function visibleGroups(
  format: StudioFormat | undefined,
  access: AdminAccess | null,
  studioId: string | null,
): NavGroup[] {
  if (!access) return [];
  return CLUB_GROUPS.map((g) => ({
    ...g,
    items: [
      ...g.items.filter(
        (i) =>
          (!i.formats || (!!format && i.formats.includes(format))) &&
          canOpenClubSection(access, studioId, i.section),
      ),
      // «Сотрудники» — в блоке «Клуб», но право у них — раздел рейки:
      // справочник общий для всех клубов.
      ...(g.key === STAFF_CLUB_GROUP && canOpenRail(access, "staff") ? [STAFF_NAV_ITEM] : []),
    ],
  })).filter((g) => g.items.length > 0);
}

// Дерево базы знаний (перетаскивание, поиск) — отдельным чанком: остальным
// разделам меню оно не нужно.
const KbSidebarMenu = lazy(() =>
  import("@/components/kb/kb-sidebar-menu").then((m) => ({ default: m.KbSidebarMenu })),
);

/**
 * Меню «Скриптов LS»: разделы скриптов живут в базе (их заводят и
 * переставляют в самом разделе), поэтому меню собирается из них. У
 * «Настроек» — счётчик новых предложений, у каждого сотрудника свой.
 */
function useScriptsMenu(enabled: boolean): { groups: NavGroup[]; loading: boolean } {
  const access = useScriptAccess();
  const { data: sections = [], isLoading } = usePlaybook(enabled && !!access?.canRead);
  const { data: unread = 0 } = useUnreadSuggestions(enabled && !!access?.canEdit);
  if (!enabled) return { groups: [], loading: false };
  // Пока нет прав или дерева скриптов — скелетон меню, а не одни «Все скрипты».
  if (!access || isLoading) return { groups: [], loading: true };
  const groups: NavGroup[] = [
    {
      key: "scripts",
      label: "Разделы",
      items: [
        { title: "Все скрипты", url: SCRIPTS_URL, icon: Notebook, exact: true },
        ...sections.map((s) => ({
          title: s.title,
          url: `${SCRIPTS_URL}/${s.id}`,
          icon: sectionIcon(s.icon),
        })),
      ],
    },
    {
      key: "scripts-settings",
      label: "Управление",
      items: [{ title: "Настройки", url: SCRIPTS_SETTINGS_URL, icon: Settings, badge: unread }],
    },
  ];
  return { groups, loading: false };
}

/**
 * Сколько обращений «Обратной связи» клуба не отработано — счётчик у пункта
 * меню. Новые обращения приходят из приложения и по QR-коду
 * (db/migrations/2026-10-15_zz_feedback_in_app.sql); счётчик обновляется раз в
 * минуту и при возвращении на вкладку. Ключ начинается с "feedback": страница
 * раздела сбрасывает его вместе со своим списком. Клубы — все клубы раздела
 * (id через запятую), как на странице (2026-10-19).
 */
function usePendingFeedback(studioIds: string, enabled: boolean): number {
  const { data = 0 } = useQuery({
    queryKey: ["feedback", studioIds, "pending-count"],
    queryFn: async () => {
      let q = supabase
        .from("feedback")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      // Как на странице: клубы раздела и старые обращения без клуба.
      if (studioIds) q = q.or(`studio_id.in.(${studioIds}),studio_id.is.null`);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    enabled,
    refetchInterval: 60_000,
  });
  return enabled ? data : 0;
}

/**
 * Сколько ответов NPS клуба не прочитано — счётчик у «NPS-опросов», как у
 * «Заявок». Новые ответы приходят из приложения
 * (db/migrations/2026-10-15_zzz_nps_read_renewal.sql); сотрудник отмечает
 * каждый прочитанным во вкладке «Статистика». Ключ начинается с
 * ["nps_responses", studioIds]: страница сбрасывает его вместе со списком.
 * Клубы — все клубы раздела (id через запятую), как на странице.
 */
function useUnreadNps(studioIds: string, enabled: boolean): number {
  const { data = 0 } = useQuery({
    queryKey: ["nps_responses", studioIds, "unread-count"],
    queryFn: async () => {
      let q = supabase
        .from("nps_responses")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      // Как на странице: клубы раздела и старые ответы без клуба.
      if (studioIds) q = q.or(`studio_id.in.(${studioIds}),studio_id.is.null`);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    enabled,
    refetchInterval: 60_000,
  });
  return enabled ? data : 0;
}

/**
 * Логотип активной студии (studios.logo_url). Меню тёмное — логотип нужен
 * светлый на прозрачном фоне. Без логотипа — название студии.
 */
function StudioLogo() {
  const studio = useActiveStudio();
  const { isLoading } = useStudios();
  const src = useStorageUrl("studios", studio?.logo_url);
  if (isLoading) return <Skeleton className="h-9 w-32 bg-white/10" />;
  if (!studio) return <span className="block h-9" />;
  if (src)
    return (
      <img
        src={src}
        alt={studio.name}
        className="h-auto max-h-12 w-36 object-contain object-left"
      />
    );
  return <span className="truncate text-lg font-semibold">{studio.name}</span>;
}

export function AppSidebar() {
  const studioFormat = useActiveStudio()?.format;
  const studioId = useActiveStudioId();
  const access = useAdminAccess();
  const currentPath = useRouterState({ select: (router) => router.location.pathname });
  const railKey = railSectionKey(currentPath);
  const scriptsMenu = useScriptsMenu(railKey === "scripts");
  // База знаний: в меню — дерево открытой базы, панель шире.
  const kbBaseId = railKey === "kb" ? kbBaseIdOf(currentPath) : null;
  const { data: kbBases } = useQuery({ ...kbBasesQuery, enabled: !!kbBaseId });
  const kbBase = kbBases?.find((b) => b.id === kbBaseId);
  const kbBaseTitle = kbBase?.title ?? "База знаний";
  const kbWidth = useKbSidebarWidth();
  // Неразобранные сообщения об ошибках — счётчик у пункта «Управления».
  const openBugReports = useOpenBugReports(!!access && hasRight(access, "portal.admin"));
  const sectionMenu =
    railKey === "scripts"
      ? { title: "Скрипты LS", groups: scriptsMenu.groups }
      : railKey === "kb"
        ? { title: kbBaseId ? kbBaseTitle : "База знаний", groups: [] }
        : railKey === "academy"
          ? {
              // Пункты — по правам в «Академии»; счётчики: свои непройденные
              // курсы; у «Проверки» — ответы, ждущие проверки, и новые
              // прохождения курсов.
              title: "Академия",
              groups: access
                ? [
                    {
                      key: "academy",
                      label: "Разделы",
                      items: ACADEMY_ITEMS.filter((i) => hasAcademyRight(access, i.need)).map(
                        (i) => ({
                          ...i,
                          badge:
                            i.need === "review"
                              ? (access.academy?.to_review ?? 0) +
                                (access.academy?.new_completions ?? 0)
                              : i.need === "any"
                                ? access.academy?.my_open
                                : undefined,
                        }),
                      ),
                    },
                  ]
                : [],
            }
          : railKey === "analytics"
            ? {
                // Группы по модулям; пункт — по своему праву (их allowed_dashboards).
                title: "Аналитика",
                groups: access
                  ? ANALYTICS_GROUPS.map((g) => ({
                      ...g,
                      items: g.items.filter((i) => canOpenPath(access, studioId, i.url)),
                    })).filter((g) => g.items.length > 0)
                  : [],
              }
            : railKey === "manage"
              ? {
                  // Блоки «Знания», «Доступы», «Клубы»; закрытые сотруднику пункты не показываем.
                  title: "Управление",
                  groups: access
                    ? MANAGE_GROUPS.map((g) => ({
                        ...g,
                        items: g.items
                          .filter((i) => canOpenPath(access, studioId, i.url))
                          .map((i) =>
                            i.url === BUG_REPORTS_URL ? { ...i, badge: openBugReports } : i,
                          ),
                      })).filter((g) => g.items.length > 0)
                    : [],
                }
              : SECTION_MENUS[railKey];
  const feedbackStudios = useSectionStudios("feedback");
  const npsStudios = useSectionStudios("nps");
  const pendingFeedback = usePendingFeedback(
    studioIdsKey(feedbackStudios),
    !sectionMenu &&
      !!feedbackStudios &&
      !!access &&
      canOpenClubSection(access, studioId, "feedback"),
  );
  const openRequests = useClubRequestsBadge();
  const unreadNps = useUnreadNps(
    studioIdsKey(npsStudios),
    !sectionMenu && !!npsStudios && !!access && canOpenClubSection(access, studioId, "nps"),
  );
  // Счётчики меню клуба: неотработанные заявки клиентов — на «Заявках»,
  // неотработанная обратная связь — на «Обратной связи», непрочитанные
  // ответы NPS — на «NPS-опросах».
  // Красные — то, что ждёт действия; NPS — просто непрочитанное (QUIET_BADGES).
  const badges: Record<string, number> = {
    [REQUESTS_URL]: openRequests,
    "/feedback": pendingFeedback,
    "/nps": unreadNps,
  };
  const groups =
    sectionMenu?.groups ??
    visibleGroups(studioFormat, access, studioId).map((g) => ({
      ...g,
      items: g.items.map((i) => (i.url in badges ? { ...i, badge: badges[i.url] } : i)),
    }));
  // Меню клуба собирается по правам сотрудника: пока их нет, оно пустое.
  const menuLoading =
    railKey === "scripts"
      ? scriptsMenu.loading
      : railKey === "manage" || railKey === "academy" || railKey === "analytics"
        ? !access
        : !sectionMenu && !access;
  // Шторка на телефоне сама не закрывается по переходу: страница менялась
  // под ней, и после каждого пункта меню шторку приходилось смахивать руками.
  // Закрывает её только пункт меню второго уровня (и логотип); раздел рейки
  // шторку оставляет открытой — дальше выбирают пункт его меню (решение
  // владельца 2026-10-13).
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  // Точное совпадение или вложенный путь: голый startsWith подсвечивал
  // «Пуш-уведомления» (/push) ещё и на /push-triggers.
  const isActive = (path: string, exact = false) =>
    currentPath === path || (!exact && currentPath.startsWith(`${path}/`));
  const itemActive = (item: NavItem) =>
    isActive(item.url, item.exact) || !!item.paths?.some((path) => isActive(path));

  return (
    /*
      Граница справа у shadcn задана с префиксом (group-data-[side=left]:border-r),
      голый border-r-0 её не перекрывал — между меню и рабочей областью
      оставалась светлая полоса, тёмный каркас разрывался.
    */
    <Sidebar
      className="border-r-0 group-data-[side=left]:border-r-0"
      width={kbBaseId ? kbWidth.cssWidth : undefined}
    >
      {/*
        Слева — рейка разделов (AppRail; там же «Мобильное приложение»,
        «Доступы» и «Клубы»), справа — меню клуба или меню раздела
        («Мобильное приложение», «Доступы», «Клубы»).
        Ширина панели (--sidebar-width) уже включает рейку; в шторке на
        телефоне рейка тоже есть, переход по ней шторку не закрывает.
      */}
      <div className="flex h-full min-h-0">
        <AppRail />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {kbBaseId && !isMobile && <KbSidebarResize {...kbWidth} />}
          <SidebarHeader className="px-3 py-4">
            {kbBaseId ? (
              // В базе знаний шапка ведёт на главную базы.
              <Link
                to="/kb/$baseId"
                params={{ baseId: kbBaseId }}
                className="flex min-w-0 items-center px-2 text-white"
                onClick={closeMobile}
              >
                <span className="min-w-0 text-lg leading-tight font-semibold">{kbBaseTitle}</span>
              </Link>
            ) : (
              <Link
                to="/"
                aria-label="На главную"
                className="flex items-center text-white"
                onClick={closeMobile}
              >
                {/* Раздел общий для студий — логотип студии там не к месту. */}
                {sectionMenu ? (
                  <span className="text-lg leading-tight font-semibold">{sectionMenu.title}</span>
                ) : (
                  <StudioLogo />
                )}
              </Link>
            )}
          </SidebarHeader>

          {/*
            Блоки плотнее, чем в shadcn: там между последним пунктом блока и
            заголовком следующего набегало ~33px пустоты (gap-2 + p-2 снизу +
            p-2 сверху + высокая строка заголовка h-8). Теперь gap-1, py-1 и
            заголовок h-7 — в меню по высоте помещается больше пунктов.
          */}
          {kbBaseId && (
            <Suspense fallback={<MenuSkeleton />}>
              <KbSidebarMenu key={kbBaseId} baseId={kbBaseId} onNavigate={closeMobile} />
            </Suspense>
          )}
          {railKey === "chats" && <ChatFoldersMenu onNavigate={closeMobile} />}
          {railKey === "tasks" && <TasksMenu onNavigate={closeMobile} />}
          {railKey === "calendar" && <CalendarMenu onNavigate={closeMobile} />}
          <SidebarContent
            className={cn(
              "sidebar-scroll gap-1",
              (kbBaseId || railKey === "chats" || railKey === "tasks" || railKey === "calendar") &&
                "hidden",
            )}
          >
            {menuLoading && <MenuSkeleton />}
            {groups.map((group) => (
              <SidebarNavGroup key={group.key} id={group.key} label={group.label}>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarNavLink
                      to={item.url}
                      active={itemActive(item)}
                      icon={item.icon}
                      title={item.title}
                      badge={item.badge}
                      badgeTone={QUIET_BADGES.has(item.url) ? "quiet" : "urgent"}
                      onClick={closeMobile}
                    />
                  </SidebarMenuItem>
                ))}
              </SidebarNavGroup>
            ))}
          </SidebarContent>

          {/*
        До lg выбор студии не помещается в шапку страницы рядом с заголовком
        и действиями — он живёт здесь, внизу меню (на телефоне — в шторке).
        На широком экране он в шапке, а этот блок скрыт. «Выход» — в рейке
        (RailAccount).
      */}
          {/* В базе знаний выбора клуба нет: базы общие для сети (решение владельца 2026-10-25). */}
          <SidebarFooter
            className={cn(
              "gap-2 border-t border-white/10 p-3 lg:hidden",
              (CLUBS_HIDDEN ||
                railKey === "kb" ||
                railKey === "academy" ||
                railKey === "analytics") &&
                "hidden",
            )}
          >
            <StudioSwitcher triggerClassName="w-full border-white/15 bg-white/5 text-white focus-visible:bg-white/10 [&>svg]:text-white" />
          </SidebarFooter>
        </div>
      </div>
    </Sidebar>
  );
}
