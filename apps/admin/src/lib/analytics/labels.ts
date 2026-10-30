/**
 * «Аналитика» — заголовки страниц и карточки главной. Тексты — со старого портала аналитики Lady Stretch (их главная,
 * DASHBOARDS в app.py), где это их функция. Их берут и страницы, и скелетоны.
 */
import type { AnNeed } from "./access";

export const AN_TITLES = {
  home: "Аналитика",
  jobs: "Фоновые задачи",
  onec: "Обработка 1С",
  partners: "Партнёры",
  partner: "Карточка партнёра",
  activity: "Посещаемость",
  journal: "Журнал",
  api: "API для GPT",
  excelCleaner: "Очистка Excel",
  top10: "Топ-10 городов",
  reviews: "Отзывы и оценки",
  reviewsUpload: "Загрузка выгрузки",
  staffLinks: "Ссылки на отзывы сотрудников",
  staffStats: "Отзывы партнёров",
  vkAccounts: "Рекламные кабинеты",
  vkSpend: "Расходы по кабинетам",
  vkRegister: "Реестр таргета",
  vkPlans: "Планы таргета",
  vkTargetologists: "Таргетологи",
  vkLeadForms: "Сбор лид-форм",
  vkSources: "Источники СС",
  vkAlerts: "Контроль бюджетов",
  vkTools: "Обслуживание VK Ads",
  amo: "Интеграция amoCRM",
  amoConnection: "Настройка amoCRM",
  mktStretch: "Маркетинг Lady Stretch",
  mktJump: "Маркетинг Lady Jump",
  avitoAccounts: "Кабинеты Авито",
  avitoPlans: "Планы Авито",
  avitoRegister: "Реестр Авито",
  fitbase: "Интеграция FitBase",
  fitbaseConnection: "Настройки студии FitBase",
  fbRevenue: "Выручка по городам",
  fbSales: "Продажи абонементов FitBase",
  fbMarketing: "Маркетинговый отчёт FitBase",
  quiz: "Квиз-лендинги",
  quizLeads: "Заявки квиза",
} as const;

/** «Очистка Excel» — тексты их ExcelCleaner 1.1-fast (окно, статусы, предупреждения). */
export const AN_EXCEL_CLEANER_TEXT = {
  lead: "Очистка Excel-выгрузок 1С: убирает объединенные ячейки, удаляет пустые строки и столбцы, приводит таблицу к рабочему виду. Файл обрабатывается в браузере и никуда не отправляется.",
  dropTitle: "Перетащите Excel-файл сюда",
  dropHint: "Поддерживается формат .xlsx. Можно также выбрать файл вручную ниже.",
  notPicked: "Файл пока не выбран",
  picked: (name: string) => `Выбран файл: ${name}`,
  outputTip: "Имя очищенного файла — он скачается после обработки.",
  statusIdle: "Перетащите .xlsx файл в окно или выберите его вручную.",
  statusPicked: "Файл выбран. Можно запускать очистку.",
  statusStarting: "Начинаю обработку...",
  statusSaved: (name: string) => `Файл сохранен: ${name}`,
  statusFailed: "Ошибка обработки.",
  reportPlaceholder: "Здесь появится отчет после обработки.",
  noFileTitle: "Не выбран файл",
  noFileText: "Сначала выберите Excel-файл или перетащите его в окно.",
  badFormatTitle: "Неподдерживаемый формат",
  badFormatText: "Выберите файл в формате .xlsx.",
};

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
  {
    key: "vk.register",
    title: "Реестр таргета",
    description: "Факт по городам за выбранный период: бюджет, ЛФ, СС, лиды и заявки.",
    url: "/analytics/vk/register",
    need: "vk.register",
  },
  {
    key: "avito.register",
    title: "Реестр Авито",
    description: "Реклама Авито по городам, РК, группам и креативам.",
    url: "/analytics/avito/register",
    need: "avito.register",
  },
  {
    key: "reviews",
    title: "Отзывы и оценки",
    description: "Статистика оценок и комментарии клиентов по загруженной выгрузке.",
    url: "/analytics/reviews",
    need: "reviews",
  },
  {
    key: "mkt.ls",
    title: "Маркетинг Lady Stretch",
    description: "Маркетинговая воронка, квалификация и конверсии по городам.",
    url: "/analytics/crm/marketing/lady-stretch",
    need: "mkt.ls",
  },
  {
    key: "mkt.lj",
    title: "Маркетинг Lady Jump",
    description: "Маркетинговая воронка, квалификация и конверсии по городам.",
    url: "/analytics/crm/marketing/lady-jump",
    need: "mkt.lj",
  },
  // Отчёты FitBase — их fitbase_staff_reports.REPORTS: вся сеть.
  {
    key: "fb.revenue",
    title: "Выручка · FitBase",
    description: "Оплаты, возвраты и прогноз по всей сети.",
    url: "/analytics/fitbase/revenue",
    need: "fb.revenue",
  },
  {
    key: "fb.marketing",
    title: "Маркетинг · FitBase",
    description: "Лиды, приходы и покупки по всей сети.",
    url: "/analytics/fitbase/marketing",
    need: "fb.marketing",
  },
  {
    key: "fb.sales",
    title: "Продажи абонементов · FitBase",
    description: "Новые и повторные покупки по всей сети.",
    url: "/analytics/fitbase/sales",
    need: "fb.sales",
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
