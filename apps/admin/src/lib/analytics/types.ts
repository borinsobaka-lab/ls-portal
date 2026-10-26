/**
 * «Аналитика сети» — типы ответов базы (RPC an_*,
 * db/migrations/2026-10-26_zzz_analytics_network.sql) после разбора. Это
 * клубы сети на своих учётных системах (1С, FitBase, АДИС, Мобифитнес…), не
 * наши клубы: их данные приходят загрузкой выгрузок. База отдаёт строки
 * массивами, lib/analytics/data.ts раскладывает их в эти объекты. Даты —
 * yyyy-MM-dd.
 */

/** Учётная система, из которой пришла выгрузка. */
export type AnSource = "1c" | "fitbase" | "adis" | "mobifitness" | "other";

/** Студия сети — как она названа в учётной системе. */
export type AnStudio = {
  id: string;
  name: string;
  city: string | null;
  partner: string | null;
  source: AnSource;
  brandId: string | null;
  brandName: string | null;
  /** Закрыта с этого дня (включительно); null — открыта. */
  closedOn: string | null;
  /** Пришла из загрузки, город и статус ещё не проверены. */
  needsReview: boolean;
};

export type AnKind = "revenue" | "sales" | "classes" | "visits";

export type AnScope = {
  /** Сегодня по Тбилиси — по часам базы. */
  today: string;
  canManage: boolean;
  studios: AnStudio[];
  /** Точка 0 городов: месячная выручка «в ноль». */
  targets: Record<string, number>;
  /** Последняя дата загруженных данных по видам и когда загружено. */
  loaded: Partial<Record<AnKind, { to: string; at: string }>>;
};

/** Движение денег студии за день (или месяц): приход и расход. */
export type RevenueRow = { studioId: string; date: string; income: number; expense: number };

/**
 * Вид оплаченной продажи абонемента: new — первая покупка клиента во всей
 * истории, renewal — повторная, return — повторная после долгого перерыва,
 * unknown — в выгрузке нет кода клиента.
 */
export type SaleOrigin = "new" | "renewal" | "return" | "unknown";

export type SoldRow = {
  studioId: string;
  date: string;
  nomenclatureId: string;
  origin: SaleOrigin;
  count: number;
  /** Оплачено по продажам. */
  paid: number;
  /** Стоимость (номинал) продаж. */
  cost: number;
};

export type SalesData = { sold: SoldRow[]; names: Record<string, string> };

export type ClassRow = {
  studioId: string;
  date: string;
  direction: string;
  classes: number;
  booked: number;
  attended: number;
};

export type TrialRow = {
  studioId: string;
  date: string;
  /** Членство / пакет услуг пробного. */
  membership: string;
  trials: number;
  attended: number;
  day0: number;
  d14: number;
  /** Пришли, ещё не купили, а 14 дней ещё не прошли. */
  open: number;
};

export type ZeroRow = {
  studioId: string;
  name: string;
  category: string;
  count: number;
  lastOn: string;
};

export type Period = { from: string; to: string };

/**
 * Права в разделе (RPC an_access): все клубы, загрузка и справочники, свои
 * города, свои клубы (клубы портала из назначений роли с analytics.clubs).
 */
export type AnAccess = { view: boolean; manage: boolean; cities: string[]; clubs?: string[] };

/** Видит ли сотрудник раздел (рейка, меню). */
export const anVisible = (a: AnAccess | undefined) =>
  !!a && (a.view || a.manage || a.cities.length > 0 || (a.clubs?.length ?? 0) > 0);
