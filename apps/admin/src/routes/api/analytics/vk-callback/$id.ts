import { createFileRoute } from "@tanstack/react-router";

import { hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { INBOX_MAX_CALLBACK_BYTES } from "@/lib/analytics/inbox/rules";
import { inboxHandleCallback } from "@/lib/analytics/server/vk-inbox.server";

// Приём Callback API VK для «Диалогов VK» (их /api/vk-inbox/callback/<id>):
// без входа и CSRF — граница здесь секрет Callback сообщества. VK ждёт
// простой текст: строку подтверждения или «ok»; отказ — «error».
export const Route = createFileRoute("/api/analytics/vk-callback/$id")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const plain = (text: string, status = 200) =>
          new Response(text, {
            status,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        const reject = (reason: string) => {
          console.warn(`[inbox] событие VK для подключения ${params.id} отклонено: ${reason}`);
          return plain("error", 400);
        };
        if (!hasSupabaseAdmin()) return plain("error", 503);
        if (!/^\d{1,18}$/.test(params.id) || Number(params.id) <= 0)
          return reject("неизвестное подключение");
        const length = Number(request.headers.get("content-length") ?? 0);
        if (!Number.isInteger(length) || length <= 0 || length > INBOX_MAX_CALLBACK_BYTES)
          return reject("Некорректный размер события VK.");
        if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
          return reject("Callback API должен передавать JSON.");
        // Читаем не больше заявленного размера.
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > INBOX_MAX_CALLBACK_BYTES) {
            await reader.cancel();
            return reject("Некорректный размер события VK.");
          }
          chunks.push(value);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          return reject("событие не в JSON");
        }
        const reply = await inboxHandleCallback(Number(params.id), payload);
        return plain(reply.text, reply.status);
      },
    },
  },
});
