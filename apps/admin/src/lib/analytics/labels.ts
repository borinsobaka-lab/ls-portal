/**
 * «Аналитика» — заголовки страниц, подписи модулей и режимов, карточки
 * главной. Тексты — со старого портала аналитики Lady Stretch (их главная,
 * DASHBOARDS в app.py), где это их функция. Их берут и страницы, и скелетоны.
 */
import type { AnNeed } from "./access";

export const AN_TITLES = {
  home: "Аналитика",
  sync: "Синхронизация со старым порталом",
} as const;

/** Шапка главной — как у их главной. */
export const AN_HOME_TEXT = {
  eyebrow: "Рабочее пространство",
  greeting: (name: string) => (name ? `Добрый день, ${name}` : "Добрый день"),
  lead: "Выберите показатель, с которым хотите работать.",
  emptyTitle: "Дашборды пока не назначены",
  emptyText: "Обратитесь к администратору портала.",
};

export type AnModule =
  | "core"
  | "onec"
  | "fitbase"
  | "crm"
  | "vk"
  | "avito"
  | "reviews"
  | "quiz"
  | "inbox"
  | "content";
export type AnMode = "mirror" | "check" | "primary";

export const AN_MODULES: Record<AnModule, { label: string; hint: string }> = {
  core: {
    label: "Пользователи и партнёры",
    hint: "Карточки и города партнёров, журнал, посещаемость.",
  },
  onec: {
    label: "1С",
    hint: "Снимок отчётов 1С: выручка, продажи, занятия, воронка, нулевая номенклатура.",
  },
  fitbase: { label: "FitBase", hint: "Студии на FitBase: подключения, факты, пробные, основания." },
  crm: { label: "amoCRM", hint: "Маркетинговые отчёты Lady Stretch и Lady Jump." },
  vk: {
    label: "VK Ads",
    hint: "Кабинеты, расходы, реестр таргета, планы, лид-формы, СС, контроль бюджетов.",
  },
  avito: { label: "Авито", hint: "Кабинеты, статистика, планы." },
  reviews: { label: "Отзывы", hint: "Оценки занятий из 1С и отзывы партнёров о сотрудниках." },
  quiz: { label: "Квиз", hint: "Заявки квиз-лендингов." },
  inbox: { label: "Диалоги VK", hint: "Сообщения сообществ, шаблоны, статистика менеджеров." },
  content: { label: "Контент", hint: "Контент-план и группы VK." },
};
export const AN_MODULE_ORDER = Object.keys(AN_MODULES) as AnModule[];

export const AN_MODES: Record<AnMode, { label: string; hint: string }> = {
  mirror: {
    label: "Зеркало",
    hint: "Данные приходят со старого портала, правки вносят там.",
  },
  check: {
    label: "Проверка",
    hint: "Зеркало + наш сборщик по кнопке: расхождения со старым порталом.",
  },
  primary: {
    label: "Основной",
    hint: "Модуль работает на своих сборщиках, правки — здесь. Старый портал работает на своих.",
  },
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
