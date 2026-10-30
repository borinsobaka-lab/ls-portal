/**
 * Разделы рейки (components/app-rail.tsx), меню клуба и меню раздела
 * «Мобильное приложение» — отдельно от компонентов: их читают рейка, боковое
 * меню, guard роутов и форма «Доступов».
 */
// Те же Solar-иконки, что у пунктов меню: Outline, у активного раздела BoldDuotone.
import {
  Bag3,
  Book,
  Book2,
  BellBing,
  BillList,
  Bolt,
  Buildings2,
  CalendarMinimalistic,
  Card,
  Chart2,
  ChartSquare,
  City,
  ChatRoundDots,
  ClipboardCheck,
  ClipboardList,
  ClipboardRemove,
  CupStar,
  DocumentText,
  Dumbbell,
  Flag,
  GraphNewUp,
  GraphUp,
  HandHeart,
  HandShake,
  History,
  HomeSmile,
  MapPoint,
  MoneyBag,
  Notebook,
  PieChart2,
  Refresh,
  Settings,
  ShieldUser,
  Smartphone,
  SquareAcademicCap,
  StarsMinimalistic,
  Structure,
  TagPrice,
  Target,
  TicketSale,
  UploadMinimalistic,
  UserId,
  UsersGroupRounded,
  WalletMoney,
  Widget3,
  Widget5,
  type NavIcon,
} from "@/components/nav-icons";
import {
  canOpenClubSection,
  canOpenRail,
  dashboardStudioIds,
  type AdminAccess,
  type ClubSectionKey,
} from "@/lib/admin-access";
import type { AccessRight } from "@/lib/access/logic";
import { anCan, type AnNeed } from "@/lib/analytics/access";
import { DASHBOARD_TITLES } from "@/lib/dashboard-stats";
import { HIDDEN_MANAGE_URLS, HIDDEN_RAIL_SECTIONS } from "@/lib/launch";
import type { StudioFormat } from "@/lib/studio-formats";

export type RailSectionKey =
  | "dashboard"
  | "analytics"
  | "club"
  | "app"
  | "scripts"
  | "kb"
  | "academy"
  | "manage";

export type RailSection = {
  key: RailSectionKey;
  /**
   * Подпись в рейке. В строку помещается слово до ~7 букв; длинное
   * переносится по мягкому дефису (\u00AD) на вторую строку.
   */
  title: string;
  /** Полное название — подсказка при наведении и для скринридера. */
  fullTitle?: string;
  url?: string;
  icon: NavIcon;
  /** Страницы раздела, кроме самого url (у раздела со своим меню). */
  paths?: string[];
};

export type NavItem = {
  title: string;
  url: string;
  icon: NavIcon;
  /**
   * Только для студий этих форматов (STUDIO_FORMATS.md). Без поля — пункт
   * общий. Пока студия не загружена, показываются только общие пункты.
   */
  formats?: StudioFormat[];
  /** Подсвечивать только на самом url, не на вложенных страницах. */
  exact?: boolean;
  /** Другие страницы пункта: на них он тоже подсвечен («Сотрудники» → вкладки). */
  paths?: string[];
  /** Счётчик справа (новые предложения в «Скриптах LS», не отработанная обратная связь). */
  badge?: number;
};
export type ClubNavItem = NavItem & {
  /** Ключ раздела в правах сотрудника («Доступы», lib/admin-access.ts). */
  section: ClubSectionKey;
  /** Полное название, если в меню сокращено (форма «Доступов»). */
  fullTitle?: string;
};
export type NavGroup<T extends NavItem = NavItem> = { key: string; label: string; items: T[] };

/** «Заявки» клиентов — на пункте и на «Клубе» в рейке горит счётчик. */
export const REQUESTS_URL = "/requests";

/**
 * Меню клуба (раздел рейки «Клуб»). Каждый пункт — раздел, который
 * открывается сотруднику отдельно в каждой студии («Доступы»).
 */
export const CLUB_GROUPS: NavGroup<ClubNavItem>[] = [
  {
    key: "workspace",
    label: "Главное",
    items: [
      { title: "Расписание", url: "/schedule", icon: CalendarMinimalistic, section: "schedule" },
      { title: "Клиенты", url: "/clients", icon: UsersGroupRounded, section: "clients" },
      // Пакетные студии: продажи абонементов, возвраты и сбор денег по
      // рассрочкам — «Продаж» у них нет (решение владельца 2026-10-13).
      {
        title: "Абонементы",
        url: "/client-memberships",
        icon: Card,
        section: "client-memberships",
        formats: ["packages"],
      },
    ],
  },
  {
    key: "stats",
    label: "Статистика",
    items: [
      {
        title: "Продажи",
        url: "/sales",
        icon: BillList,
        section: "sales",
        // В пакетных клубах продажи — в «Абонементах».
        formats: ["subscription"],
      },
      { title: "Прочие продажи", url: "/other-sales", icon: Bag3, section: "other-sales" },
      { title: "История записей", url: "/bookings-log", icon: History, section: "bookings-log" },
      {
        title: "Отмены автопр.",
        fullTitle: "Отмены автопродления",
        url: "/autorenew-cancellations",
        icon: ClipboardRemove,
        section: "autorenew-cancellations",
        // У пакетов тренировок автопродления нет.
        formats: ["subscription"],
      },
    ],
  },
  {
    key: "finance",
    label: "Финансы",
    items: [{ title: "Касса", url: "/cash", icon: WalletMoney, section: "cash" }],
  },
  {
    key: "feedback",
    label: "Обратная связь",
    items: [
      { title: "Обратная связь", url: "/feedback", icon: ChatRoundDots, section: "feedback" },
      // Заявки из приложения пакетных клубов: персональные и диагностика
      // (2026-10-15). Счётчик неотработанных — useOpenRequestsCount.
      {
        title: "Заявки",
        url: REQUESTS_URL,
        icon: ClipboardList,
        section: "requests",
        formats: ["packages"],
      },
      { title: "NPS-опросы", url: "/nps", icon: ChartSquare, section: "nps" },
    ],
  },
  {
    key: "studio",
    label: "Клуб",
    items: [
      { title: "Тренировки", url: "/workouts", icon: Dumbbell, section: "workouts" },
      // Один раздел прав «Номенклатуры», у каждого формата своя страница:
      // подписки с автопродлением / пакеты тренировок.
      {
        title: "Номенклатуры",
        url: "/memberships",
        icon: TagPrice,
        section: "memberships",
        formats: ["subscription"],
      },
      {
        title: "Номенклатуры",
        url: "/packages",
        icon: TagPrice,
        section: "memberships",
        formats: ["packages"],
      },
      { title: "Промокоды", url: "/promocodes", icon: TicketSale, section: "promocodes" },
    ],
  },
];

/**
 * Дашборд — раздел рейки над «Клубом»: на одной странице показатели всех
 * студий сотрудника по очереди. Право на него по-прежнему отмечается в
 * каждой студии (ключ dashboard в разделах клуба): студия попадает на
 * дашборд, только если он ей открыт.
 */
export const DASHBOARD_ITEM: ClubNavItem = {
  title: "Дашборд",
  url: "/dashboard",
  icon: Widget5,
  section: "dashboard",
};

/**
 * Меню раздела «Дашборд»: подразделы показателей. Как и сам дашборд, они
 * над клубами — на каждой странице все клубы сотрудника, где открыт дашборд.
 */
export const DASHBOARD_ITEMS: NavItem[] = [
  { title: DASHBOARD_TITLES.overview, url: DASHBOARD_ITEM.url, icon: PieChart2, exact: true },
  { title: DASHBOARD_TITLES.sales, url: "/dashboard/sales", icon: GraphUp },
  { title: DASHBOARD_TITLES.clients, url: "/dashboard/clients", icon: UsersGroupRounded },
  { title: DASHBOARD_TITLES.classes, url: "/dashboard/classes", icon: Dumbbell },
  { title: DASHBOARD_TITLES.marketing, url: "/dashboard/marketing", icon: Target },
];

/**
 * «Аналитика» (решения владельца 2026-10-29, ANALYTICS_PLAN.md) — перенос
 * портала аналитики Lady Stretch (analytics.lady-stretching.ru): отчёты 1С и
 * FitBase, маркетинг (amoCRM, VK Ads, Авито), отзывы, контент, диалоги VK,
 * инструменты (обработка 1С, очистка Excel). Меню — группы, пункт открыт по
 * своему праву (`need`, lib/analytics/access.ts: их allowed_dashboards).
 * Модули добавляются сюда по мере переноса.
 */
export const ANALYTICS_URL = "/analytics";
export type AnalyticsNavItem = NavItem & { need: AnNeed };
export const ANALYTICS_GROUPS: NavGroup<AnalyticsNavItem>[] = [
  {
    key: "an-home",
    label: "Аналитика",
    items: [{ title: "Главная", url: ANALYTICS_URL, icon: HomeSmile, exact: true, need: "home" }],
  },
  {
    key: "an-onec",
    label: "1С · Lady Stretch",
    items: [
      { title: "Мой город", url: "/analytics/onec/mycity", icon: MapPoint, need: "onec.mycity" },
      { title: "Выручка", url: "/analytics/onec/revenue", icon: WalletMoney, need: "onec.revenue" },
      {
        title: "Продажи абонементов",
        url: "/analytics/onec/sales",
        icon: TicketSale,
        need: "onec.sales",
      },
      { title: "Занятия", url: "/analytics/onec/activities", icon: Dumbbell, need: "onec.classes" },
      {
        title: "Воронка пробных",
        url: "/analytics/onec/funnel",
        icon: Target,
        need: "onec.trials",
      },
      {
        title: "Нулевая номенклатура",
        url: "/analytics/onec/zero",
        icon: TagPrice,
        need: "onec.zero",
      },
    ],
  },
  {
    key: "an-tools",
    label: "Инструменты",
    items: [
      {
        title: "Обработка 1С",
        url: "/analytics/tools/onec",
        icon: UploadMinimalistic,
        need: "admin",
      },
    ],
  },
  {
    key: "an-admin",
    label: "Администрирование",
    items: [
      {
        title: "Фоновые задачи",
        url: "/analytics/admin/jobs",
        icon: Refresh,
        need: "admin",
      },
    ],
  },
];
const ANALYTICS_NAV = ANALYTICS_GROUPS.flatMap((g) => g.items);
const ANALYTICS_PATHS = ANALYTICS_NAV.map((i) => i.url);

/** Пункт меню «Аналитики», которому принадлежит страница (самый длинный адрес). */
export function analyticsNavItemOf(pathname: string): AnalyticsNavItem | null {
  return (
    ANALYTICS_NAV.filter((i) => (i.exact ? pathname === i.url : matches(pathname, i.url))).sort(
      (a, b) => b.url.length - a.url.length,
    )[0] ?? null
  );
}

/** Разделы студии в форме «Доступов»: дашборд и меню клуба. */
export const STUDIO_SECTION_GROUPS: NavGroup<ClubNavItem>[] = [
  { key: "dashboard", label: "Дашборд", items: [DASHBOARD_ITEM] },
  ...CLUB_GROUPS,
];

/**
 * Меню раздела «Мобильное приложение»: приложение общее для всех студий,
 * поэтому раздел — в рейке, а не в меню клуба. Боковое меню показывает эти
 * пункты вместо пунктов клуба.
 */
export const MOBILE_APP_ITEMS: NavItem[] = [
  { title: "Новости", url: "/news", icon: DocumentText },
  { title: "Услуги", url: "/services", icon: StarsMinimalistic },
  { title: "Пуш-уведомления", url: "/push", icon: BellBing },
  { title: "Триггеры", url: "/push-triggers", icon: Bolt },
  // Ссылки кнопок главного экрана и срок отмены записи (club_settings).
  { title: "Контакты и правила", url: "/club-settings", icon: ClipboardCheck },
  // История бренда в приложении пакетных клубов: фото, цифры, Instagram.
  { title: "О нас", url: "/app-about", icon: HandHeart },
  // Установка приложения: иконка и подпись под значком (PWA).
  { title: "Настройки", url: "/app-settings", icon: Settings },
];

/**
 * «Сотрудники» (решение владельца 2026-10-13: раньше — свой раздел рейки) —
 * пункт блока «Клуб» в меню клуба; страницы раздела переключаются вкладками
 * над содержимым (components/staff-tabs.tsx), `tab` — подпись вкладки.
 * Справочник общий для всех клубов: при смене клуба в шапке он тот же. Право —
 * по-прежнему раздел рейки «Сотрудники» в «Доступах» (staff, RLS
 * has_admin_section), а не раздел клуба по студиям.
 */
export const STAFF_ITEMS: (NavItem & { tab: string })[] = [
  { title: "Сотрудники", tab: "Сотрудники", url: "/trainers", icon: UserId },
  { title: "Зарплаты", tab: "Зарплаты", url: "/payroll", icon: WalletMoney },
  {
    title: "График администраторов",
    tab: "График",
    url: "/admin-shifts",
    icon: CalendarMinimalistic,
  },
  { title: "Зарплатные ставки", tab: "Ставки", url: "/pay-rates", icon: MoneyBag },
];

/** Блок меню клуба, где стоит «Сотрудники». */
export const STAFF_CLUB_GROUP = "studio";

/** Пункт «Сотрудники» в меню клуба: подсвечен на всех страницах раздела. */
export const STAFF_NAV_ITEM: NavItem = {
  title: "Сотрудники",
  url: STAFF_ITEMS[0].url,
  icon: UserId,
  paths: STAFF_ITEMS.slice(1).map((i) => i.url),
};

/** «Скрипты LS»: все скрипты; разделы — /scripts/<id>, настройки — /scripts/settings. */
export const SCRIPTS_URL = "/scripts";
export const SCRIPTS_SETTINGS_URL = "/scripts/settings";

/**
 * Базы знаний (db/migrations/2026-10-24_knowledge_base.sql): раздел рейки
 * «База знаний» один на все базы (решение владельца 2026-10-25), базы
 * переключаются вкладками в шапке (components/kb/kb-header.tsx), меню —
 * дерево открытой базы (AppSidebar). /kb — переход в последнюю открытую
 * базу, /kb/<база>/… — база. Заводят базы и меняют их порядок в
 * «Управлении» → «Знания» (KB_BASES_URL).
 */
export const KB_URL = "/kb";
export const KB_BASES_URL = "/kb-bases";

/** База знаний страницы (/kb/<id>/…); null — не страница базы. */
export function kbBaseIdOf(pathname: string): string | null {
  const m = /^\/kb\/([0-9a-f-]{36})(?:\/|$)/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * Служебные страницы базы — «Аналитика», «Шаблоны», «Корзина» (решение
 * владельца 2026-10-26): на канве, как остальной портал (плашки, таблицы и
 * плитки — белые на светло-сером). Белая рабочая область — только у
 * главной базы, папок и статей: там читают.
 */
export function isKbToolPath(pathname: string): boolean {
  return /^\/kb\/[0-9a-f-]{36}\/(analytics|templates|trash)\/?$/.test(pathname);
}

/**
 * «Академия» (решение владельца 2026-10-25) — курсы, тесты и проверка
 * тренером, отдельный раздел рейки со своим меню и настройками (не часть
 * базы знаний). Пункт меню открыт по праву: any — всем, у кого раздел виден
 * (назначен курс или есть права), team — создателям и проверяющим, create —
 * «Создаёт курсы», review — «Проверяет ответы»; владельцу — всё.
 */
export const ACADEMY_URL = "/academy";
export type AcademyNeed = "any" | "team" | "create" | "review";
export const ACADEMY_ITEMS: (NavItem & { need: AcademyNeed })[] = [
  {
    title: "Мои курсы",
    url: ACADEMY_URL,
    icon: SquareAcademicCap,
    exact: true,
    paths: ["/academy/my", "/academy/attempts"],
    need: "any",
  },
  { title: "Курсы", url: "/academy/courses", icon: Book2, need: "team" },
  { title: "Проверка", url: "/academy/review", icon: ClipboardCheck, need: "review" },
  { title: "Отчёт", url: "/academy/report", icon: ChartSquare, need: "team" },
  { title: "Настройки", url: "/academy/settings", icon: Settings, need: "create" },
];

/** Какое право нужно странице «Академии». */
export function academyNeed(pathname: string): AcademyNeed {
  const item = ACADEMY_ITEMS.filter((i) => i.url !== ACADEMY_URL).find(
    (i) => pathname === i.url || pathname.startsWith(`${i.url}/`),
  );
  return item?.need ?? "any";
}

/** Есть ли у сотрудника нужное право в «Академии». */
export function hasAcademyRight(access: AdminAccess, need: AcademyNeed): boolean {
  const a = access.academy;
  if (!a) return false;
  if (a.is_admin) return true;
  if (need === "create") return a.can_create;
  if (need === "review") return a.can_review;
  if (need === "team") return a.can_create || a.can_review;
  return a.can_create || a.can_review || a.my_courses > 0;
}

/**
 * Все разделы рейки — и скрытые на первом этапе (lib/launch.ts): по ним
 * railSectionKey узнаёт раздел страницы. Раздел без url — заготовка: виден
 * в рейке, но не нажимается.
 */
const ALL_SECTIONS: RailSection[] = [
  // Над студиями: своё меню — подразделы дашборда.
  {
    key: "dashboard",
    title: "Дашборд",
    url: DASHBOARD_ITEM.url,
    icon: Widget5,
    paths: DASHBOARD_ITEMS.map((i) => i.url),
  },
  // Вход в клуб — первая страница его меню; закрытую в активной студии
  // AccessGate сменит на первую доступную. «Сотрудники» — тоже в меню клуба.
  { key: "club", title: "Клуб", url: CLUB_GROUPS[0].items[0].url, icon: HomeSmile },
  {
    key: "app",
    title: "Прило\u00ADжение",
    fullTitle: "Мобильное приложение",
    url: MOBILE_APP_ITEMS[0].url,
    icon: Smartphone,
    paths: MOBILE_APP_ITEMS.map((i) => i.url),
  },
  // Скрипты администраторов Lady Stretch: меню раздела — его разделы
  // (они в базе, поэтому меню собирает AppSidebar), плюс «Настройки».
  {
    key: "scripts",
    title: "Скрипты LS",
    fullTitle: "Скрипты LS — скрипты клубов Lady Stretch",
    url: SCRIPTS_URL,
    icon: Notebook,
  },
  // Все базы знаний сотрудника — одним разделом; меню — дерево открытой базы.
  { key: "kb", title: "База знаний", url: KB_URL, icon: Book },
  {
    key: "academy",
    title: "Акаде\u00ADмия",
    fullTitle: "Академия — курсы и тесты",
    url: ACADEMY_URL,
    icon: SquareAcademicCap,
    paths: ACADEMY_ITEMS.slice(1).map((i) => i.url),
  },
  // Перенос портала аналитики Lady Stretch — в конце рейки (решение
  // владельца 2026-10-26).
  {
    key: "analytics",
    title: "Анали\u00ADтика",
    fullTitle: "Аналитика — отчёты сети Lady Stretch",
    url: ANALYTICS_URL,
    icon: Chart2,
    paths: ANALYTICS_PATHS.slice(1),
  },
];

/** Разделы в рейке — без скрытых (lib/launch.ts). */
export const SECTIONS: RailSection[] = ALL_SECTIONS.filter((s) => !HIDDEN_RAIL_SECTIONS.has(s.key));

/**
 * «Управление» внизу рейки (решение владельца 2026-10-25: вместо трёх
 * разделов «Знания», «Доступы», «Клубы») — настройки над студиями; их
 * блоки — в меню раздела. Пункт открыт по сетевому праву (canOpenManagePath):
 * «Знания» — администратору баз знаний, «Пользователи и роли» (2026-10-25,
 * ACCESS.md) — тем, кто управляет людьми, ролями или структурой.
 */
export const ACCESS_URL = "/access";
export const ACCESS_ITEMS: NavItem[] = [
  {
    title: "Пользователи",
    url: ACCESS_URL,
    icon: UsersGroupRounded,
    exact: true,
    paths: ["/access/users"],
  },
  { title: "Роли", url: "/access/roles", icon: ShieldUser },
  { title: "Оргструктура", url: "/access/structure", icon: Structure },
  { title: "Журнал", url: "/access/log", icon: History },
  // Перенос клиентов из 1С (2026-10-18) — владельцу клуба.
  { title: "Импорт из 1С", url: "/import-1c", icon: ClipboardList },
];
export const STUDIOS_ITEMS: NavItem[] = [{ title: "Настройки", url: "/studios", icon: Widget3 }];
// Пункты клубов («Клубы», «Импорт из 1С») пока скрыты — lib/launch.ts: клубы
// ведут в «Оргструктуре» → «Сеть клубов».
export const MANAGE_GROUPS: NavGroup[] = [
  {
    key: "manage-kb",
    label: "Знания",
    items: [{ title: "Базы знаний", url: KB_BASES_URL, icon: Book }],
  },
  { key: "manage-access", label: "Пользователи и роли", items: ACCESS_ITEMS },
  { key: "manage-studios", label: "Клубы", items: STUDIOS_ITEMS },
]
  .map((g) => ({ ...g, items: g.items.filter((i) => !HIDDEN_MANAGE_URLS.has(i.url)) }))
  .filter((g) => g.items.length > 0);
const MANAGE_URLS = MANAGE_GROUPS.flatMap((g) => g.items.map((i) => i.url));

/** Внизу рейки. url — первая страница; AppRail ведёт на первую открытую. */
export const ADMIN_SECTIONS: RailSection[] = [
  {
    key: "manage",
    title: "Управ\u00ADление",
    fullTitle: "Управление",
    url: MANAGE_URLS[0],
    paths: MANAGE_URLS.slice(1),
    icon: Settings,
  },
];

const matches = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

/** Раздел страницы: свои страницы у разделов рейки, всё остальное — «Клуб». */
export function railSectionKey(pathname: string): RailSectionKey {
  const own = [...ALL_SECTIONS, ...ADMIN_SECTIONS].find(
    (s) =>
      s.key !== "club" &&
      [s.url, ...(s.paths ?? [])].some((path) => path && matches(pathname, path)),
  );
  return own?.key ?? "club";
}

/** Страница раздела «Сотрудники» (пункт меню клуба с правом раздела рейки). */
export function isStaffPath(pathname: string): boolean {
  return STAFF_ITEMS.some((i) => matches(pathname, i.url));
}

/** Пункт меню клуба, которому принадлежит страница (null — не пункт меню). */
export function clubNavItemOf(pathname: string): ClubNavItem | null {
  for (const group of CLUB_GROUPS) {
    const item = group.items.find((i) => matches(pathname, i.url));
    if (item) return item;
  }
  return null;
}

/**
 * Можно ли сотруднику открыть страницу. Это только интерфейс (меню и
 * guard в _authenticated/route.tsx): данные студии ограничивает RLS, разделы
 * рейки — ещё и has_admin_section в RLS.
 */
export function canOpenPath(
  access: AdminAccess,
  studioId: string | null,
  pathname: string,
): boolean {
  const section = railSectionKey(pathname);
  // Скрытые на первом этапе разделы закрыты всем (lib/launch.ts).
  if (HIDDEN_RAIL_SECTIONS.has(section)) return false;
  if (section === "manage") return canOpenManagePath(access, pathname);
  if (section === "kb") {
    const baseId = kbBaseIdOf(pathname);
    if (!baseId) return access.kbAdmin || Object.keys(access.kb ?? {}).length > 0;
    return access.kbAdmin || !!access.kb?.[baseId];
  }
  if (section === "academy") return hasAcademyRight(access, academyNeed(pathname));
  // Дашборд над студиями: открыт, если открыт хоть в одной студии.
  if (section === "dashboard") return dashboardStudioIds(access).length > 0;
  if (section === "analytics")
    return anCan(access.analytics, analyticsNavItemOf(pathname)?.need ?? "home");
  if (section === "app" || section === "scripts") return canOpenRail(access, section);
  if (section === "club") {
    // «Сотрудники» общие для клубов: право — раздел рейки, не раздел клуба.
    if (isStaffPath(pathname)) return canOpenRail(access, "staff");
    const item = clubNavItemOf(pathname);
    return item ? canOpenClubSection(access, studioId, item.section) : canOpenRail(access, "club");
  }
  return true;
}

/**
 * Страница «Управления»: «Клубы» — всем (список и свои настройки), «Знания» —
 * администратору баз знаний, импорт из 1С — владельцу клуба, «Пользователи и
 * роли» — по правам: люди — управляющим пользователями (и тем, кто ведёт роли
 * или журнал — для просмотра), роли и структура — им же, журнал — audit.view
 * или roles.manage.
 */
export function canOpenManagePath(access: AdminAccess, pathname: string): boolean {
  const any = (...rights: AccessRight[]) => rights.some((r) => access.rights.includes(r));
  if ([...HIDDEN_MANAGE_URLS].some((url) => matches(pathname, url))) return false;
  if (STUDIOS_ITEMS.some((i) => matches(pathname, i.url))) return true;
  if (matches(pathname, KB_BASES_URL)) return access.kbAdmin;
  if (matches(pathname, "/import-1c")) return Object.values(access.studios).some((s) => s.owner);
  if (matches(pathname, "/access/log")) return any("audit.view", "roles.manage");
  if (matches(pathname, "/access/structure"))
    return any("structure.manage", "users.manage", "roles.manage", "audit.view");
  if (matches(pathname, ACCESS_URL))
    return any("users.manage", "roles.manage", "audit.view", "structure.manage");
  return false;
}

/** Первая страница, которую сотруднику можно открыть (null — ни одной). */
export function firstAllowedUrl(access: AdminAccess, studioId: string | null): string | null {
  // Сначала страницы клуба: «Клуб» в рейке ведёт на первую из них, и при
  // закрытой должен попасть на другую страницу клуба, а не на дашборд.
  const urls = [
    ...CLUB_GROUPS.flatMap((g) => g.items.map((i) => i.url)),
    STAFF_NAV_ITEM.url,
    ...SECTIONS.flatMap((s) => (s.url && s.key !== "club" ? [s.url] : [])),
    ...MANAGE_URLS,
  ];
  return urls.find((url) => canOpenPath(access, studioId, url)) ?? null;
}
