import { createFileRoute } from "@tanstack/react-router";

import { FbWebError } from "@/lib/analytics/fitbase/web";
import { fbWebSessionFromHelper } from "@/lib/analytics/server/fitbase-web.server";

// Приём сессии FitBase от помощника входа (deploy/fitbase-session): владелец
// сам входит в FitBase на своём компьютере, помощник присылает
// {origin, cookies} с одноразовым кодом с портала (их configure_session по
// SSH). Сессия проверяется на FitBase и хранится шифртекстом.
export const Route = createFileRoute("/api/analytics/fitbase/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), {
            status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        const token = (request.headers.get("authorization") ?? "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!token || token.length > 200) return json(401, { error: "Нет кода помощника." });
        // Не больше 200 000 байт — читаем с ограничением, а не целиком.
        const limit = 200000;
        if (Number(request.headers.get("content-length") ?? 0) > limit)
          return json(413, { error: "Слишком большая сессия." });
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit) {
            await reader.cancel();
            return json(413, { error: "Слишком большая сессия." });
          }
          chunks.push(value);
        }
        const raw = new TextDecoder().decode(Buffer.concat(chunks));
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return json(400, { error: "Нужна сессия помощника входа: {origin, cookies}." });
        }
        try {
          const studios = await fbWebSessionFromHelper(token, payload);
          return json(200, { ok: true, studios });
        } catch (e) {
          if (e instanceof FbWebError) return json(400, { error: e.message });
          console.error("[fitbase] приём сессии", (e as Error).name);
          return json(500, { error: "Не удалось сохранить сессию. Повторите позже." });
        }
      },
    },
  },
});
