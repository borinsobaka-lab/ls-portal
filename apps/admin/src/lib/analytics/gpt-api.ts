/**
 * API для Custom GPT — их analytics_api.py и /openapi.json (app.py): только
 * чтение, ключ в заголовке Authorization: Bearer. Каталог и схема — их
 * тексты; адреса — портала: /api/analytics/openapi.json,
 * /api/analytics/v1/catalog, /api/analytics/v1/dashboards/{dashboard}.
 *
 * Данные дашборда у них — DATA из готовой HTML-доски (замороженной на
 * 13.10); у нас — то же содержимое (их full_reports.py, lib/analytics/
 * onec-reports/payload.ts) по текущему снимку 1С за период доски по
 * умолчанию или за start / end.
 */
import type { OnecBoard } from "./onec-reports/payload";

/** Их PUBLIC_DASHBOARDS: имя в API → доска 1С. */
export const GPT_DASHBOARDS: Record<string, OnecBoard> = {
  revenue: "revenue",
  subscriptions: "sales",
  activities: "activities",
  trial_funnel: "funnel",
};

export const GPT_API_BASE = "/api/analytics";

/** Их catalog(). */
export function gptCatalog() {
  return {
    dashboards: [
      {
        id: "revenue",
        title: "Выручка",
        description: "Сеть, города и студии; месячная динамика, факт, прогноз и точка 0.",
      },
      {
        id: "subscriptions",
        title: "Продажи абонементов",
        description: "Новые и повторные продажи, оплаты и сумма продаж.",
      },
      {
        id: "activities",
        title: "Занятия",
        description: "Проведённые занятия, записи и посещения по городам, студиям и направлениям.",
      },
      {
        id: "trial_funnel",
        title: "Воронка пробных",
        description: "Записи, посещения и покупки в день и за 14 дней.",
      },
    ],
    notice:
      "Данные агрегированы для аналитики. Персональные данные клиентов и административные данные портала через API не выдаются.",
  };
}

const DATE_PARAM = (name: string, description: string) => ({
  name,
  in: "query",
  required: false,
  description,
  schema: { type: "string", format: "date" },
});

/** Их /openapi.json; период — необязательные start / end (у них данные были за всю историю одним файлом). */
export function gptOpenApi(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Lady Stretch Analytics",
      version: "1.0.0",
      description:
        "Только чтение. Используй каталог перед анализом; никогда не запрашивай персональные данные.",
    },
    servers: [{ url: serverUrl.replace(/\/+$/, "") }],
    paths: {
      [`${GPT_API_BASE}/v1/catalog`]: {
        get: {
          operationId: "getAnalyticsCatalog",
          summary: "Список доступных аналитических наборов",
          responses: { "200": { description: "Каталог" } },
          security: [{ bearerAuth: [] }],
        },
      },
      [`${GPT_API_BASE}/v1/dashboards/{dashboard}`]: {
        get: {
          operationId: "getDashboardData",
          summary: "Агрегированные данные дашборда",
          parameters: [
            {
              name: "dashboard",
              in: "path",
              required: true,
              schema: { type: "string", enum: Object.keys(GPT_DASHBOARDS) },
            },
            DATE_PARAM(
              "start",
              "Начало периода (ГГГГ-ММ-ДД). По умолчанию — 1-е число текущего месяца.",
            ),
            DATE_PARAM("end", "Конец периода (ГГГГ-ММ-ДД). По умолчанию — вчера по Москве."),
          ],
          responses: { "200": { description: "Данные" } },
          security: [{ bearerAuth: [] }],
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}

/** Дата периода из запроса: только «ГГГГ-ММ-ДД», иначе — по умолчанию. */
export function gptDate(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}
