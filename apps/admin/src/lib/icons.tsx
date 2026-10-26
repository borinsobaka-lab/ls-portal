/**
 * Иконки Hugeicons под именами lucide-react.
 *
 * Alias в vite.config превращает каждый `from "lucide-react"` в этот файл,
 * поэтому имена в компонентах менять не пришлось — включая вендоренные
 * components/ui/*, которые лучше держать близко к upstream shadcn.
 *
 * Hugeicons именует иконки по-своему (Search01Icon, Delete02Icon), но заодно
 * отдаёт псевдонимы под именами lucide — по ним и импортируем. Часть
 * псевдонимов оказались неточными (AlertTriangle рисовался кружком,
 * RefreshCwOff не отличался от RefreshCw, Send был конвертом) — для них
 * иконка выбрана вручную, см. MANUAL в scripts/gen-icons.ts.
 *
 * Импортируем поимённо, а не через `import * as`: иначе в бандл уезжает весь
 * пакет — на Solar так и вышло, лишние 482 kB.
 *
 * Файл сгенерирован scripts/gen-icons.ts; добавляя иконку, дописывай импорт и export парой.
 */
import { forwardRef, type SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon as AlertTriangleArt,
  Archive as ArchiveArt,
  ArchiveRestore as ArchiveRestoreArt,
  ArrowDown as ArrowDownArt,
  ArrowLeft as ArrowLeftArt,
  ArrowLeftRight as ArrowLeftRightArt,
  ArrowRight as ArrowRightArt,
  ArrowUp as ArrowUpArt,
  ArrowUpDown as ArrowUpDownArt,
  ArrowUpRight as ArrowUpRightArt,
  BanIcon as BanArt,
  Banknote as BanknoteArt,
  Bold as BoldArt,
  Building2 as Building2Art,
  CalendarIcon as CalendarIconArt,
  CatIcon as CatArt,
  ChartAreaIcon as ChartAreaArt,
  ChartColumnIcon as ChartColumnArt,
  ChartLineIcon as ChartLineArt,
  Check as CheckArt,
  CheckCircle as CheckCircle2Art,
  CheckIcon as CheckIconArt,
  ChevronDown as ChevronDownArt,
  ChevronDownIcon as ChevronDownIconArt,
  ChevronLeft as ChevronLeftArt,
  ChevronLeftIcon as ChevronLeftIconArt,
  ChevronRight as ChevronRightArt,
  ChevronRightIcon as ChevronRightIconArt,
  ChevronUp as ChevronUpArt,
  ChevronUpIcon as ChevronUpIconArt,
  ChevronsLeft as ChevronsLeftArt,
  ChevronsRight as ChevronsRightArt,
  Circle as CircleArt,
  Clapperboard as ClapperboardArt,
  ClipboardList as ClipboardListArt,
  Clock as ClockArt,
  CloudOff as CloudOffArt,
  Code as CodeArt,
  Columns2 as Columns2Art,
  Columns3 as Columns3Art,
  Copy as CopyArt,
  CreditCard as CreditCardArt,
  Database as DatabaseArt,
  Download as DownloadArt,
  Ellipsis as EllipsisArt,
  Eraser as EraserArt,
  ExternalLink as ExternalLinkArt,
  Eye as EyeArt,
  FilePlus as FilePlusArt,
  FileText as FileTextArt,
  FileUp as FileUpArt,
  FlaskConical as FlaskConicalArt,
  FolderTransferIcon as FolderInputArt,
  FolderPlus as FolderPlusArt,
  Frown as FrownArt,
  GraduationCap as GraduationCapArt,
  DragDropVerticalIcon as GripVerticalArt,
  Hash as HashArt,
  Heading2 as Heading2Art,
  HelpCircleIcon as HelpCircleArt,
  History as HistoryArt,
  Hourglass as HourglassArt,
  ImageIcon as ImageIconArt,
  ImagePlus as ImagePlusArt,
  Images as ImagesArt,
  Info as InfoArt,
  Italic as ItalicArt,
  LayoutTemplate as LayoutTemplateArt,
  Link as LinkArt,
  Link2 as Link2Art,
  List as ListArt,
  ListOrdered as ListOrderedArt,
  LoaderCircle as Loader2Art,
  Lock as LockArt,
  LogIn as LogInArt,
  MapPin as MapPinArt,
  ArrowExpandIcon as MaximizeArt,
  Meh as MehArt,
  MessageCircle as MessageCircleArt,
  MessageCirclePlus as MessageCirclePlusArt,
  MessageSquare as MessageSquareArt,
  Mic as MicArt,
  ArrowShrinkIcon as MinimizeArt,
  Minus as MinusArt,
  MonitorPlay as MonitorPlayArt,
  Moon as MoonArt,
  Music as MusicArt,
  PanelLeft as PanelLeftArt,
  Paperclip as PaperclipArt,
  Pencil as PencilArt,
  Phone as PhoneArt,
  Play as PlayArt,
  Plus as PlusArt,
  QrCode as QrCodeArt,
  Receipt as ReceiptArt,
  RefreshCw as RefreshCwArt,
  Repeat as RepeatArt,
  RotateCcw as RotateCcwArt,
  Ruler as RulerArt,
  Save as SaveArt,
  Search as SearchArt,
  SentIcon as SendArt,
  Settings2 as Settings2Art,
  Shapes as ShapesArt,
  ShieldCheck as ShieldCheckArt,
  ShoppingBag as ShoppingBagArt,
  SlidersHorizontal as SlidersHorizontalArt,
  Smartphone as SmartphoneArt,
  Smile as SmileArt,
  Square as SquareArt,
  Star as StarArt,
  Sun as SunArt,
  Ticket as TicketArt,
  Trash2 as Trash2Art,
  TrendingDown as TrendingDownArt,
  TrendingUp as TrendingUpArt,
  Undo2 as Undo2Art,
  Upload as UploadArt,
  UserArrowLeftRightIcon as UserArrowLeftRightArt,
  UserMinus as UserMinusArt,
  UserPlus as UserPlusArt,
  UserRound as UserRoundArt,
  Users as UsersArt,
  Video as VideoArt,
  VkIcon as VkArt,
  Wallet as WalletArt,
  X as XArt,
  XCircle as XCircleArt,
} from "@hugeicons/core-free-icons";

type LucideProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  color?: string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
};

/** Обёртка, принимающая пропсы в стиле lucide (size / color / strokeWidth). */
function icon(art: IconSvgElement, displayName: string) {
  const Comp = forwardRef<SVGSVGElement, LucideProps>(function Comp(props, ref) {
    return <HugeiconsIcon ref={ref} icon={art} {...props} />;
  });
  Comp.displayName = displayName;
  return Comp;
}

export const AlertTriangle = icon(AlertTriangleArt, "AlertTriangle");
export const Archive = icon(ArchiveArt, "Archive");
export const ArchiveRestore = icon(ArchiveRestoreArt, "ArchiveRestore");
export const ArrowDown = icon(ArrowDownArt, "ArrowDown");
export const ArrowLeft = icon(ArrowLeftArt, "ArrowLeft");
export const ArrowLeftRight = icon(ArrowLeftRightArt, "ArrowLeftRight");
export const ArrowRight = icon(ArrowRightArt, "ArrowRight");
export const ArrowUp = icon(ArrowUpArt, "ArrowUp");
export const ArrowUpDown = icon(ArrowUpDownArt, "ArrowUpDown");
export const ArrowUpRight = icon(ArrowUpRightArt, "ArrowUpRight");
export const Ban = icon(BanArt, "Ban");
export const Banknote = icon(BanknoteArt, "Banknote");
export const Bold = icon(BoldArt, "Bold");
export const Building2 = icon(Building2Art, "Building2");
export const CalendarIcon = icon(CalendarIconArt, "CalendarIcon");
export const Cat = icon(CatArt, "Cat");
export const ChartArea = icon(ChartAreaArt, "ChartArea");
export const ChartColumn = icon(ChartColumnArt, "ChartColumn");
export const ChartLine = icon(ChartLineArt, "ChartLine");
export const Check = icon(CheckArt, "Check");
export const CheckCircle2 = icon(CheckCircle2Art, "CheckCircle2");
export const CheckIcon = icon(CheckIconArt, "CheckIcon");
export const ChevronDown = icon(ChevronDownArt, "ChevronDown");
export const ChevronDownIcon = icon(ChevronDownIconArt, "ChevronDownIcon");
export const ChevronLeft = icon(ChevronLeftArt, "ChevronLeft");
export const ChevronLeftIcon = icon(ChevronLeftIconArt, "ChevronLeftIcon");
export const ChevronRight = icon(ChevronRightArt, "ChevronRight");
export const ChevronRightIcon = icon(ChevronRightIconArt, "ChevronRightIcon");
export const ChevronUp = icon(ChevronUpArt, "ChevronUp");
export const ChevronUpIcon = icon(ChevronUpIconArt, "ChevronUpIcon");
export const ChevronsLeft = icon(ChevronsLeftArt, "ChevronsLeft");
export const ChevronsRight = icon(ChevronsRightArt, "ChevronsRight");
export const Circle = icon(CircleArt, "Circle");
export const Clapperboard = icon(ClapperboardArt, "Clapperboard");
export const ClipboardList = icon(ClipboardListArt, "ClipboardList");
export const Clock = icon(ClockArt, "Clock");
export const CloudOff = icon(CloudOffArt, "CloudOff");
export const Code = icon(CodeArt, "Code");
export const Columns2 = icon(Columns2Art, "Columns2");
export const Columns3 = icon(Columns3Art, "Columns3");
export const Copy = icon(CopyArt, "Copy");
export const CreditCard = icon(CreditCardArt, "CreditCard");
export const Database = icon(DatabaseArt, "Database");
export const Download = icon(DownloadArt, "Download");
export const Ellipsis = icon(EllipsisArt, "Ellipsis");
export const Eraser = icon(EraserArt, "Eraser");
export const ExternalLink = icon(ExternalLinkArt, "ExternalLink");
export const Eye = icon(EyeArt, "Eye");
export const FilePlus = icon(FilePlusArt, "FilePlus");
export const FileText = icon(FileTextArt, "FileText");
export const FileUp = icon(FileUpArt, "FileUp");
export const FlaskConical = icon(FlaskConicalArt, "FlaskConical");
export const FolderInput = icon(FolderInputArt, "FolderInput");
export const FolderPlus = icon(FolderPlusArt, "FolderPlus");
export const Frown = icon(FrownArt, "Frown");
export const GraduationCap = icon(GraduationCapArt, "GraduationCap");
export const GripVertical = icon(GripVerticalArt, "GripVertical");
export const Hash = icon(HashArt, "Hash");
export const Heading2 = icon(Heading2Art, "Heading2");
export const HelpCircle = icon(HelpCircleArt, "HelpCircle");
export const History = icon(HistoryArt, "History");
export const Hourglass = icon(HourglassArt, "Hourglass");
export const ImageIcon = icon(ImageIconArt, "ImageIcon");
export const ImagePlus = icon(ImagePlusArt, "ImagePlus");
export const Images = icon(ImagesArt, "Images");
export const Info = icon(InfoArt, "Info");
export const Italic = icon(ItalicArt, "Italic");
export const LayoutTemplate = icon(LayoutTemplateArt, "LayoutTemplate");
export const Link = icon(LinkArt, "Link");
export const Link2 = icon(Link2Art, "Link2");
export const List = icon(ListArt, "List");
export const ListOrdered = icon(ListOrderedArt, "ListOrdered");
export const Loader2 = icon(Loader2Art, "Loader2");
export const Lock = icon(LockArt, "Lock");
export const LogIn = icon(LogInArt, "LogIn");
export const MapPin = icon(MapPinArt, "MapPin");
export const Maximize = icon(MaximizeArt, "Maximize");
export const Meh = icon(MehArt, "Meh");
export const MessageCircle = icon(MessageCircleArt, "MessageCircle");
export const MessageCirclePlus = icon(MessageCirclePlusArt, "MessageCirclePlus");
export const MessageSquare = icon(MessageSquareArt, "MessageSquare");
export const Mic = icon(MicArt, "Mic");
export const Minimize = icon(MinimizeArt, "Minimize");
export const Minus = icon(MinusArt, "Minus");
export const MonitorPlay = icon(MonitorPlayArt, "MonitorPlay");
export const Moon = icon(MoonArt, "Moon");
export const Music = icon(MusicArt, "Music");
export const PanelLeft = icon(PanelLeftArt, "PanelLeft");
export const Paperclip = icon(PaperclipArt, "Paperclip");
export const Pencil = icon(PencilArt, "Pencil");
export const Phone = icon(PhoneArt, "Phone");
export const Play = icon(PlayArt, "Play");
export const Plus = icon(PlusArt, "Plus");
export const QrCode = icon(QrCodeArt, "QrCode");
export const Receipt = icon(ReceiptArt, "Receipt");
export const RefreshCw = icon(RefreshCwArt, "RefreshCw");
export const Repeat = icon(RepeatArt, "Repeat");
export const RotateCcw = icon(RotateCcwArt, "RotateCcw");
export const Ruler = icon(RulerArt, "Ruler");
export const Save = icon(SaveArt, "Save");
export const Search = icon(SearchArt, "Search");
export const Send = icon(SendArt, "Send");
export const Settings2 = icon(Settings2Art, "Settings2");
export const Shapes = icon(ShapesArt, "Shapes");
export const ShieldCheck = icon(ShieldCheckArt, "ShieldCheck");
export const ShoppingBag = icon(ShoppingBagArt, "ShoppingBag");
export const SlidersHorizontal = icon(SlidersHorizontalArt, "SlidersHorizontal");
export const Smartphone = icon(SmartphoneArt, "Smartphone");
export const Smile = icon(SmileArt, "Smile");
export const Square = icon(SquareArt, "Square");
export const Star = icon(StarArt, "Star");
export const Sun = icon(SunArt, "Sun");
export const Ticket = icon(TicketArt, "Ticket");
export const Trash2 = icon(Trash2Art, "Trash2");
export const TrendingDown = icon(TrendingDownArt, "TrendingDown");
export const TrendingUp = icon(TrendingUpArt, "TrendingUp");
export const Undo2 = icon(Undo2Art, "Undo2");
export const Upload = icon(UploadArt, "Upload");
export const UserArrowLeftRight = icon(UserArrowLeftRightArt, "UserArrowLeftRight");
export const UserMinus = icon(UserMinusArt, "UserMinus");
export const UserPlus = icon(UserPlusArt, "UserPlus");
export const UserRound = icon(UserRoundArt, "UserRound");
export const Users = icon(UsersArt, "Users");
export const Video = icon(VideoArt, "Video");
export const Vk = icon(VkArt, "Vk");
export const Wallet = icon(WalletArt, "Wallet");
export const X = icon(XArt, "X");
export const XCircle = icon(XCircleArt, "XCircle");
