/**
 * Перенос людей со старого портала аналитики (ANALYTICS_PLAN.md, §10):
 * их тип и выданные «дашборды» → права блока «Аналитика» → стартовая роль,
 * если набор совпал с ней, иначе личные права человека. Модуль без React и
 * запросов: его читают блок «Пользователи со старого портала» и сервер
 * (legacy.functions.ts). Данные — RPC an_legacy_people (зеркало их users,
 * user_dashboard_access, user_partner_cities).
 */

/** Их тип — приоритет users_page: администратор, партнёр, таргетолог, лид-менеджер. */
export type LegacyKind = "admin" | "partner" | "targetologist" | "lead_manager" | "staff";

export type LegacyPerson = {
  id: number;
  login: string;
  full_name: string;
  role: string;
  is_active: boolean;
  position: string;
  kind: LegacyKind;
  is_targetologist: boolean;
  is_lead_manager: boolean;
  grants: string[];
  cities: string[];
  created_at: string;
  last_seen_at: string | null;
  /** Человек портала после переноса. */
  user_id: string | null;
  user_name: string | null;
  imported_at: string | null;
  /** Учётная запись портала с той же почтой (ещё не связан). */
  match_user_id: string | null;
  match_in_portal: boolean | null;
};

export const LEGACY_KIND_LABEL: Record<LegacyKind, string> = {
  admin: "Администратор",
  partner: "Партнёр",
  targetologist: "Таргетолог",
  lead_manager: "Лид-менеджер",
  staff: "Сотрудник",
};

/** Их ключ «дашборда» (user_dashboard_access) → наше право. */
export const LEGACY_DASHBOARD_RIGHT: Record<string, string> = {
  "revenue_city_dashboard.html": "an.onec.revenue",
  "subscription_sales_dashboard.html": "an.onec.sales",
  "activities_dashboard.html": "an.onec.classes",
  "trial_funnel_dashboard.html": "an.onec.trials",
  "zero_nomenclature_dashboard.html": "an.onec.zero",
  "partner_city_dashboard.html": "an.onec.mycity",
  "fitbase-revenue.html": "an.fb.revenue",
  "fitbase-marketing.html": "an.fb.marketing",
  "fitbase-sales.html": "an.fb.sales",
  "fitbase-attendance.html": "an.fb.attendance",
  "fitbase-trials.html": "an.fb.trials",
  marketing_lady_stretch: "an.mkt.ls",
  marketing_lady_jump: "an.mkt.lj",
  target_register: "an.vk.register",
  avito_register: "an.avito.register",
  reviews: "an.reviews",
};

/** Стартовые роли блока «Аналитика» (system_key) — с ними сравнивается набор прав. */
export const LEGACY_STARTER_ROLES = [
  "an_admin",
  "an_partner",
  "an_targetologist",
  "an_lead_manager",
  "an_staff",
] as const;

/**
 * Права человека, как у них в allowed_dashboards: администратору — только
 * «Администратор аналитики» (он и так видит всё); остальным — их флаги
 * (партнёр — есть города, таргетолог, лид-менеджер) и выданные «дашборды».
 * Что именно откроется, решает an_me по тем же правилам, что у них.
 */
export function legacyRights(p: LegacyPerson): string[] {
  if (p.role === "admin") return ["an.admin"];
  const out = new Set<string>();
  if (p.cities.length > 0) out.add("an.partner");
  if (p.is_targetologist) out.add("an.targetologist");
  if (p.is_lead_manager) out.add("an.inbox");
  for (const g of p.grants) {
    const right = LEGACY_DASHBOARD_RIGHT[g];
    if (right) out.add(right);
  }
  return [...out].sort();
}

/** Выданные «дашборды», которых нет в каталоге (их не переносим — показываем). */
export function unknownGrants(p: LegacyPerson): string[] {
  return p.role === "admin" ? [] : p.grants.filter((g) => !LEGACY_DASHBOARD_RIGHT[g]);
}

export type LegacyRolePlan =
  | { kind: "starter"; systemKey: string }
  | { kind: "personal"; rights: string[] };

/** Набор совпал со стартовой ролью — она; иначе личные права. */
export function legacyRolePlan(
  rights: string[],
  starters: Record<string, string[]>,
): LegacyRolePlan {
  const key = [...rights].sort().join(",");
  for (const systemKey of LEGACY_STARTER_ROLES) {
    const set = starters[systemKey];
    if (set && [...set].sort().join(",") === key) return { kind: "starter", systemKey };
  }
  return { kind: "personal", rights: [...rights].sort() };
}

/** Почта входа — их логин, если это адрес почты. */
export function legacyEmail(login: string): string | null {
  const v = login.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** Почему человека нельзя перенести (или null — можно). */
export function legacyImportProblem(p: LegacyPerson, email: string | null): string | null {
  if (p.user_id) return "Уже перенесён";
  if (!p.is_active) return "Отключён на старом портале";
  if (!email) return "Нет почты — укажите её";
  return null;
}

/** Тип человека портала: партнёр — «Партнёр», остальные — УК. */
export function legacyUserType(p: LegacyPerson): "partner" | "hq" {
  return p.kind === "partner" ? "partner" : "hq";
}
