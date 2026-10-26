import { createRouter } from "@tanstack/react-router";

import { PageSkeleton } from "./components/skeletons";
import { createQueryClient } from "./lib/query";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = createQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Наведение (или касание) ссылки меню заранее грузит код раздела —
    // к клику он уже на месте. Данные страниц грузит React Query, лоадеров у
    // роутов нет, поэтому preload — это только чанк и дешёвый beforeLoad.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Пока грузится код страницы — её собственный скелетон (pendingComponent
    // роута, components/page-skeletons.tsx); меню остаётся, оно в
    // layout-роуте. PageSkeleton — только запасной вариант для роута без
    // своего (тест routes/pending-skeletons.test.ts требует его у каждой
    // страницы). По умолчанию роутер ждёт секунду и всё это время держит
    // прежнюю страницу без признаков перехода; 200 мс — не мигает на быстрых
    // переходах, 300 мс показа — не дёргается, если успел появиться.
    defaultPendingComponent: PageSkeleton,
    defaultPendingMs: 200,
    defaultPendingMinMs: 300,
  });

  return router;
};
