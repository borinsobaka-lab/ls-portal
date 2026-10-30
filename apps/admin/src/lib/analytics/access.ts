/**
 * «Аналитика» — перенос портала аналитики Lady Stretch (ANALYTICS_PLAN.md).
 * Что открыто человеку — RPC an_me: права блока «Аналитика» из ролей
 * («Пользователи и роли») и их правила старого портала (allowed_dashboards):
 * администратор аналитики — всё; таргетолог — реестр таргета и маркетинг
 * всегда, по своим парам «бренд + город»; партнёр (есть города партнёра) —
 * «Мой город» и из выданного только маркетинг, отзывы и FitBase. Модуль без
 * React и запросов: его читают меню, guard и сервер (запрос — data.ts).
 */
/** Отчёты старого портала (их «дашборды») — ключи прав `an.<ключ>`. */
export const AN_REPORTS = [
  "onec.revenue",
  "onec.sales",
  "onec.classes",
  "onec.trials",
  "onec.zero",
  "onec.mycity",
  "fb.revenue",
  "fb.marketing",
  "fb.sales",
  "fb.attendance",
  "fb.trials",
  "fb.mycity",
  "mkt.ls",
  "mkt.lj",
  "vk.register",
  "avito.register",
  "reviews",
] as const;
export type AnReport = (typeof AN_REPORTS)[number];

export type AnMe = {
  /** Видит раздел: есть хоть один отчёт, администрирование или диалоги. */
  visible: boolean;
  /** Администратор аналитики (их role='admin') или суперадминистратор. */
  admin: boolean;
  /** Открытые отчёты — их allowed_dashboards. */
  reports: AnReport[];
  /** Партнёр: его города (данные только по ним); null — не партнёр. */
  partnerCities: string[] | null;
  /** Таргетолог: его ФИО (по нему назначения «бренд + город»); null — нет. */
  targetologist: string | null;
  /** Диалоги VK: администратор или лид-менеджер. */
  inbox: boolean;
};

/** Что нужно пункту меню раздела. */
export type AnNeed = "home" | "admin" | "inbox" | AnReport;

/** Без них «Мой город» сотруднику (не партнёру) не открывается — их onec_scope. */
const ONEC_MYCITY_NEEDS: AnReport[] = ["onec.revenue", "onec.sales", "onec.classes", "onec.trials"];

export function anCan(me: AnMe | undefined | null, need: AnNeed): boolean {
  if (!me) return false;
  if (need === "home") return me.visible;
  if (need === "admin") return me.admin;
  if (need === "inbox") return me.inbox;
  if (me.admin) return true;
  if (!me.reports.includes(need)) return false;
  if (need === "onec.mycity" && me.partnerCities === null) {
    return ONEC_MYCITY_NEEDS.every((r) => me.reports.includes(r));
  }
  return true;
}

export type AnMeRow = {
  visible: boolean;
  admin: boolean;
  reports: string[] | null;
  partner_cities: string[] | null;
  targetologist: string | null;
  inbox: boolean;
};

export function parseAnMe(row: AnMeRow | null): AnMe {
  return {
    visible: !!row?.visible,
    admin: !!row?.admin,
    reports: (row?.reports ?? []).filter((r): r is AnReport =>
      (AN_REPORTS as readonly string[]).includes(r),
    ),
    partnerCities: row?.partner_cities ?? null,
    targetologist: row?.targetologist ?? null,
    inbox: !!row?.inbox,
  };
}
