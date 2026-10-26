/**
 * Пользователи, роли и доступы — логика без React (подписи, статусы,
 * матрица прав роли, области и сроки назначений, ошибки базы). Модуль
 * читает и сервер. Тест — logic.test.ts.
 */
import { formatDate, formatDateTime } from "@/lib/format";
import { plural } from "@/lib/academy/logic";
import { isHiddenPermission } from "@/lib/launch";
import type {
  Assignment,
  Effective,
  MemberRole,
  PermBlock,
  PermissionDef,
  PortalUserRow,
  RolePerm,
  ScopeType,
  Tier,
  UserType,
} from "./types";

/** Сетевые права (и users.manage) — то, что лежит в access_user_rights.rights. */
export const ACCESS_RIGHTS = [
  "portal.admin",
  "users.manage",
  "roles.manage",
  "structure.manage",
  "studios.create",
  "audit.view",
  "kb.admin",
  "academy.admin",
  "academy.create",
  "academy.review",
  "staff.directory",
  "app.content",
  "analytics.view",
  "analytics.cities",
  "analytics.manage",
] as const;
export type AccessRight = (typeof ACCESS_RIGHTS)[number];

export const BLOCK_ORDER: PermBlock[] = ["club", "sections", "knowledge", "admin"];
export const BLOCK_LABEL: Record<PermBlock, string> = {
  club: "Клуб — данные и разделы",
  sections: "Разделы админки",
  knowledge: "База знаний и Академия",
  admin: "Управление порталом",
};
export const BLOCK_HINT: Record<PermBlock, string> = {
  club: "Действуют в клубах, выбранных при назначении роли: во всех, в клубах бренда или в отдельных.",
  sections: "Общие для всей сети.",
  knowledge: "Базы знаний и курсы общие для сети.",
  admin: "Кто управляет людьми, ролями и структурой.",
};

export const USER_TYPE_LABEL: Record<UserType, string> = {
  hq: "Управляющая компания",
  partner: "Партнёр (франчайзи)",
  studio: "Сотрудник клуба",
  contractor: "Подрядчик",
  service: "Служебный",
};
export const USER_TYPES = Object.keys(USER_TYPE_LABEL) as UserType[];

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  head: "Руководитель",
  deputy: "Заместитель",
  member: "Сотрудник",
};

export const TIER_LABEL: Record<Tier, string> = {
  trainer: "Сотрудник",
  admin: "Администратор",
  owner: "Владелец клуба",
};
export const LEVEL_LABEL: Record<string, string> = {
  view: "просмотр",
  edit: "правка",
  ...TIER_LABEL,
};

export const SCOPE_LABEL: Record<ScopeType, string> = {
  all: "Во всех клубах — и в новых",
  brands: "В клубах брендов — и в новых",
  studios: "В выбранных клубах",
};

// --- Статус человека --------------------------------------------------------

export type UserStatusKey = "active" | "invited" | "blocked" | "expired" | "no_roles";

export const STATUS_LABEL: Record<UserStatusKey, string> = {
  active: "Активен",
  invited: "Ещё не входил",
  blocked: "Заблокирован",
  expired: "Доступ истёк",
  no_roles: "Без ролей",
};
export const STATUS_TONE: Record<
  UserStatusKey,
  "positive" | "negative" | "info" | "warning" | "neutral"
> = {
  active: "positive",
  invited: "info",
  blocked: "negative",
  expired: "warning",
  no_roles: "neutral",
};

export function userStatus(
  u: Pick<PortalUserRow, "status" | "access_until" | "last_sign_in_at" | "portal">,
  today: string,
): UserStatusKey {
  if (u.status === "blocked") return "blocked";
  if (u.access_until && u.access_until < today) return "expired";
  if (!u.portal) return "no_roles";
  if (!u.last_sign_in_at) return "invited";
  return "active";
}

// --- Матрица прав роли ---------------------------------------------------------

export function groupCatalog(catalog: PermissionDef[]) {
  return BLOCK_ORDER.map((block) => ({
    block,
    label: BLOCK_LABEL[block],
    hint: BLOCK_HINT[block],
    items: catalog.filter((p) => p.block === block).sort((a, b) => a.sort_order - b.sort_order),
  })).filter((g) => g.items.length > 0);
}

const sameTarget = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);

/** Уровень права в роли; null — права нет. */
export function permLevel(perms: RolePerm[], key: string, target: string | null = null) {
  return perms.find((p) => p.perm_key === key && sameTarget(p.target_id, target))?.level ?? null;
}

/** Поставить (или снять — level null) право роли. */
export function setPerm(
  perms: RolePerm[],
  key: string,
  level: string | null,
  target: string | null = null,
): RolePerm[] {
  const rest = perms.filter((p) => !(p.perm_key === key && sameTarget(p.target_id, target)));
  return level === null ? rest : [...rest, { perm_key: key, target_id: target, level }];
}

/** Разделы клуба по одному (без «Все разделы»). */
export function clubSectionPerms(catalog: PermissionDef[]) {
  return catalog
    .filter((p) => p.block === "club" && p.key.startsWith("club.") && p.key !== "club.all")
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Есть ли у роли права «в клубе» — тогда при назначении важны клубы. Права
 * скрытых разделов (lib/launch.ts) не в счёт.
 */
export function hasStudioPerms(perms: RolePerm[], catalog: PermissionDef[]) {
  const scope = new Map(catalog.map((p) => [p.key, p.scope]));
  return perms.some((p) => !isHiddenPermission(p.perm_key) && scope.get(p.perm_key) === "studio");
}

/** Что не так с правами роли (как проверяет база); null — всё в порядке. */
export function roleProblem(perms: RolePerm[]): string | null {
  const sections = perms.some((p) => p.perm_key.startsWith("club."));
  if (sections && !permLevel(perms, "studio.tier")) {
    return "Разделы клуба работают только вместе с доступом к данным клуба — выберите его уровень.";
  }
  return null;
}

/** Короткое описание прав роли — чипами в списке ролей. */
export function roleSummary(allPerms: RolePerm[], catalog: PermissionDef[]): string[] {
  // Права скрытых разделов (lib/launch.ts) в описании роли не упоминаются.
  const perms = allPerms.filter((p) => !isHiddenPermission(p.perm_key));
  const label = new Map(catalog.map((p) => [p.key, p.label]));
  const out: string[] = [];
  const tier = permLevel(perms, "studio.tier") as Tier | null;
  if (permLevel(perms, "portal.admin")) out.push("Всё в портале");
  if (tier) out.push(TIER_LABEL[tier]);
  if (permLevel(perms, "club.all")) out.push("все разделы клуба");
  else {
    const n = perms.filter((p) => p.perm_key.startsWith("club.")).length;
    if (n) out.push(`разделов клуба: ${n}`);
  }
  const kb = perms.filter((p) => p.perm_key === "kb.base");
  const kbAll = kb.find((p) => p.target_id === null);
  if (kbAll) out.push(`все базы знаний: ${LEVEL_LABEL[kbAll.level]}`);
  else if (kb.length) out.push(`баз знаний: ${kb.length}`);
  const scripts = permLevel(perms, "scripts");
  if (scripts) out.push(`Скрипты LS: ${LEVEL_LABEL[scripts]}`);
  for (const p of catalog) {
    if (p.scope !== "network" || p.target || p.key === "scripts" || p.key === "portal.admin")
      continue;
    if (permLevel(perms, p.key)) out.push(label.get(p.key) ?? p.key);
  }
  // Прочие права «в клубе» (аналитика своих клубов) — по названию.
  for (const p of catalog) {
    if (p.scope !== "studio" || p.key === "studio.tier" || p.key.startsWith("club.")) continue;
    if (p.key !== "users.manage" && permLevel(perms, p.key)) out.push(p.label);
  }
  if (permLevel(perms, "users.manage")) out.push(label.get("users.manage") ?? "users.manage");
  return out;
}

// --- Назначения ---------------------------------------------------------------

export type Names = {
  studio: Map<string, string>;
  brand: Map<string, string>;
  unit: Map<string, string>;
  position: Map<string, string>;
  user: Map<string, string>;
};

function listText(ids: string[], names: Map<string, string>, fallback: string) {
  const items = ids.map((id) => names.get(id) ?? fallback);
  if (items.length <= 3) return items.join(", ");
  return `${items.slice(0, 3).join(", ")} и ещё ${items.length - 3}`;
}

/**
 * Где действует назначение — для строки и подсказки. studioScoped = false —
 * у роли нет прав «в клубе», клубы не важны: «Вся сеть».
 */
export function scopeText(
  a: Pick<Assignment, "scope_type" | "scope_ids">,
  names: Pick<Names, "studio" | "brand">,
  studioScoped = true,
): string {
  if (!studioScoped) return "Вся сеть";
  if (a.scope_type === "all") return "Все клубы";
  if (a.scope_type === "brands")
    return `${plural(a.scope_ids.length, ["Бренд", "Бренды", "Бренды"])} ${listText(a.scope_ids, names.brand, "бренд")}`;
  if (a.scope_ids.length === 0) return "Клубов нет";
  return listText(a.scope_ids, names.studio, "клуб");
}

/** Кому выдано назначение. */
export function subjectText(a: Assignment, names: Names): string {
  if (a.subject_type === "user") return names.user.get(a.user_id ?? "") ?? "Пользователь";
  if (a.subject_type === "position")
    return `Должность «${names.position.get(a.position_id ?? "") ?? "—"}»`;
  const unit = names.unit.get(a.unit_id ?? "") ?? "—";
  const who = a.unit_members === "heads" ? "руководители" : "все";
  return `«${unit}»: ${who}${a.with_subunits ? ", и ниже" : ""}`;
}

/** Срок назначения: «до 12.11.2026 18:00», «с …», «истёк …»; null — бессрочно. */
export function validityText(
  a: Pick<Assignment, "valid_from" | "valid_until">,
  now: Date = new Date(),
): string | null {
  const from = a.valid_from ? new Date(a.valid_from) : null;
  const until = a.valid_until ? new Date(a.valid_until) : null;
  if (until && until <= now) return `истекло ${formatDateTime(a.valid_until)}`;
  if (from && from > now)
    return `с ${formatDateTime(a.valid_from)}${until ? ` до ${formatDateTime(a.valid_until)}` : ""}`;
  if (until) return `до ${formatDateTime(a.valid_until)}`;
  return null;
}

// --- Оргструктура ---------------------------------------------------------------

export type UnitLike = { id: string; parent_id: string | null; name: string; sort_order: number };

/** Дерево подразделений по порядку: родитель, потом его ветка. */
export function unitTree<T extends UnitLike>(units: T[]): { unit: T; depth: number }[] {
  const byParent = new Map<string | null, T[]>();
  for (const u of units) {
    const key = units.some((x) => x.id === u.parent_id) ? u.parent_id : null;
    byParent.set(key, [...(byParent.get(key) ?? []), u]);
  }
  for (const list of byParent.values())
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  const out: { unit: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const u of byParent.get(parent) ?? []) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push({ unit: u, depth });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Подразделение и всё ниже него. */
export function unitSubtree(units: UnitLike[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parent_id && out.has(u.parent_id) && !out.has(u.id)) {
        out.add(u.id);
        grew = true;
      }
    }
  }
  return out;
}

/** «Отдел развития › Кураторы». */
export function unitPathText(units: UnitLike[], id: string): string {
  const byId = new Map(units.map((u) => [u.id, u]));
  const parts: string[] = [];
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(" › ");
}

// --- Прочее --------------------------------------------------------------------

/** profiles.full_name — «Фамилия Имя»: фамилия — первое слово, имя — остальное. */
export function splitFullName(fullName: string | null) {
  const [last = "", ...rest] = (fullName ?? "").trim().split(/\s+/);
  return { last_name: last, first_name: rest.join(" ") };
}

export function lastSeenText(v: string | null): string {
  return v ? formatDateTime(v) : "не входил";
}

export function untilText(v: string | null): string | null {
  return v ? `до ${formatDate(v)}` : null;
}

/** «2026-11-12T18:00» (input datetime-local) ⇄ ISO с часовым поясом браузера. */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function isoToLocalInput(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ERRORS: Record<string, string> = {
  access_forbidden: "Нет прав на это действие",
  access_last_superadmin: "Нельзя оставить портал без суперадминистратора",
  access_self: "Себе это сделать нельзя — попросите другого администратора",
  access_superadmin_only: "Это может только суперадминистратор",
  access_sections_need_tier:
    "Разделы клуба работают только вместе с доступом к данным клуба — выберите его уровень",
  access_role_in_use: "Роль выдана — сначала снимите её назначения (и в Академии)",
  access_role_locked: "Эту роль нельзя удалить",
  access_role_not_found: "Роль не найдена — обновите страницу",
  access_user_not_found: "Пользователь не найден — обновите страницу",
  access_assignment_not_found: "Назначение не найдено — обновите страницу",
  access_scope_empty: "Выберите клубы или бренды",
  access_name_required: "Укажите фамилию и имя",
  access_personal_network_only:
    "В личных правах — только сетевые права; права в клубе выдаются ролью",
  access_bad_level: "Неверный уровень права",
  access_bad_target: "База знаний не найдена — обновите страницу",
  org_unit_cycle: "Нельзя перенести подразделение внутрь самого себя",
  org_unit_has_children: "Сначала перенесите или удалите вложенные подразделения",
  org_unit_not_found: "Подразделение не найдено — обновите страницу",
  org_brand_in_use: "У бренда есть клубы — сначала переведите их в другой бренд",
};
const UNIQUE: [RegExp, string][] = [
  [/access_roles_name_uidx/, "Роль с таким названием уже есть"],
  [/org_positions_name_uidx/, "Такая должность уже есть"],
  [/org_brands_name_uidx/, "Такой бренд уже есть"],
];

/** Текст ошибки базы для тоста; detail — причина у access_grant_denied. */
export function accessErrorText(message: string, detail?: string | null): string {
  if (message === "access_grant_denied") return detail || "Эту роль вам выдавать нельзя";
  if (ERRORS[message]) return ERRORS[message];
  for (const [re, text] of UNIQUE) if (re.test(message)) return text;
  if (/value too long|check constraint/i.test(message))
    return "Слишком длинное или неверное значение";
  return message;
}

// --- Журнал: что изменилось в правах ------------------------------------------

export type EffectiveNames = {
  studio: Map<string, string>;
  kbBase: Map<string, string>;
  perm: Map<string, string>;
};

/** Итог прав строками «Клуб «Тбилиси»: администратор» — для сравнения. */
export function effectiveLines(e: Effective | null | undefined, names: EffectiveNames): string[] {
  if (!e) return [];
  const out: string[] = [];
  if (e.active === false) out.push("Доступ выключен (заблокирован или истёк срок)");
  for (const [id, s] of Object.entries(e.studios ?? {})) {
    const club = `Клуб «${names.studio.get(id) ?? "удалён"}»`;
    const sections =
      s.sections === null
        ? "все разделы"
        : s.sections.length
          ? `разделов: ${s.sections.length}`
          : "без разделов";
    out.push(`${club}: ${TIER_LABEL[s.tier]}, ${sections}`);
  }
  for (const [id, level] of Object.entries(e.kb ?? {}))
    out.push(`База знаний «${names.kbBase.get(id) ?? "—"}»: ${LEVEL_LABEL[level]}`);
  for (const r of e.rights ?? []) out.push(names.perm.get(r) ?? r);
  if (e.rails === null) out.push("Все разделы админки");
  else if (e.rails?.includes("scripts-edit")) out.push("Скрипты LS: правка");
  else if (e.rails?.includes("scripts")) out.push("Скрипты LS: просмотр");
  return out.sort((a, b) => a.localeCompare(b, "ru"));
}

/** Что добавилось и что ушло. */
export function effectiveDiff(
  before: Effective | null | undefined,
  after: Effective | null | undefined,
  names: EffectiveNames,
): { added: string[]; removed: string[] } {
  const a = new Set(effectiveLines(before, names));
  const b = new Set(effectiveLines(after, names));
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}
