import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { loadDictionary, readDocumentLocale } from "@/i18n";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Данные с экрана, который только что открывали, показываются сразу и
        // обновляются фоном не чаще раза в минуту — переходы между разделами
        // и возвращение в приложение без скелетонов и лишних запросов (до
        // 2026-10-16 — 30 секунд: при 1000 клиентов это вдвое больше запросов
        // к базе от каждого возвращения на главную).
        staleTime: 60_000,
        // Кэш держим сутки: он же сохраняется в браузере между запусками
        // (src/lib/query-persist.ts). На сервере — без таймера: QueryClient
        // создаётся на каждый запрос, и суточный таймер сборки держал бы в
        // памяти кэш каждого отрисованного запроса целые сутки (утечка
        // памяти контейнера). Infinity — значение React Query по умолчанию
        // для сервера: кэш уходит вместе с запросом.
        gcTime: typeof window === "undefined" ? Infinity : 24 * 60 * 60_000,
        retry: 1,
        // Повтор — с разбросом: после сбоя сервера телефоны не приходят
        // все в одну и ту же секунду.
        retryDelay: (attempt) => 1000 * 2 ** attempt + Math.random() * 1000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: false,
    // Код раздела подгружается при наведении/касании ссылки, до перехода.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Словарь выбранного языка — до гидратации: сервер отрисовал страницу на
    // нём, и первый рендер в браузере должен совпасть (src/i18n/).
    hydrate: async () => {
      await loadDictionary(readDocumentLocale());
    },
  });

  return router;
};
