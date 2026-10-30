import { createFileRoute } from "@tanstack/react-router";

import { gptOpenApiResponse } from "@/lib/analytics/server/gpt-api.server";

// Схема API для Custom GPT — их /openapi.json (без ключа).
export const Route = createFileRoute("/api/analytics/openapi.json")({
  server: {
    handlers: {
      GET: ({ request }) => gptOpenApiResponse(request),
    },
  },
});
