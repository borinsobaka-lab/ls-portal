import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { portableRequestBody } from "@/lib/assistant/schema-compat";

// AI-провайдер задаётся переменными окружения (Coolify, club40-admin). Пока
// они не заданы, /api/chat и /api/transcribe отвечают 503 «временно
// недоступно».
//   AI_GATEWAY_BASE_URL — адрес API, например https://api.openai.com/v1
//   AI_GATEWAY_API_KEY  — ключ провайдера
//   AI_CHAT_MODEL       — модель чата (например gpt-6-luna)
//   AI_TRANSCRIBE_MODEL — модель распознавания речи (например gpt-4o-mini-transcribe)
// Необязательные:
//   AI_CHAT_API         — responses (Responses API OpenAI) или chat
//                         (/chat/completions — любой OpenAI-совместимый). По
//                         умолчанию: responses для api.openai.com, chat — для
//                         остальных. Рассуждающие модели OpenAI (gpt-6-…)
//                         с инструментами работают только через responses.
//   AI_REASONING_EFFORT — сила рассуждения модели OpenAI: none / minimal /
//                         low / medium / high / xhigh; не задана — по
//                         умолчанию модели.

export function getAiGatewayConfig() {
  const baseURL = process.env.AI_GATEWAY_BASE_URL;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!baseURL || !apiKey) return null;
  return { baseURL: baseURL.replace(/\/+$/, ""), apiKey };
}

export type ChatApi = "responses" | "chat";

/** Какой API модели: явно из AI_CHAT_API, иначе по адресу провайдера. */
export function chatApiFor(baseURL: string, setting: string | undefined): ChatApi {
  const value = setting?.trim().toLowerCase();
  if (value === "responses" || value === "chat") return value;
  try {
    return new URL(baseURL).hostname === "api.openai.com" ? "responses" : "chat";
  } catch {
    return "chat";
  }
}

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

// Схемы инструментов — без ключей, на которые часть провайдеров отвечает
// 400, у Responses API — без строгого режима (lib/assistant/schema-compat.ts).
const portableFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(
    input,
    typeof init?.body === "string" ? { ...init, body: portableRequestBody(init.body) } : init,
  );

/** Модель чата Kate и её параметры для streamText; null — не подключена. */
export function createChatModel(): {
  model: LanguageModel;
  api: ChatApi;
  providerOptions?: { openai: { reasoningEffort: string } };
} | null {
  const config = getAiGatewayConfig();
  const modelId = process.env.AI_CHAT_MODEL?.trim();
  if (!config || !modelId) return null;
  const api = chatApiFor(config.baseURL, process.env.AI_CHAT_API);
  if (api === "chat") {
    const provider = createOpenAICompatible({
      name: "ai-gateway",
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      fetch: portableFetch,
    });
    return { model: provider(modelId), api };
  }
  const openai = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    fetch: portableFetch,
  });
  const effort = process.env.AI_REASONING_EFFORT?.trim().toLowerCase();
  const known = REASONING_EFFORTS.find((e) => e === effort);
  return {
    model: openai.responses(modelId),
    api,
    ...(known ? { providerOptions: { openai: { reasoningEffort: known } } } : {}),
  };
}
