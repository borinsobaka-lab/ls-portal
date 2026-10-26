import { createFileRoute } from "@tanstack/react-router";

import { getAiGatewayConfig } from "@/lib/ai-gateway.server";
import { authenticateStaff } from "@/lib/staff-auth.server";

// Потолок загрузки — как у типичных API распознавания (25 МБ); минута
// диктовки в webm — сотни килобайт.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const tooLarge = () => new Response("Запись слишком длинная", { status: 413 });

/** Тело запроса, если оно не больше maxBytes; иначе null. */
async function readBodyLimited(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return null;
  if (!request.body) return new ArrayBuffer(0);
  // Content-Length может не быть (chunked) или он может врать — считаем сами.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // Диктовка — инструмент сотрудника и прокси к платному API распознавания.
          // Требуем роль сотрудника ДО обращения к провайдеру, иначе эндпоинт
          // становится открытым прокси, жгущим кредиты (любой из интернета).
          const auth = await authenticateStaff(request);
          if (!auth.ok) return new Response(auth.message, { status: auth.status });

          const config = getAiGatewayConfig();
          const model = process.env.AI_TRANSCRIBE_MODEL;
          if (!config || !model) {
            return new Response(
              "Распознавание речи временно недоступно: после переезда новый AI-провайдер ещё не подключён.",
              { status: 503 },
            );
          }

          const contentType = request.headers.get("content-type") ?? "";
          if (
            !contentType.includes("multipart/form-data") &&
            !contentType.includes("application/x-www-form-urlencoded")
          ) {
            return new Response("Нужен аудиофайл", { status: 400 });
          }

          // formData() прочитал бы в память тело любого размера — читаем сами
          // с потолком и разбираем уже прочитанное.
          const raw = await readBodyLimited(request, MAX_UPLOAD_BYTES);
          if (raw === null) return tooLarge();
          const inForm = await new Response(raw, {
            headers: { "content-type": contentType },
          }).formData();
          const file = inForm.get("file");
          if (!(file instanceof File) || file.size === 0) {
            return new Response("Запись пустая", { status: 400 });
          }

          const upstream = new FormData();
          upstream.append("model", model);
          const type = file.type.split(";")[0];
          const ext =
            (
              {
                "audio/webm": "webm",
                "audio/mp4": "mp4",
                "audio/mpeg": "mp3",
                "audio/wav": "wav",
                "audio/ogg": "ogg",
              } as Record<string, string>
            )[type] ?? "webm";
          upstream.append("file", file, `recording.${ext}`);

          const res = await fetch(`${config.baseURL}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: upstream,
          });

          if (!res.ok) {
            // Ответ провайдера (статус, тело — там бывают детали аккаунта и
            // ключа) пишем в лог, а сотруднику отдаём общий текст.
            const text = await res.text().catch(() => "");
            console.error("[api/transcribe] upstream error", res.status, text.slice(0, 2000));
            return new Response("Не удалось распознать речь", { status: 502 });
          }
          const data = (await res.json()) as { text?: string };
          return new Response(JSON.stringify({ text: data.text ?? "" }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          console.error("[api/transcribe] request failed", error);
          return new Response("Не удалось распознать речь", { status: 500 });
        }
      },
    },
  },
});
