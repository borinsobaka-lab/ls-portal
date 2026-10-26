import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Banknote,
  Check,
  ChevronDown,
  CreditCard,
  Loader2,
  Plus,
  Receipt,
  Smartphone,
  Trash2,
  UserArrowLeftRight,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { RequireFormat } from "@/components/require-format";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useStudios } from "@/hooks/use-studios";
import { catalogStudiosQuery, useNetworkStudioIds } from "@/hooks/use-catalog-studios";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useCrmLinks } from "@/hooks/use-crm-links";
import { isAdminRole } from "@/lib/staff-directory";
import { STUDIO_STAFF_COLS, type StudioStaffRow } from "@/lib/studio-staff";
import { MEMBERSHIP_STATUS_DOT, MEMBERSHIP_STATUS_LABEL } from "@/lib/membership-status";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  SALE_KIND_LABEL,
  SALE_KINDS,
  SALE_ADDED_VIA_LABEL,
  SALE_TIPS,
  addMonthsISO,
  saleDeleteDescription,
  scheduleShortfall,
  type MembershipKind,
  type PaymentMethod,
  type SaleAddedVia,
  type SaleKind,
} from "@/lib/payments";
import {
  clientName,
  formatDate,
  formatMoney,
  formatMoneyPrecise,
  phoneSearchTerm,
  sanitizeSearch,
  todayISO,
  formatPhone,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { STATUS_TONE_CLASS } from "@/components/ui/status-chip-styles";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPagination } from "@/components/data-pagination";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { NumberRangeFilter } from "@/components/number-range-filter";
import { EMPTY_NUMBER_RANGE, rangeBound, type NumberRange } from "@/lib/number-range";
import { StaffOption } from "@/components/employee-photo";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { TableSkeletonRows } from "@/components/skeletons";
import { ClientNameLink } from "@/components/client-name-link";
import { ClientCombobox, type ClientOption } from "@/components/client-combobox";
import { CommentCell } from "@/components/comment-cell";
import { commentSaver } from "@/lib/comment-saver";
import { RowContextMenu } from "@/components/row-context-menu";
import { useConfirm } from "@/components/confirm-dialog";
import { ClientMembershipsPageSkeleton } from "@/components/page-skeletons";
import { MembershipStatusBadge } from "@/components/membership-status-badge";
import { SaleDialog } from "@/components/sale-dialog";
import { SaleKindDot, SaleKindPickerDialog } from "@/components/sale-kind-picker";
import { RefundDialog, type RefundSale } from "@/components/refund-dialog";

// «Абонементы» пакетной студии (STUDIO_FORMATS.md): проданные клиентам
// абонементы, одна строка — одна продажа. С 2026-10-13 это и раздел продаж
// пакетного клуба («Продаж» у него нет): кнопка «Продажа», возврат и удаление
// — здесь. С 2026-10-20 раздел общий для всех пакетных клубов сети (как база
// клиентов): фильтр «Клуб» и колонка «Клуб продажи»; продажа по-прежнему
// клуба, где её внесли (касса, зарплаты, дашборд — по нему). Платежи и
// комментарии любой строки правит сотрудник любого клуба сети (решение
// владельца 2026-10-20: администраторы помогают друг другу), возврат,
// удаление и «Переоформить» — только сотрудник клуба продажи.
// Администраторы собирают деньги по рассрочкам: отмечают внесённые платежи,
// правят суммы и даты, пишут свой комментарий. Строки — вью
// client_packages_list (последняя версия —
// db/migrations/2026-10-20_packages_membership_transfer.sql): платежи и
// состояние оплаты (полоска слева) считает база, фильтр по нему — на сервере.

/** Подсказки «?» колонок и полей. */
const TIPS = {
  client: "Кому продан абонемент: телефон и почта. Нажмите на имя — откроется карточка клиента.",
  membership: `Что продано (из «Номенклатур») и тип продажи: «С» — дата продажи, «До» — последний день срока абонемента. У продления срок появится после первого посещения по нему. ${SALE_TIPS.saleKind}`,
  status:
    "Действует, ждёт начала (продление), истёк, заменён новым и т. п. Ниже — сколько дней осталось до конца срока.",
  balance:
    "Тренировок на балансе (из скольких в пакете), ниже — персональных, если они входят. Групповые списываются, когда отмечено посещение группового занятия, персональные — персонального. Срок задан в «Номенклатурах» и считается от даты продажи.",
  amount:
    "Стоимость продажи (со скидкой). Ниже — сколько из неё уже внесено, промокод и возвраты. Возврат — правый клик (касание) по строке.",
  soldBy: `Кто продал — администратор, оформивший продажу. Ниже — тренер при продаже. ${SALE_TIPS.trainer}`,
  studio:
    "Клуб, где продан абонемент: продажа идёт в его кассу, зарплаты и дашборд. Платежи и комментарии отмечает любой клуб, возврат, удаление и переоформление — только этот клуб.",
  addedVia:
    "Как абонемент попал в базу: внесён в админке, перенесён из 1С или куплен клиентом в приложении. Ставит база.",
  comments:
    "«При продаже» — комментарий из формы продажи, здесь его не меняют. Ниже — ваш комментарий к абонементу: договорённости с клиентом об оплате, напоминания. Нажмите, чтобы изменить.",
  note: "Договорённости с клиентом об оплате, напоминания — видно всем администраторам клуба.",
  payment:
    "Платежи по порядку: сумма и дата. Зелёный — внесён (дата, когда заплатили, справа — иконка способа оплаты), серый — сколько и до какого числа клиент должен внести, синий — внести сегодня или в ближайшие 2 дня, красный — просрочен. Нажмите на платёж, чтобы отметить оплату (когда и как внесён). «Редактировать платежи» — разбить невнесённый остаток на другие платежи и даты или исправить сумму внесённого.",
  editPayments:
    "Клиент не может внести платёж целиком — поставьте в платёж сумму, которую он внёс, и добавьте платежи на остаток. У внесённого платежа можно исправить сумму; дату, способ оплаты и «Снять отметку об оплате» — нажатием на отметку «Внесён» (сохраняется сразу). Сохранить можно, только если платежи в сумме покрывают стоимость абонемента.",
  paymentAmount: "Сколько клиент внёс или должен внести этим платежом.",
  paidMark:
    "Когда и как клиент внёс платёж. Нажмите, чтобы изменить или снять отметку об оплате — сохраняется сразу, как при нажатии на платёж в таблице.",
  dueDate:
    "До какого числа клиент должен внести платёж. За два дня до даты и в сам день невнесённый платёж помечает строку синим, дата прошла — красным.",
  paidAt: "Когда клиент фактически заплатил.",
  paymentMethod: "Как заплатил клиент — для отчётов, как способ оплаты в форме продажи.",
  renewal:
    "Срок абонемента идёт с первого посещения: пока клиент не пришёл, абонемент ожидает посещения. Продление — тренировки списываются после текущего абонемента.",
  nextPayment:
    "Абонементы, у которых ближайший невнесённый платёж приходится на выбранные даты. Одна дата — платежи за этот день, две — за период.",
  endsAt:
    "Абонементы, срок которых заканчивается в выбранные даты (последний день срока). Одна дата — заканчиваются в этот день. Абонементы без срока (ещё не было первого посещения) не попадают.",
  balanceRange:
    "Остаток баланса от и до (включительно): групповых тренировок, у пакета персональных — персональных. Одну границу можно оставить пустой.",
  transferClient:
    "Клиент, которому переходит абонемент. Если его ещё нет в базе — «Новый клиент» под полем.",
};

/**
 * Статусы в фильтре — как на бейдже (client_packages_list.membership_state
 * считает их так же, как effectiveStatus): сначала действующие.
 */
const STATUS_FILTER_ORDER = [
  "active",
  "awaiting",
  "pending",
  "frozen",
  "expired",
  "replaced",
  "cancelled",
  "refunded",
] as const;
type StatusFilter = (typeof STATUS_FILTER_ORDER)[number];
/** Продажи без продавца (перенесённые из 1С). */
const NO_SELLER = "none";

/**
 * Состояние оплаты (client_packages_list.payment_state) — цвет полоски строки:
 * всё внесено, просрочка, невнесённый платёж сегодня или в ближайшие 2 дня.
 * Платёж позже (pending) не подсвечивается (решение владельца 2026-10-11).
 */
type PaymentState = "paid" | "overdue" | "soon" | "pending" | "refunded";

const PAYMENT_STATES: Record<
  PaymentState,
  {
    label: string;
    filter: string;
    /** Полоска слева; null — без полоски. */
    stripe: string | null;
    /** Тот же цвет — рамкой карточки на телефоне (там строка — блок). */
    mobile: string | null;
  }
> = {
  paid: {
    label: "Оплачен полностью",
    filter: "Оплачены полностью",
    stripe: "bg-emerald-500",
    mobile: "max-md:border-l-4 max-md:border-l-emerald-500",
  },
  overdue: {
    label: "Просрочен платёж",
    filter: "С просрочкой",
    stripe: "bg-rose-500",
    mobile: "max-md:border-l-4 max-md:border-l-rose-500",
  },
  soon: {
    label: "Платёж в ближайшие 3 дня",
    filter: "Платёж в ближайшие 3 дня",
    stripe: "bg-blue-500",
    mobile: "max-md:border-l-4 max-md:border-l-blue-500",
  },
  pending: { label: "Следующий платёж позже", filter: "Платёж позже", stripe: null, mobile: null },
  // Оформлен возврат: платежей больше не ждём — ни в один фильтр по платежам
  // не попадает (решение владельца 2026-10-13).
  refunded: { label: "Возврат", filter: "Возврат", stripe: null, mobile: null },
};
// Цветные (с точкой в фильтре) — первыми (решение владельца 2026-10-14).
const PAYMENT_STATE_ORDER: PaymentState[] = ["overdue", "soon", "paid", "pending", "refunded"];
/** Цвета расшифровки на плашке фильтров. */
const STRIPED_STATES: PaymentState[] = ["paid", "overdue", "soon"];
const ALL = "all";

type Payment = {
  /** null — продажа без графика: оплачена сразу, править нечего. */
  id: string | null;
  amount: number;
  due_date: string;
  paid: boolean;
  paid_at: string | null;
  /** Способ оплаты внесённого платежа; null — не указан (старые платежи). */
  payment_method: PaymentMethod | null;
  /** Снят возвратом: не вносится (вместо суммы и даты — «Возврат»). */
  refunded?: boolean;
};

type Row = {
  id: string;
  client_id: string;
  admin_name: string | null;
  trainer_name: string | null;
  studio_id: string;
  sold_at: string;
  total_amount: number;
  /** Сколько из стоимости внесено (без графика — вся сумма). */
  paid_amount: number;
  /** Тип продажи; null — без типа (покупка в приложении, старые продажи). */
  sale_kind: SaleKind | null;
  /** Откуда продажа: админка или клиентское приложение. */
  source: "admin" | "mobile" | null;
  /** «Добавлен»: админка, импорт из 1С или приложение (считает вью). */
  added_via: SaleAddedVia | null;
  promo_code: string | null;
  comment: string | null;
  membership_note: string | null;
  clients: {
    id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  memberships: {
    id: string;
    name: string;
    kind: MembershipKind;
    visits_count: number | null;
    /** Персональных в номенклатуре: подарочные или количество у пакета персональных. */
    personal_count: number | null;
    /** Диагностик тела в номенклатуре. */
    diagnostics_count?: number | null;
  } | null;
  membership_status: string | null;
  visits_left: number | null;
  /** Остаток персональных (пакетный формат). */
  personal_left: number | null;
  /** Остаток диагностик тела (2026-10-15_zz_diagnostics_client_requests.sql). */
  diagnostics_left: number | null;
  ends_at: string | null;
  payments: Payment[];
  payment_state: PaymentState;
  /** Начало срока; у продления — дата первого посещения (null — ещё не было). */
  membership_started_at: string | null;
  /** Продление: срок считается от первого посещения. */
  starts_on_first_visit: boolean;
  /** Клуб продажи (2026-10-20_packages_membership_transfer.sql). */
  studio_name: string;
  /** Переоформлен с клиента (имя на момент переоформления) и когда. */
  transferred_from_name: string | null;
  transferred_at: string | null;
  /** Статус, как на бейдже: awaiting, expired и у active с прошедшим сроком. */
  membership_state: string | null;
};

const COLUMNS =
  "id, studio_id, client_id, admin_name, trainer_name, sold_at, total_amount, paid_amount, " +
  "sale_kind, source, promo_code, comment, membership_note, clients, memberships, " +
  "membership_status, visits_left, personal_left, ends_at, payments, payment_state, " +
  "membership_started_at, starts_on_first_visit, diagnostics_left, added_via, " +
  "studio_name, transferred_from_name, transferred_at, membership_state";
// Фильтры по продавцу, остатку и статусу — колонки seller_id, balance_left и
// membership_state (db/migrations/2026-10-18_zzzzz_client_packages_filters.sql).

/**
 * Колонки сортировки (lib/table-sort.ts): ключ заголовка → колонки вью
 * client_packages_list. Клиент и абонемент — поля json-колонок (PostgREST
 * сортирует по `col->>key`), платежи — по ближайшему невнесённому.
 */
const SORT_COLUMNS = {
  client: ["clients->>last_name", "clients->>first_name", "clients->>full_name"],
  membership: "memberships->>name",
  status: ["membership_state", "ends_at"],
  balance: "balance_left",
  amount: "total_amount",
  soldBy: ["admin_name", "trainer_name"],
  studio: "studio_name",
  addedVia: "added_via",
  comments: ["comment", "membership_note"],
  payment: "next_due_date",
};

/**
 * Колонки: клиент, абонемент, статус, баланс, сумма, продал / тренер,
 * «Клуб продажи» (2026-10-20), «Добавлен» (2026-10-18), комментарии и
 * платежи — с 2026-10-14 одной колонкой (решение владельца):
 * плашки по два в ряд, сколько бы платежей ни было.
 */
const COLUMN_COUNT = 10;

/** «Переоформить» — только живой или ждущий абонемент (membership_state). */
const TRANSFERABLE_STATES = new Set(["active", "awaiting", "frozen", "pending"]);

export const Route = createFileRoute("/_authenticated/client-memberships")({
  head: () => ({ meta: [{ title: "Абонементы — Lady Stretch" }] }),
  pendingComponent: ClientMembershipsPageSkeleton,
  component: ClientMembershipsRoute,
});

function ClientMembershipsRoute() {
  return (
    <RequireFormat format="packages" title="Абонементы" other={{ subscription: "/sales" }}>
      <ClientMembershipsPage />
    </RequireFormat>
  );
}

/** Дней от сегодня до даты (по календарю, без часовых поясов). */
function daysUntil(iso: string) {
  const toUtc = (v: string) => {
    const [y, m, d] = v.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(iso) - toUtc(todayISO())) / 86_400_000);
}

/** Дата календаря как YYYY-MM-DD (локальная, без перевода в UTC). */
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ClientMembershipsPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [state, setState] = useState<PaymentState | typeof ALL>(ALL);
  const [kind, setKind] = useState<SaleKind | typeof ALL>(ALL);
  // Продажа: сначала тип (плитки), потом форма; возврат — из меню строки.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleKind, setSaleKind] = useState<SaleKind>("new");
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSale, setRefundSale] = useState<RefundSale | null>(null);
  // Ближайший платёж: одна дата (выбран только день) — платежи за этот день.
  const [nextPayment, setNextPayment] = useState<DateRange | undefined>();
  const payFrom = nextPayment?.from ? isoDay(nextPayment.from) : "";
  // Выбран только первый день диапазона — это и есть «одно число».
  const payTo = nextPayment?.to ? isoDay(nextPayment.to) : payFrom;
  const sort = useTableSort();
  // Срок окончания — так же: один день или период.
  const [endsRange, setEndsRange] = useState<DateRange | undefined>();
  const endsFrom = endsRange?.from ? isoDay(endsRange.from) : "";
  const endsTo = endsRange?.to ? isoDay(endsRange.to) : endsFrom;
  const [balance, setBalance] = useState<NumberRange>(EMPTY_NUMBER_RANGE);
  const debouncedBalance = useDebouncedValue(balance);
  const balanceMin = rangeBound(debouncedBalance.min);
  const balanceMax = rangeBound(debouncedBalance.max);
  const [seller, setSeller] = useState<string>(ALL);
  const [status, setStatus] = useState<StatusFilter | typeof ALL>(ALL);
  const [club, setClub] = useState<string>(ALL);
  const [transferRow, setTransferRow] = useState<Row | null>(null);

  // Клубы раздела — вся сеть пакетных клубов (как база клиентов). Платежи и
  // комментарии правит любой клуб сети, меню строки (возврат, удаление,
  // «Переоформить») — только клуб продажи (RLS: «sales studio rw»;
  // db/migrations/2026-10-20_zz_packages_network_payments.sql).
  const networkIds = useNetworkStudioIds(studioId);
  const { data: allStudios } = useQuery(catalogStudiosQuery);
  const networkStudios = (allStudios ?? []).filter((s) => networkIds?.includes(s.id));
  const { data: myStudios } = useStudios();
  const myPackagesIds = (myStudios ?? []).filter((s) => s.format === "packages").map((s) => s.id);
  const canEdit = (r: Row) => myPackagesIds.includes(r.studio_id);

  // Продавцы — администраторы клубов раздела (выбранного клуба) из
  // «Сотрудников», как в форме продажи.
  const sellerStudioIds = club !== ALL ? [club] : networkIds;
  const { data: sellers = [] } = useQuery({
    queryKey: ["trainers", "sellers", sellerStudioIds?.join(","), STUDIO_STAFF_COLS],
    queryFn: () =>
      unwrap<StudioStaffRow[]>(
        supabase
          .from("trainers")
          .select(STUDIO_STAFF_COLS)
          .in("trainer_studios.studio_id", sellerStudioIds!)
          .order("full_name"),
      ),
    select: (rows) => rows.filter((r) => isAdminRole(r.role)),
    enabled: !!sellerStudioIds,
    meta: { errorMessage: "Не удалось загрузить сотрудников клуба" },
  });

  // Досчитать очередь продлений: у кого срок текущего абонемента вышел без
  // записей, продление становится действующим (packages_settle_studio). Один
  // раз при открытии раздела (и по «Обновить») по каждому своему пакетному
  // клубу (досчитывать можно только свои), а не на каждую страницу и фильтр;
  // список его не ждёт — после досчёта перечитывается.
  const settleKey = myPackagesIds.join(",");
  useQuery({
    queryKey: ["packages_settle_studio", settleKey],
    queryFn: async () => {
      await Promise.all(
        settleKey
          .split(",")
          .map((id) => unwrap(supabase.rpc("packages_settle_studio", { p_studio_id: id }))),
      );
      void queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
      return true;
    },
    enabled: !!settleKey,
    staleTime: Infinity,
    gcTime: 0,
    meta: { errorMessage: "Не удалось досчитать очередь продлений" },
  });

  const term = sanitizeSearch(useDebouncedValue(search));
  const table = useServerTable<Row>({
    queryKey: [
      "client_packages_list",
      networkIds?.join(","),
      club,
      term,
      state,
      kind,
      payFrom,
      payTo,
      endsFrom,
      endsTo,
      String(balanceMin ?? ""),
      String(balanceMax ?? ""),
      seller,
      status,
      sort.key,
    ],
    queryFn: ({ from, to }) => {
      let q = supabase
        .from("client_packages_list")
        .select(COLUMNS, { count: "exact" })
        .in("studio_id", networkIds!);
      if (club !== ALL) q = q.eq("studio_id", club);
      if (term) q = q.ilike("search_text", `%${phoneSearchTerm(term)}%`);
      if (state !== ALL) q = q.eq("payment_state", state);
      if (kind !== ALL) q = q.eq("sale_kind", kind);
      // next_due_date во вью — ближайший невнесённый платёж (у оплаченных — null).
      if (payFrom) q = q.gte("next_due_date", payFrom).lte("next_due_date", payTo);
      if (endsFrom) q = q.gte("ends_at", endsFrom).lte("ends_at", endsTo);
      if (balanceMin != null) q = q.gte("balance_left", balanceMin);
      if (balanceMax != null) q = q.lte("balance_left", balanceMax);
      if (seller === NO_SELLER) q = q.is("seller_id", null);
      else if (seller !== ALL) q = q.eq("seller_id", seller);
      if (status !== ALL) q = q.eq("membership_state", status);
      // Без сортировки по колонке: ждут платежа и просроченные — по
      // ближайшему платежу (сверху те, с кем разбираться первыми), по сроку
      // окончания — сначала те, у кого он кончается раньше, остальное — новые
      // продажи сверху.
      const byDue = payFrom || state === "overdue" || state === "soon" || state === "pending";
      return orderBy(q, sort.sort, SORT_COLUMNS, (o) => {
        let d = byDue ? o.order("next_due_date", { ascending: true }) : o;
        if (endsFrom) d = d.order("ends_at", { ascending: true });
        return d
          .order("sold_at", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id");
      }).range(from, to);
    },
    enabled: !!networkIds,
    errorMessage: "Не удалось загрузить абонементы",
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });

  // Возвраты по продажам страницы — одним запросом (таблица refunds не во вью:
  // она из db/sales_payment.sql, выполнявшегося вручную).
  const saleIds = table.rows.map((r) => r.id);
  const { data: refundedBySale } = useQuery({
    queryKey: ["refunds", "by-sales", studioId, saleIds.join(",")],
    queryFn: async () => {
      const rows = await unwrap<{ sale_id: string; amount: number | string | null }[]>(
        supabase.from("refunds").select("sale_id, amount").in("sale_id", saleIds),
      );
      const sums: Record<string, number> = {};
      for (const r of rows) sums[r.sale_id] = (sums[r.sale_id] ?? 0) + Number(r.amount ?? 0);
      return sums;
    },
    enabled: saleIds.length > 0,
    meta: { errorMessage: "Не удалось загрузить возвраты" },
  });

  const openSale = (k: SaleKind) => {
    setPickerOpen(false);
    setSaleKind(k);
    setSaleOpen(true);
  };
  // Новая продажа видна и в карточке клиента, и в статусе клиента.
  const onSold = () => {
    for (const key of ["client_packages_list", "client_memberships", "clients_with_status"])
      queryClient.invalidateQueries({ queryKey: [key] });
  };
  // «Переоформить»: сначала проверки, понятные без окна (статус, долг), —
  // их же повторит база (transfer_client_membership).
  const openTransfer = async (r: Row) => {
    const blocked = !TRANSFERABLE_STATES.has(r.membership_state ?? "")
      ? {
          title: "Этот абонемент нельзя переоформить",
          description:
            "Переоформить можно только действующий, замороженный или ожидающий абонемент. Истёкший, заменённый, отменённый и абонемент с возвратом передавать нечего.",
        }
      : r.payment_state !== "paid"
        ? {
            title: "Абонемент не оплачен полностью",
            description:
              "Нельзя передать абонемент, который не оплачен полностью. Сначала клиент вносит все платежи — отметьте их в колонке «Платежи», затем переоформите абонемент.",
          }
        : null;
    if (blocked) {
      await confirm({ ...blocked, confirmLabel: "Понятно", destructive: false, hideCancel: true });
      return;
    }
    setTransferRow(r);
  };
  const openRefund = (r: Row) => {
    setRefundSale({
      id: r.id,
      studio_id: r.studio_id,
      total_amount: Number(r.total_amount),
      paidAmount: Number(r.paid_amount ?? 0),
      membershipName: r.memberships?.name ?? null,
      packages: true,
    });
    setRefundOpen(true);
  };

  // Строка — продажа: удаляем её, абонемент клиента база удаляет вместе с ней
  // (db/migrations/2026-10-11_zzzzzz_sale_membership_delete.sql).
  const handleDelete = async (r: Row) => {
    if (
      !(await confirm({
        title: "Удалить абонемент?",
        description: saleDeleteDescription(
          r.clients ? clientName(r.clients) : null,
          r.memberships?.name ?? null,
        ),
      }))
    )
      return;
    const { error } = await supabase.from("sales").delete().eq("id", r.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Абонемент и продажа удалены");
    for (const key of [
      "client_packages_list",
      "sales_list",
      "client_memberships",
      "clients_with_status",
    ])
      queryClient.invalidateQueries({ queryKey: [key] });
  };
  const onTransferred = () => {
    setTransferRow(null);
    for (const key of [
      "client_packages_list",
      "sales_list",
      "client_memberships",
      "clients_with_status",
    ])
      queryClient.invalidateQueries({ queryKey: [key] });
  };
  const crmLinkOf = useCrmLinks(
    studioId,
    "id",
    table.rows.map((r) => r.client_id),
  );

  const columns = COLUMN_COUNT;
  const filtered =
    !!term ||
    state !== ALL ||
    kind !== ALL ||
    !!payFrom ||
    !!endsFrom ||
    !!balance.min.trim() ||
    !!balance.max.trim() ||
    seller !== ALL ||
    status !== ALL ||
    club !== ALL;

  return (
    <AdminShell
      title="Абонементы"
      actions={
        // Одна кнопка — тип продажи выбирается в окне, как тип занятия в «Расписании».
        <Button onClick={() => setPickerOpen(true)} disabled={!studioId}>
          <Plus />
          Продажа
        </Button>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Поиск по клиенту, абонементу, сотруднику"
            />
            {networkStudios.length > 1 && (
              <Select
                value={club}
                onValueChange={(v) => {
                  setClub(v);
                  // Продавцы другого клуба — другие.
                  setSeller(ALL);
                }}
              >
                <SelectTrigger className="w-48" aria-label="Клуб">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Все клубы</SelectItem>
                  {networkStudios.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name ?? "Клуб"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={state} onValueChange={(v) => setState(v as PaymentState | typeof ALL)}>
              <SelectTrigger className="w-48" aria-label="Оплата">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все платежи</SelectItem>
                {PAYMENT_STATE_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      {PAYMENT_STATES[s].stripe && (
                        <span
                          aria-hidden="true"
                          className={cn("size-2.5 shrink-0 rounded-full", PAYMENT_STATES[s].stripe)}
                        />
                      )}
                      {PAYMENT_STATES[s].filter}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as SaleKind | typeof ALL)}>
              <SelectTrigger className="w-48" aria-label="Тип продажи">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все типы продаж</SelectItem>
                {SALE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className="flex items-center gap-2">
                      <SaleKindDot kind={k} />
                      {SALE_KIND_LABEL[k]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter | typeof ALL)}>
              <SelectTrigger className="w-40" aria-label="Статус абонемента">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все статусы</SelectItem>
                {STATUS_FILTER_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn("size-2.5 shrink-0 rounded-full", MEMBERSHIP_STATUS_DOT[s])}
                      />
                      {MEMBERSHIP_STATUS_LABEL[s]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DateRangeFilter
              value={nextPayment}
              onChange={setNextPayment}
              placeholder="Ближайший платёж"
              title={TIPS.nextPayment}
            />
            <DateRangeFilter
              value={endsRange}
              onChange={setEndsRange}
              placeholder="Окончание срока"
              title={TIPS.endsAt}
            />
            <NumberRangeFilter
              value={balance}
              onChange={setBalance}
              placeholder="Баланс"
              title={TIPS.balanceRange}
            />
            <Select value={seller} onValueChange={setSeller}>
              <SelectTrigger className="w-48" aria-label="Кто продал">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Все продавцы</SelectItem>
                {sellers.map((a) => (
                  <SelectItem key={a.id} value={a.id} textValue={a.full_name}>
                    <StaffOption name={a.full_name} photo={a.photo_url} />
                  </SelectItem>
                ))}
                <SelectItem value={NO_SELLER}>Без продавца</SelectItem>
              </SelectContent>
            </Select>
            <ToolbarReset
              active={filtered}
              onReset={() => {
                setSearch("");
                setState(ALL);
                setKind(ALL);
                setNextPayment(undefined);
                setEndsRange(undefined);
                setBalance(EMPTY_NUMBER_RANGE);
                setSeller(ALL);
                setStatus(ALL);
                setClub(ALL);
              }}
            />
            <StripeLegend />
          </TableToolbar>

          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[170px]" tip={TIPS.client} {...sort.head("client")}>
                    Клиент
                  </TableHead>
                  <TableHead tip={TIPS.membership} {...sort.head("membership")}>
                    Абонемент
                  </TableHead>
                  <TableHead tip={TIPS.status} {...sort.head("status")}>
                    Статус
                  </TableHead>
                  <TableHead tip={TIPS.payment} {...sort.head("payment")}>
                    Платежи
                  </TableHead>
                  <TableHead tip={TIPS.comments} {...sort.head("comments")}>
                    Комментарии
                  </TableHead>
                  <TableHead tip={TIPS.balance} {...sort.head("balance")}>
                    Баланс
                  </TableHead>
                  <TableHead className="text-right" tip={TIPS.amount} {...sort.head("amount")}>
                    Сумма
                  </TableHead>
                  <TableHead tip={TIPS.soldBy} {...sort.head("soldBy")}>
                    Продал / тренер
                  </TableHead>
                  <TableHead tip={TIPS.studio} {...sort.head("studio")}>
                    Клуб продажи
                  </TableHead>
                  <TableHead tip={TIPS.addedVia} {...sort.head("addedVia")}>
                    Добавлен
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.loading ? (
                  <TableSkeletonRows columns={columns} />
                ) : table.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {filtered
                        ? "Ничего не найдено."
                        : "Проданных абонементов пока нет. Нажмите «Продажа»."}
                    </TableCell>
                  </TableRow>
                ) : (
                  table.rows.map((r) => (
                    <RowContextMenu
                      key={r.id}
                      actions={
                        canEdit(r)
                          ? [
                              {
                                label: "Переоформить",
                                icon: UserArrowLeftRight,
                                onSelect: () => openTransfer(r),
                              },
                              {
                                label: "Оформить возврат",
                                icon: Receipt,
                                onSelect: () => openRefund(r),
                              },
                              {
                                label: "Удалить",
                                icon: Trash2,
                                destructive: true,
                                onSelect: () => handleDelete(r),
                              },
                            ]
                          : []
                      }
                    >
                      <TableRow className={cn(PAYMENT_STATES[r.payment_state].mobile)}>
                        <TableCell className="relative font-medium">
                          {PAYMENT_STATES[r.payment_state].stripe && (
                            <span
                              aria-hidden
                              className={cn(
                                "absolute inset-y-0 left-0 w-1 max-md:hidden",
                                PAYMENT_STATES[r.payment_state].stripe,
                              )}
                            />
                          )}
                          <span className="sr-only">{PAYMENT_STATES[r.payment_state].label}. </span>
                          {r.clients ? (
                            <ClientNameLink clientId={r.client_id} crmLink={crmLinkOf(r.client_id)}>
                              {clientName(r.clients)}
                            </ClientNameLink>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {r.clients?.phone && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {formatPhone(r.clients.phone)}
                            </div>
                          )}
                          {r.clients?.email && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {r.clients.email}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="min-w-[130px]">
                          <div>{r.memberships?.name ?? "—"}</div>
                          {r.memberships?.kind !== "package" && r.memberships?.kind && (
                            <div className="text-xs text-muted-foreground">
                              {r.memberships.kind === "trial"
                                ? "Пробное"
                                : r.memberships.kind === "single"
                                  ? "Разовое"
                                  : "Персональные"}
                            </div>
                          )}
                          {r.sale_kind && (
                            <div className="flex items-center gap-1.5 whitespace-nowrap text-xs">
                              <SaleKindDot kind={r.sale_kind} />
                              {SALE_KIND_LABEL[r.sale_kind]}
                            </div>
                          )}
                          <div className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                            С {formatDate(r.sold_at)}
                          </div>
                          <div className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                            До{" "}
                            {r.ends_at
                              ? formatDate(r.ends_at)
                              : r.starts_on_first_visit
                                ? "— с 1-го посещения"
                                : "—"}
                          </div>
                          {r.transferred_at && (
                            <div className="text-xs text-muted-foreground tabular-nums">
                              Переоформлен {formatDate(r.transferred_at.slice(0, 10))}
                              {r.transferred_from_name && ` с ${r.transferred_from_name}`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            {r.membership_status ? (
                              <MembershipStatusBadge
                                m={{
                                  status: r.membership_status,
                                  ends_at: r.ends_at,
                                  starts_on_first_visit: r.starts_on_first_visit,
                                  started_at: r.membership_started_at,
                                }}
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            <div className="text-xs tabular-nums">
                              <DaysLeft
                                status={r.membership_status}
                                endsAt={r.ends_at}
                                notStarted={r.starts_on_first_visit && !r.membership_started_at}
                              />
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <PaymentsCell row={r} onSaved={reload} />
                        </TableCell>
                        <TableCell>
                          <div className="max-w-[200px] space-y-1">
                            {r.comment?.trim() && (
                              <div className="text-xs">
                                <div className="text-muted-foreground">При продаже</div>
                                <CommentCell
                                  text={r.comment}
                                  onSave={commentSaver("sales", r.id)}
                                  onSaved={reload}
                                />
                              </div>
                            )}
                            {/* Комментарий раздела (sales.membership_note): договорённости
                                об оплате, напоминания — правится прямо в строке. */}
                            <CommentCell
                              text={r.membership_note}
                              onSave={commentSaver("sales", r.id, "membership_note")}
                              onSaved={reload}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          <Balance row={r} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <Amount row={r} refunded={refundedBySale?.[r.id] ?? 0} />
                        </TableCell>
                        <TableCell>
                          <div>{r.admin_name ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.trainer_name ? `Тренер: ${r.trainer_name}` : "Без тренера"}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{r.studio_name}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {SALE_ADDED_VIA_LABEL[r.added_via ?? "admin"]}
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  ))
                )}
              </TableBody>
            </Table>

            <DataPagination {...table.pagination} />
          </div>
        </RequireStudio>
      </div>
      <SaleKindPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={openSale} />
      <SaleDialog
        open={saleOpen}
        onOpenChange={setSaleOpen}
        studioId={studioId}
        onSaved={onSold}
        kind={saleKind}
      />
      <RefundDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        sale={refundSale}
        onSaved={reload}
      />
      <Dialog open={!!transferRow} onOpenChange={(o) => !o && setTransferRow(null)}>
        <DialogContent className="max-w-lg">
          {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
          {transferRow && (
            <TransferForm
              row={transferRow}
              onClose={() => setTransferRow(null)}
              onSaved={onTransferred}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

/** Что значат цвета полосок — справа на плашке фильтров. */
function StripeLegend() {
  return (
    <div className="toolbar-full ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {STRIPED_STATES.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("h-3.5 w-1 rounded-full", PAYMENT_STATES[s].stripe)} />
          {PAYMENT_STATES[s].label}
        </span>
      ))}
    </div>
  );
}

/**
 * Баланс абонемента: групповые тренировки (у пакета персональных их нет) и
 * отдельной строкой персональные — у пакета персональных и у пакета
 * тренировок с подарочными; диагностики — если входят в абонемент.
 */
function Balance({ row }: { row: Row }) {
  const m = row.memberships;
  const isPersonal = m?.kind === "personal";
  const personalTotal = m?.personal_count ?? 0;
  const diagnosticsTotal = m?.diagnostics_count ?? 0;
  const line = (left: number | null, total: number | null, unit: string) => (
    <div>
      {left ?? "—"}
      {left != null && total != null && (
        <span className="text-muted-foreground"> из {total}</span>
      )}{" "}
      <span className="text-muted-foreground">{unit}</span>
    </div>
  );
  return (
    <>
      {!isPersonal && line(row.visits_left, m?.visits_count ?? null, "трен.")}
      {(isPersonal || personalTotal > 0) && line(row.personal_left, personalTotal || null, "перс.")}
      {diagnosticsTotal > 0 && line(row.diagnostics_left, diagnosticsTotal, "диагн.")}
    </>
  );
}

/** Стоимость продажи, сколько внесено, промокод и возвраты. */
function Amount({ row, refunded }: { row: Row; refunded: number }) {
  const total = Number(row.total_amount);
  const paid = Number(row.paid_amount);
  return (
    <>
      <div className="font-medium tabular-nums">{formatMoney(total)}</div>
      {paid < total && (
        <div className="text-xs text-muted-foreground tabular-nums">
          внесено {formatMoney(paid)}
        </div>
      )}
      {row.promo_code && (
        <div className="text-xs text-muted-foreground">Промокод: {row.promo_code}</div>
      )}
      {refunded > 0 && (
        <div className="text-xs text-rose-600 tabular-nums">возврат {formatMoney(refunded)}</div>
      )}
    </>
  );
}

/** Абонемент закончился: дни не считаем (статус — бейджем рядом). */
const ENDED_STATUSES = new Set(["replaced", "cancelled", "expired", "frozen", "refunded"]);

function DaysLeft({
  status,
  endsAt,
  notStarted,
}: {
  status: string | null;
  endsAt: string | null;
  /** Продление, по которому ещё не было посещений: срок пока не идёт. */
  notStarted: boolean;
}) {
  if (status && ENDED_STATUSES.has(status)) return null;
  if (notStarted)
    return (
      <span className="text-muted-foreground" title={TIPS.renewal}>
        {status === "pending" ? "Ждёт окончания текущего" : "Срок — с 1-го посещения"}
      </span>
    );
  if (!endsAt) return <span className="text-muted-foreground">Без срока</span>;
  const days = daysUntil(endsAt);
  if (days < 0) return <span className="text-rose-600">закончился {formatDate(endsAt)}</span>;
  return (
    <span title={`До ${formatDate(endsAt)} включительно`}>
      {days === 0 ? "Последний день" : `ещё ${days} дн.`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Переоформить (transfer_client_membership)
// ---------------------------------------------------------------------------

/** Живой абонемент нового владельца того же вида (embed memberships — объект или массив). */
type LiveMembership = {
  status: string;
  ends_at: string | null;
  memberships: { name: string } | { name: string }[] | null;
};

/**
 * «Переоформить» (решение владельца 2026-10-20): абонемент переходит другому
 * клиенту как есть — статус, остаток, срок, платежи, продавец и тренер не
 * меняются. Статус и оплату проверяет openTransfer до окна; живой абонемент
 * того же вида у нового владельца — здесь, как только он выбран. Всё это ещё
 * раз проверяет база (db/migrations/2026-10-20_packages_membership_transfer.sql).
 */
function TransferForm({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState<ClientOption | null>(null);
  const [saving, setSaving] = useState(false);
  const targetId = target?.id ?? "";
  const sameClient = targetId === row.client_id;
  // Пакет персональных и пакет тренировок — разные балансы: живой абонемент
  // у клиента один на вид (client_memberships_one_live_per_balance).
  const balanceKind = row.memberships?.kind === "personal" ? "personal" : "group";
  const isLive = row.membership_status === "active" || row.membership_status === "frozen";

  const { data: current, isFetching: checking } = useQuery({
    queryKey: ["client_memberships", "transfer-check", targetId, balanceKind],
    queryFn: async () =>
      (
        await unwrap<LiveMembership[]>(
          supabase
            .from("client_memberships")
            .select("status, ends_at, memberships(name)")
            .eq("client_id", targetId)
            .eq("balance_kind", balanceKind)
            .in("status", ["active", "frozen"])
            .limit(1),
        )
      )[0] ?? null,
    enabled: !!targetId && !sameClient,
    meta: { errorMessage: "Не удалось проверить абонементы клиента" },
  });
  const currentName =
    (Array.isArray(current?.memberships) ? current?.memberships[0] : current?.memberships)?.name ??
    "—";
  const currentLabel = current
    ? `${current.status === "frozen" ? "замороженный" : "действующий"} абонемент «${currentName}»${
        current.ends_at ? ` до ${formatDate(current.ends_at)}` : ""
      }`
    : "";
  const blocked = isLive && !!current;

  const handleSave = async () => {
    if (saving) return;
    if (!target) {
      toast.error("Выберите клиента, на которого переоформить абонемент");
      return;
    }
    if (sameClient) {
      toast.error("Абонемент уже оформлен на этого клиента");
      return;
    }
    if (blocked) {
      toast.error(`У клиента уже есть ${currentLabel}`);
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("transfer_client_membership", {
        p_sale_id: row.id,
        p_client_id: target.id,
      });
      if (error) {
        toast.error("Не удалось переоформить: " + error.message);
        return;
      }
      const status = (data as { status?: string } | null)?.status;
      toast.success(
        `Абонемент переоформлен на ${clientName(target)}` +
          (status === "pending" ? " — встал в очередь за текущим" : ""),
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Переоформить абонемент</DialogTitle>
        <DialogDescription>
          {row.memberships?.name ?? "Абонемент"} · сейчас у{" "}
          {row.clients ? clientName(row.clients) : "клиента"} · клуб «{row.studio_name}»
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField
              label="Новый владелец"
              tip={TIPS.transferClient}
              required
              hint={sameClient ? "Абонемент уже оформлен на этого клиента." : undefined}
            >
              <ClientCombobox
                studioId={row.studio_id}
                creatable
                value={targetId}
                onChange={(_, c) => setTarget(c)}
              />
            </FormField>
            {blocked ? (
              <InfoNote variant="warning">
                У клиента уже есть {currentLabel}. Двух действующих абонементов одного вида у
                клиента быть не может — переоформить на него можно, когда этот закончится.
              </InfoNote>
            ) : (
              target &&
              !sameClient &&
              !checking &&
              row.membership_status === "pending" && (
                <InfoNote>
                  {current
                    ? `Абонемент встанет в очередь за текущим: у клиента ${currentLabel}.`
                    : "У клиента нет действующего абонемента — этот станет текущим."}
                </InfoNote>
              )
            )}
            <InfoNote>
              Переходит всё как есть: статус, остаток тренировок, срок, платежи, продавец и тренер.
              Посещения, уже списанные с абонемента, остаются в истории прежнего клиента.
            </InfoNote>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || checking || blocked || sameClient}>
            {saving && <Loader2 className="animate-spin" />}
            Переоформить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

// ---------------------------------------------------------------------------
// Платёж рассрочки (sale_installments)
// ---------------------------------------------------------------------------

/**
 * Способ оплаты внесённого платежа — иконкой справа от даты (решение
 * владельца 2026-10-14: плашки ниже, подпись — во всплывающей подсказке).
 */
const PAYMENT_METHOD_ICON: Record<PaymentMethod, typeof Banknote> = {
  cash: Banknote,
  card: CreditCard,
  transfer: ArrowLeftRight,
  app: Smartphone,
};

/**
 * Платежи продажи одной колонкой: плашки по два в ряд (внесённый — зелёная,
 * просроченный — красная), под ними — «Редактировать платежи».
 */
function PaymentsCell({ row, onSaved }: { row: Row; onSaved: () => void }) {
  const [editOpen, setEditOpen] = useState(false);
  const [marked, setMarked] = useState(false);
  const payments = row.payments ?? [];
  if (payments.length === 0) return <span className="text-muted-foreground">—</span>;
  // Любой абонемент без возврата — и оплаченный полностью, и сразу при продаже
  // (решение владельца 2026-10-18); бесплатный без графика править нечего.
  const editable =
    (payments.some((p) => p.id) || Number(row.total_amount) > 0) &&
    !payments.some((p) => p.refunded) &&
    row.membership_status !== "refunded";
  // Отметка оплаты из окна правки сохраняется сразу — таблицу обновляем, когда
  // окно закроют (иначе строка могла бы уйти из фильтра вместе с окном).
  const closeEdit = () => {
    setEditOpen(false);
    if (marked) {
      setMarked(false);
      onSaved();
    }
  };
  return (
    // Плашки по ширине содержимого (суммы — до трёх знаков, решение владельца
    // 2026-10-14): колонки по самой широкой плашке, без пустоты справа.
    <div className="w-max space-y-1.5">
      <div className="grid grid-cols-[repeat(2,max-content)] gap-1.5">
        {payments.map((p, i) => (
          <PaymentCell key={p.id ?? i} index={i} payment={p} onSaved={onSaved} />
        ))}
      </div>
      {editable && (
        <Button
          variant="link"
          size="inline"
          // Серым, как «Комментарий» в соседней колонке, — не спорит с платежами.
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => setEditOpen(true)}
        >
          Редактировать платежи
        </Button>
      )}
      <Dialog open={editOpen} onOpenChange={(o) => (o ? setEditOpen(true) : closeEdit())}>
        <DialogContent className="max-w-lg">
          {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
          <PaymentsEditForm
            row={row}
            onClose={closeEdit}
            onSaved={() => {
              setEditOpen(false);
              setMarked(false);
              onSaved();
            }}
            onMarked={() => setMarked(true)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PaymentCell({
  index,
  payment,
  onSaved,
}: {
  index: number;
  payment: Payment;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const overdue = !payment.paid && !payment.refunded && payment.due_date < todayISO();
  // Сегодня или в ближайшие 2 дня — синяя, как полоска строки «Платёж в
  // ближайшие 3 дня» (payment_state = 'soon', решение владельца 2026-10-14).
  const soon = !payment.paid && !payment.refunded && !overdue && daysUntil(payment.due_date) <= 2;
  const box = cn(
    "block w-full rounded-md px-2 py-1.5 text-left",
    payment.refunded
      ? STATUS_TONE_CLASS.negative
      : payment.paid
        ? STATUS_TONE_CLASS.positive
        : overdue
          ? STATUS_TONE_CLASS.negative
          : soon
            ? STATUS_TONE_CLASS.info
            : STATUS_TONE_CLASS.neutral,
  );
  const number = <span className="font-normal text-muted-foreground">{index + 1}. </span>;

  // Снят возвратом: ни суммы, ни даты — только отметка (решение владельца 2026-10-13).
  if (payment.refunded)
    return (
      <div title="По продаже оформлен возврат — платёж больше не ждём" className={box}>
        <div className="text-xs font-medium">
          {number}
          Возврат
        </div>
      </div>
    );

  const summary = (
    <>
      <div className="whitespace-nowrap text-sm font-medium tabular-nums">
        {number}
        {formatMoneyPrecise(Number(payment.amount))}
      </div>
      <div
        className={cn(
          "flex items-center gap-1 whitespace-nowrap text-xs tabular-nums",
          payment.paid
            ? "text-emerald-700"
            : soon
              ? "text-blue-700"
              : overdue
                ? "text-rose-700"
                : "text-muted-foreground",
        )}
      >
        {payment.paid ? (
          <>
            {formatDate(payment.paid_at ?? payment.due_date)}
            {payment.payment_method && <PaymentMethodIcon method={payment.payment_method} />}
          </>
        ) : (
          <>до {formatDate(payment.due_date)}</>
        )}
      </div>
    </>
  );

  // Оплата сразу при продаже — графика нет, отмечать нечего.
  if (!payment.id)
    return (
      <div title="Оплачено полностью при продаже" className={box}>
        {summary}
      </div>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={payment.paid ? "Изменить платёж" : "Отметить оплату"}
          className={cn(
            box,
            "cursor-pointer transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          )}
        >
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PaymentForm
          payment={{ ...payment, id: payment.id }}
          onDone={() => {
            setOpen(false);
            onSaved();
          }}
          onCancel={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function PaymentMethodIcon({ method }: { method: PaymentMethod }) {
  const Icon = PAYMENT_METHOD_ICON[method];
  const label = PAYMENT_METHOD_LABEL[method];
  return (
    <span title={label} className="inline-flex">
      <Icon aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Платёж в окне правки графика. id null — новый невнесённый или оплата при
 * продаже у продажи без графика (paid: база запишет её первым платежом).
 */
type DraftPayment = {
  key: string;
  id: string | null;
  amount: string;
  dueDate: string;
  paid: boolean;
  paidAt: string | null;
  method: PaymentMethod | null;
};

/**
 * «Редактировать платежи» (решения владельца 2026-10-14, 2026-10-18): у
 * невнесённых платежей — сумма и дата, их можно удалять и добавлять; у
 * внесённых — только сумма, отметку снимают нажатием на «внесён» (та же
 * форма, что у платежа в таблице, сохраняется сразу). Сохраняет RPC
 * replace_sale_installments (db/migrations/2026-10-18_zzzzzz_sale_installments_edit_paid.sql)
 * — одним действием, и сама база не даст сохранить график меньше стоимости.
 */
function PaymentsEditForm({
  row,
  onClose,
  onSaved,
  onMarked,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
  /** Отметка оплаты сохранена из окна — таблицу обновить после закрытия. */
  onMarked: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftPayment[]>(() =>
    row.payments
      .filter((p) => !p.refunded)
      .map((p, i) => ({
        key: p.id ?? `sold-${i}`,
        id: p.id,
        amount: String(p.amount),
        dueDate: p.due_date,
        paid: p.paid,
        paidAt: p.paid_at,
        method: p.payment_method,
      })),
  );
  const [saving, setSaving] = useState(false);

  const total = Number(row.total_amount) || 0;
  const amounts = drafts.map((d) => Number(d.amount.replace(",", ".")));
  const shortfall = scheduleShortfall(total, amounts);
  const sum = amounts.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);

  const update = (key: string, patch: Partial<DraftPayment>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (key: string) => setDrafts((list) => list.filter((d) => d.key !== key));
  const add = () =>
    setDrafts((list) => {
      const last =
        list
          .map((d) => d.dueDate)
          .filter(Boolean)
          .sort()
          .at(-1) ?? todayISO();
      return [
        ...list,
        {
          key: crypto.randomUUID(),
          id: null,
          // Новый платёж сразу предлагает недостающую сумму.
          amount: shortfall > 0 ? String(shortfall) : "",
          dueDate: addMonthsISO(last < todayISO() ? todayISO() : last, 1),
          paid: false,
          paidAt: null,
          method: null,
        },
      ];
    });

  const handleSave = async () => {
    if (saving) return;
    for (const d of drafts) {
      const v = Number(d.amount.replace(",", "."));
      if (!d.amount.trim() || !Number.isFinite(v) || v <= 0) {
        toast.error("Укажите сумму каждого платежа");
        return;
      }
      if (!d.paid && !d.dueDate) {
        toast.error("Укажите дату каждого платежа");
        return;
      }
    }
    if (shortfall > 0) {
      toast.error(
        `Платежи в сумме меньше стоимости абонемента: не хватает ${formatMoneyPrecise(shortfall)}`,
      );
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("replace_sale_installments", {
        p_sale_id: row.id,
        p_rows: drafts.map((d) => ({
          id: d.id,
          amount: Number(d.amount.replace(",", ".")),
          due_date: d.dueDate,
          paid: d.paid,
        })),
      });
      if (error) {
        toast.error("Не удалось сохранить платежи: " + error.message);
        return;
      }
      toast.success("Платежи сохранены");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Редактировать платежи</DialogTitle>
        <DialogDescription>
          {row.clients ? clientName(row.clients) : "Клиент"} ·{" "}
          {row.memberships?.name ?? "Абонемент"}
          {" · "}стоимость {formatMoneyPrecise(total)}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-3">
            <InfoNote>{TIPS.editPayments}</InfoNote>
            <ol className="space-y-2">
              {drafts.map((d, i) => (
                <li
                  key={d.key}
                  className={cn(
                    "flex items-end gap-2 rounded-md border px-3 py-2",
                    d.paid && "border-emerald-200 bg-emerald-100",
                  )}
                >
                  <span className="w-5 shrink-0 pb-2.5 text-sm text-muted-foreground">
                    {i + 1}.
                  </span>
                  <FormField label="Сумма, ₾" tip={TIPS.paymentAmount} required className="flex-1">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={d.amount}
                      onChange={(e) => update(d.key, { amount: e.target.value })}
                    />
                  </FormField>
                  {d.paid ? (
                    <FormField label="Внесён" tip={TIPS.paidMark} className="flex-1">
                      <PaidMarkButton
                        draft={d}
                        onMarked={(mark) => {
                          update(d.key, {
                            paid: mark.paid,
                            paidAt: mark.paidAt,
                            method: mark.method,
                          });
                          onMarked();
                        }}
                      />
                    </FormField>
                  ) : (
                    <FormField label="Внести до" tip={TIPS.dueDate} required className="flex-1">
                      <Input
                        type="date"
                        value={d.dueDate}
                        onChange={(e) => update(d.key, { dueDate: e.target.value })}
                      />
                    </FormField>
                  )}
                  {/* Внесённый не убрать — сначала снять отметку; место кнопки
                      держим, чтобы поля строк стояли ровно. */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "mb-1 shrink-0 text-muted-foreground hover:text-destructive",
                      d.paid && "invisible",
                    )}
                    aria-label={`Убрать платёж ${i + 1}`}
                    disabled={d.paid}
                    onClick={() => remove(d.key)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ol>
            <Button variant="outline" size="sm" onClick={add}>
              <Plus />
              Добавить платёж
            </Button>
            <InfoNote variant={shortfall > 0 ? "warning" : undefined}>
              Платежи в сумме: {formatMoneyPrecise(sum)} из {formatMoneyPrecise(total)}.
              {shortfall > 0
                ? ` Не хватает ${formatMoneyPrecise(shortfall)} — добавьте платёж или увеличьте сумму.`
                : " Стоимость абонемента покрыта."}
            </InfoNote>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * Отметка «внесён» у платежа в окне правки: по нажатию — та же форма, что у
 * платежа в таблице (когда, как, «Снять отметку об оплате»). Оплата при
 * продаже без графика (id null) отдельной строкой в базе не хранится —
 * отмечать нечего.
 */
function PaidMarkButton({
  draft,
  onMarked,
}: {
  draft: DraftPayment;
  onMarked: (mark: PaymentMark) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = (
    <span className="flex min-w-0 items-center gap-1 text-emerald-700">
      <Check className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {formatDate(draft.paidAt ?? draft.dueDate)}
        {draft.method && ` · ${PAYMENT_METHOD_LABEL[draft.method]}`}
      </span>
    </span>
  );
  if (!draft.id)
    return (
      <div title="Оплачено при продаже" className={cn(fieldTriggerClass, "cursor-default")}>
        {label}
      </div>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title="Изменить отметку об оплате" className={fieldTriggerClass}>
          {label}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PaymentForm
          payment={{
            id: draft.id,
            amount: Number(draft.amount.replace(",", ".")) || 0,
            due_date: draft.dueDate,
            paid: draft.paid,
            paid_at: draft.paidAt,
            payment_method: draft.method,
          }}
          onDone={(mark) => {
            setOpen(false);
            onMarked(mark);
          }}
          onCancel={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Отметка платежа после сохранения в PaymentForm. */
type PaymentMark = { paid: boolean; paidAt: string | null; method: PaymentMethod | null };

/**
 * Отметка оплаты по клику на платёж (решение владельца 2026-10-14): сумма и
 * «внести до» здесь не меняются — только когда внесён и способ оплаты; график
 * правят в «Редактировать платежи». Внесённый по ошибке — «Снять отметку».
 * Та же форма — у внесённого платежа в «Редактировать платежи».
 */
function PaymentForm({
  payment,
  onDone,
  onCancel,
}: {
  payment: Pick<Payment, "amount" | "due_date" | "paid" | "paid_at" | "payment_method"> & {
    id: string;
  };
  onDone: (mark: PaymentMark) => void;
  onCancel: () => void;
}) {
  // Отмечают оплату обычно в день, когда клиент заплатил, — сегодня.
  const [paidAt, setPaidAt] = useState(payment.paid_at ?? todayISO());
  const [method, setMethod] = useState<PaymentMethod>(payment.payment_method ?? "cash");
  const [saving, setSaving] = useState(false);

  const save = async (paid: boolean) => {
    if (saving) return;
    if (paid && !paidAt) {
      toast.error("Укажите, когда платёж внесён");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("sale_installments")
        .update({
          paid,
          paid_at: paid ? paidAt : null,
          payment_method: paid ? method : null,
        })
        .eq("id", payment.id);
      if (error) {
        toast.error("Не удалось сохранить платёж: " + error.message);
        return;
      }
      toast.success(paid ? "Платёж отмечен внесённым" : "Отметка об оплате снята");
      onDone({ paid, paidAt: paid ? paidAt : null, method: paid ? method : null });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        // В «Редактировать платежи» форма — в портале внутри формы окна: React
        // довёл бы submit и до неё (сохранил бы график).
        e.stopPropagation();
        save(true);
      }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold leading-tight">Фиксация оплаты</h3>
        <div className="text-sm">
          <span className="font-medium tabular-nums">
            {formatMoneyPrecise(Number(payment.amount))}
          </span>
          <span className="text-muted-foreground"> · до {formatDate(payment.due_date)}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Когда внесён" tip={TIPS.paidAt} required>
          <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </FormField>
        <FormField label="Способ оплаты" tip={TIPS.paymentMethod} required>
          <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      {payment.paid && (
        <Button
          variant="link"
          size="inline"
          className="text-xs text-muted-foreground underline hover:text-destructive"
          disabled={saving}
          onClick={() => save(false)}
        >
          Снять отметку об оплате
        </Button>
      )}
      <PopoverButtons saving={saving} onCancel={onCancel} />
    </form>
  );
}

function PopoverButtons({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" onClick={onCancel} disabled={saving}>
        Отмена
      </Button>
      <Button type="submit" disabled={saving}>
        {saving && <Loader2 className="animate-spin" />}
        Сохранить
      </Button>
    </div>
  );
}
