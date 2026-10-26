import type { UIMessage } from "ai";

/**
 * История переписки с Kate (таблицы assistant_threads / assistant_messages;
 * переписка у сотрудника одна).
 * Модуль без сервера и React: его читают /api/chat и окно Kate.
 */

/** Сколько последних сообщений диалога уходит модели вместе с новым вопросом. */
export const HISTORY_FOR_MODEL = 40;
/** Длина вопроса сотрудника. */
export const MAX_QUESTION_CHARS = 8000;

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  parts: UIMessage["parts"];
  tools: string[];
};

/** Весь текст сообщения. */
export function messageText(message: Pick<UIMessage, "parts">): string {
  return message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

/** Имена инструментов, которые вызывала Kate в ответе (части `tool-<имя>`). */
export function messageTools(message: Pick<UIMessage, "parts">): string[] {
  const names = message.parts
    .map((p) => (p.type.startsWith("tool-") ? p.type.slice("tool-".length) : null))
    .filter((n): n is string => !!n);
  return [...new Set(names)];
}

/**
 * Что сохраняется: только текст. Строки данных из инструментов (сотни
 * клиентов с телефонами) в истории не лежат — к следующему вопросу Kate
 * запросит свежие, а модели не придётся читать старые снова.
 */
export function toStored(message: UIMessage): StoredMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text = messageText(message);
  const tools = message.role === "assistant" ? messageTools(message) : [];
  if (!text && !tools.length) return null;
  return {
    id: message.id,
    role: message.role,
    parts: text ? [{ type: "text", text }] : [],
    tools,
  };
}

/**
 * Ответ Kate из шагов генерации (onFinish у streamText): текст всех шагов и
 * вызванные инструменты. Не из UI-потока: если сотрудник закрыл окно, тот
 * заканчивается сразу и с пустым сообщением, а генерация идёт до конца.
 */
export function answerFromSteps(
  id: string,
  steps: { text: string; toolCalls: ({ toolName: string } | undefined)[] }[],
): StoredMessage | null {
  const text = steps
    .map((s) => s.text)
    .join("")
    .trim();
  const tools = [
    ...new Set(steps.flatMap((s) => s.toolCalls.map((c) => c?.toolName).filter((n) => !!n))),
  ] as string[];
  if (!text && !tools.length) return null;
  return { id, role: "assistant", parts: text ? [{ type: "text", text }] : [], tools };
}

/** Сохранённое сообщение — обратно в UIMessage (для окна и модели). */
export function fromStored(row: { id: string; role: string; parts: unknown }): UIMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  const parts = Array.isArray(row.parts)
    ? (row.parts as UIMessage["parts"]).filter(
        (p) => p && p.type === "text" && typeof p.text === "string",
      )
    : [];
  return { id: row.id, role: row.role, parts };
}

/**
 * Что уходит модели: последние сообщения диалога с текстом. Первым должен
 * идти вопрос сотрудника — ответ без вопроса модель поняла бы неверно.
 */
export function historyForModel(messages: UIMessage[], max = HISTORY_FOR_MODEL): UIMessage[] {
  const withText = messages.filter((m) => messageText(m));
  const tail = withText.slice(-max);
  const firstUser = tail.findIndex((m) => m.role === "user");
  return firstUser < 0 ? [] : tail.slice(firstUser);
}
