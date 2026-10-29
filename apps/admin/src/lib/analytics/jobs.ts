/**
 * Фоновые задачи «Аналитики» — подписи для экрана «Синхронизация» (сами
 * задачи — lib/analytics/server/jobs.server.ts). Модули добавляют сюда свои
 * задачи с тем же расписанием, что на старом портале (ANALYTICS_PLAN.md, §7).
 */
export const AN_JOB_LABEL: Record<string, string> = {
  "core.housekeeping": "Очистка журналов (раз в сутки)",
};

export const jobLabel = (key: string) => AN_JOB_LABEL[key] ?? key;
