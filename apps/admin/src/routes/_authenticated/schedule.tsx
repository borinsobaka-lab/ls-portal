import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Plus,
  ChevronDown,
  Loader2,
  Pencil,
  Repeat,
  Trash2,
  Copy,
  Undo2,
  Check,
  UserMinus,
  UserPlus,
  X,
  Maximize,
  Minimize,
} from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useActiveStudio } from "@/hooks/use-studios";
import { useCatalogStudioIds, useNetworkStudioIds } from "@/hooks/use-catalog-studios";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { fieldClass, fieldTriggerClass } from "@/components/ui/field-styles";
import { StatusChip } from "@/components/ui/status-chip";
import { PeriodStepper } from "@/components/period-stepper";
import { ChoiceCard } from "@/components/ui/choice-card";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import {
  attendanceBlock,
  balanceFor,
  entryBalance,
  tbilisiDate,
  type BalanceKind,
  type Coverage,
} from "@/lib/booking-coverage";
import {
  pickTrainer,
  regularTrainerIds,
  removeTrainer,
  substitutionsOf,
  trainerChanges,
  undoSubstitution,
  type PickMode,
  type SubstitutionRow,
  type SubsMap,
  type TrainerAssignment,
} from "@/lib/schedule-trainers";
import { roleGroup } from "@/lib/staff-roles";
import { clientName, formatDate, toDateTimeLocalValue } from "@/lib/format";
import { ClubStatusBadge } from "@/components/club-status-badge";
import {
  endsSoon,
  fewVisitsLeft,
  PAYMENT_SOON_DAYS,
  paymentInfo,
  type InstallmentLite,
  type PaymentInfo,
} from "@/lib/membership-status";
import type { ClubStatus } from "@/lib/client-status";
import { parseTranslations, translationText } from "@/lib/content-i18n";
import { DAY_TYPES, dayTypeColor } from "@/lib/workout-types";
import {
  ACTIVITY_KIND_VALUES,
  activityKind,
  activityKindsFor,
  isOneOnOne,
  type ActivityKind,
} from "@/lib/schedule-activities";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ListItemButton } from "@/components/ui/list-item-button";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { ClientNameLink } from "@/components/client-name-link";
import { ClientCombobox } from "@/components/client-combobox";
import { ClientDialog } from "@/components/client-form-dialog";
import { StaffOption } from "@/components/employee-photo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { noteChipClass } from "@/components/comment-cell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { EntryCardSkeleton, SchedulePageSkeleton } from "@/components/page-skeletons";
import { SCHEDULE_SKELETON_HOURS, isScheduleSkeletonCell } from "@/lib/page-skeleton-layout";

export const Route = createFileRoute("/_authenticated/schedule")({
  head: () => ({ meta: [{ title: "Расписание — Lady Stretch" }] }),
  pendingComponent: SchedulePageSkeleton,
  component: SchedulePage,
});

type Workout = {
  id: string;
  name: string;
  type?: string | null;
  /** По умолчанию — для клуба без своей строки в capacities. */
  capacity?: number | null;
  color?: string | null;
  /** Вместимость в каждом клубе («Тренировки», workout_capacities). */
  capacities?: { studio_id: string; capacity: number | null }[];
};

/** Вместимость тренировки в клубе: своя строка, иначе по умолчанию. */
function workoutCapacityIn(w: Workout | undefined, studioId: string | null) {
  if (!w) return null;
  const own = studioId ? w.capacities?.find((c) => c.studio_id === studioId) : undefined;
  return (own ? own.capacity : w.capacity) ?? null;
}
type Trainer = {
  id: string;
  full_name: string;
  /** trainer | admin | masseur — справочник «Сотрудники». */
  role?: string;
  /** Фото из справочника — аватарка в выпадающих списках. */
  photo_url?: string | null;
  /** Переводы имени — английское в полноэкранном просмотре. */
  translations?: unknown;
};
type Entry = {
  id: string;
  studio_id: string;
  /** Групповое — по тренировке; персональное и прочее — без неё. */
  kind: ActivityKind;
  workout_id: string | null;
  /** Название прочей активности. */
  title: string | null;
  /** Ставка за прочую активность, лари каждому отмеченному сотруднику. */
  pay_rate: number | null;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  booked_count: number;
  waitlist_count?: number | null;
  /** Отменено (cancel_schedule_entry): клиенты не видят, записаться нельзя. */
  cancelled_at: string | null;
  cancel_reason: string | null;
  workout?: {
    name: string;
    type?: string;
    capacity?: number | null;
    /** Пакетный формат: цвет полоски на карточке. */
    color?: string | null;
    translations?: unknown;
  } | null;
  schedule_entry_trainers?: {
    trainer_id: string;
    trainer: Trainer | null;
    /**
     * Замена (пакетные клубы): этот тренер заменяет replaced_trainer_id —
     * schedule_entry_substitutions. Связь «один к одному»; без схемы базы
     * разбор select может отдать и массив.
     */
    substitution?: SubstitutionRow | SubstitutionRow[] | null;
  }[];
  /** Записи с карточками клиентов — для подписи персонального на карточке. */
  participants?: { status: string; client_id: string | null; client: ParticipantName | null }[];
};

type ParticipantName = {
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  id: string;
  /** Абонементы клиента: когда выдан и вид (пробный или нет) — для «новеньких». */
  client_memberships?: { created_at: string; membership: { kind: string | null } | null }[];
};

/**
 * Клиенты персонального занятия: «Фамилия Имя» записанных (не отменённых).
 * Карточку, которую RLS не отдаёт (клиент чужой базы клиентов), — «Гость»
 * (имя — в окне занятия). Клиенты пакетных клубов — одна база (2026-10-17),
 * их карточки видны.
 */
function participantNames(e: Entry) {
  return (e.participants ?? [])
    .filter((p) => (p.client || p.client_id) && (p.status === "booked" || p.status === "attended"))
    .map((p) => (p.client ? clientName(p.client) : "Гость"))
    .join(", ");
}

/**
 * Новенькие на занятии — записанные клиенты, у которых к началу занятия не
 * было абонементов, кроме пробного (решение владельца 2026-10-13). Не текущий
 * статус ПЧК: «Посетил» без абонемента не отметить, пробное — тоже абонемент,
 * и после занятия пробник уже ЧК — счётчик прошедших занятий обнулялся бы.
 */
function newcomerIds(e: Entry): Set<string> {
  const start = new Date(e.starts_at).getTime();
  const ids = new Set<string>();
  for (const p of e.participants ?? []) {
    if (!p.client || (p.status !== "booked" && p.status !== "attended")) continue;
    const hadPackage = (p.client.client_memberships ?? []).some(
      (m) => m.membership?.kind !== "trial" && new Date(m.created_at).getTime() < start,
    );
    if (!hadPackage) ids.add(p.client.id);
  }
  return ids;
}

/** Занятие к созданию: строка schedule_entries и тренеры, которых к ней привязать. */
type EntryDraft = {
  kind: ActivityKind;
  workout_id: string | null;
  /** Групповое: пусто — вместимость тренировки в клубе (ставит база). */
  capacity?: number | null;
  title: string | null;
  pay_rate: number | null;
  starts_at: string;
  ends_at: string;
  trainerIds: string[];
};

const ENTRY_SELECT =
  "*, workout:workouts(name, type, capacity, color, translations), schedule_entry_trainers(trainer_id, trainer:trainers(id, full_name, translations), substitution:schedule_entry_substitutions(replaced_trainer_id, replaced:trainers(full_name))), participants:schedule_bookings(status, client_id, client:clients(id, first_name, last_name, full_name, client_memberships(created_at, membership:memberships(kind))))";
// Колонки справочников входят в ключ запроса: разделы «Тренировки» и «Сотрудники»
// грузят те же таблицы целиком, и общий ключ подсовывал бы им наш урезанный кэш.
const WORKOUT_COLS =
  "id, name, type, capacity, color, capacities:workout_capacities(studio_id, capacity)";
// Сотрудники общие для студий: в расписание ставим тех, кто привязан к этой
// студии (trainer_studios). Занятия ведут тренеры; на прочую активность
// (например, фотосъёмку) можно отметить и администраторов.
const STAFF_COLS = "id, full_name, role, photo_url, trainer_studios!inner(studio_id)";

/** Полоска на карточках персональных занятий и прочих активностей. */
const NON_GROUP_STRIPE = "#262626";

/**
 * Причины отмены занятия (решение владельца 2026-10-11: не больше четырёх,
 * пятая — «Другое» со своим текстом). Первая — самая частая, выбрана сразу.
 */
const ENTRY_CANCEL_REASONS = [
  "Мало записавшихся",
  "Заболел тренер",
  "Технические проблемы в зале",
  "Праздник или нерабочий день",
];
const OTHER_REASON = "other";

const ADMIN_CANCEL_REASONS = [
  "Клиент отменил",
  "Клиент не пришёл",
  "Замена или перенос",
  "Технические причины",
  "Другое",
];
const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
// Полноэкранный просмотр — на английском: скриншот уходит клиентам с разными
// языками (решение владельца 2026-10-13).
const DAY_NAMES_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Английский перевод поля контента, нет — русский текст. */
function enText(translations: unknown, field: string, ru: string) {
  return translationText(parseTranslations(translations), "en", field).trim() || ru;
}
// Часы сетки по умолчанию — 7..22; занятие раньше или позже расширяет сетку
// (иначе оно было бы в базе, но не на экране).
// С 9:00: на 7 и 8 утра занятий не бывает (решение владельца 2026-10-13);
// занятие раньше всё равно покажется — сетка расширится до его часа.
const FIRST_HOUR = 9;
const LAST_HOUR = 22;
// Высота часа с занятиями — по самой высокой карточке (две строки названия +
// строка тренеров или «тренер + клиент» в две строки). Меняешь вёрстку
// EntryCard — перемерь и поправь здесь и в SLOT_FULL (page-skeletons.tsx).
const SLOT_PX_FULL = 72;
const SLOT_PX_EMPTY = 28;
// Полноэкранный просмотр: высота строки с занятиями — по карточкам, пустой
// час между занятиями — узкая полоска.
const SLOT_PX_FULLSCREEN_EMPTY = 16;
const ALL_FILTER_VALUE = "all";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function startOfWeek(d: Date) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDate(d: Date, en = false) {
  return d.toLocaleDateString(en ? "en-GB" : "ru-RU", { day: "2-digit", month: "short" });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function nextFullHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** Ячейка сетки «день + час». */
function todayIndex() {
  return (new Date().getDay() + 6) % 7;
}

function cellKey(day: Date, hour: number) {
  return `${day.toDateString()}|${hour}`;
}

/**
 * «Что + начало» — так узнаём одно и то же занятие на соседней неделе:
 * групповое — по тренировке, персональное — по тренеру, прочее — по названию.
 */
function entryKey(
  e: Pick<EntryDraft, "kind" | "workout_id" | "title" | "starts_at" | "trainerIds">,
) {
  const subject =
    e.kind === "group"
      ? e.workout_id
      : isOneOnOne(e.kind)
        ? [...e.trainerIds].sort().join(",")
        : e.title?.trim().toLowerCase();
  return `${e.kind}|${subject}|${new Date(e.starts_at).toISOString()}`;
}

function trainerIdsOf(e: Pick<Entry, "schedule_entry_trainers">) {
  return e.schedule_entry_trainers?.map((x) => x.trainer_id) ?? [];
}

/** Тренеры для копии занятия: вместо заменяющего — тот, кого заменили. */
function regularTrainerIdsOf(e: Pick<Entry, "schedule_entry_trainers">) {
  return regularTrainerIds(e.schedule_entry_trainers);
}

/** Подпись занятия на карточке и в баннере копирования; `en` — полный экран. */
function entryTitle(e: Entry, en = false) {
  if (e.kind === "personal") return en ? "Personal training" : "Персональное занятие";
  if (e.kind === "diagnostic") return en ? "Body diagnostics" : "Диагностика";
  // Название прочей активности — свободный текст без переводов.
  if (e.kind === "other") return e.title ?? (en ? "Activity" : "Прочая активность");
  const name = e.workout?.name ?? (en ? "Class" : "Занятие");
  return en ? enText(e.workout?.translations, "name", name) : name;
}

/**
 * Вместимость занятия: своя или по умолчанию из тренировки; 0 и пусто — без
 * лимита. Одна на сетку и панель записей: панель раньше брала только свою и
 * при вместимости из тренировки показывала «3» вместо «3 / 12».
 */
function entryCapacity(e: Entry) {
  return (e.capacity ?? e.workout?.capacity) || null;
}

/** Копия занятия с новым началом: тот же тип, тренировка, длительность и тренеры. */
function copyDraft(e: Entry, start: Date): EntryDraft {
  const duration = new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime();
  return {
    kind: e.kind,
    workout_id: e.workout_id,
    capacity: e.capacity,
    title: e.title,
    pay_rate: e.pay_rate,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + duration).toISOString(),
    trainerIds: regularTrainerIdsOf(e),
  };
}

/** Привязывает тренеров к занятиям; возвращает текст ошибки или null. */
async function linkTrainers(links: { entry_id: string; trainer_id: string }[]) {
  if (links.length === 0) return null;
  const { error } = await supabase.from("schedule_entry_trainers").insert(links);
  return error?.message ?? null;
}

type InsertResult =
  | { ok: false; error: string }
  | { ok: true; count: number; ids: string[]; trainersError: string | null };

/**
 * Создаёт занятия вместе с привязками тренеров — общий путь для «Нового
 * занятия», вставки скопированного и «Дублировать неделю». Ошибку привязки
 * тренеров отдаём отдельно: занятия к этому моменту уже созданы, и повторная
 * вставка дала бы дубли.
 */
async function insertEntries(studioId: string, drafts: EntryDraft[]): Promise<InsertResult> {
  // id задаём сами: тренеров привязываем по нему, а не по порядку строк в
  // ответе на вставку (его база не гарантирует) и не по «тренировка + начало»
  // (у персональных и прочих тренировки нет).
  const rows = drafts.map((d) => ({
    id: crypto.randomUUID(),
    studio_id: studioId,
    kind: d.kind,
    workout_id: d.workout_id,
    capacity: d.capacity ?? null,
    title: d.title,
    pay_rate: d.pay_rate,
    starts_at: d.starts_at,
    ends_at: d.ends_at,
  }));
  const { error } = await supabase.from("schedule_entries").insert(rows);
  if (error) return { ok: false, error: error.message };
  const links = rows.flatMap((row, i) =>
    drafts[i].trainerIds.map((trainer_id) => ({ entry_id: row.id, trainer_id })),
  );
  return {
    ok: true,
    count: rows.length,
    ids: rows.map((r) => r.id),
    trainersError: await linkTrainers(links),
  };
}

function SchedulePage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  // Пакетные студии: у тренировок нет типа — фильтра по типу нет, карточка
  // занятия светлая с полоской цвета тренировки (2026-10-11).
  const studio = useActiveStudio();
  const packages = studio?.format === "packages";
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [presetStart, setPresetStart] = useState<Date | null>(null);
  // Новое занятие: сначала окно выбора типа, потом форма выбранного типа.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formKind, setFormKind] = useState<ActivityKind>("group");
  // Фильтр типов занятий не запоминается: при входе в раздел видны все типы.
  const [kindFilter, setKindFilter] = useState<ActivityKind[]>(ACTIVITY_KIND_VALUES);
  // Отменённые занятия по умолчанию скрыты и тоже не запоминаются.
  const [showCancelled, setShowCancelled] = useState(false);
  const [filterType, setFilterType] = useState<string>(ALL_FILTER_VALUE);
  const [filterTrainerId, setFilterTrainerId] = useState<string>(ALL_FILTER_VALUE);
  const [filterWorkoutId, setFilterWorkoutId] = useState<string>(ALL_FILTER_VALUE);
  const [copySource, setCopySource] = useState<Entry | null>(null);
  // Полноэкранный просмотр — для скриншота клиенту: только сетка с текущими
  // фильтрами, без копирования, остатка мест и подсказок администратору.
  const [fullscreen, setFullscreen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [duplicatingWeek, setDuplicatingWeek] = useState(false);
  // На телефоне сетка показывает один день недели (семь колонок по 1200px
  // не помещались): выбранный день — индекс 0..6 от понедельника.
  const isMobile = useIsMobile();
  const [dayIndex, setDayIndex] = useState(() => todayIndex());
  // Текущее время — красная линия в колонке сегодняшнего дня; сдвигается
  // раз в 30 секунд.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Справочники зависят только от студии, занятия — ещё и от недели: листание
  // недель не перезапрашивает тренировки и тренеров. Тренировки пакетных
  // клубов общие (lib/studio-catalog.ts).
  const catalogIds = useCatalogStudioIds();
  const {
    data: workouts = [],
    isFetching: workoutsFetching,
    isPending: workoutsPending,
  } = useQuery({
    queryKey: ["workouts", studioId, WORKOUT_COLS, catalogIds?.join(",")],
    queryFn: () =>
      unwrap<Workout[]>(
        supabase.from("workouts").select(WORKOUT_COLS).in("studio_id", catalogIds!).order("name"),
      ),
    enabled: !!studioId && !!catalogIds,
    meta: { errorMessage: "Ошибка загрузки тренировок" },
  });
  const { data: staff = [], isFetching: trainersFetching } = useQuery({
    queryKey: ["trainers", studioId, STAFF_COLS],
    queryFn: () =>
      unwrap<Trainer[]>(
        supabase
          .from("trainers")
          .select(STAFF_COLS)
          .eq("trainer_studios.studio_id", studioId!)
          .order("full_name"),
      ),
    enabled: !!studioId,
    meta: { errorMessage: "Ошибка загрузки сотрудников" },
  });
  const trainers = useMemo(() => staff.filter((t) => t.role === "trainer"), [staff]);
  // Без placeholderData: пока грузится новая неделя, занятий нет вовсе, а не
  // занятия прошлой — иначе «Дублировать неделю» скопировал бы чужую неделю.
  // Ответ, пришедший после перелистывания, ложится в кэш своей недели.
  const weekFrom = weekStart.toISOString();
  const {
    data: entries = [],
    isFetching: entriesFetching,
    isPending: entriesPending,
  } = useQuery({
    queryKey: ["schedule_entries", studioId, weekFrom],
    queryFn: () =>
      unwrap<Entry[]>(
        supabase
          .from("schedule_entries")
          .select(ENTRY_SELECT)
          .eq("studio_id", studioId!)
          .gte("starts_at", weekFrom)
          .lt("starts_at", addDays(weekStart, 7).toISOString())
          .order("starts_at"),
      ),
    enabled: !!studioId,
    meta: { errorMessage: "Ошибка загрузки расписания" },
  });
  const loading = workoutsFetching || trainersFetching || entriesFetching;
  const reloadEntries = () => queryClient.invalidateQueries({ queryKey: ["schedule_entries"] });

  const weekLabel = `${fmtDate(weekStart)} — ${fmtDate(addDays(weekStart, 6))}`;
  const isCurrentWeek = startOfWeek(new Date()).toDateString() === weekStart.toDateString();
  // Фильтр типа, выбранный в подписочной студии, в пакетной не действует.
  const typeFilter = packages ? ALL_FILTER_VALUE : filterType;
  // Тренировки этой недели — для фильтра: в списке только то, что стоит в
  // расписании на экране, с цветом тренировки (у подписочных — цветом типа).
  const weekWorkouts = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; color: string | null }>();
    for (const e of entries) {
      if (e.kind !== "group" || !e.workout_id || byId.has(e.workout_id)) continue;
      byId.set(e.workout_id, {
        id: e.workout_id,
        name: e.workout?.name ?? "Тренировка",
        color: e.workout?.color ?? dayTypeColor(e.workout?.type)?.hex ?? null,
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [entries]);
  // Выбранной тренировки нет на этой неделе — фильтр не действует.
  const workoutFilter = weekWorkouts.some((w) => w.id === filterWorkoutId)
    ? filterWorkoutId
    : ALL_FILTER_VALUE;
  const filtersActive =
    typeFilter !== ALL_FILTER_VALUE ||
    workoutFilter !== ALL_FILTER_VALUE ||
    filterTrainerId !== ALL_FILTER_VALUE ||
    kindFilter.length !== ACTIVITY_KIND_VALUES.length ||
    showCancelled;

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  // Колонки сетки: на телефоне — только выбранный день. Индекс дня храним,
  // чтобы подпись (Пн, Вт…) и ключ ячейки оставались прежними.
  const visibleDays = isMobile ? [dayIndex] : weekDays.map((_, i) => i);

  // Видимые занятия раскладываем по ячейкам один раз, а не сканируем весь
  // список для каждой ячейки и каждого часа.
  const grid = useMemo(() => {
    const cells = new Map<string, Entry[]>();
    const busyHours = new Set<number>();
    // Занятий по дням недели — точки под днями в переключателе на телефоне.
    const perDay = Array.from({ length: 7 }, () => 0);
    for (const e of entries) {
      if (e.cancelled_at && !showCancelled) continue;
      if (!kindFilter.includes(e.kind)) continue;
      // Тип тренировки есть только у групповых: при выбранном типе прочие скрыты.
      if (typeFilter !== ALL_FILTER_VALUE && (e.kind !== "group" || e.workout?.type !== typeFilter))
        continue;
      // Тренировка есть только у групповых: при выбранной прочие скрыты.
      if (workoutFilter !== ALL_FILTER_VALUE && e.workout_id !== workoutFilter) continue;
      if (
        filterTrainerId !== ALL_FILTER_VALUE &&
        !e.schedule_entry_trainers?.some((x) => x.trainer_id === filterTrainerId)
      )
        continue;
      const start = new Date(e.starts_at);
      const key = cellKey(start, start.getHours());
      cells.set(key, [...(cells.get(key) ?? []), e]);
      busyHours.add(start.getHours());
      perDay[(start.getDay() + 6) % 7]++;
    }
    const hourList = [...busyHours];
    const first = Math.min(FIRST_HOUR, ...hourList);
    const last = Math.max(LAST_HOUR, ...hourList);
    const hours = Array.from({ length: last - first + 1 }, (_, i) => i + first);
    // Полный экран — только часы от первого до последнего занятия.
    const compactHours = hourList.length
      ? hours.filter((h) => h >= Math.min(...hourList) && h <= Math.max(...hourList))
      : hours;
    return { cells, busyHours, perDay, hours, compactHours };
  }, [entries, kindFilter, typeFilter, workoutFilter, filterTrainerId, showCancelled]);

  // Браузерный полноэкранный режим прячет вкладки и адресную строку; выход
  // из него (Esc, жест) закрывает и наш. Без поддержки (iPhone) — просто
  // слой поверх страницы, закрывается крестиком или Esc.
  const openFullscreen = () => {
    setCopySource(null);
    setFullscreen(true);
    // Весь документ, а не слой: окна занятия (портал в body) остаются видны.
    document.documentElement.requestFullscreen?.().catch(() => {});
  };
  const closeFullscreen = () => {
    setFullscreen(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  useEffect(() => {
    if (!fullscreen) return;
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    // Esc в открытом окне занятия закрывает только окно.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  // Полный экран: неделя целиком помещается в экран — сетка уменьшается
  // (transform: scale, ширина раскладки — 100 / масштаб %, чтобы по ширине
  // заполнять экран) до наибольшего масштаба, при котором влезает по высоте.
  // Масштаб подбирается делением пополам: в уменьшенной сетке колонки шире,
  // названия переносятся реже, высота падает быстрее масштаба. CSS zoom не
  // годится: размеры увеличенного элемента в Chrome меряются неверно.
  const fitBoxRef = useRef<HTMLDivElement>(null);
  const fitGridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = fitBoxRef.current;
    const el = fitGridRef.current;
    if (!box || !el) return;
    const apply = (scale: number) => {
      const scaled = scale < 1;
      el.style.transformOrigin = scaled ? "0 0" : "";
      el.style.transform = scaled ? `scale(${scale})` : "";
      el.style.width = scaled ? `${100 / scale}%` : "";
      box.style.overflow = scaled ? "hidden" : "";
    };
    if (!fullscreen) {
      apply(1);
      return;
    }
    const fits = (scale: number) => {
      apply(scale);
      return el.offsetHeight * scale <= box.clientHeight;
    };
    const fit = () => {
      if (fits(1)) return;
      let lo = 0.3;
      let hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      apply(lo);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box, { box: "border-box" });
    return () => {
      observer.disconnect();
      apply(1);
    };
  }, [fullscreen, grid, dayIndex]);

  const openSlot = (day: Date, hour: number) => {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    if (copySource) {
      pasteCopy(copySource, start);
      return;
    }
    setEditing(null);
    setPresetStart(start);
    setPickerOpen(true);
  };

  const pickKind = (kind: ActivityKind) => {
    setFormKind(kind);
    setPickerOpen(false);
    setDialogOpen(true);
  };

  const startCopy = (e: Entry) => {
    setCopySource(e);
    toast.message("Выберите пустой слот, куда скопировать занятие");
  };

  const pasteCopy = async (source: Entry, start: Date) => {
    if (!studioId || pasting) return;
    setPasting(true);
    try {
      const res = await insertEntries(studioId, [copyDraft(source, start)]);
      if (!res.ok) {
        toast.error("Ошибка копирования: " + res.error);
        return;
      }
      setCopySource(null);
      if (res.trainersError) {
        toast.error("Занятие создано, но тренеры не привязаны: " + res.trainersError);
      } else {
        toast.success("Занятие скопировано");
      }
      reloadEntries();
    } finally {
      setPasting(false);
    }
  };

  const duplicateWeek = async () => {
    if (!studioId || duplicatingWeek) return;
    if (entries.length === 0) {
      toast.error("На текущей неделе нет занятий для копирования");
      return;
    }
    const nextWeekStart = addDays(weekStart, 7);
    // Подтверждение — до копирования; само копирование идёт со спиннером на
    // кнопке в шапке, при ошибке её можно нажать снова.
    if (
      !(await confirm({
        title: "Дублировать неделю?",
        description: `Все занятия с недели ${weekLabel} (${entries.length}) будут скопированы на следующую неделю (${fmtDate(nextWeekStart)} — ${fmtDate(addDays(nextWeekStart, 6))}) в те же дни и время, с теми же тренерами. Записи клиентов не копируются. Уже существующие на следующей неделе занятия (то же занятие и время) пропускаются.`,
        confirmLabel: "Дублировать",
        destructive: false,
      }))
    )
      return;
    setDuplicatingWeek(true);
    try {
      // Уже стоящие на следующей неделе занятия (то же занятие и время) не дублируем.
      const { data: existing, error: exErr } = await supabase
        .from("schedule_entries")
        .select(
          "kind, workout_id, title, starts_at, schedule_entry_trainers(trainer_id, substitution:schedule_entry_substitutions(replaced_trainer_id))",
        )
        .eq("studio_id", studioId)
        .gte("starts_at", nextWeekStart.toISOString())
        .lt("starts_at", addDays(nextWeekStart, 7).toISOString());
      if (exErr) {
        toast.error("Ошибка проверки следующей недели: " + exErr.message);
        return;
      }
      const existingKeys = new Set(
        (
          (existing ?? []) as Pick<
            Entry,
            "kind" | "workout_id" | "title" | "starts_at" | "schedule_entry_trainers"
          >[]
        ).map((e) => entryKey({ ...e, trainerIds: regularTrainerIdsOf(e) })),
      );
      const drafts = entries
        .map((e) => copyDraft(e, new Date(new Date(e.starts_at).getTime() + WEEK_MS)))
        .filter((d) => !existingKeys.has(entryKey(d)));
      if (drafts.length === 0) {
        toast.info("Все занятия уже скопированы на следующую неделю");
        return;
      }

      const res = await insertEntries(studioId, drafts);
      if (!res.ok) {
        toast.error("Ошибка копирования недели: " + res.error);
        return;
      }
      if (res.trainersError) {
        toast.error("Занятия скопированы, но тренеры не привязаны: " + res.trainersError);
      } else {
        toast.success(`Скопировано занятий: ${res.count}`);
      }
      setWeekStart(nextWeekStart);
    } finally {
      setDuplicatingWeek(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setPresetStart(null);
    setPickerOpen(true);
  };

  const openEdit = (e: Entry) => {
    setEditing(e);
    setFormKind(e.kind);
    setPresetStart(null);
    setDialogOpen(true);
  };

  /** true — занятие удалено (окно можно закрыть), false — отказ или ошибка. */
  const handleDelete = async (e: Entry) => {
    if (
      !(await confirm({
        title: "Удалить занятие?",
        // Брони (schedule_bookings) удаляются каскадом: списанное возвращает
        // триггер …_zzzzzzzz_review_fixes.sql, журнал переводит в «Отменено»
        // …_schedule_entry_delete.sql.
        description:
          "Записи клиентов на него будут отменены, списанные тренировки вернутся на абонементы. Если занятие состоялось или переносится, лучше «Отменить» — оно останется в расписании.",
      }))
    )
      return false;
    const { error } = await supabase.from("schedule_entries").delete().eq("id", e.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return false;
    }
    toast.success("Занятие удалено");
    reloadEntries();
    return true;
  };

  return (
    <AdminShell
      title="Расписание"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={duplicateWeek}
            disabled={!studioId || entries.length === 0 || loading || duplicatingWeek}
          >
            {duplicatingWeek ? <Loader2 className="animate-spin" /> : <Copy />}
            {/* На телефоне — коротко, чтобы обе кнопки встали в одну строку. */}
            Дублировать<span className="max-sm:hidden"> неделю</span>
          </Button>
          <Button onClick={openAdd} disabled={!studioId}>
            <Plus />
            Добавить<span className="max-sm:hidden"> занятие</span>
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <PeriodStepper
              unit="week"
              label={weekLabel}
              onPrev={() => setWeekStart(addDays(weekStart, -7))}
              onNext={() => setWeekStart(addDays(weekStart, 7))}
              onCurrent={() => {
                setWeekStart(startOfWeek(new Date()));
                setDayIndex(todayIndex());
              }}
              isCurrent={isCurrentWeek}
            >
              {/* Первая загрузка недели — скелетон в сетке, спиннер — только для обновления. */}
              {loading && !entriesPending && (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              )}
            </PeriodStepper>

            <div className="toolbar-full flex flex-wrap items-center gap-2 sm:ml-auto">
              <Button
                variant="outline"
                size="icon"
                aria-label="Во весь экран"
                title="Во весь экран — для скриншота клиенту"
                onClick={openFullscreen}
              >
                <Maximize />
              </Button>
              {!packages && (
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger
                    aria-label="Тип тренировки"
                    className="w-40 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1"
                  >
                    <SelectValue placeholder="Все типы" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER_VALUE}>Все типы</SelectItem>
                    {DAY_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {packages ? (
                <ActivityTypesFilter
                  value={kindFilter}
                  onChange={setKindFilter}
                  cancelled={showCancelled}
                  onCancelledChange={setShowCancelled}
                />
              ) : (
                <KindFilter value={kindFilter} onChange={setKindFilter} />
              )}
              <Select value={workoutFilter} onValueChange={setFilterWorkoutId}>
                <SelectTrigger
                  aria-label="Тренировка"
                  className="w-48 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1"
                >
                  {/* Пакетные клубы: тренировка — «Направление» (2026-10-13). */}
                  <SelectValue>
                    {packages && workoutFilter === ALL_FILTER_VALUE ? "Направление" : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER_VALUE}>
                    {packages ? "Все направления" : "Все тренировки"}
                  </SelectItem>
                  {weekWorkouts.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      <WorkoutOption name={w.name} color={w.color} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterTrainerId} onValueChange={setFilterTrainerId}>
                <SelectTrigger
                  aria-label="Сотрудник"
                  className="w-48 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1"
                >
                  <SelectValue placeholder="Все сотрудники" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER_VALUE}>Все сотрудники</SelectItem>
                  {/* С администраторами: их отмечают на прочих активностях. */}
                  {staff.map((t) => (
                    <SelectItem key={t.id} value={t.id} textValue={t.full_name}>
                      <StaffOption name={t.full_name} photo={t.photo_url} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ToolbarReset
                active={filtersActive}
                onReset={() => {
                  setFilterType(ALL_FILTER_VALUE);
                  setFilterWorkoutId(ALL_FILTER_VALUE);
                  setFilterTrainerId(ALL_FILTER_VALUE);
                  setKindFilter(ACTIVITY_KIND_VALUES);
                  setShowCancelled(false);
                }}
              />
            </div>
          </TableToolbar>

          {copySource && !fullscreen && (
            <InfoNote
              variant="info"
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                {pasting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span>
                  Копирование «{entryTitle(copySource)}» — кликните на свободный слот, чтобы
                  вставить.
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCopySource(null)}
                disabled={pasting}
              >
                <X />
                Отмена
              </Button>
            </InfoNote>
          )}

          {/*
            Телефон: переключатель дня вместо шапки сетки. Точка под днём —
            в этот день есть занятия (с учётом фильтров); сегодня — розовым,
            как отметка «сегодня» в недельной сетке.
          */}
          <div
            className={cn(
              fullscreen
                ? "fixed inset-0 z-50 flex flex-col gap-2 bg-background p-3 sm:p-4"
                : "space-y-3",
            )}
          >
            {fullscreen && (
              <div className="flex items-center justify-between gap-3">
                {/* Заголовок и неделя — одной строкой: по высоте остаётся
                    больше места сетке (решение владельца 2026-10-19). */}
                <div className="flex min-w-0 items-baseline gap-3">
                  <div className="truncate text-xl font-bold">
                    {studio?.name
                      ? `Schedule · ${enText(studio.translations, "name", studio.name)}`
                      : "Schedule"}
                  </div>
                  <div className="shrink-0 whitespace-nowrap text-base font-medium text-muted-foreground">
                    {fmtDate(weekStart, true)} — {fmtDate(addDays(weekStart, 6), true)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Выйти из полноэкранного режима"
                  title="Выйти из полноэкранного режима (Esc)"
                  onClick={closeFullscreen}
                >
                  <Minimize />
                </Button>
              </div>
            )}
            {isMobile && (
              <div className="grid grid-cols-7 gap-1 rounded-lg border bg-background p-1">
                {weekDays.map((d, i) => {
                  const today = d.toDateString() === new Date().toDateString();
                  const selected = i === dayIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={selected}
                      aria-label={d.toLocaleDateString(fullscreen ? "en-GB" : "ru-RU", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                      onClick={() => setDayIndex(i)}
                      className={cn(
                        "flex flex-col items-center rounded-md py-1.5 text-xs transition-colors",
                        selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        today && !selected && "text-brand-on-light",
                      )}
                    >
                      <span
                        className={cn("uppercase", !selected && !today && "text-muted-foreground")}
                      >
                        {(fullscreen ? DAY_NAMES_EN : DAY_NAMES)[i]}
                      </span>
                      <span className="text-base font-semibold tabular-nums leading-tight">
                        {d.getDate()}
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 size-1 rounded-full",
                          grid.perDay[i] > 0 ? "bg-current" : "bg-transparent",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            )}

            <div
              ref={fitBoxRef}
              className={cn(
                "overflow-auto rounded-lg border bg-background",
                fullscreen ? "min-h-0 flex-1" : "md:max-h-[calc(100dvh-220px)]",
              )}
            >
              <div
                ref={fitGridRef}
                className={cn("grid", !isMobile && !fullscreen && "min-w-[1200px]")}
                style={{
                  // Полный экран (скриншот клиенту): время крупнее — столбец шире.
                  gridTemplateColumns: `${fullscreen ? (isMobile ? 64 : 80) : isMobile ? 52 : 60}px repeat(${visibleDays.length}, minmax(0, 1fr))`,
                }}
              >
                {!isMobile && (
                  <>
                    <div className="sticky top-0 z-20 border-b border-r bg-background" />
                    {weekDays.map((d, i) => {
                      const today = d.toDateString() === new Date().toDateString();
                      return (
                        <div
                          key={i}
                          className={cn(
                            "sticky top-0 z-20 border-r bg-background text-center",
                            // Полный экран: дата и день недели крупно (их
                            // должно быть видно на скриншоте), одной строкой —
                            // «20 Oct (Mon)»: шапка ниже, сетке больше места.
                            fullscreen
                              ? "truncate px-2 py-1 text-lg font-bold leading-tight"
                              : "p-2 text-xs",
                            today
                              ? "border-b-4 border-b-brand font-semibold text-primary"
                              : "border-b",
                          )}
                        >
                          {fullscreen ? (
                            <>
                              {d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{" "}
                              {/* День недели чуть мельче даты (решение владельца 2026-10-19). */}
                              <span className="text-base font-semibold text-foreground/70">
                                ({DAY_NAMES_EN[i]})
                              </span>
                            </>
                          ) : (
                            <>
                              <div className="uppercase tracking-wide text-muted-foreground">
                                {DAY_NAMES[i]}
                              </div>
                              <div>
                                {d.toLocaleDateString("ru-RU", {
                                  day: "2-digit",
                                  month: "2-digit",
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}

                {(fullscreen ? grid.compactHours : grid.hours).map((hour) => {
                  const busy =
                    grid.busyHours.has(hour) ||
                    (entriesPending && SCHEDULE_SKELETON_HOURS.has(hour));
                  // Полный экран: строка с занятиями — по высоте карточек
                  // (undefined — авто), чтобы неделя помещалась в экран.
                  const rowHeight = fullscreen
                    ? busy
                      ? undefined
                      : SLOT_PX_FULLSCREEN_EMPTY
                    : busy
                      ? SLOT_PX_FULL
                      : SLOT_PX_EMPTY;
                  return (
                    <div key={`row-${hour}`} className="contents">
                      <div
                        className={cn(
                          "border-b border-r px-2 text-right",
                          fullscreen
                            ? "text-base font-semibold tabular-nums text-foreground"
                            : "text-xs text-muted-foreground",
                        )}
                        style={{
                          height: rowHeight,
                          lineHeight: fullscreen ? "1.25rem" : "1rem",
                          paddingTop: fullscreen && !busy ? 0 : 4,
                        }}
                      >
                        {/* Пустой час в полном экране — полоска без подписи. */}
                        {(!fullscreen || busy) && `${pad(hour)}:00`}
                      </div>
                      {visibleDays.map((di) => {
                        const day = weekDays[di];
                        return (
                          <div
                            key={`${hour}-${di}`}
                            className={cn(
                              "relative border-b border-r max-md:border-r-0",
                              // Пакетные студии: слоты — светлее подложки раздела (её цвет
                              // наполовину с белым фоном сетки), линии — обычные светло-серые
                              // (--border); шапка дней и столбец времени — белые.
                              packages && "bg-canvas/50",
                            )}
                            style={{ height: rowHeight }}
                          >
                            {/*
                          Кнопка слота лежит под карточками, а не оборачивает их:
                          кнопка внутри кнопки — невалидный HTML и ломает доступность.
                        */}
                            {!fullscreen && (
                              <button
                                type="button"
                                aria-label={`${copySource ? "Вставить" : "Добавить"} занятие: ${DAY_NAMES[di]}, ${pad(hour)}:00`}
                                onClick={() => openSlot(day, hour)}
                                className={cn(
                                  "absolute inset-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                  packages ? "hover:bg-black/5" : "hover:bg-accent/40",
                                )}
                              />
                            )}
                            {entriesPending && isScheduleSkeletonCell(hour, di, isMobile) && (
                              <EntryCardSkeleton />
                            )}
                            {/* Несколько занятий в одном часе — рядом, а не друг на друге.
                              Обёртка пропускает клики в промежутках к кнопке слота. */}
                            {grid.cells.has(cellKey(day, hour)) && (
                              <div
                                className={cn(
                                  "pointer-events-none flex gap-1",
                                  // Полный экран: карточки в потоке — высота
                                  // ячейки по содержимому, без пустоты снизу.
                                  fullscreen ? "h-full p-1" : "absolute inset-1",
                                )}
                              >
                                {grid.cells.get(cellKey(day, hour))?.map((e) => (
                                  <EntryCard
                                    key={e.id}
                                    entry={e}
                                    packages={packages}
                                    clean={fullscreen}
                                    onOpen={() => openEdit(e)}
                                    onCopy={() => startCopy(e)}
                                  />
                                ))}
                              </div>
                            )}
                            {/* Линия текущего времени — поверх карточек, но
                                клики пропускает (pointer-events-none). Под
                                липкой шапкой дней (z-20), в полном экране —
                                нет: это вид для клиента. */}
                            {!fullscreen &&
                              hour === now.getHours() &&
                              day.toDateString() === now.toDateString() && (
                                <div
                                  aria-hidden
                                  className="pointer-events-none absolute inset-x-0 z-10 h-0.5 -translate-y-1/2 bg-destructive"
                                  style={{ top: `${(now.getMinutes() / 60) * 100}%` }}
                                >
                                  <span className="absolute -left-1 top-1/2 size-2.5 -translate-y-1/2 rounded-full bg-destructive" />
                                </div>
                              )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {!fullscreen && !workoutsPending && workouts.length === 0 && (
            <InfoNote variant="empty">
              Чтобы добавлять групповые занятия, сначала создайте тренировки в разделе «Тренировки».
              Персональные занятия и прочие активности тренировок не требуют.
            </InfoNote>
          )}
        </RequireStudio>
      </div>

      <KindPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        packages={packages}
        hasWorkouts={workouts.length > 0}
        onPick={pickKind}
      />

      <EntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        kind={formKind}
        studioId={studioId}
        workouts={workouts}
        trainers={trainers}
        staff={staff}
        packages={packages}
        // Свежая строка из списка: после записи клиентов в окне booked_count
        // у снимка `editing` устаревает (предупреждение в «Отменить тренировку»).
        entry={editing ? (entries.find((x) => x.id === editing.id) ?? editing) : null}
        presetStart={presetStart}
        onSaved={reloadEntries}
        onDelete={handleDelete}
      />

      {confirmDialog}
    </AdminShell>
  );
}

/** Отметить или снять тип в фильтре, сохраняя порядок ACTIVITY_KIND_VALUES. */
function toggleKind(value: ActivityKind[], kind: ActivityKind, checked: boolean): ActivityKind[] {
  return ACTIVITY_KIND_VALUES.filter((k) => (k === kind ? checked : value.includes(k)));
}

/**
 * Фильтр по типам занятий подписочного клуба — галочки прямо в панели
 * фильтров (решение владельца 2026-10-11: на клик меньше, чем выпадающий
 * список). По умолчанию отмечены все; последний отмеченный тип снять нельзя
 * — пустая сетка только путает.
 */
function KindFilter({
  value,
  onChange,
}: {
  value: ActivityKind[];
  onChange: (v: ActivityKind[]) => void;
}) {
  const kinds = activityKindsFor("subscription");
  const shown = kinds.filter((k) => value.includes(k.value)).length;
  return (
    <div
      role="group"
      aria-label="Какие занятия показывать"
      className={cn(
        fieldClass,
        "flex h-auto min-h-10 w-auto flex-wrap items-center gap-x-4 gap-y-1 py-1.5 max-sm:w-full",
      )}
    >
      {kinds.map((k) => {
        const checked = value.includes(k.value);
        return (
          <CheckboxOption
            key={k.value}
            checked={checked}
            disabled={checked && shown === 1}
            onCheckedChange={(v) => onChange(toggleKind(value, k.value, v))}
            className="whitespace-nowrap"
          >
            {k.plural}
          </CheckboxOption>
        );
      })}
    </div>
  );
}

/**
 * «Типы активностей» пакетного клуба — выпадающий список с галочками
 * (решение владельца 2026-10-13): групповые, персональные, прочие и
 * «Отменённые». По умолчанию отмечено всё, кроме отменённых; последний
 * отмеченный тип снять нельзя.
 */
function ActivityTypesFilter({
  value,
  onChange,
  cancelled,
  onCancelledChange,
}: {
  value: ActivityKind[];
  onChange: (v: ActivityKind[]) => void;
  cancelled: boolean;
  onCancelledChange: (v: boolean) => void;
}) {
  const kinds = activityKindsFor("packages");
  const picked = kinds.filter((k) => value.includes(k.value));
  const all = picked.length === kinds.length;
  const label =
    all && !cancelled
      ? "Типы активностей"
      : [
          ...(all ? ["Все"] : picked.map((k) => k.plural)),
          ...(cancelled ? ["Отменённые"] : []),
        ].join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={`Типы активностей: ${label}`}
          title={label}
          className={cn(fieldTriggerClass, "w-48 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1")}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="space-y-0.5">
          {kinds.map((k) => {
            const checked = value.includes(k.value);
            return (
              <CheckboxOption
                key={k.value}
                checked={checked}
                disabled={checked && picked.length === 1}
                onCheckedChange={(v) => onChange(toggleKind(value, k.value, v))}
                className="rounded-md px-2 py-1.5 hover:bg-accent"
              >
                {k.plural}
              </CheckboxOption>
            );
          })}
          <div className="my-1 border-t" />
          <CheckboxOption
            checked={cancelled}
            onCheckedChange={onCancelledChange}
            className="rounded-md px-2 py-1.5 hover:bg-accent"
          >
            Отменённые
          </CheckboxOption>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Цвет тренировки: свой (пакетные клубы) или цвет её типа. */
function workoutColor(w: Pick<Workout, "color" | "type">) {
  return w.color ?? dayTypeColor(w.type)?.hex ?? null;
}

/**
 * Тренировка в выпадающем списке: цветной кружок и название — во всех
 * выборах тренировки (решение владельца 2026-10-13).
 */
function WorkoutOption({ name, color }: { name: string; color: string | null }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "var(--muted-foreground)" }}
      />
      {name}
    </span>
  );
}

/** Выбор типа нового занятия — плитки с иконками; дальше форма этого типа. */
function KindPickerDialog({
  open,
  onOpenChange,
  packages,
  hasWorkouts,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Пакетный клуб: есть диагностика. */
  packages: boolean;
  /** Групповое занятие ставится по тренировке — без тренировок плитка выключена. */
  hasWorkouts: boolean;
  onPick: (kind: ActivityKind) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Что добавить в расписание?</DialogTitle>
          <DialogDescription>Выберите тип занятия.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            className={cn("grid grid-cols-1 gap-3", packages ? "sm:grid-cols-2" : "sm:grid-cols-3")}
          >
            {activityKindsFor(packages ? "packages" : "subscription").map((k) => {
              const disabled = k.value === "group" && !hasWorkouts;
              return (
                <ChoiceCard
                  key={k.value}
                  stacked
                  disabled={disabled}
                  onClick={() => onPick(k.value)}
                  media={
                    <span
                      className="flex size-11 shrink-0 items-center justify-center rounded-lg sm:size-12"
                      style={{ backgroundColor: `${k.color}1f`, color: k.color }}
                    >
                      <k.icon className="size-6" />
                    </span>
                  }
                  title={k.label}
                  description={
                    disabled ? "Сначала создайте тренировки в разделе «Тренировки»" : k.description
                  }
                />
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Бейдж «записано/мест» и очередь листа ожидания на карточке занятия. */
function CapacityBadge({ entry }: { entry: Entry }) {
  const cap = entryCapacity(entry);
  if (!cap) return null;
  const left = Math.max(0, cap - entry.booked_count);
  const waiting = entry.waitlist_count ?? 0;
  const tone = left === 0 ? "negative" : left <= 5 ? "warning" : "neutral";
  return (
    <span className="flex shrink-0 items-center gap-1">
      <StatusChip tone={tone} size="sm" className="tabular-nums">
        {entry.booked_count}/{cap}
      </StatusChip>
      {waiting > 0 && (
        <StatusChip
          tone="info"
          size="sm"
          title="Люди в листе ожидания — записались, когда мест уже не было"
          className="tabular-nums"
        >
          +{waiting}
        </StatusChip>
      )}
    </span>
  );
}

/**
 * Сколько новеньких — только цифра, в цветах бейджа ПЧК, слева от счётчика
 * записей и в его форме (решение владельца 2026-10-13): длинному названию
 * не мешает.
 */
/**
 * Красный «!» слева от счётчика записей: занятие закончилось, а у записанных
 * не отмечено «Посетил» / «Не посетил» (решение владельца 2026-10-13).
 */
function UnmarkedBadge({ entry }: { entry: Entry }) {
  if (entry.cancelled_at || new Date(entry.ends_at).getTime() > Date.now()) return null;
  const n = (entry.participants ?? []).filter((p) => p.status === "booked").length;
  if (!n) return null;
  return (
    <StatusChip
      tone="negative"
      size="sm"
      title={`Не отмечены посещения: ${n}. Откройте занятие и отметьте «Посетил» или «Не посетил».`}
      aria-label="Не отмечены посещения"
      className="font-semibold"
    >
      !
    </StatusChip>
  );
}

function NewcomersBadge({ entry }: { entry: Entry }) {
  const n = newcomerIds(entry).size;
  if (!n) return null;
  return (
    <StatusChip
      tone="info"
      size="sm"
      title={`Новеньких: ${n} — до занятия не было абонементов, кроме пробного`}
      className="tabular-nums"
    >
      {/* Значок — чтобы «3» рядом с «5/12» не читалась загадкой без подсказки
          (на тач-экране title не всплывает). */}
      <UserPlus aria-hidden />
      {n}
      <span className="sr-only"> новеньких</span>
    </StatusChip>
  );
}

function EntryCard({
  entry,
  packages,
  clean,
  onOpen,
  onCopy,
}: {
  entry: Entry;
  /** Пакетная студия: светлая карточка с полоской цвета тренировки. */
  packages: boolean;
  /** Полноэкранный просмотр для клиента: без «Копировать» и остатка мест. */
  clean?: boolean;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const trainers = (entry.schedule_entry_trainers ?? []).flatMap((x) =>
    x.trainer ? [x.trainer] : [],
  );
  // Полный экран (скриншот клиентам) — имена тренеров на английском.
  const names = trainers
    .map((t) => (clean ? enText(t.translations, "full_name", t.full_name) : t.full_name))
    .join(", ");
  // Персональное: «тренер + клиент» — видно, с кем занятие. В полном экране
  // имён клиентов нет: скриншот уходит другим клиентам.
  const clients = isOneOnOne(entry.kind) && !clean ? participantNames(entry) : "";
  const people = [names, clients].filter(Boolean).join(" + ");
  // Персональные и прочие в обоих форматах — светлая карточка с тёмной
  // полоской: так они не путаются с групповыми.
  const group = entry.kind === "group";
  // Отменённое — белое в наклонную серую полоску, перед временем красный знак.
  const cancelled = !!entry.cancelled_at;
  if (packages || !group || cancelled) {
    return (
      <div
        className={cn(
          "pointer-events-auto relative h-full min-w-0 flex-1 overflow-hidden rounded-md border border-l-4 bg-background text-foreground",
          // Полный экран: строки времени, названия и тренера плотнее —
          // карточка ниже, в экран помещается больше занятий.
          clean ? "text-base leading-[1.1]" : "text-xs leading-tight",
          cancelled && "schedule-cancelled",
        )}
        title={
          cancelled && !clean
            ? `Отменено: ${entry.cancel_reason ?? "причина не указана"}`
            : undefined
        }
        // Без цвета (тренировка заведена до 2026-10-11) — серая полоска.
        style={{
          borderLeftColor: group
            ? (entry.workout?.color ?? "var(--muted-foreground)")
            : NON_GROUP_STRIPE,
        }}
      >
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "flex h-full w-full cursor-pointer flex-col px-1.5 text-left hover:bg-accent/40",
            clean ? "py-0.5" : "pt-0.5 pb-px",
          )}
        >
          <span className="flex w-full items-start justify-between gap-1">
            <span
              className={cn(
                "flex items-center gap-1 whitespace-nowrap",
                clean ? "font-semibold tabular-nums text-foreground/80" : "text-muted-foreground",
              )}
            >
              {cancelled && (
                <Ban
                  className={cn("shrink-0 text-rose-600", clean ? "size-4" : "size-3")}
                  aria-label={clean ? "Cancelled" : "Отменено"}
                />
              )}
              {fmtTime(entry.starts_at)}–{fmtTime(entry.ends_at)}
            </span>
            {!cancelled && !clean && (
              <span className="flex items-center gap-1">
                <UnmarkedBadge entry={entry} />
                <NewcomersBadge entry={entry} />
                <CapacityBadge entry={entry} />
              </span>
            )}
          </span>
          <span
            className={cn(
              "font-semibold",
              clean ? "text-lg leading-[1.05]" : "text-sm leading-[1.15]",
              // Персональному название в одну строку — место под клиента.
              clients ? "truncate" : "line-clamp-2",
            )}
          >
            {entryTitle(entry, clean)}
          </span>
          {/* Фото тренеров на карточке нет (решение владельца 2026-10-11) —
              только имена: карточка ниже. У персонального «тренер + клиент» —
              до двух строк, имя клиента не режем. pr-5 — место под «Копировать». */}
          {people && (
            <span
              className={cn(
                "min-w-0 text-muted-foreground",
                // Полный экран: «Копировать» нет — места под неё не держим.
                clean ? "font-medium" : "pr-5",
                clients ? "line-clamp-2 break-words" : "truncate",
              )}
            >
              {people}
            </span>
          )}
        </button>
        {!clean && (
          <button
            type="button"
            aria-label="Копировать занятие"
            title="Копировать занятие"
            onClick={onCopy}
            className="absolute bottom-1 right-1.5 rounded-full bg-muted p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground after:absolute after:-inset-1.5 after:rounded-full"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }
  const color = dayTypeColor(entry.workout?.type);
  const colorClasses = color ? `${color.bg} ${color.text}` : "bg-primary text-primary-foreground";
  return (
    <div
      className={cn(
        "pointer-events-auto relative h-full min-w-0 flex-1 overflow-hidden rounded-md",
        clean ? "text-base leading-[1.1]" : "text-xs leading-tight",
        colorClasses,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex h-full w-full cursor-pointer flex-col px-2 text-left hover:opacity-90",
          clean ? "py-0.5" : "pt-0.5 pb-px",
        )}
      >
        <span className="flex w-full items-start justify-between gap-1">
          <span
            className={cn("whitespace-nowrap", clean ? "font-semibold tabular-nums" : "opacity-90")}
          >
            {fmtTime(entry.starts_at)}–{fmtTime(entry.ends_at)}
          </span>
          {!clean && (
            <span className="flex items-center gap-1">
              <UnmarkedBadge entry={entry} />
              <NewcomersBadge entry={entry} />
              <CapacityBadge entry={entry} />
            </span>
          )}
        </span>
        <span
          className={cn(
            "font-semibold line-clamp-2",
            clean ? "text-lg leading-[1.05]" : "text-sm leading-[1.15]",
          )}
        >
          {entryTitle(entry, clean)}
        </span>
        {/* pr-5 — место под «Копировать» в углу. */}
        {names && (
          <span className={cn("block truncate opacity-90", clean ? "font-medium" : "pr-5")}>
            {names}
          </span>
        )}
      </button>
      {/* Соседняя кнопка поверх карточки, а не вложенная в неё — там же, где была. */}
      {!clean && (
        <button
          type="button"
          aria-label="Копировать занятие"
          title="Копировать занятие"
          onClick={onCopy}
          className="absolute bottom-1 right-2 rounded-full bg-black/25 p-0.5 text-white hover:bg-black/40 after:absolute after:-inset-1.5 after:rounded-full"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

type EntryDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Тип нового занятия; у правки — тип самого занятия (entry.kind). */
  kind: ActivityKind;
  studioId: string | null;
  workouts: Workout[];
  /** Тренеры студии — для групповых и персональных занятий. */
  trainers: Trainer[];
  /** Все сотрудники студии (и администраторы) — для прочей активности. */
  staff: Trainer[];
  /** Пакетная студия: отмена занятия и «Не посетил» у записанных. */
  packages: boolean;
  entry: Entry | null;
  presetStart: Date | null;
  onSaved: () => void;
  /** Спрашивает подтверждение и удаляет; true — удалено. */
  onDelete: (entry: Entry) => Promise<boolean>;
};

/** Тексты формы по типу занятия. */
const FORM_TEXT: Record<
  ActivityKind,
  { create: string; edit: string; hint: string; added: string; updated: string }
> = {
  group: {
    create: "Новое групповое занятие",
    edit: "Групповое занятие",
    hint: "Выберите тренировку, время и тренеров.",
    added: "Занятие добавлено",
    updated: "Занятие обновлено",
  },
  personal: {
    create: "Новое персональное занятие",
    edit: "Персональное занятие",
    hint: "Выберите тренера, клиента и время. Клиенты в приложении персональные занятия не видят.",
    added: "Персональное занятие добавлено",
    updated: "Персональное занятие обновлено",
  },
  diagnostic: {
    create: "Новая диагностика",
    edit: "Диагностика",
    hint: "Выберите тренера, клиента и время. Клиент увидит диагностику в приложении, «Посетил» спишет диагностику с его абонемента.",
    added: "Диагностика добавлена",
    updated: "Диагностика обновлена",
  },
  other: {
    create: "Новая прочая активность",
    edit: "Прочая активность",
    hint: "Название, время, сотрудники и ставка. Клиенты в приложении её не видят.",
    added: "Активность добавлена",
    updated: "Активность обновлена",
  },
};

const TIPS = {
  workout: "Из раздела «Тренировки»: оттуда берутся описание, фото и вместимость.",
  capacity:
    "Сколько человек можно записать. По умолчанию — вместимость тренировки в этом клубе из «Тренировок»; на этот день можно больше или меньше. Пусто — без лимита.",
  starts:
    "От него считается срок, до которого клиент может отменить запись сам (см. «Приложение» → «Контакты и правила»).",
  groupTrainers: "Клиенты видят их имена в расписании приложения. Можно выбрать нескольких.",
  groupTrainer: "Клиенты видят его имя в расписании приложения. На тренировке — один тренер.",
  personalTrainer:
    "Тренер, который проводит занятие. В зарплату ему пойдёт ставка за персональную тренировку из «Зарплатных ставок».",
  title: "Как активность будет подписана в расписании, например «Мастер-класс» или «Съёмка».",
  personalClients: "С кем занятие. Позже с абонемента на персональные будет списываться посещение.",
  diagnosticTrainer:
    "Тренер, который проводит диагностику. Время согласуйте с ним заранее — по заявке клиента («Обратная связь» → «Заявки»).",
  diagnosticClients:
    "Кому диагностика. «Посетил» спишет одну диагностику с абонемента клиента; клиент увидит её в приложении и сможет отменить.",
  groupClients:
    "Обычно клиенты записываются сами в приложении. Здесь — записать без приложения или на пробное.",
  otherStaff:
    "Тренеры и администраторы, которые участвуют, — им начислится ставка. Можно никого не выбирать.",
  payRate:
    "Сколько получит за эту активность каждый отмеченный сотрудник, в лари — пойдёт в зарплату. Без сотрудников можно не указывать.",
};

/** У заведённого занятия с записями окно в две колонки: слева настройки, справа клиенты. */
function hasBookingsPanel(entry: Entry | null): entry is Entry {
  return !!entry && entry.kind !== "other" && !entry.cancelled_at;
}

function EntryDialog({ open, ...formProps }: EntryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={formProps.onOpenChange}>
      {/* Заведённое занятие — широкое окно: записанные справа от настроек,
          их видно больше без прокрутки (решение владельца 2026-10-19, как в
          подробном отчёте дашборда). Новое и прочая активность — узкое. */}
      <DialogContent className={hasBookingsPanel(formProps.entry) ? "max-w-6xl" : "max-w-2xl"}>
        {/*
          Форма монтируется при каждом открытии и сбрасывать её не нужно. Раньше
          поля сбрасывал эффект по списку тренировок, и любая перезагрузка
          («Посетил» в панели записей, «Обновить» в шапке) затирала правки.
        */}
        <EntryForm key={formProps.entry?.id ?? `new-${formProps.kind}`} {...formProps} />
      </DialogContent>
    </Dialog>
  );
}

/** Ставка из поля ввода: null — пусто, NaN — не число или меньше нуля. */
function parsePayRate(v: string) {
  const s = v.trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Галочки сотрудников; с byRole — тренеры, массажисты и администраторы отдельными группами. */
function TrainerChecks({
  options,
  value,
  onToggle,
  byRole,
}: {
  options: Trainer[];
  value: string[];
  onToggle: (id: string) => void;
  byRole?: boolean;
}) {
  const checks = (list: Trainer[]) => (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {list.map((t) => (
        <CheckboxOption
          key={t.id}
          checked={value.includes(t.id)}
          onCheckedChange={() => onToggle(t.id)}
        >
          {t.full_name}
        </CheckboxOption>
      ))}
    </div>
  );
  // Неизвестная роль — к тренерам, руководитель студии — к администраторам.
  const groups = ROLE_GROUPS.map((g) => ({
    ...g,
    list: options.filter((t) => roleGroup(t.role) === g.role),
  })).filter((g) => g.list.length > 0);
  if (!byRole || groups.length < 2) {
    return <div className="rounded-md border p-3">{checks(options)}</div>;
  }
  return (
    <div className="space-y-3 rounded-md border p-3">
      {groups.map((g) => (
        <div key={g.role} className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">{g.label}</div>
          {checks(g.list)}
        </div>
      ))}
    </div>
  );
}

type TrainerOption = { id: string; full_name: string; photo_url?: string | null };

/**
 * Тренер заведённой групповой тренировки (пакетные клубы): «Замена» (тренер
 * заболел: клиенты увидят в приложении пометку «Замена» и прежнего тренера
 * неактивным) и «Редактировать» (ошиблись при заведении — просто другой
 * тренер, без следа в приложении). Замену можно отменить. Тренер на
 * тренировке один (решение владельца 2026-10-13): добавить второго нельзя, у
 * прежних занятий с несколькими лишних можно снять.
 */
function TrainerAssignments({
  options,
  value,
  subs,
  onChange,
}: {
  options: TrainerOption[];
  value: string[];
  subs: SubsMap;
  onChange: (ids: string[], subs: SubsMap) => void;
}) {
  // Строка в правке: индекс в value и режим.
  const [editing, setEditing] = useState<{ index: number; mode: PickMode } | null>(null);
  const byId = new Map(options.map((t) => [t.id, t]));
  const nameOf = (id: string) => byId.get(id)?.full_name ?? "Тренер";

  const apply = (next: TrainerAssignment) => onChange(next.ids, next.subs);
  const state = { ids: value, subs };
  const pick = (id: string) => {
    if (!editing) return;
    setEditing(null);
    apply(pickTrainer(state, editing.index, id, editing.mode, nameOf));
  };
  const undoSub = (index: number) => apply(undoSubstitution(state, index));
  const remove = (index: number) => apply(removeTrainer(state, index));

  const picker = (index: number, mode: PickMode) => {
    const current = value[index];
    const free = options.filter((t) => !value.includes(t.id));
    return (
      <div className="space-y-2">
        {mode === "replace" && (
          <InfoNote variant="warning">
            Замена будет видна клиентам в мобильном приложении: у тренировки появится пометка
            «Замена», в окне тренировки — прежний тренер неактивным и новый тренер.
          </InfoNote>
        )}
        <div className="flex items-center gap-2">
          <Select onValueChange={pick}>
            <SelectTrigger className="flex-1">
              <SelectValue
                placeholder={
                  mode === "replace" ? `Кто заменит: ${nameOf(current)}` : "Другой тренер"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {free.map((t) => (
                <SelectItem key={t.id} value={t.id} textValue={t.full_name}>
                  <StaffOption name={t.full_name} photo={t.photo_url ?? null} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
            Отмена
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-md border">
        {value.map((id, index) => {
          const t = byId.get(id);
          const sub = subs[id];
          return (
            <li key={id} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <StaffOption name={t?.full_name ?? "Тренер"} photo={t?.photo_url ?? null} />
                  {sub && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs font-medium text-amber-700">
                      <Repeat className="size-3.5 shrink-0" />
                      Замена · вместо {sub.name ?? nameOf(sub.id)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {sub ? (
                    <Button variant="outline" size="xs" onClick={() => undoSub(index)}>
                      <Undo2 />
                      Отменить замену
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setEditing({ index, mode: "replace" })}
                    >
                      <Repeat />
                      Замена
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setEditing({ index, mode: "edit" })}
                  >
                    <Pencil />
                    Редактировать
                  </Button>
                  {value.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Убрать с занятия"
                      title="Убрать с занятия"
                      onClick={() => remove(index)}
                    >
                      <X />
                    </Button>
                  )}
                </div>
              </div>
              {editing?.index === index && picker(index, editing.mode)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ROLE_GROUPS = [
  { role: "trainer", label: "Тренеры" },
  { role: "masseur", label: "Массажисты" },
  { role: "admin", label: "Администраторы" },
] as const;

/** «Без тренера» в выборе одного тренера: пустое значение Select не принимает. */
const NO_TRAINER = "none";

function NoTrainersNote({ staff }: { staff?: boolean }) {
  return (
    <InfoNote variant="empty">
      В клубе нет {staff ? "сотрудников" : "тренеров"}. Добавьте их в разделе «Сотрудники» (в рейке
      слева) и отметьте этот клуб.
    </InfoNote>
  );
}

function EntryForm({
  onOpenChange,
  kind: newKind,
  studioId,
  workouts,
  trainers,
  staff,
  packages,
  entry,
  presetStart,
  onSaved,
  onDelete,
}: Omit<EntryDialogProps, "open">) {
  // Тип занятия после создания не меняется.
  const kind = entry?.kind ?? newKind;
  const text = FORM_TEXT[kind];
  const [workoutId, setWorkoutId] = useState(entry?.workout_id ?? workouts[0]?.id ?? "");
  // Вместимость занятия: по умолчанию — тренировки в этом клубе («Тренировки»),
  // на один день можно больше или меньше. Пусто — без лимита.
  const defaultCapacity = (id: string) =>
    workoutCapacityIn(
      workouts.find((w) => w.id === id),
      studioId,
    );
  const [capacity, setCapacity] = useState(() => {
    const c = entry?.capacity ?? defaultCapacity(workoutId);
    return c ? String(c) : "";
  });
  const pickWorkout = (id: string) => {
    setWorkoutId(id);
    const c = defaultCapacity(id);
    setCapacity(c ? String(c) : "");
  };
  const [title, setTitle] = useState(entry?.title ?? "");
  const [payRate, setPayRate] = useState(entry?.pay_rate != null ? String(entry.pay_rate) : "");
  const [startsAt, setStartsAt] = useState(() =>
    toDateTimeLocalValue(entry ? new Date(entry.starts_at) : (presetStart ?? nextFullHour())),
  );
  const [endsAt, setEndsAt] = useState(() => {
    if (entry) return toDateTimeLocalValue(new Date(entry.ends_at));
    const end = new Date(startsAt);
    end.setHours(end.getHours() + 1);
    return toDateTimeLocalValue(end);
  });
  const [trainerIds, setTrainerIds] = useState<string[]>(() => (entry ? trainerIdsOf(entry) : []));
  // Замены: тренер занятия → кого он заменяет (пакетные клубы, групповое).
  const [subs, setSubs] = useState<SubsMap>(() => substitutionsOf(entry?.schedule_entry_trainers));
  // У заведённой групповой тренировки с тренерами — не галочки, а список
  // тренеров с «Замена» / «Редактировать» (решение владельца 2026-10-13).
  const assignMode = packages && !!entry && kind === "group" && trainerIdsOf(entry).length > 0;
  // Пакетные клубы: тренер на групповой тренировке один (2026-10-13) — у
  // новой и у заведённой без тренера выбор из списка, а не галочки.
  const singleGroupTrainer = packages && kind === "group" && !assignMode;
  // Клиенты нового занятия: записываются после его создания. У созданного —
  // панель записей, там запись сразу.
  const [pending, setPending] = useState<PickedClient[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const busy = saving || deleting || restoring;
  const cancelled = !!entry?.cancelled_at;

  const toggleTrainer = (id: string) => {
    setTrainerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  // На прочую активность отмечают любых сотрудников студии, на занятия — тренеров.
  const pool = kind === "other" ? staff : trainers;
  // Тренер, которого отвязали от студии, остаётся на прежних занятиях —
  // показываем его в списке, чтобы его можно было снять с занятия.
  const trainerOptions = [
    ...pool,
    ...(entry?.schedule_entry_trainers ?? []).flatMap((x) =>
      x.trainer && !pool.some((t) => t.id === x.trainer_id) ? [x.trainer] : [],
    ),
  ];

  /**
   * Правка занятия: строка, тренеры (только разница — снятый тренер уносит
   * свою замену, оставшиеся её сохраняют) и замены. Возвращает текст ошибки.
   */
  const updateEntry = async (id: string, row: Record<string, string | number | null>) => {
    const { error } = await supabase.from("schedule_entries").update(row).eq("id", id);
    if (error) return "Ошибка сохранения: " + error.message;
    const { removed, added, dropSubs, putSubs } = trainerChanges(
      {
        ids: entry ? trainerIdsOf(entry) : [],
        subs: substitutionsOf(entry?.schedule_entry_trainers),
      },
      { ids: trainerIds, subs },
    );
    if (removed.length > 0) {
      const { error: delErr } = await supabase
        .from("schedule_entry_trainers")
        .delete()
        .eq("entry_id", id)
        .in("trainer_id", removed);
      if (delErr) return "Ошибка обновления тренеров: " + delErr.message;
    }
    const linkErr = await linkTrainers(added.map((trainer_id) => ({ entry_id: id, trainer_id })));
    if (linkErr) return "Ошибка добавления тренеров: " + linkErr;

    if (dropSubs.length > 0) {
      const { error: subErr } = await supabase
        .from("schedule_entry_substitutions")
        .delete()
        .eq("entry_id", id)
        .in("trainer_id", dropSubs);
      if (subErr) return "Ошибка обновления замены: " + subErr.message;
    }
    if (putSubs.length > 0) {
      const { error: subErr } = await supabase
        .from("schedule_entry_substitutions")
        .upsert(putSubs.map((row) => ({ entry_id: id, ...row })));
      if (subErr) return "Ошибка сохранения замены: " + subErr.message;
    }
    return null;
  };

  /** Поля своего типа занятия или текст ошибки проверки. */
  const kindFields = ():
    | {
        workout_id: string | null;
        capacity?: number;
        title: string | null;
        pay_rate: number | null;
      }
    | string => {
    if (kind === "group") {
      if (!workoutId) return "Выберите тренировку";
      const cap = capacity.trim() === "" ? 0 : Number(capacity);
      if (!Number.isInteger(cap) || cap < 0) return "Вместимость — целое число не меньше 0";
      // 0 — без лимита (как пустая вместимость в «Тренировках»).
      return { workout_id: workoutId, capacity: cap, title: null, pay_rate: null };
    }
    if (isOneOnOne(kind)) {
      if (trainerIds.length !== 1) return "Выберите тренера";
      if (!entry && pending.length === 0) return "Добавьте клиента";
      return { workout_id: null, title: null, pay_rate: null };
    }
    if (!title.trim()) return "Введите название активности";
    const rate = parsePayRate(payRate);
    if (Number.isNaN(rate)) return "Ставка — число не меньше 0";
    if (rate == null && trainerIds.length > 0)
      return "Укажите ставку — она пойдёт в зарплату отмеченным сотрудникам";
    return { workout_id: null, title: title.trim(), pay_rate: rate };
  };

  const handleSave = async () => {
    if (!studioId) return;
    const fields = kindFields();
    if (typeof fields === "string") {
      toast.error(fields);
      return;
    }
    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (!(startDate.getTime() < endDate.getTime())) {
      toast.error("Время окончания должно быть позже начала");
      return;
    }
    const row = {
      kind,
      ...fields,
      starts_at: startDate.toISOString(),
      ends_at: endDate.toISOString(),
    };
    setSaving(true);
    try {
      if (entry && isOneOnOne(kind) && !cancelled) {
        // Персональное без клиента не сохраняем: клиент записан в панели ниже.
        // У отменённого записей уже нет — его можно править и так.
        // «Не посетил» (no_show) — клиент тоже записан: такое занятие
        // переносят и правят, не трогая клиента.
        const { count, error: countError } = await supabase
          .from("schedule_bookings")
          .select("id", { count: "exact", head: true })
          .eq("entry_id", entry.id)
          .in("status", ["booked", "attended", "no_show"]);
        if (countError) {
          toast.error("Не удалось проверить запись клиента: " + countError.message);
          return;
        }
        if (!count) {
          toast.error("Добавьте клиента — кнопка «+ клиент» ниже");
          return;
        }
      }
      if (entry) {
        const failure = await updateEntry(entry.id, { studio_id: studioId, ...row });
        if (failure) {
          toast.error(failure);
          return;
        }
        toast.success(text.updated);
      } else {
        const res = await insertEntries(studioId, [{ ...row, trainerIds }]);
        if (!res.ok) {
          toast.error("Ошибка сохранения: " + res.error);
          return;
        }
        // Занятие уже создано: окно закрываем и при ошибке тренеров, иначе
        // повторное «Сохранить» создало бы второе такое же.
        if (res.trainersError) {
          toast.error("Занятие добавлено, но тренеры не привязаны: " + res.trainersError);
        } else {
          toast.success(text.added);
        }
        // Клиенты — после создания: запись идёт по id занятия.
        const failed: string[] = [];
        for (const c of pending) {
          const err = await bookClient(res.ids[0], c.id);
          if (err) failed.push(`${c.name} (${err})`);
        }
        if (failed.length > 0) toast.error("Не записаны: " + failed.join(", "));
      }
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  // Сначала подтверждение, потом закрытие: при отказе окно с правками остаётся.
  const handleDelete = async () => {
    if (!entry) return;
    setDeleting(true);
    try {
      if (await onDelete(entry)) onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  };

  // Отменили по ошибке — занятие снова в расписании; снятые записи не
  // возвращаются (клиентам записываться заново).
  const handleRestore = async () => {
    if (!entry) return;
    setRestoring(true);
    try {
      const ok = await entryRpc(
        "restore_schedule_entry",
        { p_entry_id: entry.id },
        "Не удалось вернуть занятие",
      );
      if (!ok) return;
      toast.success("Занятие снова в расписании");
      onOpenChange(false);
      onSaved();
    } finally {
      setRestoring(false);
    }
  };

  const KindIcon = activityKind(kind).icon;
  const cancelLabel = kind === "group" ? "Отменить тренировку" : "Отменить занятие";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KindIcon className="size-5 shrink-0" style={{ color: activityKind(kind).color }} />
          {entry ? text.edit : text.create}
        </DialogTitle>
        <DialogDescription>
          {hasBookingsPanel(entry)
            ? "Настройки занятия и записанные клиенты."
            : entry && kind !== "other"
              ? "Настройки занятия."
              : text.hint}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div
            className={cn(
              hasBookingsPanel(entry) &&
                "grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]",
            )}
          >
            {/* Настройки при прокрутке длинного списка записей остаются на месте. */}
            <div
              className={cn(
                "space-y-4",
                hasBookingsPanel(entry) && "lg:sticky lg:top-0 lg:self-start",
              )}
            >
              {entry && cancelled && (
                <InfoNote variant="warning" className="flex flex-wrap items-center gap-3">
                  <span className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                    <Ban className="mt-0.5 size-4 shrink-0 text-rose-600" />
                    <span>
                      <span className="font-medium">
                        Отменено {entry.cancelled_at && formatDate(entry.cancelled_at)}
                      </span>
                      {entry.cancel_reason && <> — {entry.cancel_reason}</>}. Клиенты его не видят и
                      записаться не могут.
                    </span>
                  </span>
                  <Button variant="outline" size="sm" onClick={handleRestore} disabled={busy}>
                    {restoring ? <Loader2 className="animate-spin" /> : <Undo2 />}
                    Вернуть в расписание
                  </Button>
                </InfoNote>
              )}

              {kind === "group" && (
                <div
                  className={cn(
                    "grid grid-cols-1 gap-3",
                    workoutId && "sm:grid-cols-[minmax(0,1fr)_9rem]",
                  )}
                >
                  <FormField label="Тренировка" tip={TIPS.workout} required>
                    <Select value={workoutId} onValueChange={pickWorkout}>
                      <SelectTrigger>
                        <SelectValue placeholder="Выберите тренировку" />
                      </SelectTrigger>
                      <SelectContent>
                        {workouts.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            <WorkoutOption name={w.name} color={workoutColor(w)} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  {workoutId && (
                    <FormField label="Вместимость" tip={TIPS.capacity}>
                      <Input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={capacity}
                        onChange={(e) => setCapacity(e.target.value)}
                        placeholder="Без лимита"
                      />
                    </FormField>
                  )}
                </div>
              )}

              {isOneOnOne(kind) && (
                <FormField
                  label="Тренер"
                  tip={kind === "diagnostic" ? TIPS.diagnosticTrainer : TIPS.personalTrainer}
                  required
                  htmlFor={trainerOptions.length === 0 ? null : undefined}
                >
                  {trainerOptions.length === 0 ? (
                    <NoTrainersNote />
                  ) : (
                    <Select value={trainerIds[0] ?? ""} onValueChange={(id) => setTrainerIds([id])}>
                      <SelectTrigger>
                        <SelectValue placeholder="Выберите тренера" />
                      </SelectTrigger>
                      <SelectContent>
                        {trainerOptions.map((t) => (
                          <SelectItem key={t.id} value={t.id} textValue={t.full_name}>
                            <StaffOption name={t.full_name} photo={t.photo_url} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}

              {kind === "other" && (
                <FormField label="Название" tip={TIPS.title} required>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Например, мастер-класс"
                    autoFocus
                  />
                </FormField>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField label="Начало" tip={kind === "group" ? TIPS.starts : undefined} required>
                  <Input
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </FormField>
                <FormField label="Окончание" required>
                  <Input
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </FormField>
              </div>

              {assignMode && (
                <FormField label="Тренер" tip={TIPS.groupTrainer} htmlFor={null}>
                  <TrainerAssignments
                    options={trainerOptions}
                    value={trainerIds}
                    subs={subs}
                    onChange={(ids, nextSubs) => {
                      setTrainerIds(ids);
                      setSubs(nextSubs);
                    }}
                  />
                </FormField>
              )}

              {singleGroupTrainer && (
                <FormField
                  label="Тренер"
                  tip={TIPS.groupTrainer}
                  optional
                  htmlFor={trainerOptions.length === 0 ? null : undefined}
                >
                  {trainerOptions.length === 0 ? (
                    <NoTrainersNote />
                  ) : (
                    <Select
                      value={trainerIds[0] ?? NO_TRAINER}
                      onValueChange={(id) => setTrainerIds(id === NO_TRAINER ? [] : [id])}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Выберите тренера" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_TRAINER}>Без тренера</SelectItem>
                        {trainerOptions.map((t) => (
                          <SelectItem key={t.id} value={t.id} textValue={t.full_name}>
                            <StaffOption name={t.full_name} photo={t.photo_url} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}

              {!isOneOnOne(kind) && !assignMode && !singleGroupTrainer && (
                <FormField
                  label={kind === "group" ? "Тренеры" : "Сотрудники"}
                  tip={kind === "group" ? TIPS.groupTrainers : TIPS.otherStaff}
                  optional
                  htmlFor={null}
                >
                  {trainerOptions.length === 0 ? (
                    <NoTrainersNote staff={kind === "other"} />
                  ) : (
                    <TrainerChecks
                      options={trainerOptions}
                      value={trainerIds}
                      onToggle={toggleTrainer}
                      byRole={kind === "other"}
                    />
                  )}
                </FormField>
              )}

              {kind === "other" && (
                <FormField
                  label="Ставка, ₾"
                  tip={TIPS.payRate}
                  // Без ставки не сохранится, только если отмечены сотрудники.
                  required={trainerIds.length > 0}
                  optional={trainerIds.length === 0}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={payRate}
                    onChange={(e) => setPayRate(e.target.value)}
                    placeholder="0"
                  />
                </FormField>
              )}

              {!entry && kind !== "other" && (
                <FormField
                  label="Клиенты"
                  tip={
                    kind === "diagnostic"
                      ? TIPS.diagnosticClients
                      : kind === "personal"
                        ? TIPS.personalClients
                        : TIPS.groupClients
                  }
                  required={isOneOnOne(kind)}
                  optional={kind === "group"}
                  htmlFor={null}
                >
                  <div className="space-y-2">
                    {pending.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {pending.map((c) => (
                          <span
                            key={c.id}
                            className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-1 pl-3 pr-1.5 text-sm"
                          >
                            {c.name}
                            <button
                              type="button"
                              aria-label={`Убрать ${c.name}`}
                              onClick={() =>
                                setPending((prev) => prev.filter((x) => x.id !== c.id))
                              }
                              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <ParticipantActions
                      studioId={studioId}
                      trial={kind === "group"}
                      packages={packages}
                      onPick={(c) =>
                        setPending((prev) =>
                          prev.some((x) => x.id === c.id) ? prev : [...prev, c],
                        )
                      }
                    />
                  </div>
                </FormField>
              )}
            </div>
            {hasBookingsPanel(entry) && (
              <BookingsPanel
                entry={entry}
                trial={kind === "group"}
                packages={packages}
                onChanged={onSaved}
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {entry && (
            <EntryActionsMenu
              kind={kind}
              cancelLabel={packages && !cancelled ? cancelLabel : null}
              onDelete={handleDelete}
              onCancel={() => setCancelOpen(true)}
              disabled={busy}
            />
          )}
          {/* У открытого занятия — «Закрыть»: рядом «Действия» с «Отменить
              тренировку», два «отменить» в одном подвале путались. */}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {entry ? "Закрыть" : "Отмена"}
          </Button>
          <Button type="submit" disabled={busy}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
      {entry && packages && (
        <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <DialogContent className="max-w-md">
            <CancelEntryForm
              entry={entry}
              title={cancelLabel}
              onClose={() => setCancelOpen(false)}
              onDone={() => {
                setCancelOpen(false);
                onOpenChange(false);
                onSaved();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * «Действия» в подвале окна занятия (решение владельца 2026-10-13: две
 * красные кнопки перегружали окно): удалить — занятие добавили по ошибке;
 * отменить — оно было в расписании, но не состоится (остаётся с причиной).
 * Оба пункта сначала спрашивают подтверждение.
 */
function EntryActionsMenu({
  kind,
  cancelLabel,
  onDelete,
  onCancel,
  disabled,
}: {
  kind: ActivityKind;
  /** Подпись отмены; null — отменить нельзя (подписочный клуб, уже отменено). */
  cancelLabel: string | null;
  onDelete: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const group = kind === "group";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled}
        >
          Действия
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {cancelLabel && (
          <ListItemButton
            className="items-start"
            onClick={() => {
              setOpen(false);
              onCancel();
            }}
          >
            <Ban className="mt-0.5 text-rose-600" />
            <span className="space-y-0.5">
              <span className="block font-medium">{cancelLabel}</span>
              <span className="block text-xs text-muted-foreground">
                {group
                  ? "Тренировка не состоится: останется в расписании отменённой, с причиной."
                  : "Занятие не состоится: останется в расписании отменённым, с причиной."}{" "}
                Записи клиентов снимутся, списанное вернётся на абонементы.
              </span>
            </span>
          </ListItemButton>
        )}
        <ListItemButton
          className="items-start"
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          <Trash2 className="mt-0.5 text-destructive" />
          <span className="space-y-0.5">
            <span className="block font-medium text-destructive">Удалить</span>
            <span className="block text-xs text-muted-foreground">
              Добавили по ошибке: {group ? "тренировка исчезнет" : "занятие исчезнет"} из
              расписания, записи клиентов отменятся, списанное вернётся на абонементы.
            </span>
          </span>
        </ListItemButton>
      </PopoverContent>
    </Popover>
  );
}

const ENTRY_RPC_REASONS: Record<string, string> = {
  already_cancelled: "уже отменено",
  not_cancelled: "занятие не отменено",
  reason_required: "укажите причину",
  forbidden: "нет прав в этом клубе",
  not_found: "занятие не найдено",
};

/** RPC отмены и возврата занятия: { ok, reason }; тост об ошибке — здесь. */
async function entryRpc(
  fn: "cancel_schedule_entry" | "restore_schedule_entry",
  args: Record<string, string>,
  failed: string,
) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    toast.error(`${failed}: ${error.message}`);
    return null;
  }
  const result = data as { ok?: boolean; reason?: string; cancelled_bookings?: number } | null;
  if (!result?.ok) {
    const reason = result?.reason ?? "";
    toast.error(`${failed}: ${ENTRY_RPC_REASONS[reason] ?? (reason || "неизвестно")}`);
    return null;
  }
  return result;
}

/**
 * Отмена занятия с причиной (пакетные студии): записанные снимаются, списанные
 * тренировки возвращаются на абонементы, в сетке занятие остаётся
 * заштрихованным (db/migrations/2026-10-11_zzzzzzz_entry_cancel_no_show.sql).
 */
function CancelEntryForm({
  entry,
  title,
  onClose,
  onDone,
}: {
  entry: Entry;
  title: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState(ENTRY_CANCEL_REASONS[0]);
  const [other, setOther] = useState("");
  const [saving, setSaving] = useState(false);
  const booked = entry.booked_count + (entry.waitlist_count ?? 0);

  const handleSubmit = async () => {
    const text = reason === OTHER_REASON ? other.trim() : reason;
    if (!text) {
      toast.error("Напишите причину отмены");
      return;
    }
    setSaving(true);
    try {
      const result = await entryRpc(
        "cancel_schedule_entry",
        { p_entry_id: entry.id, p_reason: text },
        "Не удалось отменить",
      );
      if (!result) return;
      const n = result.cancelled_bookings ?? 0;
      toast.success(n > 0 ? `Отменено, снято записей: ${n}` : "Отменено");
      // Списанные тренировки вернулись — баланс в «Абонементах» изменился.
      queryClient.invalidateQueries({ queryKey: ["schedule_bookings"] });
      queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}?</DialogTitle>
        <DialogDescription>
          {booked > 0
            ? `Записанные клиенты (${booked}) будут сняты, списанные тренировки вернутся на абонементы. `
            : ""}
          Занятие останется в расписании отменённым — клиенты его не увидят и не смогут записаться.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody>
          <FormField label="Причина отмены" required htmlFor={null}>
            <RadioGroup value={reason} onValueChange={setReason} className="space-y-1">
              {[...ENTRY_CANCEL_REASONS, OTHER_REASON].map((r) => (
                <label
                  key={r}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-sm"
                >
                  <RadioGroupItem value={r} />
                  {r === OTHER_REASON ? "Другое" : r}
                </label>
              ))}
            </RadioGroup>
            {reason === OTHER_REASON && (
              <Input
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="Что случилось"
                aria-label="Своя причина отмены"
                autoFocus
              />
            )}
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Не отменять
          </Button>
          <Button type="submit" variant="destructive" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Ban />}
            {title}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

type BookingRow = {
  id: string;
  user_id: string | null;
  /** Карточка клиента; у старых записей из приложения может не быть. */
  client_id: string | null;
  status: string;
  created_at: string;
  /** «Не посетил»: true — уважительная (не списано), false — неуважительная (списано). */
  no_show_excused: boolean | null;
  no_show_comment: string | null;
};

type ClientRow = {
  id: string;
  user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  crm_link: string | null;
  /** Комментарий о клиенте — виден под строкой записи, правится в карточке. */
  notes: string | null;
  /** Статус клуба (ЧК / БЧК / ПЧК) — из вью clients_with_status, как в «Клиентах». */
  club_status: ClubStatus | null;
  studio_id?: string;
};

type ActiveMembershipRow = {
  client_id: string;
  /** active — текущий; pending — продление ждёт (только для расчёта остатка). */
  status: "active" | "pending";
  started_at: string | null;
  ends_at: string | null;
  visits_left: number | null;
  /** Пакетный формат: остаток персональных и вид баланса абонемента. */
  personal_left: number;
  /** Остаток диагностик тела. */
  diagnostics_left?: number | null;
  balance_kind: "group" | "personal";
  membership: { name: string | null } | null;
  sale_id: string | null;
  /** «Оплата» в строке клиента — из платежей продажи (paymentInfo). */
  payment?: PaymentInfo;
};

type BookingsData = {
  bookings: BookingRow[];
  clientsById: Map<string, ClientRow>;
  clientsByUser: Map<string, ClientRow>;
  /** У клиента пакетной студии может быть два: пакет тренировок и пакет персональных. */
  membershipsByClient: Map<string, ActiveMembershipRow[]>;
  /**
   * Пакетная студия — хватает ли абонемента на это занятие (id записи →
   * остаток): balance — тренировок на балансе сейчас (с ждущим продлением),
   * ahead — сколько записей клиента на такие же занятия раньше этого ещё не
   * отмечены. Записаться можно и сверх остатка (решение владельца
   * 2026-10-13), а «Посетил» без остатка база не даст — сначала продажа.
   */
  coverage: Map<string, Coverage>;
  /** Ждущие продления (пакетные клубы): «id клиента:вид баланса». */
  renewals: Set<string>;
};

function bookingClient(data: BookingsData | undefined, b: BookingRow) {
  return (
    (b.client_id ? data?.clientsById.get(b.client_id) : undefined) ??
    (b.user_id ? data?.clientsByUser.get(b.user_id) : undefined)
  );
}

/**
 * Записи на занятие + карточки клиентов + их активные абонементы.
 * networkIds — клубы базы клиентов клуба занятия: у пакетного — все пакетные
 * (база общая, 2026-10-17): карточку клиента, заведённую в другом клубе
 * сети, сотрудник видит целиком, «гостей» больше нет.
 */
async function fetchBookings(
  entry: Entry,
  packages: boolean,
  networkIds: string[],
): Promise<BookingsData> {
  const bookings = await unwrap<BookingRow[]>(
    supabase
      .from("schedule_bookings")
      .select("id, user_id, client_id, status, created_at, no_show_excused, no_show_comment")
      .eq("entry_id", entry.id)
      // no_show — «Отметить пропущенные» в «Истории записей»: у прошедшего
      // занятия посещение можно зафиксировать и после этого.
      .in("status", ["booked", "attended", "no_show", "waitlist"])
      .order("created_at"),
  );
  const clientsById = new Map<string, ClientRow>();
  const clientsByUser = new Map<string, ClientRow>();
  const membershipsByClient = new Map<string, ActiveMembershipRow[]>();
  const coverage = new Map<string, Coverage>();
  const renewals = new Set<string>();
  const empty = { bookings, clientsById, clientsByUser, membershipsByClient, coverage, renewals };
  const clientIds = Array.from(new Set(bookings.map((r) => r.client_id).filter(Boolean)));
  // Старые записи из приложения без карточки — по учётной записи.
  const userIds = Array.from(
    new Set(bookings.filter((r) => !r.client_id).map((r) => r.user_id)),
  ).filter((v): v is string => !!v);
  if (clientIds.length === 0 && userIds.length === 0) return empty;

  // Карточки и абонементы — дополнение: если они не загрузились, записи всё
  // равно показываем (с «Пользователь без анкеты»), а не ошибку на всю панель.
  const cols =
    "id, user_id, first_name, last_name, full_name, phone, email, crm_link, notes, club_status, studio_id";
  const [byId, byUser] = await Promise.all([
    clientIds.length
      ? supabase.from("clients_with_status").select(cols).in("id", clientIds)
      : Promise.resolve({ data: [] as ClientRow[] }),
    userIds.length
      ? supabase
          .from("clients_with_status")
          .select(cols)
          .in("studio_id", networkIds)
          .in("user_id", userIds)
      : Promise.resolve({ data: [] as ClientRow[] }),
  ]);
  const clients = [...(byId.data ?? []), ...(byUser.data ?? [])] as ClientRow[];
  for (const c of clients) {
    clientsById.set(c.id, c);
    if (c.user_id) clientsByUser.set(c.user_id, c);
  }
  if (clients.length === 0) return empty;

  const ids = clients.map((c) => c.id);
  const balanceCheck = packages && entry.kind !== "other";
  const [{ data: mData }, { data: aheadData }] = await Promise.all([
    supabase
      .from("client_memberships")
      .select(
        "client_id, status, started_at, ends_at, visits_left, personal_left, diagnostics_left, balance_kind, sale_id, membership:memberships(name), sale:sales(sold_at)",
      )
      // Ждущее продление — только в остаток: с него спишется, когда кончится
      // текущий. Замороженный — чтобы знать, что текущий есть (balanceFor).
      .in("status", balanceCheck ? ["active", "pending", "frozen"] : ["active"])
      .in("client_id", ids),
    // Сколько у каждого клиента неотмеченных записей на такие же занятия
    // раньше этого — остаток уйдёт на них. Считает база: записи в других
    // клубах сети сотруднику не видны, а списываются с того же абонемента.
    balanceCheck
      ? supabase.rpc("entry_bookings_ahead", { p_entry_id: entry.id })
      : Promise.resolve({ data: [] as { client_id: string; ahead: number }[] }),
  ]);
  // membership — связь «многие к одному», но разбор select без схемы базы
  // считает любую связь массивом.
  const all = (mData ?? []) as unknown as (ActiveMembershipRow & {
    sale: { sold_at: string | null } | null;
  })[];
  // Платежи продаж действующих абонементов — для «Оплаты» в строке клиента.
  // Дополнение, как и абонементы: не загрузились — строка без «Оплаты».
  const saleIds = Array.from(
    new Set(all.filter((m) => m.status === "active" && m.sale_id).map((m) => m.sale_id!)),
  );
  if (saleIds.length) {
    const { data: iData } = await supabase
      .from("sale_installments")
      .select("sale_id, due_date, paid, paid_at, refunded")
      .in("sale_id", saleIds);
    const bySale = new Map<string, InstallmentLite[]>();
    for (const r of (iData ?? []) as (InstallmentLite & { sale_id: string })[])
      bySale.set(r.sale_id, [...(bySale.get(r.sale_id) ?? []), r]);
    if (iData)
      for (const m of all)
        if (m.status === "active" && m.sale_id)
          m.payment = paymentInfo(bySale.get(m.sale_id) ?? [], m.sale?.sold_at ?? null);
  }
  const allByClient = new Map<string, ActiveMembershipRow[]>();
  for (const m of all) {
    allByClient.set(m.client_id, [...(allByClient.get(m.client_id) ?? []), m]);
    if (m.status === "active")
      membershipsByClient.set(m.client_id, [...(membershipsByClient.get(m.client_id) ?? []), m]);
    else if (m.status === "pending") renewals.add(`${m.client_id}:${m.balance_kind}`);
  }
  if (balanceCheck) {
    const aheadByClient = new Map<string, number>();
    for (const r of (aheadData ?? []) as { client_id: string; ahead: number }[])
      aheadByClient.set(r.client_id, r.ahead);
    const date = tbilisiDate(entry.starts_at);
    const balance = entryBalance(entry.kind);
    for (const b of bookings) {
      const c =
        (b.client_id ? clientsById.get(b.client_id) : undefined) ??
        (b.user_id ? clientsByUser.get(b.user_id) : undefined);
      if (!c) continue;
      coverage.set(b.id, {
        balance: balanceFor(allByClient.get(c.id) ?? [], balance, date),
        ahead: aheadByClient.get(c.id) ?? 0,
      });
    }
  }
  return empty;
}

/**
 * Абонемент, с которого спишется посещение: на персональном (пакетная
 * студия) — с остатком персональных, иначе пакет персональных; на
 * диагностике — с остатком диагностик; на остальных — абонемент обычных
 * тренировок.
 */
function pickMembership(rows: ActiveMembershipRow[] | undefined, balance: BalanceKind) {
  if (!rows?.length) return undefined;
  if (balance === "diagnostic")
    return (
      rows.find((r) => (r.diagnostics_left ?? 0) > 0) ??
      rows.find((r) => r.balance_kind !== "personal") ??
      rows[0]
    );
  if (balance === "personal")
    return (
      rows.find((r) => r.personal_left > 0) ??
      rows.find((r) => r.balance_kind === "personal") ??
      rows[0]
    );
  return rows.find((r) => r.balance_kind !== "personal") ?? rows[0];
}

const BOOK_REASONS: Record<string, string> = {
  full: "мест нет",
  already_booked: "уже записан",
  forbidden: "нет прав в этом клубе",
  not_bookable: "на прочую активность не записывают",
  client_not_found: "клиент не из этого клуба и не из клубов его сети",
  not_found: "занятие не найдено",
};

/** Записывает клиента на занятие (RPC admin_book_client); текст ошибки или null. */
async function bookClient(entryId: string, clientId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("admin_book_client", {
    p_entry_id: entryId,
    p_client_id: clientId,
  });
  if (error) return error.message;
  const result = data as { ok?: boolean; reason?: string } | null;
  if (result?.ok) return null;
  return BOOK_REASONS[result?.reason ?? ""] ?? result?.reason ?? "неизвестная ошибка";
}

type PickedClient = { id: string; name: string };

/**
 * «+ клиент» — выбор клиента студии; «+ пробник» (у групповых) — новая
 * карточка клиента: он попадает в «Клиенты» потенциальным членом клуба. Оба
 * отдают клиента наверх — там его записывают. Подписи короткие (решение
 * владельца 2026-10-13), полные — в подсказке.
 */
function ParticipantActions({
  studioId,
  trial,
  packages,
  onPick,
  disabled,
}: {
  studioId: string | null;
  trial: boolean;
  /** Пакетная студия: в поиске — клиенты всех клубов сети (база общая). */
  packages: boolean;
  onPick: (c: PickedClient) => void;
  disabled?: boolean;
}) {
  const [pickOpen, setPickOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => setPickOpen(true)}
          disabled={disabled || !studioId}
          title="Записать клиента"
        >
          <Plus />
          клиент
        </Button>
        {trial && (
          <Button
            variant="default"
            size="sm"
            onClick={() => setTrialOpen(true)}
            disabled={disabled || !studioId}
            title="Записать пробника"
          >
            <Plus />
            пробник
          </Button>
        )}
      </div>
      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent className="max-w-md">
          <PickClientForm
            studioId={studioId}
            packages={packages}
            onCancel={() => setPickOpen(false)}
            onPick={(c) => {
              setPickOpen(false);
              onPick(c);
            }}
          />
        </DialogContent>
      </Dialog>
      <ClientDialog
        open={trialOpen}
        onOpenChange={setTrialOpen}
        studioId={studioId}
        client={null}
        createTitle="Записать пробника"
        createDescription="Новый клиент появится в «Клиентах» как потенциальный член клуба и будет записан на это занятие."
        onSaved={(c) => onPick({ id: c.id, name: clientName(c) })}
      />
    </>
  );
}

function PickClientForm({
  studioId,
  packages,
  onPick,
  onCancel,
}: {
  studioId: string | null;
  packages: boolean;
  onPick: (c: PickedClient) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<PickedClient | null>(null);
  const handleSubmit = () => {
    if (!picked) {
      toast.error("Выберите клиента");
      return;
    }
    onPick(picked);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Записать клиента</DialogTitle>
        <DialogDescription>
          {packages
            ? "Клиент любого клуба сети — база клиентов общая. Поиск по имени, телефону или почте."
            : "Клиент клуба — поиск по имени, телефону или почте."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody>
          <FormField label="Клиент" required>
            <ClientCombobox
              studioId={studioId}
              value={picked?.id ?? ""}
              onChange={(id, c) => setPicked(c ? { id, name: clientName(c) } : null)}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit">Записать</Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * RPC записей отвечают { ok, reason }: ok=false — штатный отказ базы (запись
 * уже отменена и т. п.), а не ошибка запроса. Тост об ошибке показываем здесь;
 * true — успех.
 */
/** Коды отказа RPC записи (db/migrations, booking_waitlist.sql) — по-русски, а не как есть. */
const BOOKING_RPC_REASONS: Record<string, string> = {
  not_found: "запись не найдена",
  wrong_status: "у записи уже другой статус — обновите окно",
  already_cancelled: "запись уже отменена",
  not_booked: "клиент не записан",
  excuse_required: "укажите, уважительная ли причина",
  comment_required: "напишите причину",
  forbidden: "нет прав в этом клубе",
  unauthorized: "нет прав",
  past: "занятие уже прошло",
};

async function bookingRpc(
  fn:
    | "mark_booking_attended"
    | "unmark_booking_attended"
    | "cancel_schedule_booking_admin"
    | "mark_booking_no_show",
  args: Record<string, string | boolean | null>,
  messages: { error: string; failed: string },
) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    toast.error(`${messages.error}: ${error.message}`);
    return false;
  }
  const result = data as { ok?: boolean; reason?: string } | null;
  if (!result?.ok) {
    const reason = result?.reason ?? "";
    toast.error(`${messages.failed}: ${BOOKING_RPC_REASONS[reason] ?? (reason || "неизвестно")}`);
    return false;
  }
  return true;
}

function BookingClientName({ client }: { client: ClientRow | undefined }) {
  if (!client) return <span className="font-medium">Пользователь без анкеты</span>;
  return (
    <ClientNameLink clientId={client.id} crmLink={client.crm_link}>
      {clientName(client)}
    </ClientNameLink>
  );
}

/**
 * Причина «Не посетил» у записи: уважительная или списано. Без причины
 * («Пропущено») отметки нет — её видно по кнопке «Причина» (решение
 * владельца 2026-10-13: в строке клиента меньше плашек).
 */
function NoShowBadge({ booking }: { booking: BookingRow }) {
  if (booking.no_show_excused === true)
    return (
      <StatusChip tone="warning" size="sm">
        Не посетил · уважительная
      </StatusChip>
    );
  if (booking.no_show_excused === false)
    return (
      <StatusChip tone="negative" size="sm">
        Не посетил · списано
      </StatusChip>
    );
  return null;
}

/** Остаток нужного вида: «осталось 3», «персональных 1», «диагностик 2». */
function balanceLeftLabel(m: ActiveMembershipRow, balance: BalanceKind) {
  if (balance === "personal") return `персональных ${m.personal_left}`;
  if (balance === "diagnostic") return `диагностик ${m.diagnostics_left ?? 0}`;
  return m.visits_left != null ? `осталось ${m.visits_left}` : "безлимит";
}

/**
 * Абонемент клиента одной строкой: «Пакет 8 · осталось 3 · до 12.11.2026».
 * Посещений меньше 5 или до конца срока меньше 14 дней — красным: подсказка
 * администратору продать продление (решение владельца 2026-10-13). renewed —
 * продление уже куплено и ждёт, подсказывать нечего.
 */
const PAYMENT_TITLE: Record<PaymentInfo["state"], string> = {
  paid: "Оплачен полностью — дата последнего платежа",
  due: "Следующий платёж по рассрочке",
  soon: `Следующий платёж — в ближайшие ${PAYMENT_SOON_DAYS} дней`,
  overdue: "Платёж просрочен",
};

function MembershipSummary({
  m,
  balance,
  renewed,
}: {
  m: ActiveMembershipRow;
  balance: BalanceKind;
  renewed: boolean;
}) {
  // Диагностик всего 1–2 — красным не подсвечиваем.
  const count =
    balance === "personal" ? m.personal_left : balance === "diagnostic" ? null : m.visits_left;
  const left = balanceLeftLabel(m, balance);
  // Пакетная продажа ждёт первого посещения — срок ещё не идёт.
  const term = m.ends_at
    ? `до ${formatDate(m.ends_at)}`
    : !m.started_at
      ? "срок — с 1-го посещения"
      : null;
  const hint = "font-medium text-rose-600";
  const pay = m.payment;
  // Две строки (решение владельца 2026-10-26: в одну не помещалось):
  // абонемент и остаток, ниже — срок и оплата.
  return (
    <>
      <div className="truncate">
        {m.membership?.name ?? "Абонемент"} ·{" "}
        <span className={cn(!renewed && fewVisitsLeft(count) && hint)}>{left}</span>
      </div>
      {(term || pay?.date) && (
        <div className="truncate">
          {term && <span className={cn(!renewed && endsSoon(m.ends_at) && hint)}>{term}</span>}
          {term && pay?.date && " · "}
          {pay?.date && (
            <span
              title={PAYMENT_TITLE[pay.state]}
              className={cn(
                pay.state === "soon" && "font-medium text-blue-600",
                pay.state === "overdue" && hint,
              )}
            >
              {pay.state === "paid" ? "оплачен" : "оплата"} {formatDate(pay.date)}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function BookingsPanel({
  entry,
  trial,
  packages,
  onChanged,
}: {
  entry: Entry;
  /** Групповое: можно записать на пробное посещение нового клиента. */
  trial: boolean;
  /** Пакетная студия: «Не посетил» с причиной вместо «Отклонить». */
  packages: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  // Пакетная студия: на персональном занятии посещение списывается с баланса
  // персональных, на диагностике — диагностик; его и показываем у клиента.
  const balance: BalanceKind = packages ? entryBalance(entry.kind) : "visits";
  const [booking, setBooking] = useState(false);
  const [attendingId, setAttendingId] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<BookingRow | null>(null);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [noShowTarget, setNoShowTarget] = useState<BookingRow | null>(null);

  const queryKey = ["schedule_bookings", entry.id];
  const networkIds = useNetworkStudioIds(entry.studio_id);
  const { data, isLoading: loading } = useQuery({
    queryKey: [...queryKey, networkIds?.join(",")],
    queryFn: () => fetchBookings(entry, packages, networkIds!),
    enabled: !!networkIds,
    meta: { errorMessage: "Ошибка загрузки записей" },
  });
  const bookings = data?.bookings ?? [];
  const reload = () => {
    queryClient.invalidateQueries({ queryKey });
    // Посещение списало тренировку — баланс в «Абонементах» изменился.
    queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
    onChanged();
  };

  const addParticipant = async (c: PickedClient) => {
    setBooking(true);
    try {
      const err = await bookClient(entry.id, c.id);
      if (err) {
        toast.error(`Не удалось записать ${c.name}: ${err}`);
        return;
      }
      toast.success(`${c.name} — записан(а)`);
      reload();
    } finally {
      setBooking(false);
    }
  };

  const askCancel = (b: BookingRow) => {
    setCancelTarget(b);
    setCancelOpen(true);
  };

  const askNoShow = (b: BookingRow) => {
    setNoShowTarget(b);
    setNoShowOpen(true);
  };

  const { confirm, confirmDialog } = useConfirm();

  const handleAttend = async (b: BookingRow) => {
    // До начала больше часа — скорее всего, промахнулись по строке или дню
    // (решение владельца 2026-10-13: спрашивать).
    if (new Date(entry.starts_at).getTime() - Date.now() > 60 * 60 * 1000) {
      const ok = await confirm({
        title: "Отметить посещение заранее?",
        description:
          "До начала тренировки ещё больше часа. Точно отметить посещение сейчас? Тренировка спишется с абонемента клиента.",
        confirmLabel: "Отметить",
        destructive: false,
      });
      if (!ok) return;
    }
    setAttendingId(b.id);
    try {
      const ok = await bookingRpc(
        "mark_booking_attended",
        { p_booking_id: b.id },
        { error: "Ошибка", failed: "Не удалось отметить" },
      );
      if (!ok) return;
      toast.success("Посещение зафиксировано");
      reload();
    } finally {
      setAttendingId(null);
    }
  };

  // Отметка по ошибке: запись снова «Записан», тренировка возвращается на
  // баланс (триггер списания в БД). В любой момент, и у прошедших занятий.
  const handleUnattend = async (b: BookingRow) => {
    setAttendingId(b.id);
    try {
      const ok = await bookingRpc(
        "unmark_booking_attended",
        { p_booking_id: b.id },
        { error: "Ошибка", failed: "Не удалось отменить посещение" },
      );
      if (!ok) return;
      toast.success("Посещение отменено, тренировка возвращена на баланс");
      reload();
    } finally {
      setAttendingId(null);
    }
  };

  // Лист ожидания держим отдельно от записанных: он не занимает мест и не
  // должен путаться со счётчиком заполненности.
  const booked = bookings.filter((b) => b.status !== "waitlist");
  // Те же «новенькие», что в цифре на карточке занятия.
  const newcomers = newcomerIds(entry);
  const waitlisted = bookings.filter((b) => b.status === "waitlist");
  const capacity = entryCapacity(entry);

  return (
    // Правая колонка окна занятия; на узком экране — под настройками.
    <div className="min-w-0 space-y-4 max-lg:border-t max-lg:pt-4 lg:border-l lg:pl-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Записанные клиенты{" "}
            <span className="tabular-nums normal-case">
              · {booked.length}
              {capacity != null ? ` / ${capacity}` : ""}
              {waitlisted.length > 0 && ` · +${waitlisted.length} в очереди`}
            </span>
          </div>
          <ParticipantActions
            studioId={entry.studio_id}
            trial={trial}
            packages={packages}
            onPick={addParticipant}
            disabled={booking}
          />
        </div>

        {loading ? (
          <div className="divide-y rounded-md border">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-1.5 px-3 py-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            ))}
          </div>
        ) : booked.length === 0 ? (
          <InfoNote variant="empty">
            {isOneOnOne(entry.kind)
              ? "Клиент не выбран — нажмите «+ клиент»."
              : "Пока никто не записан."}
          </InfoNote>
        ) : (
          // Строка клиента — компактно (решение владельца 2026-10-11: в окне
          // занятия приходилось долго листать): имя и отметка, ниже двумя
          // строками абонемент — название и остаток, срок и оплата (телефона
          // нет — решение владельца 2026-10-26); кнопки справа.
          <ul className="divide-y rounded-md border">
            {booked.map((b) => {
              const c = bookingClient(data, b);
              const m = c
                ? pickMembership(data?.membershipsByClient.get(c.id), balance)
                : undefined;
              const busy = attendingId === b.id;
              // Пакетная студия: посещение без остатка база не отметит —
              // сначала продажа; если остаток уйдёт на более ранние записи —
              // предупреждаем заранее.
              const { noBalance, uncovered } = attendanceBlock(b, data?.coverage.get(b.id));
              return (
                <li key={b.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <BookingClientName client={c} />
                      {c?.club_status && <ClubStatusBadge status={c.club_status} size="sm" />}
                      {c && newcomers.has(c.id) && (
                        <StatusChip
                          tone="info"
                          size="sm"
                          title="До занятия не было абонементов, кроме пробного"
                        >
                          Новенький
                        </StatusChip>
                      )}
                      {/* «Посетил» и «Пропущено» плашками не пишем — состояние
                          видно по кнопкам справа (решение владельца 2026-10-13). */}
                      {b.status === "no_show" && <NoShowBadge booking={b} />}
                    </div>
                    <div className="min-w-0 text-xs text-muted-foreground">
                      {m ? (
                        <MembershipSummary
                          m={m}
                          balance={balance}
                          renewed={!!c && !!data?.renewals.has(`${c.id}:${m.balance_kind}`)}
                        />
                      ) : (
                        "Нет активного абонемента"
                      )}
                    </div>
                    {/* Комментарий о клиенте — одной строкой; весь и правка —
                        в карточке по нажатию на имя. */}
                    {c?.notes?.trim() && (
                      <div
                        title={c.notes}
                        className={cn(noteChipClass, "mt-1 truncate px-1.5 py-0.5 text-xs")}
                      >
                        {c.notes}
                      </div>
                    )}
                    {uncovered && (
                      <div className="text-xs text-rose-700">
                        {noBalance
                          ? "Чтобы отметить посещение, сначала оформите продажу"
                          : "На это занятие абонемента не хватит: остаток уйдёт на более ранние записи"}
                      </div>
                    )}
                    {b.status === "no_show" && b.no_show_comment && (
                      <div
                        className={cn(
                          noteChipClass,
                          "mt-1 inline-block max-w-full px-1.5 py-0.5 text-xs",
                        )}
                      >
                        {b.no_show_comment}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {(b.status === "booked" || b.status === "no_show") && (
                      <Button
                        // Пакетные: отметки — белые, тёмные — действия окна
                        // («+ клиент», «+ пробник»; 2026-10-13).
                        variant={packages ? "outline" : "default"}
                        size={packages ? "xs" : "sm"}
                        onClick={() => handleAttend(b)}
                        // «Не посетил» по неуважительной уже списан — его
                        // можно перевести в «Посетил» и без остатка
                        // (attendanceBlock такую запись не блокирует).
                        disabled={busy || noBalance}
                        title={
                          noBalance
                            ? "Нет абонемента с остатком — сначала оформите продажу"
                            : undefined
                        }
                      >
                        {busy ? <Loader2 className="animate-spin" /> : <Check />}
                        Посетил
                      </Button>
                    )}
                    {packages && b.status === "booked" && (
                      <Button variant="outline" size="xs" onClick={() => askNoShow(b)}>
                        <X />
                        Не посетил
                      </Button>
                    )}
                    {packages && b.status === "no_show" && (
                      <Button
                        variant="outline"
                        size="xs"
                        title="Изменить причину или комментарий"
                        onClick={() => askNoShow(b)}
                      >
                        <X />
                        Причина
                      </Button>
                    )}
                    {!packages && b.status === "booked" && (
                      <Button variant="outline" size="sm" onClick={() => askCancel(b)}>
                        Отклонить
                      </Button>
                    )}
                    {b.status === "attended" && (
                      <Button
                        variant="outline"
                        size={packages ? "xs" : "sm"}
                        title="Отметили по ошибке? Тренировка вернётся на баланс клиента"
                        onClick={() => handleUnattend(b)}
                        disabled={busy}
                      >
                        {busy && <Loader2 className="animate-spin" />}
                        Отменить посещение
                      </Button>
                    )}
                    {/* Пакетные: отписать (записали по ошибке, клиент отменил
                        заранее) — тихой кнопкой, главная — «Не посетил»; не
                        крестик — он у «Не посетил». */}
                    {packages && b.status === "booked" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Отписать клиента"
                        title="Отписать клиента"
                        onClick={() => askCancel(b)}
                      >
                        <UserMinus />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {waitlisted.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase text-muted-foreground">Лист ожидания</div>
            <span
              className="text-xs text-muted-foreground"
              title="Записались, когда свободных мест уже не было"
            >
              {waitlisted.length} ждут места
            </span>
          </div>
          <ul className="divide-y rounded-md border">
            {waitlisted.map((b) => {
              const c = bookingClient(data, b);
              return (
                <li key={b.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <BookingClientName client={c} />
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c?.phone ?? c?.email ?? "—"}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => askCancel(b)}>
                    Убрать
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        {/* Окно открыто из формы занятия; всплытие submit в неё гасит DialogForm. */}
        <DialogContent className="max-w-md">
          {cancelTarget && (
            <CancelBookingForm
              key={cancelTarget.id}
              booking={cancelTarget}
              packages={packages}
              onClose={() => setCancelOpen(false)}
              onDone={reload}
            />
          )}
        </DialogContent>
      </Dialog>

      {confirmDialog}

      <Dialog open={noShowOpen} onOpenChange={setNoShowOpen}>
        <DialogContent className="max-w-md">
          {noShowTarget && (
            <NoShowForm
              key={noShowTarget.id}
              booking={noShowTarget}
              clientName={(() => {
                const c = bookingClient(data, noShowTarget);
                return c ? clientName(c) : null;
              })()}
              onClose={() => setNoShowOpen(false)}
              onDone={reload}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Причины «Не посетил»: уважительная — тренировка остаётся, нет — списывается. */
const NO_SHOW_OPTIONS = [
  {
    value: "excused",
    title: "Уважительная причина",
    description:
      "Клиент отписался больше чем за 3 часа до начала или у него форс-мажор. Тренировка останется на абонементе.",
  },
  {
    value: "unexcused",
    title: "Неуважительная причина",
    description:
      "Не пришёл без предупреждения или отписался меньше чем за 3 часа. Тренировка спишется с абонемента.",
  },
] as const;

/**
 * «Не посетил» (пакетные студии): причина и короткий комментарий —
 * RPC mark_booking_no_show; списание и возврат тренировки делает база.
 */
function NoShowForm({
  booking,
  clientName: name,
  onClose,
  onDone,
}: {
  booking: BookingRow;
  clientName: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<string>(
    booking.no_show_excused === true
      ? "excused"
      : booking.no_show_excused === false
        ? "unexcused"
        : "",
  );
  const [comment, setComment] = useState(booking.no_show_comment ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!kind) {
      toast.error("Выберите причину: уважительная или нет");
      return;
    }
    if (!comment.trim()) {
      toast.error("Напишите короткий комментарий");
      return;
    }
    setSaving(true);
    try {
      const excused = kind === "excused";
      const ok = await bookingRpc(
        "mark_booking_no_show",
        { p_booking_id: booking.id, p_excused: excused, p_comment: comment.trim() },
        { error: "Ошибка", failed: "Не удалось отметить" },
      );
      if (!ok) return;
      toast.success(
        excused
          ? "Не посетил по уважительной причине — тренировка на абонементе"
          : "Не посетил — тренировка списана с абонемента",
      );
      onClose();
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Не посетил</DialogTitle>
        <DialogDescription>
          {name ? `${name}: ` : ""}почему клиента не было на занятии?
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Причина" required htmlFor={null}>
              <RadioGroup value={kind} onValueChange={setKind} className="space-y-2">
                {NO_SHOW_OPTIONS.map((o) => (
                  <label
                    key={o.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                      kind === o.value && "border-foreground/40 bg-muted/40",
                    )}
                  >
                    <RadioGroupItem value={o.value} className="mt-0.5" />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{o.title}</span>
                      <span className="block text-xs text-muted-foreground">{o.description}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </FormField>
            <FormField label="Комментарий" required>
              <Textarea
                note
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Например: заболела, предупредила утром"
              />
            </FormField>
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

function CancelBookingForm({
  booking,
  packages,
  onClose,
  onDone,
}: {
  booking: BookingRow;
  /** Пакетная студия: «Отписать» (кнопка «Отклонить» заменена на «Не посетил»). */
  packages: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const verb = packages ? "Отписать клиента" : "Отклонить запись";
  // Причина живёт в форме, а форма монтируется при каждом открытии окна:
  // «Отклонить» у другого клиента не наследует прошлую причину.
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  // Окно закрывается по успеху: на время запроса виден спиннер, при ошибке
  // можно повторить.
  const handleCancel = async () => {
    setCancelling(true);
    try {
      const ok = await bookingRpc(
        "cancel_schedule_booking_admin",
        { p_booking_id: booking.id, p_reason: reason || null },
        { error: "Ошибка отмены", failed: "Не удалось отписать" },
      );
      if (!ok) return;
      toast.success(packages ? "Клиент отписан" : "Запись отклонена");
      onClose();
      onDone();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{verb}?</DialogTitle>
        <DialogDescription>
          Запись будет отменена (в «Истории записей» — «Отменено» с причиной), тренировка с
          абонемента не спишется. Клиент сможет записаться снова, если останутся места.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleCancel}>
        <DialogBody>
          <div className="space-y-4">
            <FormField
              label="Причина отмены"
              tip="Сохранится в «Истории записей» — потом видно, почему бронь отклонили."
              optional
            >
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger>
                  <SelectValue placeholder="Не указана" />
                </SelectTrigger>
                <SelectContent>
                  {ADMIN_CANCEL_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={cancelling}>
            Отмена
          </Button>
          <Button type="submit" variant="destructive" disabled={cancelling}>
            {cancelling && <Loader2 className="animate-spin" />}
            {verb}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
