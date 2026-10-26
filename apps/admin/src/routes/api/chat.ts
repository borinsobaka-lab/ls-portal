import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText } from "ai";
import type { UIMessage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { canOpenClubSection } from "@/lib/admin-access";
import { createChatModel } from "@/lib/ai-gateway.server";
import { filterTools } from "@/lib/assistant/access";
import { loadAdminAccess } from "@/lib/assistant/access.server";
import { studioToday } from "@/lib/assistant/dates";
import {
  HISTORY_FOR_MODEL,
  MAX_QUESTION_CHARS,
  answerFromSteps,
  fromStored,
  historyForModel,
  messageText,
  toStored,
} from "@/lib/assistant/history";
import { describeAiError } from "@/lib/assistant/errors";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { createAssistantTools } from "@/lib/assistant/tools.server";
import type { StudioFormat } from "@/lib/studio-formats";
import { authenticateStaff } from "@/lib/staff-auth.server";

// Сколько шагов (вызовов инструментов) модель может сделать за один ответ.
// Вопрос о продажах — до 3–5 вызовов; потолок ограничивает стоимость зацикливания.
const MAX_STEPS = 12;

// Браузер присылает только новый вопрос — историю сервер берёт из базы
// (assistant_messages), поэтому запрос маленький.
const MAX_BODY_BYTES = 64 * 1024;

/** Тело запроса окна Kate: новый вопрос (UIMessage). */
type ChatRequest = { message?: unknown };

/**
 * Переписка сотрудника с Kate (RLS — только своя). Одновременный первый
 * вопрос из двух вкладок упрётся в уникальный индекс — тогда берём уже
 * заведённую.
 */
async function ownThreadId(
  supabase: SupabaseClient,
  userId: string,
  studioId: string,
): Promise<string> {
  const find = async () => {
    const { data, error } = await supabase
      .from("assistant_threads")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.id as string | undefined) ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const { data, error } = await supabase
    .from("assistant_threads")
    .insert({ studio_id: studioId, title: "Переписка с Kate" })
    .select("id")
    .single();
  if (!error && data) return data.id as string;
  const again = await find();
  if (again) return again;
  throw new Error(error?.message ?? "Не удалось завести переписку с Kate");
}

/** Для лога: у ошибки провайдера главное — код, адрес и тело ответа. */
function logError(error: unknown) {
  const e = error as { statusCode?: unknown; url?: unknown; responseBody?: unknown } | null;
  return e && typeof e === "object" && "statusCode" in e
    ? { statusCode: e.statusCode, url: e.url, responseBody: e.responseBody, error }
    : error;
}

const text = (message: string, status: number) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // Ассистент Kate — инструмент сотрудника, а не клиента приложения.
          const auth = await authenticateStaff(request);
          if (!auth.ok) return text(auth.message, auth.status);

          const chat = createChatModel();
          if (!chat) {
            return text(
              "AI-ассистент временно недоступен: модель ещё не подключена. История переписки сохранится, когда её подключат.",
              503,
            );
          }

          const declared = Number(request.headers.get("content-length") ?? "0");
          if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
            return text("Слишком длинный вопрос", 413);
          }
          // Content-Length может не быть (chunked) — проверяем и прочитанное.
          const raw = await request.text();
          if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return text("Слишком длинный вопрос", 413);
          let body: ChatRequest | null = null;
          try {
            body = JSON.parse(raw) as ChatRequest | null;
          } catch {
            body = null;
          }
          const parsed = await safeValidateUIMessages({ messages: [body?.message] });
          if (!parsed.success) {
            return text("Некорректный запрос к ассистенту", 400);
          }
          const question = parsed.data[0];
          const questionText = messageText(question);
          if (question.role !== "user" || !questionText || question.id.length > 100) {
            return text("Некорректный запрос к ассистенту", 400);
          }
          if (questionText.length > MAX_QUESTION_CHARS) {
            return text(`Вопрос длиннее ${MAX_QUESTION_CHARS} символов — сократите его`, 413);
          }

          const { supabase, userId, studioId, roles } = auth.staff;

          // Переписка у сотрудника одна (assistant_threads_one_per_user):
          // нет — заводится при первом вопросе.
          const threadId = await ownThreadId(supabase, userId, studioId);

          const { data: past, error: pastError } = await supabase
            .from("assistant_messages")
            .select("id, role, parts")
            .eq("thread_id", threadId)
            .order("created_at", { ascending: false })
            .limit(HISTORY_FOR_MODEL);
          if (pastError) throw new Error(pastError.message);
          const history = ((past ?? []) as { id: string; role: string; parts: unknown }[])
            .reverse()
            .map(fromStored)
            .filter((m): m is UIMessage => !!m && m.id !== question.id);

          // Вопрос сохраняется сразу: не дошёл ответ — вопрос в истории остался.
          const storedQuestion = toStored(question);
          if (storedQuestion) {
            const { error } = await supabase
              .from("assistant_messages")
              .upsert(
                { thread_id: threadId, ...storedQuestion },
                { onConflict: "thread_id,id", ignoreDuplicates: true },
              );
            if (error) throw new Error(error.message);
          }

          const [{ data: studio }, { data: profile }, access] = await Promise.all([
            supabase.from("studios").select("name, format").eq("id", studioId).maybeSingle(),
            supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
            loadAdminAccess(supabase, userId, studioId, roles),
          ]);
          const tools = filterTools(
            createAssistantTools(supabase, studioId, {
              canSee: (key) => canOpenClubSection(access, studioId, key),
            }),
            access,
            studioId,
          );

          const messages = [...history, question];
          const answerId = crypto.randomUUID();
          const result = streamText({
            model: chat.model,
            providerOptions: chat.providerOptions,
            system: buildSystemPrompt({
              today: studioToday(),
              studio: {
                name: (studio?.name as string | null | undefined) ?? null,
                format: (studio?.format as StudioFormat | null | undefined) ?? null,
              },
              staffName: (profile?.full_name as string | null | undefined) ?? null,
            }),
            // Модели — только текст последних сообщений: строки данных из
            // прошлых ответов не хранятся, нужные Kate запросит заново.
            messages: await convertToModelMessages(historyForModel(messages)),
            tools,
            stopWhen: stepCountIs(MAX_STEPS),
            // Ответ сохраняется из итога генерации, а не UI-потока: закрыл
            // окно — поток в браузер оборван, а ответ дописывается и при
            // следующем открытии будет в истории.
            onFinish: async ({ steps }) => {
              const stored = answerFromSteps(answerId, steps);
              if (!stored) return;
              const { error } = await supabase
                .from("assistant_messages")
                .upsert({ thread_id: threadId, ...stored }, { onConflict: "thread_id,id" });
              if (error) console.error("[api/chat] save answer failed", error.message);
            },
            onError: ({ error }) => console.error("[api/chat] AI stream error", logError(error)),
          });
          // Без этого обрыв связи с браузером остановил бы генерацию.
          void result.consumeStream();

          return result.toUIMessageStreamResponse({
            originalMessages: messages,
            generateMessageId: () => answerId,
            // Причину (ключ, модель, баланс) видно в окне — иначе её не найти
            // без логов сервера.
            onError: (error) => describeAiError(error),
          });
        } catch (error) {
          console.error("[api/chat] request failed", error);
          return text("Не удалось запустить ассистента. Попробуйте ещё раз.", 500);
        }
      },
    },
  },
});
