import type { SupabaseClient } from "@supabase/supabase-js";
import { tool } from "ai";
import { z } from "zod";

import type { ClubSectionKey } from "@/lib/admin-access";
import { sanitizeSearch } from "@/lib/format";
import { catalogStudioIds, networkStudioIds, type CatalogStudio } from "@/lib/studio-catalog";

import { addDays, studioDayStart, studioToday } from "./dates";

/**
 * Инструменты AI-ассистента Kate: только чтение данных клуба через клиент
 * от имени сотрудника (RLS действует). Каждый инструмент возвращает
 * { count, rows } или { error } — модель обязана сказать об ошибке, а не
 * подставлять значения (см. prompt.ts). Какие инструменты открыты
 * сотруднику — access.ts (разделы «Доступов»).
 *
 * Инструменты под вопросы о продажах (2026-10-19) отдают строки уже со
 * связанными именами клиентов и абонементов: модель не сопоставляет id сама.
 * Медицинское из анкеты (health_flags, health_notes) Kate не получает —
 * ответы уходят внешнему провайдеру модели.
 */

type QueryResult = { data: unknown; error: { message: string } | null };
type Row = Record<string, unknown>;

/** Ответ Supabase -> результат инструмента. */
async function listResult(query: PromiseLike<QueryResult>) {
  const { data, error } = await query;
  if (error) return { error: error.message };
  const rows = (data ?? []) as Row[];
  return { count: rows.length, rows };
}

/** Ответ RPC, возвращающей jsonb-массив, -> результат инструмента. */
async function rpcList(query: PromiseLike<QueryResult>) {
  const { data, error } = await query;
  if (error) return { error: error.message };
  const rows = (Array.isArray(data) ? data : []) as Row[];
  return { count: rows.length, rows };
}

const limit = (max: number, byDefault: number) =>
  z.number().int().min(1).max(max).default(byDefault);
// Только дата: inPeriod строит из неё границы суток, время сломало бы фильтр.
const dateString = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате YYYY-MM-DD, без времени")
    .describe(`${what}, YYYY-MM-DD`);
const isoDate = (what: string) => dateString(what).optional();
const uuid = (what: string) => z.string().uuid().describe(what);

/** Встроенная связь нетипизированного клиента: объект или массив из одного. */
function one<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

function sum<T>(rows: T[], value: (row: T) => unknown) {
  return rows.reduce((s, r) => s + Number(value(r) || 0), 0);
}

type ClientRef = {
  id?: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
};

/** «Фамилия Имя», как в админке; нет частей — full_name. */
export function clientName(c: ClientRef | null | undefined): string | null {
  if (!c) return null;
  return (
    [c.last_name, c.first_name].filter(Boolean).join(" ").trim() || c.full_name?.trim() || null
  );
}

/**
 * Фильтр периода по timestamptz-колонке: границы — сутки студии, `to`
 * включительно (до начала следующих суток). Голая дата в .lte() обрезала бы
 * последний день до полуночи UTC.
 */
function inPeriod<Q extends { gte: (c: string, v: string) => Q; lt: (c: string, v: string) => Q }>(
  q: Q,
  column: string,
  from?: string,
  to?: string,
) {
  if (from) q = q.gte(column, studioDayStart(from));
  if (to) q = q.lt(column, studioDayStart(addDays(to, 1)));
  return q;
}

/** Постранично (лимит PostgREST — 1000 строк на ответ), не больше `max`. */
async function allRows(
  page: (lo: number, hi: number) => PromiseLike<QueryResult>,
  max = 5000,
): Promise<{ rows: Row[] } | { error: string }> {
  const rows: Row[] = [];
  const size = 1000;
  for (let lo = 0; lo < max; lo += size) {
    const { data, error } = await page(lo, lo + size - 1);
    if (error) return { error: error.message };
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < size) break;
  }
  return { rows };
}

function countBy<T>(rows: T[], key: (r: T) => string, value: (r: T) => number = () => 1) {
  const out: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] ??= { count: 0, amount: 0 };
    out[k].count += 1;
    out[k].amount += value(r);
  }
  return out;
}

const CLIENT_COLUMNS = "id, full_name, first_name, last_name, phone";

export type AssistantToolsOptions = {
  /**
   * Открыт ли сотруднику раздел клуба — для частей сводки по клиенту
   * (продажи, посещения, заявки, NPS). По умолчанию — все.
   */
  canSee?: (key: ClubSectionKey) => boolean;
};

export function createAssistantTools(
  supabase: SupabaseClient,
  studioId: string,
  opts: AssistantToolsOptions = {},
) {
  const canSee = opts.canSee ?? (() => true);
  // feedback и nps_responses: старые строки могут быть без студии (до
  // feedback_nps_studio.sql) — так же, как в разделах админки.
  const ownOrUnassigned = `studio_id.eq.${studioId},studio_id.is.null`;

  // Список клубов читается публично; один раз на запрос к Kate.
  let studiosLoad: Promise<CatalogStudio[]> | null = null;
  const studios = () =>
    (studiosLoad ??= (async () => {
      const { data } = await supabase.from("studios").select("id, format");
      return (data ?? []) as CatalogStudio[];
    })());
  // Тренировки и номенклатура пакетных клубов общие (lib/studio-catalog.ts).
  const catalogIds = async () => catalogStudioIds(await studios(), studioId);
  // База клиентов пакетных клубов — тоже общая (2026-10-17): клиент абонемента
  // или продажи клуба мог быть заведён в другом пакетном клубе.
  const clientStudioIds = async () => networkStudioIds(await studios(), studioId);
  const isPackages = async () =>
    (await studios()).find((s) => s.id === studioId)?.format === "packages";

  return {
    // ====== КЛИЕНТЫ ======
    list_clients: tool({
      description:
        "Клиенты клуба: ФИО, телефон, email, ДР, пол, заметки, дата регистрации, последний визит, " +
        "club_status (chk — член клуба: действующий или замороженный абонемент, пробный не в счёт; " +
        "bchk — бывший: абонементы были, действующего нет; pchk — потенциальный: абонементов не было), " +
        "primary_goal — цель из анкеты приложения, has_app — входил в приложение, app_last_seen_at — " +
        "последний раз в приложении, source — кто добавил (admin — сотрудник, import — из 1С, mobile — приложение). " +
        "У клубов с пакетами тренировок база клиентов общая — здесь клиенты всех таких клубов. " +
        "Период — по дате добавления карточки (created_at), обе даты включительно.",
      inputSchema: z.object({
        ids: z
          .array(z.string().uuid())
          .optional()
          .describe("Точные clients.id, если нужно подтянуть клиентов по связям из других таблиц"),
        search: z.string().optional().describe("Поиск по имени/фамилии/телефону/email"),
        club_status: z.enum(["chk", "bchk", "pchk"]).optional(),
        added_from: isoDate("Добавлены с"),
        added_to: isoDate("Добавлены по (включительно)"),
        order_by: z
          .enum(["added_desc", "app_last_seen_desc", "last_visit_desc"])
          .default("added_desc"),
        limit: limit(500, 100),
      }),
      execute: async ({ ids, search, club_status, added_from, added_to, order_by, limit }) => {
        let q = supabase
          .from("clients_with_status")
          .select(
            "id, studio_id, full_name, first_name, last_name, phone, phone2, email, birthday, gender, notes, registration_date, last_visit_date, source, club_status, primary_goal, user_id, app_last_seen_at, created_at",
          )
          .in("studio_id", await clientStudioIds());
        q = inPeriod(q, "created_at", added_from, added_to);
        if (order_by === "app_last_seen_desc") {
          q = q.order("app_last_seen_at", { ascending: false, nullsFirst: false });
        } else if (order_by === "last_visit_desc") {
          q = q.order("last_visit_date", { ascending: false, nullsFirst: false });
        } else {
          q = q.order("created_at", { ascending: false });
        }
        q = q.limit(limit);
        if (ids?.length) q = q.in("id", ids);
        if (club_status) q = q.eq("club_status", club_status);
        // Запятые и скобки из строки модели развалили бы .or():
        // там запятая разделяет условия, а скобки группируют.
        const term = sanitizeSearch(search ?? "");
        if (term) {
          q = q.or(
            `full_name.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%,phone2.ilike.%${term}%,email.ilike.%${term}%`,
          );
        }
        const res = await listResult(q);
        if ("error" in res) return res;
        // Сам id учётной записи модели ни к чему — только факт входа.
        const rows = res.rows.map(({ user_id, ...r }) => ({
          ...r,
          client_name: clientName(r as ClientRef),
          has_app: !!user_id,
        }));
        return { count: rows.length, rows };
      },
    }),

    get_client_details: tool({
      description:
        "Всё о клиенте одним вызовом — для вопросов «что предложить клиенту», «почему не ходит»: карточка и статус, " +
        "абонементы (остаток, срок, статус), продажи и неоплаченные платежи, последние посещения, анкета приложения " +
        "(цели, опыт, удобное время, откуда узнал), заявки, последние ответы NPS, приложение (последний вход, " +
        "уведомления, какие разделы смотрел за 30 дней). Части, закрытые сотруднику, не приходят.",
      inputSchema: z.object({ client_id: uuid("clients.id") }),
      execute: async ({ client_id }) => {
        const scope = await clientStudioIds();
        const { data: card, error } = await supabase
          .from("clients_with_status")
          .select(
            "id, studio_id, full_name, first_name, last_name, phone, phone2, email, birthday, gender, notes, registration_date, last_visit_date, source, club_status, primary_goal, user_id, app_last_seen_at, created_at",
          )
          .eq("id", client_id)
          .in("studio_id", scope)
          .maybeSingle();
        if (error) return { error: error.message };
        if (!card) return { error: "Клиент не найден в базе клиентов этого клуба" };
        const userId = (card as Row).user_id as string | null;

        const part = async (q: PromiseLike<QueryResult>) => {
          const { data, error } = await q;
          return error ? { error: error.message } : data;
        };
        const parts: Record<string, PromiseLike<unknown>> = {
          memberships: part(
            supabase
              .from("client_memberships")
              .select(
                "id, studio_id, status, balance_kind, started_at, ends_at, visits_left, personal_left, diagnostics_left, starts_on_first_visit, frozen_until, auto_renew, created_at, memberships(name, kind, visits_count, personal_count, duration_days, price)",
              )
              .eq("client_id", client_id)
              .order("created_at", { ascending: false })
              .limit(20),
          ),
        };
        if (canSee("sales") || canSee("client-memberships")) {
          parts.sales = part(
            supabase
              .from("sales")
              .select(
                "id, studio_id, sold_at, total_amount, discount_amount, promo_code, sale_kind, source, admin_name, trainer_name, comment, memberships(name, kind), sale_installments(amount, due_date, paid, paid_at, refunded)",
              )
              .eq("client_id", client_id)
              .order("sold_at", { ascending: false })
              .limit(20),
          );
        }
        if (canSee("schedule") || canSee("bookings-log") || canSee("clients")) {
          parts.visits = part(
            supabase
              .from("bookings_log")
              .select("studio_id, workout_name, workout_type, starts_at, status, cancel_reason")
              .eq("client_id", client_id)
              .order("starts_at", { ascending: false })
              .limit(15),
          );
        }
        if (userId) {
          parts.profile = part(
            supabase
              .from("member_profiles")
              .select(
                "primary_goal, goal_other, goal_motivation, target_timeframe, desired_frequency, experience_level, current_weekly_activity, preferred_times, referral_source, onboarding_completed_at",
              )
              .eq("user_id", userId)
              .maybeSingle(),
          );
          parts.app = part(supabase.rpc("client_app_overview", { p_client_id: client_id }));
        }
        if (canSee("requests")) {
          parts.requests = part(
            supabase
              .from("client_requests")
              .select("kind, goals, goal_other, comment, created_at, processed_at")
              .eq("client_id", client_id)
              .order("created_at", { ascending: false })
              .limit(10),
          );
        }
        if (canSee("nps")) {
          parts.nps = part(
            supabase
              .from("nps_responses")
              .select("score, survey_type, comment, created_at, handled")
              .eq("client_id", client_id)
              .order("created_at", { ascending: false })
              .limit(5),
          );
        }
        const keys = Object.keys(parts);
        const values = await Promise.all(keys.map((k) => parts[k]));
        const details: Row = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
        details.app = summarizeApp(details.app);

        const { user_id: _user, ...client } = card as Row;
        return {
          client: { ...client, client_name: clientName(client as ClientRef), has_app: !!userId },
          ...details,
        };
      },
    }),

    list_app_clients: tool({
      description:
        "Клиенты в мобильном приложении клуба. order: registered — кто недавно впервые вошёл в приложение " +
        "(первый вход — first_sign_in_at, новые сверху); last_seen — кто недавно открывал приложение (last_app_at); " +
        "membership_views — кто за 30 дней чаще смотрел раздел абонементов (интерес к покупке). " +
        "Также: открытия за 30 дней, включены ли пуши, club_status (chk/bchk/pchk). " +
        "since — только вошедшие (registered) или открывавшие (last_seen) с этой даты.",
      inputSchema: z.object({
        order: z.enum(["registered", "last_seen", "membership_views"]).default("registered"),
        since: isoDate("С даты"),
        limit: limit(200, 30),
      }),
      execute: async ({ order, since, limit }) =>
        rpcList(
          supabase.rpc("assistant_app_clients", {
            p_studio_id: studioId,
            p_order: order,
            p_since: since ?? null,
            p_limit: limit,
          }),
        ),
    }),

    list_inactive_members: tool({
      description:
        "Клиенты с действующим абонементом, которые давно не ходят: последнее посещение раньше, чем days дней назад, " +
        "или ни одного (membership_state = awaiting — купил, но ещё не пришёл ни разу). Сначала те, кто не был дольше всех. " +
        "Есть остаток (visits_left / personal_left), срок (ends_at), запись на будущее (has_upcoming_booking). " +
        "Повод позвонить: абонемент сгорает зря — клиент не продлит.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).default(14),
        limit: limit(300, 50),
      }),
      execute: async ({ days, limit }) =>
        rpcList(
          supabase.rpc("assistant_inactive_members", {
            p_studio_id: studioId,
            p_days: days,
            p_limit: limit,
          }),
        ),
    }),

    list_birthdays: tool({
      description:
        "Дни рождения клиентов клуба в ближайшие days дней (0 — только сегодня): дата, сколько исполняется, телефон, club_status.",
      inputSchema: z.object({ days: z.number().int().min(0).max(60).default(7) }),
      execute: async ({ days }) =>
        rpcList(supabase.rpc("assistant_birthdays", { p_studio_id: studioId, p_days: days })),
    }),

    // ====== СОТРУДНИКИ ======
    // Сотрудники общие для студий (trainer_studios); здесь — сотрудники этой
    // студии. Банковские реквизиты и ставки ассистенту не отдаём.
    list_trainers: tool({
      description:
        "Сотрудники клуба: имя, роль (trainer — тренер, admin — администратор, senior_admin — руководитель студии, masseur — массажист), специализация, рейтинг из приложения.",
      inputSchema: z.object({ limit: limit(200, 100) }),
      execute: async ({ limit }) =>
        listResult(
          supabase
            .from("trainers")
            .select(
              "id, full_name, role, specialization, rating_avg, rating_count, telegram, created_at, trainer_studios!inner(studio_id)",
            )
            .eq("trainer_studios.studio_id", studioId)
            .limit(limit),
        ),
    }),

    // ====== ТРЕНИРОВКИ (шаблоны) ======
    list_workouts: tool({
      description: "Шаблоны тренировок клуба (название, описание, тип).",
      inputSchema: z.object({ limit: limit(200, 100) }),
      execute: async ({ limit }) =>
        listResult(
          supabase
            .from("workouts")
            .select("id, name, description, type, created_at")
            .in("studio_id", await catalogIds())
            .limit(limit),
        ),
    }),

    // ====== РАСПИСАНИЕ ======
    list_schedule: tool({
      description:
        "Расписание занятий за период (по дате начала занятия, обе даты включительно): название тренировки, тренеры, " +
        "вместимость (capacity, null — без лимита) и записано (booked_count), отменено ли клубом (cancelled_at). " +
        "kind: group — групповое, personal — персональное, diagnostic — диагностика тела, other — прочая активность (название в title).",
      inputSchema: z.object({
        from: dateString("Начало периода"),
        to: dateString("Конец периода включительно"),
        limit: limit(1000, 500),
      }),
      execute: async ({ from, to, limit }) => {
        const q = supabase
          .from("schedule_entries")
          .select(
            "id, kind, title, starts_at, ends_at, capacity, booked_count, cancelled_at, cancel_reason, workouts(name), schedule_entry_trainers(trainer:trainers(full_name))",
          )
          .eq("studio_id", studioId);
        const res = await listResult(
          inPeriod(q, "starts_at", from, to).order("starts_at", { ascending: true }).limit(limit),
        );
        if ("error" in res) return res;
        const rows = res.rows.map(({ workouts, schedule_entry_trainers, ...r }) => ({
          ...r,
          workout_name: one(workouts as { name: string } | null)?.name ?? null,
          trainers: ((schedule_entry_trainers ?? []) as { trainer: unknown }[])
            .map((t) => one(t.trainer as { full_name: string } | null)?.full_name)
            .filter(Boolean),
        }));
        return { count: rows.length, rows };
      },
    }),

    // ====== АБОНЕМЕНТЫ (шаблоны) ======
    list_memberships: tool({
      description:
        "Номенклатура абонементов клуба: название, тип (package — пакет групповых, personal — пакет персональных, trial — пробное, single — разовое посещение), " +
        "описание, бонусы, число посещений, срок, цена, сколькими платежами можно оплатить, активность. Можно фильтровать по точным ID.",
      inputSchema: z.object({
        ids: z
          .array(z.string().uuid())
          .optional()
          .describe(
            "Точные memberships.id, если нужно подтянуть названия по связям из client_memberships или sales",
          ),
        only_active: z.boolean().default(false),
        for_couple: z.boolean().optional(),
        limit: limit(500, 200),
      }),
      execute: async ({ ids, only_active, for_couple, limit }) => {
        let q = supabase
          .from("memberships")
          .select(
            "id, name, kind, description, benefits, visits_count, personal_count, diagnostics_count, duration_days, auto_renew, installment_enabled, max_payments, price, is_active, for_couple, created_at",
          )
          .in("studio_id", await catalogIds())
          .limit(limit);
        if (ids?.length) q = q.in("id", ids);
        if (only_active) q = q.eq("is_active", true);
        if (typeof for_couple === "boolean") q = q.eq("for_couple", for_couple);
        return listResult(q);
      },
    }),

    // ====== ВЫДАННЫЕ КЛИЕНТАМ АБОНЕМЕНТЫ ======
    list_client_memberships: tool({
      description:
        "Выданные клиентам абонементы (client_memberships) с именем клиента и названием абонемента. " +
        "status: active — действует, frozen — заморожен (тоже действующий), pending — оплаченное продление ждёт в очереди, " +
        "expired — закончился, replaced — заменён новым, cancelled — отменён, refunded — возврат. " +
        "Для вопросов «у кого скоро заканчивается абонемент» используй list_expiring_client_memberships.",
      inputSchema: z.object({
        status: z
          .enum(["active", "frozen", "pending", "replaced", "expired", "cancelled", "refunded"])
          .optional(),
        client_id: z.string().uuid().optional(),
        order_by: z.enum(["created_desc", "ends_at_asc"]).default("created_desc"),
        limit: limit(500, 200),
      }),
      execute: async ({ status, client_id, order_by, limit }) => {
        let q = supabase
          .from("client_memberships")
          .select(
            `id, studio_id, client_id, membership_id, sale_id, source, status, balance_kind, started_at, ends_at, visits_left, personal_left, starts_on_first_visit, created_at, clients(${CLIENT_COLUMNS}), memberships(name, kind)`,
          )
          .in("studio_id", await clientStudioIds())
          .limit(limit);
        q =
          order_by === "ends_at_asc"
            ? q.order("ends_at", { ascending: true, nullsFirst: false })
            : q.order("created_at", { ascending: false });
        if (status) q = q.eq("status", status);
        if (client_id) q = q.eq("client_id", client_id);
        const res = await listResult(q);
        if ("error" in res) return res;
        const rows = res.rows.map(({ clients, memberships, ...r }) => ({
          ...r,
          client_name: clientName(one(clients as ClientRef | null)),
          client_phone: one(clients as ClientRef | null)?.phone ?? null,
          membership_name: one(memberships as { name: string } | null)?.name ?? null,
          membership_kind: one(memberships as { kind: string } | null)?.kind ?? null,
        }));
        return { count: rows.length, rows };
      },
    }),

    list_expiring_client_memberships: tool({
      description:
        "ТОЛЬКО для вопросов «у кого заканчивается/истекает абонемент», «кому предложить продление». " +
        "Пробные и разовые посещения сюда не входят (они — в list_trials_without_purchase). " +
        "Действующие абонементы, у которых срок кончается в ближайшие within_days дней (reason = ends_soon), " +
        "а в клубах с пакетами тренировок — и у которых осталось не больше low_balance тренировок (reason = low_balance). " +
        "Уже купившие продление (оно ждёт в очереди или оформлено) исключены, если не include_renewed. " +
        "Строки уже со связанным клиентом и абонементом — сортировка по дате окончания.",
      inputSchema: z.object({
        within_days: z.number().int().min(0).max(365).default(14),
        low_balance: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(2)
          .describe("Пакетные клубы: остаток тренировок не больше этого числа"),
        include_renewed: z.boolean().default(false),
        limit: limit(300, 50),
      }),
      execute: async ({ within_days, low_balance, include_renewed, limit }) => {
        const today = studioToday();
        const packages = await isPackages();
        const until = addDays(today, within_days);
        const soon = `and(ends_at.gte.${today},ends_at.lte.${until})`;
        const low = packages
          ? `,and(balance_kind.eq.group,visits_left.lte.${low_balance}),and(balance_kind.eq.personal,personal_left.lte.${low_balance})`
          : "";
        const { data, error } = await supabase
          .from("client_memberships")
          .select(
            `id, studio_id, client_id, status, balance_kind, started_at, ends_at, visits_left, personal_left, starts_on_first_visit, auto_renew, created_at, clients(${CLIENT_COLUMNS}), memberships(name, kind, visits_count, personal_count, price)`,
          )
          .in("studio_id", await clientStudioIds())
          .eq("status", "active")
          .or(`${soon}${low}`)
          .order("ends_at", { ascending: true, nullsFirst: false })
          .limit(1000);
        if (error) return { error: error.message };
        // Срок уже прошёл (статус ещё не сменился) — не «заканчивается».
        // Пробное и разовое — не продление: для них list_trials_without_purchase.
        const live = ((data ?? []) as Row[]).filter((r) => {
          const kind = one(r.memberships as { kind: string | null } | null)?.kind;
          return (
            (!r.ends_at || String(r.ends_at) >= today) && kind !== "trial" && kind !== "single"
          );
        });

        // Продление: следующий абонемент того же вида уже куплен — ждёт в
        // очереди (pending) или выдан позже и действует дольше.
        const clientIds = [...new Set(live.map((r) => r.client_id as string))];
        const renewed = new Set<string>();
        if (clientIds.length) {
          const { data: others, error: othersError } = await supabase
            .from("client_memberships")
            .select("id, client_id, status, balance_kind, ends_at, created_at")
            .in("client_id", clientIds)
            .in("status", ["pending", "active", "frozen"]);
          if (othersError) return { error: othersError.message };
          for (const r of live) {
            const next = ((others ?? []) as Row[]).some(
              (o) =>
                o.id !== r.id &&
                o.client_id === r.client_id &&
                (o.balance_kind ?? "group") === (r.balance_kind ?? "group") &&
                (o.status === "pending" ||
                  String(o.created_at) > String(r.created_at) ||
                  (!!o.ends_at && !!r.ends_at && String(o.ends_at) > String(r.ends_at))),
            );
            if (next) renewed.add(r.id as string);
          }
        }

        const rows = live
          .filter((r) => include_renewed || !renewed.has(r.id as string))
          .slice(0, limit)
          .map(({ clients, memberships, ...r }) => {
            const client = one(clients as ClientRef | null);
            const m = one(
              memberships as {
                name: string | null;
                kind: string | null;
                visits_count: number | null;
                personal_count: number | null;
                price: number | null;
              } | null,
            );
            const balanceLeft = r.balance_kind === "personal" ? r.personal_left : r.visits_left;
            const endsSoon = !!r.ends_at && String(r.ends_at) <= until;
            return {
              id: r.id,
              client_id: r.client_id,
              client_name: clientName(client),
              client_phone: client?.phone ?? null,
              membership_name: m?.name ?? null,
              membership_kind: m?.kind ?? null,
              membership_price: m?.price ?? null,
              reason: endsSoon ? "ends_soon" : "low_balance",
              ends_at: r.ends_at,
              days_left: r.ends_at
                ? Math.round((Date.parse(String(r.ends_at)) - Date.parse(today)) / 86_400_000)
                : null,
              balance_left: balanceLeft,
              awaiting_first_visit: !!r.starts_on_first_visit && !r.started_at,
              auto_renew: r.auto_renew,
              renewal_bought: renewed.has(r.id as string),
              studio_id: r.studio_id,
            };
          });
        return {
          count: rows.length,
          renewed_excluded: include_renewed ? 0 : renewed.size,
          rows,
          integrity_note:
            "client_name и membership_name взяты только из связанных строк. Если поле null — связь в базе отсутствует, его нельзя додумывать.",
        };
      },
    }),

    // ====== ПАКЕТНЫЕ КЛУБЫ: РАЗДЕЛ «АБОНЕМЕНТЫ» ======
    list_package_sales: tool({
      description:
        "Только клубы с пакетами тренировок: проданные абонементы клуба, как в разделе «Абонементы» — клиент, абонемент, " +
        "тип продажи (sale_kind: new — новая, trial — пробное, upsell — допродажа, renewal — продление), продавец, тренер, " +
        "оплата (payment_state: paid — оплачен, pending — ждёт платежа, soon — платёж в ближайшие 2 дня, overdue — просрочен, refunded — возврат), " +
        "оплачено (paid_amount), следующий платёж, статус абонемента (membership_state: active, awaiting — ждёт первого посещения, " +
        "frozen, pending — в очереди, expired, replaced, refunded), остаток (balance_left), окончание, откуда (added_via: admin / import — 1С / mobile). " +
        "Период — по дате продажи.",
      inputSchema: z.object({
        from: isoDate("Продано с"),
        to: isoDate("Продано по (включительно)"),
        payment_state: z.enum(["paid", "pending", "soon", "overdue", "refunded"]).optional(),
        membership_state: z
          .enum(["active", "awaiting", "frozen", "pending", "expired", "replaced", "refunded"])
          .optional(),
        sale_kind: z.enum(["new", "trial", "upsell", "renewal"]).optional(),
        client_id: z.string().uuid().optional(),
        limit: limit(500, 100),
      }),
      execute: async (input) => {
        if (!(await isPackages())) {
          return { error: "Раздел «Абонементы» есть только у клубов с пакетами тренировок" };
        }
        let q = supabase
          .from("client_packages_list")
          .select(
            "id, client_id, clients, memberships, sold_at, total_amount, sale_kind, admin_name, trainer_name, promo_code, comment, membership_note, payment_state, paid_amount, next_due_date, membership_state, balance_left, visits_left, personal_left, diagnostics_left, ends_at, added_via",
          )
          .eq("studio_id", studioId)
          .order("sold_at", { ascending: false })
          .limit(input.limit);
        if (input.from) q = q.gte("sold_at", input.from);
        if (input.to) q = q.lte("sold_at", input.to);
        if (input.payment_state) q = q.eq("payment_state", input.payment_state);
        if (input.membership_state) q = q.eq("membership_state", input.membership_state);
        if (input.sale_kind) q = q.eq("sale_kind", input.sale_kind);
        if (input.client_id) q = q.eq("client_id", input.client_id);
        const res = await listResult(q);
        if ("error" in res) return res;
        const rows = res.rows.map(({ clients, memberships, ...r }) => {
          const client = clients as ClientRef | null;
          const m = memberships as { name: string; kind: string } | null;
          return {
            ...r,
            client_name: clientName(client),
            client_phone: client?.phone ?? null,
            membership_name: m?.name ?? null,
            membership_kind: m?.kind ?? null,
          };
        });
        return {
          count: rows.length,
          total_amount: sum(rows as Row[], (r) => r.total_amount),
          paid_amount: sum(rows as Row[], (r) => r.paid_amount),
          rows,
        };
      },
    }),

    list_installments_due: tool({
      description:
        "Платежи по рассрочке, которые не внесены: просроченные (overdue = true) и с датой в ближайшие within_days дней. " +
        "С клиентом, телефоном, абонементом и суммой. Повод напомнить об оплате.",
      inputSchema: z.object({
        within_days: z.number().int().min(0).max(60).default(3),
        limit: limit(500, 100),
      }),
      execute: async ({ within_days, limit }) => {
        const today = studioToday();
        const { data, error } = await supabase
          .from("sale_installments")
          .select(
            `id, amount, due_date, sales!inner(id, studio_id, client_id, sold_at, total_amount, admin_name, clients(${CLIENT_COLUMNS}), memberships(name))`,
          )
          .eq("sales.studio_id", studioId)
          .eq("paid", false)
          .eq("refunded", false)
          .lte("due_date", addDays(today, within_days))
          .order("due_date", { ascending: true })
          .limit(limit);
        if (error) return { error: error.message };
        const rows = ((data ?? []) as Row[]).map((r) => {
          const sale = one<Row>(r.sales as Row | null);
          const client = one(sale?.clients as ClientRef | null);
          return {
            installment_id: r.id,
            amount: r.amount,
            due_date: r.due_date,
            overdue: String(r.due_date) < today,
            sale_id: sale?.id ?? null,
            sold_at: sale?.sold_at ?? null,
            sale_total: sale?.total_amount ?? null,
            seller: sale?.admin_name ?? null,
            client_id: sale?.client_id ?? null,
            client_name: clientName(client),
            client_phone: client?.phone ?? null,
            membership_name: one(sale?.memberships as { name: string } | null)?.name ?? null,
          };
        });
        const overdue = rows.filter((r) => r.overdue);
        return {
          count: rows.length,
          overdue_count: overdue.length,
          overdue_amount: sum(overdue, (r) => r.amount),
          upcoming_amount: sum(
            rows.filter((r) => !r.overdue),
            (r) => r.amount,
          ),
          rows,
        };
      },
    }),

    // ====== ПРОДАЖИ ======
    list_sales: tool({
      description:
        "Продажи абонементов клуба: дата, сумма, скидка, промокод, тип продажи (sale_kind), откуда (source: admin / mobile), " +
        "клиент, абонемент, продавец (admin_name), тренер, комментарий. " +
        "Фильтр по дате продажи (sold_at, обе даты включительно). total_amount — сумма продаж без учёта возвратов.",
      inputSchema: z.object({
        from: isoDate("Начало периода"),
        to: isoDate("Конец периода включительно"),
        client_id: z.string().uuid().optional(),
        limit: limit(500, 200),
      }),
      execute: async ({ from, to, client_id, limit }) => {
        let q = supabase
          .from("sales")
          .select(
            `id, sold_at, client_id, membership_id, admin_name, total_amount, discount_amount, promo_code, down_payment_amount, remaining_installments, sale_kind, source, trainer_name, comment, created_at, clients(${CLIENT_COLUMNS}), memberships(name, kind)`,
          )
          .eq("studio_id", studioId)
          .order("sold_at", { ascending: false })
          .limit(limit);
        // sold_at — date, поэтому голые даты здесь корректны.
        if (from) q = q.gte("sold_at", from);
        if (to) q = q.lte("sold_at", to);
        if (client_id) q = q.eq("client_id", client_id);
        const res = await listResult(q);
        if ("error" in res) return res;
        const rows = res.rows.map(({ clients, memberships, ...r }) => ({
          ...r,
          client_name: clientName(one(clients as ClientRef | null)),
          membership_name: one(memberships as { name: string } | null)?.name ?? null,
          membership_kind: one(memberships as { kind: string } | null)?.kind ?? null,
        }));
        return {
          count: rows.length,
          total_amount: sum(rows as Row[], (r) => r.total_amount),
          rows,
        };
      },
    }),

    sales_summary: tool({
      description:
        "Итоги продаж клуба за период (обе даты включительно): число и сумма продаж абонементов, разбивка по типу продажи " +
        "(sale_kind), виду абонемента, названию (топ-10), продавцу, источнику (админка / приложение), скидки; " +
        "received — фактически поступившие деньги за период (внесённые платежи рассрочки по дате внесения, продажи без графика — в день продажи), " +
        "refunds — возвраты за период. Для вопросов «сколько продали», «кто из администраторов продаёт лучше».",
      inputSchema: z.object({
        from: dateString("Начало периода"),
        to: dateString("Конец периода включительно"),
      }),
      execute: async ({ from, to }) => {
        const sales = await allRows((lo, hi) =>
          supabase
            .from("sales")
            .select(
              "id, sold_at, total_amount, discount_amount, sale_kind, source, admin_name, memberships(name, kind), sale_installments(id)",
            )
            .eq("studio_id", studioId)
            .gte("sold_at", from)
            .lte("sold_at", to)
            .order("sold_at")
            .order("id")
            .range(lo, hi),
        );
        if ("error" in sales) return sales;
        const paid = await allRows((lo, hi) =>
          supabase
            .from("sale_installments")
            .select("amount, paid_at, sales!inner(studio_id)")
            .eq("sales.studio_id", studioId)
            .eq("paid", true)
            .gte("paid_at", from)
            .lte("paid_at", to)
            .order("id")
            .range(lo, hi),
        );
        if ("error" in paid) return paid;
        const refunds = await allRows((lo, hi) =>
          inPeriod(
            supabase.from("refunds").select("amount, refunded_at").eq("studio_id", studioId),
            "refunded_at",
            from,
            to,
          )
            .order("id")
            .range(lo, hi),
        );
        if ("error" in refunds) return refunds;

        type Sale = Row & { memberships: unknown; client_memberships: unknown };
        const rows = sales.rows as Sale[];
        const amount = (r: Row) => Number(r.total_amount || 0);
        const membership = (r: Sale) =>
          one(r.memberships as { name: string | null; kind: string | null } | null);
        const withoutSchedule = rows.filter(
          (r) => !((r.sale_installments as unknown[] | null) ?? []).length,
        );
        const byName = Object.entries(
          countBy(rows, (r) => membership(r)?.name ?? "без названия", amount),
        )
          .sort((a, b) => b[1].amount - a[1].amount)
          .slice(0, 10);
        return {
          period: { from, to },
          sales_count: rows.length,
          sales_amount: sum(rows, amount),
          discount_amount: sum(rows, (r) => r.discount_amount),
          truncated: rows.length >= 5000,
          by_sale_kind: countBy(rows, (r) => String(r.sale_kind ?? "без типа"), amount),
          by_membership_kind: countBy(rows, (r) => membership(r)?.kind ?? "unknown", amount),
          top_memberships: Object.fromEntries(byName),
          by_seller: countBy(rows, (r) => String(r.admin_name ?? "не указан"), amount),
          by_source: countBy(rows, (r) => String(r.source ?? "admin"), amount),
          received: sum(paid.rows, (r) => r.amount) + sum(withoutSchedule, amount),
          refunds_count: refunds.rows.length,
          refunds_amount: sum(refunds.rows, (r) => r.amount),
        };
      },
    }),

    list_trials_without_purchase: tool({
      description:
        "Кто был на пробном или разовом посещении за период и после этого НЕ купил абонемент — главный список для звонков " +
        "новичкам. Период — по дате продажи пробного (обе даты включительно). include_bought — показать и купивших (bought = true).",
      inputSchema: z.object({
        from: dateString("Начало периода"),
        to: dateString("Конец периода включительно"),
        include_bought: z.boolean().default(false),
        limit: limit(300, 100),
      }),
      execute: async ({ from, to, include_bought, limit }) => {
        const { data, error } = await supabase
          .from("sales")
          .select(
            `id, client_id, sold_at, admin_name, trainer_name, total_amount, clients(${CLIENT_COLUMNS}), memberships!inner(name, kind), client_memberships(status, visits_left, started_at)`,
          )
          .eq("studio_id", studioId)
          .in("memberships.kind", ["trial", "single"])
          .gte("sold_at", from)
          .lte("sold_at", to)
          .order("sold_at", { ascending: false })
          .limit(1000);
        if (error) return { error: error.message };
        const trials = (data ?? []) as Row[];
        const clientIds = [...new Set(trials.map((t) => t.client_id as string).filter(Boolean))];
        const bought = new Map<string, string[]>();
        if (clientIds.length) {
          // Покупка — в любом клубе базы: у пакетных клубов клиент общий.
          const { data: later, error: laterError } = await supabase
            .from("sales")
            .select("client_id, sold_at, memberships(kind), client_memberships(status)")
            .in("client_id", clientIds)
            .in("studio_id", await clientStudioIds())
            .gte("sold_at", from);
          if (laterError) return { error: laterError.message };
          for (const s of (later ?? []) as Row[]) {
            const kind = one(s.memberships as { kind: string } | null)?.kind;
            const term = one(s.client_memberships as { status: string } | null);
            if (!kind || kind === "trial" || kind === "single") continue;
            if (!term || term.status === "cancelled" || term.status === "refunded") continue;
            const list = bought.get(s.client_id as string) ?? [];
            list.push(String(s.sold_at));
            bought.set(s.client_id as string, list);
          }
        }
        const today = studioToday();
        const rows = trials
          .map(({ clients, memberships, client_memberships, ...t }) => {
            const client = one(clients as ClientRef | null);
            const term = one(client_memberships as { visits_left: number | null } | null);
            const isBought = (bought.get(t.client_id as string) ?? []).some(
              (d) => d >= String(t.sold_at),
            );
            return {
              client_id: t.client_id,
              client_name: clientName(client),
              client_phone: client?.phone ?? null,
              trial_name: one(memberships as { name: string } | null)?.name ?? null,
              trial_kind: one(memberships as { kind: string } | null)?.kind ?? null,
              sold_at: t.sold_at,
              days_since: Math.round(
                (Date.parse(today) - Date.parse(String(t.sold_at))) / 86_400_000,
              ),
              trial_used: term ? Number(term.visits_left ?? 0) === 0 : null,
              seller: t.admin_name,
              trainer: t.trainer_name,
              bought: isBought,
            };
          })
          .filter((r) => include_bought || !r.bought);
        const total = trials.length;
        const converted = trials.filter((t) =>
          (bought.get(t.client_id as string) ?? []).some((d) => d >= String(t.sold_at)),
        ).length;
        return {
          trials_total: total,
          bought_after: converted,
          conversion_percent: total ? Math.round((converted / total) * 100) : null,
          count: Math.min(rows.length, limit),
          rows: rows.slice(0, limit),
        };
      },
    }),

    // ====== КАССА ======
    list_cash_operations: tool({
      description:
        "Операции по кассе: приход/расход, категория, сумма, комментарий, дата (обе даты периода включительно).",
      inputSchema: z.object({
        kind: z.enum(["income", "expense"]).optional(),
        from: isoDate("Начало периода"),
        to: isoDate("Конец периода включительно"),
        limit: limit(500, 200),
      }),
      execute: async ({ kind, from, to, limit }) => {
        let q = supabase
          .from("cash_operations")
          .select("id, kind, category, amount, comment, occurred_at, created_at")
          .eq("studio_id", studioId);
        if (kind) q = q.eq("kind", kind);
        const res = await listResult(
          inPeriod(q, "occurred_at", from, to)
            .order("occurred_at", { ascending: false })
            .limit(limit),
        );
        if ("error" in res) return res;
        const income = sum(
          res.rows.filter((r) => r.kind === "income"),
          (r) => r.amount,
        );
        const expense = sum(
          res.rows.filter((r) => r.kind === "expense"),
          (r) => r.amount,
        );
        return {
          count: res.count,
          total_income: income,
          total_expense: expense,
          balance: income - expense,
          rows: res.rows,
        };
      },
    }),

    // ====== ПРОМОКОДЫ ======
    list_promo_codes: tool({
      description: "Промокоды клуба: имя, код, скидка, лимит, использования, срок, активность.",
      inputSchema: z.object({
        only_active: z.boolean().default(false),
        limit: limit(500, 200),
      }),
      execute: async ({ only_active, limit }) => {
        let q = supabase
          .from("promo_codes")
          .select(
            "id, name, code, expires_at, discount_type, discount_value, usage_limit, usage_count, description, is_active, created_at",
          )
          .eq("studio_id", studioId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (only_active) q = q.eq("is_active", true);
        return listResult(q);
      },
    }),

    // ====== НОВОСТИ ======
    // Новости, услуги и пуши выбирают клубы (studio_ids) — берём те, что
    // показываются в текущем клубе.
    list_news: tool({
      description:
        "Новости мобильного приложения, которые показываются в текущем клубе: заголовок, описание, кнопка.",
      inputSchema: z.object({ limit: limit(200, 100) }),
      execute: async ({ limit }) =>
        listResult(
          supabase
            .from("news")
            .select(
              "id, position, title, description, full_title, full_text, button_text, button_url, created_at, updated_at",
            )
            .contains("studio_ids", [studioId])
            .limit(limit),
        ),
    }),

    // ====== УСЛУГИ ======
    list_services: tool({
      description:
        "Услуги мобильного приложения (карточки услуг), которые показываются в текущем клубе.",
      inputSchema: z.object({ limit: limit(200, 100) }),
      execute: async ({ limit }) =>
        listResult(
          supabase
            .from("services")
            .select(
              "id, position, title, description, full_title, full_text, button_text, button_url, created_at",
            )
            .contains("studio_ids", [studioId])
            .limit(limit),
        ),
    }),

    // ====== ПУШ-УВЕДОМЛЕНИЯ ======
    list_push_notifications: tool({
      description:
        "Пуш-рассылки клиентам текущего клуба из раздела «Пуш-уведомления» (автоматические триггерные уведомления сюда не входят): заголовок, текст, action_url, сегменты, статус (draft/scheduled/sending — идёт рассылка/sent), запланировано/отправлено, метрики: recipients_count — клиентов с приложением, devices_count — их телефонов с уведомлениями, sent_count — принято службой доставки, failed_count — не дошло, delivered_count — показано на телефоне, read_count — клиентов открыли.",
      inputSchema: z.object({
        status: z.enum(["draft", "scheduled", "sending", "sent"]).optional(),
        limit: limit(500, 200),
      }),
      execute: async ({ status, limit }) => {
        let q = supabase
          .from("push_notifications")
          .select(
            "id, title, message, action_url, segments, status, scheduled_at, sent_at, recipients_count, devices_count, sent_count, failed_count, delivered_count, read_count, created_at, updated_at",
          )
          .contains("studio_ids", [studioId])
          .is("trigger_key", null)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status) q = q.eq("status", status);
        return listResult(q);
      },
    }),

    // ====== ОБРАТНАЯ СВЯЗЬ ======
    list_feedback: tool({
      description:
        "Обратная связь от клиентов (форма в мобильном приложении и по QR-коду клуба): тема, сообщение, настроение, контакт, статус (pending/resolved), откуда (source: app — приложение, link — ссылка или QR-код, portal — добавил сотрудник).",
      inputSchema: z.object({
        status: z.enum(["pending", "resolved"]).optional(),
        topic: z
          .enum(["training", "staff", "cleanliness", "app", "idea", "thanks", "other"])
          .optional(),
        limit: limit(500, 200),
      }),
      execute: async ({ status, topic, limit }) => {
        let q = supabase
          .from("feedback")
          .select(
            "id, topic, message, mood, client_name, client_contact, status, resolved_by_name, resolved_at, resolution_comment, created_at, source",
          )
          .or(ownOrUnassigned)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status) q = q.eq("status", status);
        if (topic) q = q.eq("topic", topic);
        return listResult(q);
      },
    }),

    // ====== NPS ======
    list_nps: tool({
      description:
        "NPS-ответы: оценка (0-10), тип опроса, комментарий, обработан ли, клиент (client_id). Период — по дате ответа, обе даты включительно. " +
        "Критики (0–6) — повод связаться, промоутеры (9–10) — попросить отзыв или привести друга.",
      inputSchema: z.object({
        survey_type: z
          .enum(["first_lessons", "first_month", "before_renewal", "after_return", "general"])
          .optional(),
        handled: z.boolean().optional(),
        from: isoDate("Начало периода"),
        to: isoDate("Конец периода включительно"),
        limit: limit(500, 200),
      }),
      execute: async ({ survey_type, handled, from, to, limit }) => {
        let q = supabase
          .from("nps_responses")
          .select(
            "id, score, client_id, client_name, comment, language, survey_type, handled, created_at",
          )
          .or(ownOrUnassigned);
        if (survey_type) q = q.eq("survey_type", survey_type);
        if (typeof handled === "boolean") q = q.eq("handled", handled);
        const res = await listResult(
          inPeriod(q, "created_at", from, to)
            .order("created_at", { ascending: false })
            .limit(limit),
        );
        if ("error" in res) return res;
        const scores = res.rows.map((r) => Number(r.score));
        const promoters = scores.filter((s) => s >= 9).length;
        const detractors = scores.filter((s) => s <= 6).length;
        const nps = scores.length
          ? Math.round(((promoters - detractors) / scores.length) * 100)
          : null;
        return { ...res, nps_score: nps, promoters, detractors };
      },
    }),

    // ====== ЗАЯВКИ ======
    list_client_requests: tool({
      description:
        "Заявки клиентов из приложения (клубы с пакетами тренировок): kind personal — на персональные занятия (цели, комментарий), " +
        "diagnostic — на диагностику тела. По умолчанию — неотработанные (processed = false). Каждая заявка — готовая продажа.",
      inputSchema: z.object({
        processed: z.boolean().default(false),
        kind: z.enum(["personal", "diagnostic"]).optional(),
        limit: limit(300, 100),
      }),
      execute: async ({ processed, kind, limit }) => {
        let q = supabase
          .from("client_requests")
          .select(
            `id, kind, goals, goal_other, comment, created_at, processed_at, processed_by_name, client_id, clients(${CLIENT_COLUMNS})`,
          )
          .eq("studio_id", studioId)
          .order("created_at", { ascending: false })
          .limit(limit);
        q = processed ? q.not("processed_at", "is", null) : q.is("processed_at", null);
        if (kind) q = q.eq("kind", kind);
        const res = await listResult(q);
        if ("error" in res) return res;
        const rows = res.rows.map(({ clients, ...r }) => ({
          ...r,
          client_name: clientName(one(clients as ClientRef | null)),
          client_phone: one(clients as ClientRef | null)?.phone ?? null,
        }));
        return { count: rows.length, rows };
      },
    }),

    // ====== ИСТОРИЯ ЗАПИСЕЙ ======
    list_bookings_log: tool({
      description:
        "История записей клиентов на занятия: клиент, тренировка, тип, время, статус (booked — записан, attended — посетил, " +
        "no_show — не пришёл, cancelled — отменено). Период — по времени занятия (starts_at), обе даты включительно.",
      inputSchema: z.object({
        from: isoDate("Начало периода"),
        to: isoDate("Конец периода включительно"),
        client_id: z.string().uuid().optional(),
        status: z.enum(["booked", "attended", "no_show", "cancelled"]).optional(),
        limit: limit(500, 200),
      }),
      execute: async ({ from, to, client_id, status, limit }) => {
        // В bookings_log нет created_at (раньше инструмент всегда отвечал
        // ошибкой) — период и сортировка по времени занятия.
        let q = supabase
          .from("bookings_log")
          .select(
            "id, client_id, client_full_name, client_first_name, client_last_name, client_phone, workout_name, workout_type, starts_at, status, cancel_reason, booked_at, cancelled_at",
          )
          .eq("studio_id", studioId);
        if (client_id) q = q.eq("client_id", client_id);
        if (status) q = q.eq("status", status);
        return listResult(
          inPeriod(q, "starts_at", from, to).order("starts_at", { ascending: false }).limit(limit),
        );
      },
    }),

    // ====== АКТИВНЫЕ БРОНИ ======
    list_schedule_bookings: tool({
      description:
        "Текущие записи в расписании (schedule_bookings): занятие (entry_id), клиент (client_id), статус, когда записан.",
      inputSchema: z.object({ limit: limit(500, 200) }),
      execute: async ({ limit }) =>
        listResult(
          supabase
            .from("schedule_bookings")
            .select("id, entry_id, client_id, status, created_at, cancelled_at")
            .eq("studio_id", studioId)
            .order("created_at", { ascending: false })
            .limit(limit),
        ),
    }),

    // ====== НАСТРОЙКИ КЛУБА ======
    get_club_settings: tool({
      description:
        "Контакты и правила мобильного приложения в текущем клубе: ссылки кнопок «Написать» и «Позвонить» и минуты для отмены брони. Кнопка «Фидбэк» — своя форма приложения, обращения — в list_feedback.",
      inputSchema: z.object({}),
      execute: async () => {
        const { data, error } = await supabase
          .from("studio_app_settings")
          .select("write_url, call_url, cancel_booking_minutes, updated_at")
          .eq("studio_id", studioId)
          .maybeSingle();
        if (error) return { error: error.message };
        // Строки нет — в приложении значения по умолчанию.
        return (
          data ?? {
            write_url: null,
            call_url: null,
            cancel_booking_minutes: 180,
          }
        );
      },
    }),

    // ====== СВОДКА ======
    counts_overview: tool({
      description:
        "Сводка по клубу: число клиентов (у клубов с пакетами тренировок — общей базы всех таких клубов), тренеров, шаблонов абонементов, активных клиентских абонементов, продаж за 30 дней, операций кассы, фидбэка, ответов NPS, новостей и услуг в приложении клуба, отправленных пушей.",
      inputSchema: z.object({}),
      execute: async () => {
        const head = { count: "exact" as const, head: true };
        const byStudio = (table: string) =>
          supabase.from(table).select("id", head).eq("studio_id", studioId);
        const queries = {
          clients: supabase
            .from("clients")
            .select("id", head)
            .in("studio_id", await clientStudioIds()),
          trainers: supabase
            .from("trainer_studios")
            .select("trainer_id", head)
            .eq("studio_id", studioId),
          workouts: byStudio("workouts"),
          membership_plans: byStudio("memberships"),
          active_client_memberships: byStudio("client_memberships").eq("status", "active"),
          sales_last_30d: byStudio("sales").gte("sold_at", addDays(studioToday(), -30)),
          cash_operations: byStudio("cash_operations"),
          news: supabase.from("news").select("id", head).contains("studio_ids", [studioId]),
          services: supabase.from("services").select("id", head).contains("studio_ids", [studioId]),
          push_sent: supabase
            .from("push_notifications")
            .select("id", head)
            .contains("studio_ids", [studioId])
            .is("trigger_key", null)
            .eq("status", "sent"),
          feedback_pending: supabase
            .from("feedback")
            .select("id", head)
            .or(ownOrUnassigned)
            .eq("status", "pending"),
          nps_responses: supabase.from("nps_responses").select("id", head).or(ownOrUnassigned),
        };
        const entries = await Promise.all(
          Object.entries(queries).map(async ([key, q]) => [key, await q] as const),
        );
        // Ошибку не превращаем в 0: модель не должна выдавать её за данные.
        const counts: Record<string, number | null> = {};
        const errors: string[] = [];
        for (const [key, { count, error }] of entries) {
          counts[key] = error ? null : (count ?? 0);
          if (error) errors.push(`${key}: ${error.message}`);
        }
        return errors.length ? { ...counts, errors } : counts;
      },
    }),
  };
}

/**
 * Сводка приложения клиента (client_app_overview) — коротко: модели не нужны
 * user agent, размеры экрана и посуточная полоска.
 */
function summarizeApp(app: unknown): unknown {
  if (!app || typeof app !== "object" || "error" in app) return app;
  const o = app as {
    has_account?: boolean;
    account?: { created_at?: string; last_sign_in_at?: string | null };
    devices?: Array<Record<string, unknown>>;
    activity?: {
      days?: Array<{ day: string; sessions: number }>;
      screens_30d?: Record<string, number>;
      memberships_last_day?: string | null;
    };
    push?: unknown;
    actions?: unknown;
  };
  if (!o.has_account) return { has_account: false };
  const devices = o.devices ?? [];
  return {
    has_account: true,
    first_sign_in_at: o.account?.created_at ?? null,
    last_sign_in_at: o.account?.last_sign_in_at ?? null,
    last_seen_at: devices[0]?.last_seen_at ?? null,
    devices: devices.map((d) => ({
      platform: d.platform,
      device_model: d.device_model,
      app_version: d.app_version,
      installed: d.standalone,
      push_permission: d.push_permission,
      push_subscribed: d.push_subscribed,
      locale: d.locale,
    })),
    days_active_30d: (o.activity?.days ?? []).filter((d) => d.sessions > 0).length,
    screens_30d: o.activity?.screens_30d ?? {},
    memberships_last_viewed: o.activity?.memberships_last_day ?? null,
    push_30d: o.push ?? null,
    actions: o.actions ?? null,
  };
}
