import { createFileRoute } from "@tanstack/react-router";

import { ADMIN_VERSION } from "@/lib/app-version";

// Версия, которая сейчас на сервере: открытая вкладка сверяет её со своей
// (components/update-banner.tsx) и после выкатки предлагает обновиться —
// старая страница иначе просит у сервера уже удалённые файлы сборки
// (замечание тестирования 2026-10-27: страница без стилей, вечная загрузка).
export const Route = createFileRoute("/api/version")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { version: ADMIN_VERSION },
          { headers: { "Cache-Control": "no-store, max-age=0" } },
        ),
    },
  },
});
