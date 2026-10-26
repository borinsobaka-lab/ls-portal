import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { ContentTranslations } from "@/i18n";
import { APP_FORMAT } from "@/lib/app-format";
import { untypedDb } from "@/lib/untyped-db";
import { settlePackageMemberships } from "@/lib/packages-memberships";
import { PACK_ENTRY_SELECT, attachSubstitutions, type PackEntry } from "./entries";
import { paymentsBySale, type InstallmentRow, type UpcomingPayment } from "./upcoming-payments";

/**
 * Запросы экранов пакетного приложения — одни и те же для самих экранов и для
 * фоновой подгрузки (usePrefetchScreens в __root.tsx): пока клиент смотрит
 * главную, расписание, абонементы и «Студия» уже лежат в кэше, и переход на
 * них открывается сразу, без скелетона.
 */

/** Окно расписания: 3 дня назад … 7 дней вперёд от начала сегодняшнего дня. */
export const SCHEDULE_DAYS_BEFORE = 3;
export const SCHEDULE_DAYS = 10;

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function scheduleRange(today: Date) {
  return {
    from: addDays(today, -SCHEDULE_DAYS_BEFORE).toISOString(),
    to: addDays(today, SCHEDULE_DAYS - SCHEDULE_DAYS_BEFORE).toISOString(),
  };
}

/** Занятия смотримой студии в окне расписания. */
export function packScheduleQuery(studioId: string | null, today: Date, enabled = true) {
  const { from, to } = scheduleRange(today);
  return queryOptions({
    queryKey: ["pack-schedule", studioId, from],
    queryFn: async (): Promise<PackEntry[]> => {
      let query = supabase
        .from("schedule_entries")
        .select(PACK_ENTRY_SELECT)
        .gte("starts_at", from)
        .lt("starts_at", to)
        // Клиенту RLS отдаёт только групповые неотменённые; сотруднику в
        // приложении — все, поэтому фильтруем явно.
        .eq("kind", "group")
        .is("cancelled_at", null);
      if (studioId) query = query.eq("studio_id", studioId);
      const { data, error } = await query.order("starts_at");
      if (error) throw error;
      return attachSubstitutions((data as unknown as PackEntry[]) ?? []);
    },
    enabled,
  });
}

export type MyScheduleBookings = { booked: string[]; waitlist: string[] };

/** Свои записи в окне расписания (id занятий) — явный фильтр по user_id: RLS даёт тренеру все брони студии. */
export function packMyBookingsQuery(userId: string | null, today: Date) {
  const { from, to } = scheduleRange(today);
  return queryOptions({
    queryKey: ["pack-my-bookings", userId, from],
    queryFn: async (): Promise<MyScheduleBookings> => {
      const { data, error } = await untypedDb
        .from("schedule_bookings")
        .select("entry_id, status, schedule_entries!inner(starts_at)")
        .eq("user_id", userId)
        .in("status", ["booked", "waitlist"])
        .gte("schedule_entries.starts_at", from)
        .lt("schedule_entries.starts_at", to);
      if (error) throw error;
      const rows = (data as { entry_id: string; status: string }[] | null) ?? [];
      return {
        booked: rows.filter((r) => r.status === "booked").map((r) => r.entry_id),
        waitlist: rows.filter((r) => r.status === "waitlist").map((r) => r.entry_id),
      };
    },
    enabled: !!userId,
  });
}

// ---- Абонементы ----

export type MembershipKind = "package" | "trial" | "personal";

export type Pack = {
  id: string;
  name: string;
  description: string | null;
  kind: MembershipKind | null;
  visits_count: number | null;
  personal_count: number | null;
  duration_days: number | null;
  price: number;
  max_payments: number | null;
  /** Тег справа от названия и его вид (2026-10-12_zz_packages_app_fixes.sql). */
  tag_text?: string | null;
  tag_style?: "soft" | "bright" | null;
  /** Блок «В подарок» — текст с разметкой. */
  gift_text?: string | null;
  /** «Что входит» — пункты из админки («Номенклатуры»). */
  benefits?: string[] | null;
  /** Переводы названия, описания, тега, подарка и пунктов (src/i18n/content.ts). */
  translations?: ContentTranslations | null;
};

export type MyMembership = {
  id: string;
  status: string;
  ends_at: string | null;
  visits_left: number | null;
  personal_left: number | null;
  /**
   * Остаток диагностик тела (2026-10-15_zz_diagnostics_client_requests.sql);
   * до миграции поля нет.
   */
  diagnostics_left?: number | null;
  balance_kind: "group" | "personal" | null;
  /** kind — тип номенклатуры: «пакет тренировок» отличает от пробного (у обоих balance_kind group). */
  memberships: {
    name: string;
    kind: MembershipKind | null;
    translations?: ContentTranslations | null;
  } | null;
  sale_id: string | null;
  /**
   * Невнесённые платежи рассрочки по продаже — дата и сумма, по порядку
   * (2026-10-13: «следующие платежи» у абонемента). Пусто — всё внесено или
   * продажа без рассрочки.
   */
  upcomingPayments: UpcomingPayment[];
};

/** Сегодня по Тбилиси (ends_at — дата, как считает база). */
function tbilisiDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Номенклатура (витрина «Абонементов»). С 2026-10-13 она общая для всех
 * пакетных студий (db/migrations/2026-10-13_zzzz_packages_shared_catalog.sql):
 * строки отбираются по формату студии, а не по смотримой студии. Фильтр по
 * формату нужен и сотруднику-клиенту: RLS отдаёт ему ещё и номенклатуру его
 * студий в админке.
 */
export function packCatalogQuery() {
  return queryOptions({
    queryKey: ["pack-memberships"],
    queryFn: async (): Promise<Pack[]> => {
      const { data, error } = await untypedDb
        .from("memberships")
        // «*», а не список колонок: тег и подарок (миграция 2026-10-12) приходят,
        // когда они есть в базе, и не ломают запрос до её выкатки.
        .select("*, catalog_studio:studios!inner(format)")
        .eq("catalog_studio.format", "packages")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("price", { ascending: true });
      if (error) throw error;
      return (data as Pack[] | null) ?? [];
    },
  });
}

/** Свои абонементы — по карточке клиента (своя студия), не по смотримой. */
export function packMyMembershipsQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["pack-my-memberships", userId],
    queryFn: async (): Promise<MyMembership[]> => {
      await settlePackageMemberships();
      const { data: client, error: cErr } = await untypedDb
        .from("clients")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!client) return [];
      const { data, error } = await untypedDb
        .from("client_memberships")
        // «*», а не список колонок: diagnostics_left (миграция 2026-10-15)
        // приходит, когда она есть в базе, и не ломает запрос до её выкатки.
        .select("*, memberships(name, kind, translations)")
        .eq("client_id", (client as { id: string }).id)
        .in("status", ["active", "frozen", "pending"])
        .or(`ends_at.is.null,ends_at.gte.${tbilisiDateISO()},status.eq.frozen`)
        .order("balance_kind", { ascending: true })
        .order("status", { ascending: true });
      if (error) throw error;
      const rows = ((data as unknown as Omit<MyMembership, "upcomingPayments">[] | null) ?? [])
        .filter(hasTrainingsLeft)
        .map((m) => ({ ...m, upcomingPayments: [] as MyMembership["upcomingPayments"] }));
      return attachUpcomingPayments(rows);
    },
    enabled: !!userId,
  });
}

/**
 * Клиент с действующим пакетом тренировок (решение владельца 2026-10-15):
 * ему в витрине пакетов — плашка «указана полная стоимость, продление
 * дешевле». Пробное и персональные не в счёт; kind null — давняя
 * номенклатура до типов, это пакет (как в витрине).
 */
export function hasActivePackage(rows: Pick<MyMembership, "memberships">[]) {
  return rows.some((m) => m.memberships && (m.memberships.kind ?? "package") === "package");
}

/**
 * Отхоженный абонемент (и пробное) клиенту не показываем (решение владельца
 * 2026-10-14): база переводит его в expired
 * (db/migrations/2026-10-14_zz_packages_exhausted_expire.sql), фильтр — на
 * случай, если строка ещё active. Безлимит (visits_left null) не кончается,
 * подарочные персональные у пакета тренировок — тоже остаток.
 */
function hasTrainingsLeft(
  m: Pick<
    MyMembership,
    "status" | "visits_left" | "personal_left" | "diagnostics_left" | "balance_kind"
  >,
) {
  if (m.status !== "active") return true;
  const personal = m.personal_left ?? 0;
  // Диагностики держат абонемент, пока их не пройдут (как и база).
  if ((m.diagnostics_left ?? 0) > 0) return true;
  if (m.balance_kind === "personal") return personal > 0;
  return m.visits_left == null || m.visits_left > 0 || personal > 0;
}

/** Диагностик на своих абонементах — balance.ts (без запросов: его проверяют тесты). */
export { diagnosticsBalance } from "./balance";

/**
 * Невнесённые платежи по продажам абонементов — отдельным запросом: не
 * прошёл (нет прав на график, сеть) — абонементы показываются без них.
 */
async function attachUpcomingPayments(rows: MyMembership[]): Promise<MyMembership[]> {
  const saleIds = rows.flatMap((m) => (m.sale_id ? [m.sale_id] : []));
  if (saleIds.length === 0) return rows;
  try {
    const { data, error } = await untypedDb
      .from("sale_installments")
      .select("sale_id, amount, due_date")
      .in("sale_id", saleIds)
      .eq("paid", false)
      .order("due_date", { ascending: true });
    if (error || !data) return rows;
    const bySale = paymentsBySale(data as InstallmentRow[]);
    return rows.map((m) =>
      m.sale_id ? { ...m, upcomingPayments: bySale.get(m.sale_id) ?? [] } : m,
    );
  } catch {
    return rows;
  }
}

// ---- «Студия» ----

// Роли сотрудников и подписи вкладок «Студии» — staff-roles.ts (без
// запросов к базе: их проверяют тесты).
export {
  MASSAGE_BOOKING_URL,
  STAFF_ROLE_TEXT,
  staffHasRating,
  staffOrder,
  staffRole,
  staffRoleLabel,
  type StaffRole,
} from "./staff-roles";

export type StudioTrainer = {
  id: string;
  full_name: string;
  photo_url: string | null;
  bio: string | null;
  role: string | null;
  rating_avg: number | null;
  rating_count: number;
  tip_url: string | null;
  /** Переводы имени и «О тренере» (src/i18n/content.ts). */
  translations?: ContentTranslations | null;
};

const TRAINER_CARD_COLUMNS =
  "id, full_name, photo_url, bio, role, rating_avg, rating_count, tip_url, translations";

/** numeric приходит строкой. */
function normalizeTrainer(t: StudioTrainer): StudioTrainer {
  return { ...t, rating_avg: t.rating_avg == null ? null : Number(t.rating_avg) };
}

/** Карточка одного сотрудника (шторка тренера из окна тренировки). */
export function trainerCardQuery(trainerId: string | null) {
  return queryOptions({
    queryKey: ["trainer-card", trainerId],
    queryFn: async (): Promise<StudioTrainer | null> => {
      const { data, error } = await untypedDb
        .from("trainers")
        .select(TRAINER_CARD_COLUMNS)
        .eq("id", trainerId)
        .maybeSingle();
      if (error) throw error;
      return data ? normalizeTrainer(data as StudioTrainer) : null;
    },
    enabled: !!trainerId,
  });
}

export type AboutInstagramPost = { path: string; url: string | null };

/** «О нас» — фото, цифры и Instagram из админки (app_about_settings). */
export type AboutSettings = {
  cover_photo_path: string | null;
  first_studio_photos: string[];
  second_studio_photos: string[];
  massage_photos: string[];
  community_photo_path: string | null;
  visitors_count: number | null;
  group_trainings_count: number | null;
  visits_count: number | null;
  /** «N специалистов работают…» — с 2026-10-12_zzzzzzz_staff_masseurs.sql; до неё не приходит. */
  specialists_count?: number | null;
  instagram_followers: number | null;
  instagram_posts: AboutInstagramPost[];
};

/**
 * Строка приложения (формата) в app_about_settings. Ошибку пробрасываем:
 * раньше она превращалась в «пусто» и кэшировалась как ответ — раздел без
 * фото Instagram, пока кэш не устареет (AboutTab сам показывает временное).
 * Время свежести — общее (30 с): правки из админки видны при следующем
 * открытии вкладки, а не через 10 минут.
 */
export function aboutQuery() {
  return queryOptions({
    queryKey: ["app-about", APP_FORMAT],
    queryFn: async (): Promise<AboutSettings | null> => {
      const { data, error } = await untypedDb
        .from("app_about_settings")
        // «*», а не список колонок: specialists_count (миграция 2026-10-12)
        // приходит, когда она есть в базе, и не ломает запрос до её выкатки.
        .select("*")
        .eq("format", APP_FORMAT)
        .maybeSingle();
      if (error) throw error;
      return (data as AboutSettings | null) ?? null;
    },
  });
}

/**
 * Сотрудники студии — все роли одним запросом, вкладки «Студии» делят их по
 * staffRole. Ключ прежний: после оценки его обновляет RateTrainer.
 */
export function studioStaffQuery(studioId: string | null, enabled = true) {
  return queryOptions({
    queryKey: ["studio-trainers", studioId],
    queryFn: async (): Promise<StudioTrainer[]> => {
      const { data, error } = await untypedDb
        .from("trainer_studios")
        .select(`trainer:trainers(${TRAINER_CARD_COLUMNS})`)
        .eq("studio_id", studioId);
      if (error) throw error;
      return ((data as unknown as { trainer: StudioTrainer | null }[] | null) ?? [])
        .map((r) => r.trainer)
        .filter((t): t is StudioTrainer => !!t)
        .map(normalizeTrainer)
        .sort((a, b) => a.full_name.localeCompare(b.full_name, "ru"));
    },
    enabled: enabled && !!studioId,
  });
}
