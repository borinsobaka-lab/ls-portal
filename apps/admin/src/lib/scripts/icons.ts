/**
 * Иконки разделов «Скриптов LS» в меню — ключи те же, что в «Аудиоаналитике»
 * (scripts_sections.icon), картинки — Solar из nav-icons.
 */
import {
  Alarm,
  Bell,
  CalendarAdd,
  ChatRoundDots,
  ChatRoundLine,
  ClipboardList,
  CupStar,
  DocumentText,
  DumbbellSmall,
  Fire,
  Gift,
  HandHeart,
  HashtagCircle,
  Letter,
  MapPoint,
  PhoneCallingRounded,
  QuestionCircle,
  ShieldCheck,
  StarShine,
  TagPrice,
  WalletMoney,
  type NavIcon,
} from "@/components/nav-icons";

export const SECTION_ICONS: { key: string; label: string; Icon: NavIcon }[] = [
  { key: "calendar-add", label: "Запись", Icon: CalendarAdd },
  { key: "chat-round-dots", label: "Переписка", Icon: ChatRoundDots },
  { key: "chat-round-line", label: "Сообщение", Icon: ChatRoundLine },
  { key: "alarm", label: "Напоминание", Icon: Alarm },
  { key: "bell", label: "Уведомление", Icon: Bell },
  { key: "hand-heart", label: "Забота", Icon: HandHeart },
  { key: "question-circle", label: "Вопросы", Icon: QuestionCircle },
  { key: "shield-check", label: "Возражения", Icon: ShieldCheck },
  { key: "hashtag-circle", label: "Соцсети", Icon: HashtagCircle },
  { key: "phone-calling-rounded", label: "Звонок", Icon: PhoneCallingRounded },
  { key: "wallet-money", label: "Оплата", Icon: WalletMoney },
  { key: "tag-price", label: "Цены", Icon: TagPrice },
  { key: "gift", label: "Подарок", Icon: Gift },
  { key: "fire", label: "Акция", Icon: Fire },
  { key: "star-shine", label: "Отзывы", Icon: StarShine },
  { key: "cup-star", label: "Достижения", Icon: CupStar },
  { key: "dumbbell-small", label: "Тренировки", Icon: DumbbellSmall },
  { key: "map-point", label: "Адрес", Icon: MapPoint },
  { key: "letter", label: "Письмо", Icon: Letter },
  { key: "clipboard-list", label: "Задачи", Icon: ClipboardList },
  { key: "document-text", label: "Документ", Icon: DocumentText },
];

export const DEFAULT_SECTION_ICON = "document-text";
export const CALL_SECTION_ICON = "phone-calling-rounded";

/** Иконка по ключу; неизвестный (убрали из набора) — по умолчанию. */
export function sectionIcon(key: string | undefined): NavIcon {
  return (
    SECTION_ICONS.find((i) => i.key === key)?.Icon ??
    SECTION_ICONS.find((i) => i.key === DEFAULT_SECTION_ICON)!.Icon
  );
}
