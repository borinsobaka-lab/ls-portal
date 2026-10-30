import { createFileRoute } from "@tanstack/react-router";

import { kickAnalyticsJob } from "@/lib/analytics/server/jobs.server";
import { handleQuizLead } from "@/lib/analytics/server/quiz.server";

// Приём заявок квиз-лендинга — их POST /api/quiz/leads (без входа; проверки
// и запись — lib/analytics/server/quiz.server.ts). Сохранённую заявку сразу
// отправляет в таблицу города задача «quiz_sheets», если её включили.
export const Route = createFileRoute("/api/analytics/quiz/leads")({
  server: {
    handlers: {
      POST: ({ request }) => handleQuizLead(request, () => void kickAnalyticsJob("quiz_sheets")),
    },
  },
});
