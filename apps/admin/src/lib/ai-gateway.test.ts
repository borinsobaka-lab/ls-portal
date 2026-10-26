import { describe, expect, test } from "bun:test";

import { chatApiFor } from "./ai-gateway.server";

describe("API модели Kate", () => {
  test("OpenAI — Responses API, остальные — chat/completions", () => {
    expect(chatApiFor("https://api.openai.com/v1", undefined)).toBe("responses");
    expect(chatApiFor("https://openrouter.ai/api/v1", undefined)).toBe("chat");
    expect(chatApiFor("не адрес", undefined)).toBe("chat");
  });

  test("AI_CHAT_API важнее адреса", () => {
    expect(chatApiFor("https://api.openai.com/v1", "chat")).toBe("chat");
    expect(chatApiFor("https://proxy.example/v1", " Responses ")).toBe("responses");
    expect(chatApiFor("https://api.openai.com/v1", "другое")).toBe("responses");
  });
});
