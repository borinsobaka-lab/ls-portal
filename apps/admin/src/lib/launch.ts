/**
 * Первый этап портала Lady Stretch (решения владельца 2026-10-27): работают
 * база знаний, «Академия» и «Аналитика сети». Разделы клубов — «Дашборд»,
 * «Клуб» (с «Сотрудниками» и «Рабочим днём»), «Мобильное приложение»,
 * «Скрипты LS» — скрыты и нигде на портале не упоминаются: ни в рейке и
 * меню, ни в шапке (поиск клиента, выбор клуба, Kate), ни в «Пользователях
 * и ролях» (права и стартовые роли этих разделов). Сами клубы остаются:
 * их заводят в одном месте — «Оргструктура» → «Сеть клубов» (бренд, свой /
 * франшиза, город, собственники; «Управление» → «Клубы» с логотипом, цветом
 * и приложением скрыт), роли назначаются в клубах (все, клубы бренда,
 * выбранные), «Аналитика сети: свои клубы» показывает отчёты по клубам
 * назначения и клубам, где человек собственник. Через несколько месяцев разделы переделывают под
 * российский рынок — тогда они возвращаются отсюда.
 *
 * Только интерфейс: таблицы, RLS и права в базе не меняются.
 */
import type { RailSectionKey } from "@/lib/nav-sections";

/**
 * Клубы и всё, что к ним относится, на портале не показываются. Вернуть
 * разделы — build-переменная VITE_SHOW_CLUBS=true (с ней же идёт отдельный
 * прогон тестов логики клубов — `bun run test` в apps/admin).
 */
export const CLUBS_HIDDEN = import.meta.env.VITE_SHOW_CLUBS !== "true";

/** Разделы рейки, которых пока нет: их страницы закрыты, как без права. */
export const HIDDEN_RAIL_SECTIONS: ReadonlySet<RailSectionKey> = new Set<RailSectionKey>(
  CLUBS_HIDDEN ? ["dashboard", "club", "app", "scripts"] : [],
);

/**
 * Пункты «Управления» скрытых разделов: перенос клиентов из 1С и «Клубы»
 * (логотип, цвет, приложение клиентов — клубы ведут в «Сети клубов»).
 */
export const HIDDEN_MANAGE_URLS: ReadonlySet<string> = new Set(
  CLUBS_HIDDEN ? ["/import-1c", "/studios"] : [],
);

/** Права скрытых разделов (каталог access_permissions): в ролях их не видно. */
const HIDDEN_PERMISSIONS = new Set(["studio.tier", "staff.directory", "app.content", "scripts"]);

export function isHiddenPermission(key: string): boolean {
  return CLUBS_HIDDEN && (HIDDEN_PERMISSIONS.has(key) || key.startsWith("club."));
}

/**
 * Стартовые роли клубов (access_seed_role): в списке ролей и при назначении
 * их нет. «Суперадминистратор», «Администратор портала», знания и аналитика
 * остаются.
 */
const HIDDEN_ROLE_KEYS = new Set([
  "studio_owner",
  "studio_manager",
  "studio_admin",
  "trainer",
  "curator",
  "marketing",
]);

export function isHiddenRole(role: { system_key?: string | null }): boolean {
  return CLUBS_HIDDEN && !!role.system_key && HIDDEN_ROLE_KEYS.has(role.system_key);
}
