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

export const AN_JOBS: Record<string, AnJobInfo> = {};

export const jobLabel = (key: string) => AN_JOBS[key]?.label ?? key;

/** Включена ли задача: строка состояния, иначе — внешняя выключена. */
export function jobEnabled(key: string, state: { enabled: boolean } | undefined): boolean {
  return state ? state.enabled : !AN_JOBS[key]?.external;
}
