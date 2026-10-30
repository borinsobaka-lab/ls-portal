/**
 * «Аналитика» — заголовки страниц и карточки главной. Тексты — со старого портала аналитики Lady Stretch (их главная,
 * DASHBOARDS в app.py), где это их функция. Их берут и страницы, и скелетоны.
 */
import type { AnNeed } from "./access";

export const AN_TITLES = {
  home: "Аналитика",
  jobs: "Фоновые задачи",
} as const;

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
 * Карточки главной по порядку их главной. Модули добавляют свои по мере
 * переноса — карточка появляется вместе с готовой страницей.
 */
export const AN_CARDS: AnCard[] = [];
