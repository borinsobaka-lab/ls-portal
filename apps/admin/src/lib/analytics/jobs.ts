/**
 * Фоновые задачи «Аналитики» — подписи и признак внешнего действия для
 * экрана «Фоновые задачи» (сами задачи — lib/analytics/server/jobs.server.ts).
 * Модули добавляют сюда свои задачи с тем же расписанием, что на старом
 * портале (ANALYTICS_PLAN.md, §7).
 *
 * `external` — задача делает что-то снаружи: пишет в Google-таблицы, шлёт в
 * Telegram, публикует в VK. Старый портал работает параллельно и делает то
 * же самое, поэтому такую задачу сервер не запускает, пока её не включат на
 * экране (иначе — дубли сообщений, строк и постов).
 */
export type AnJobInfo = { label: string; external?: boolean };

export const AN_JOBS: Record<string, AnJobInfo> = {
  vk_ads: {
    label: "VK Ads: остатки, кампании, лид-формы, расходы за вчера и предупреждения о бюджете",
  },
  vk_budget_tg: {
    label: "VK Ads: предупреждения о бюджете партнёрам в Telegram",
    external: true,
  },
  vk_ss: { label: "VK Ads: лиды и заявки СС из Google-таблиц" },
  amo: { label: "amoCRM: изменённые сделки для маркетинговой аналитики" },
  avito: { label: "Авито: структура кабинетов и статистика кампаний за вчера" },
  vk_lf: { label: "VK Ads: новые заявки лид-форм в Google-таблицы", external: true },
  vk_lf_metrics: { label: "VK Ads: заявки лид-форм за текущий месяц для реестра" },
  fitbase: { label: "FitBase: ночная загрузка всех студий (01:00 МСК, только изменения)" },
  quiz_sheets: { label: "Квиз: новые заявки в Google-таблицы городов", external: true },
};

export const jobLabel = (key: string) => AN_JOBS[key]?.label ?? key;

/** Включена ли задача: строка состояния, иначе — внешняя выключена. */
export function jobEnabled(key: string, state: { enabled: boolean } | undefined): boolean {
  return state ? state.enabled : !AN_JOBS[key]?.external;
}
