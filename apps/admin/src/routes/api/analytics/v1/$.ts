import { createFileRoute } from "@tanstack/react-router";

import { gptApiResponse } from "@/lib/analytics/server/gpt-api.server";

// API для Custom GPT — их /api/v1/*: каталог и данные досок 1С по ключу
// (lib/analytics/server/gpt-api.server.ts).
export const Route = createFileRoute("/api/analytics/v1/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => gptApiResponse(request, params._splat ?? ""),
    },
  },
});
