/**
 * Иконки баз знаний — из того же набора Solar, что рейка и меню
 * (components/nav-icons.tsx). В базе хранится ключ (kb_bases.icon);
 * незнакомый ключ — иконка по умолчанию.
 */
import {
  Alarm,
  Bag3,
  Bell,
  BillList,
  Book,
  Book2,
  BookBookmark,
  CalendarMinimalistic,
  Card,
  Case,
  ChatRoundDots,
  ClipboardCheck,
  ClipboardList,
  Crown,
  CupStar,
  Diploma,
  Documents,
  Dumbbell,
  Fire,
  Flag,
  Folder,
  FolderOpen,
  Gift,
  GraphUp,
  HandHeart,
  Heart,
  HomeSmile,
  Letter,
  Lightbulb,
  MapPoint,
  MoneyBag,
  Notebook,
  PhoneCallingRounded,
  Rocket,
  Settings,
  ShieldCheck,
  Smartphone,
  SquareAcademicCap,
  StarShine,
  TagPrice,
  Target,
  TicketSale,
  UserId,
  UsersGroupRounded,
  WalletMoney,
  type NavIcon,
} from "@/components/nav-icons";

export const KB_ICONS: { key: string; label: string; icon: NavIcon }[] = [
  { key: "notebook", label: "Блокнот", icon: Notebook },
  { key: "book", label: "Книга", icon: Book },
  { key: "book2", label: "Книга с закладкой", icon: Book2 },
  { key: "book-bookmark", label: "Справочник", icon: BookBookmark },
  { key: "academic", label: "Обучение", icon: SquareAcademicCap },
  { key: "diploma", label: "Диплом", icon: Diploma },
  { key: "documents", label: "Документы", icon: Documents },
  { key: "case", label: "Бизнес", icon: Case },
  { key: "money", label: "Финансы", icon: MoneyBag },
  { key: "users", label: "Команда", icon: UsersGroupRounded },
  { key: "chat", label: "Общение", icon: ChatRoundDots },
  { key: "dumbbell", label: "Тренировки", icon: Dumbbell },
  { key: "hand-heart", label: "Сервис", icon: HandHeart },
  { key: "heart", label: "Забота", icon: Heart },
  { key: "lightbulb", label: "Идеи", icon: Lightbulb },
  { key: "target", label: "Цели", icon: Target },
  { key: "rocket", label: "Запуск", icon: Rocket },
  { key: "flag", label: "Стандарты", icon: Flag },
  { key: "crown", label: "Франшиза", icon: Crown },
  { key: "star", label: "Звезда", icon: StarShine },
  { key: "shield", label: "Правила", icon: ShieldCheck },
];

export const KB_DEFAULT_ICON = "notebook";

export function kbIcon(key: string | null | undefined): NavIcon {
  return (KB_ICONS.find((i) => i.key === key) ?? KB_ICONS[0]).icon;
}

/**
 * Иконки разделов базы (папок верхнего уровня, kb_nodes.icon): «Папка» —
 * по умолчанию (null в базе), дальше — иконки баз и рабочие темы студии.
 */
export const KB_SECTION_ICONS: { key: string; label: string; icon: NavIcon }[] = [
  { key: "folder", label: "Папка", icon: Folder },
  ...KB_ICONS,
  { key: "home", label: "Студия", icon: HomeSmile },
  { key: "calendar", label: "Расписание", icon: CalendarMinimalistic },
  { key: "alarm", label: "Время, смены", icon: Alarm },
  { key: "clipboard-check", label: "Чек-лист", icon: ClipboardCheck },
  { key: "clipboard-list", label: "Регламент", icon: ClipboardList },
  { key: "bill", label: "Отчёты", icon: BillList },
  { key: "wallet", label: "Касса", icon: WalletMoney },
  { key: "card", label: "Оплата", icon: Card },
  { key: "ticket", label: "Абонементы", icon: TicketSale },
  { key: "tag", label: "Цены", icon: TagPrice },
  { key: "bag", label: "Продажи", icon: Bag3 },
  { key: "graph", label: "Рост, показатели", icon: GraphUp },
  { key: "phone", label: "Звонки", icon: PhoneCallingRounded },
  { key: "letter", label: "Письма", icon: Letter },
  { key: "bell", label: "Уведомления", icon: Bell },
  { key: "smartphone", label: "Приложение", icon: Smartphone },
  { key: "user-id", label: "Сотрудники", icon: UserId },
  { key: "gift", label: "Подарки, акции", icon: Gift },
  { key: "cup", label: "Достижения", icon: CupStar },
  { key: "fire", label: "Важное", icon: Fire },
  { key: "map", label: "Адреса", icon: MapPoint },
  { key: "settings", label: "Настройки", icon: Settings },
];

export const KB_SECTION_DEFAULT_ICON = "folder";

/** Иконка раздела; без своей — папка (раскрытая — открытая папка). */
export function kbSectionIcon(key: string | null | undefined, open = false): NavIcon {
  const found = KB_SECTION_ICONS.find((i) => i.key === key && i.key !== KB_SECTION_DEFAULT_ICON);
  return found ? found.icon : open ? FolderOpen : Folder;
}
