/**
 * «Аналитика» — заголовки страниц и карточки главной. Тексты — со старого портала аналитики Lady Stretch (их главная,
 * DASHBOARDS в app.py), где это их функция. Их берут и страницы, и скелетоны.
 */
import type { AnNeed } from "./access";

export const AN_TITLES = {
  home: "Аналитика",
  jobs: "Фоновые задачи",
  onec: "Обработка 1С",
} as const;

/** Вкладки «Обработки 1С»: обработка и справочники их обработчика. */
export const AN_ONEC_TABS = [
  { value: "processing", label: "Обработка" },
  { value: "studios", label: "Студии" },
  { value: "nomenclature", label: "Номенклатура" },
  { value: "break_even", label: "Точка 0" },
] as const;
export type AnOnecTab = (typeof AN_ONEC_TABS)[number]["value"];

/** Шапка главной — как у их главной. */
export const AN_HOME_TEXT = {
  eyebrow: "Рабочее пространство",
  greeting: (name: string) => (name ? `Добрый день, ${name}` : "Добрый день"),
  lead: "Выберите показатель, с которым хотите работать.",
  emptyTitle: "Дашборды пока не назначены",
  emptyText: "Обратитесь к администратору портала.",
};

/** Карточка главной — как их карточки (`DASHBOARDS`): заголовок и описание. */
export type AnCard = {
  key: string;
  title: string;
  description: string;
  url: string;
  need: AnNeed;
};

/**
 * Карточки главной по порядку их главной (`DASHBOARDS`: заголовок и
 * описание). Модули добавляют свои по мере переноса — карточка появляется
 * вместе с готовой страницей. «Мой город» — отдельно (AN_MYCITY_CARD): у
 * партнёра по карточке на город, как у них.
 */
export const AN_CARDS: AnCard[] = [
  {
    key: "onec.revenue",
    title: "Выручка",
    description: "Финансовый результат сети и динамика по городам.",
    url: "/analytics/onec/revenue",
    need: "onec.revenue",
  },
  {
    key: "onec.sales",
    title: "Продажи абонементов",
    description: "Конверсия и ключевые показатели продаж.",
    url: "/analytics/onec/sales",
    need: "onec.sales",
  },
  {
    key: "onec.classes",
    title: "Занятия",
    description: "Динамика проведённых занятий и посещений.",
    url: "/analytics/onec/activities",
    need: "onec.classes",
  },
  {
    key: "onec.trials",
    title: "Воронка пробных",
    description: "Записи, посещения и покупки после пробного.",
    url: "/analytics/onec/funnel",
    need: "onec.trials",
  },
  {
    key: "onec.zero",
    title: "Нулевая номенклатура",
    description: "Номенклатуры, проданные с нулевой стоимостью.",
    url: "/analytics/onec/zero",
    need: "onec.zero",
  },
];

/**
 * «Мой город» на главной — их home(): партнёру по карточке на каждый город
 * («Мой город — Абакан»; ведёт на доску, как у них, без выбора города),
 * администратору и сотруднику — одна общая.
 */
export const AN_MYCITY_CARD = {
  url: "/analytics/onec/mycity",
  need: "onec.mycity" as AnNeed,
  cityTitle: (city: string) => `Мой город — ${city}`,
  cityDescription: "Единый борд города: финансы, продажи, занятия и воронка.",
  title: "Мой город",
  description: "Общий единый борд для сотрудников.",
};
