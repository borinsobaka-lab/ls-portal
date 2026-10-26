import { describe, expect, test } from "bun:test";

import { describeAiError } from "./errors";

const apiError = (statusCode: number, responseBody?: string) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, responseBody, url: "https://x/v1" });

describe("ошибки модели для окна Kate", () => {
  test("неверный ключ — подсказка про переменную, ключ вырезан", () => {
    const text = describeAiError(
      apiError(
        401,
        JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-abcdef123456" } }),
      ),
    );
    expect(text).toContain("AI_GATEWAY_API_KEY");
    expect(text).toContain("код 401");
    expect(text).toContain("Incorrect API key provided");
    expect(text).not.toContain("abcdef123456");
  });

  test("нет модели — про AI_CHAT_MODEL и /v1", () => {
    const text = describeAiError(apiError(404, '{"message":"model not found"}'));
    expect(text).toContain("AI_CHAT_MODEL");
    expect(text).toContain("model not found");
  });

  test("RetryError — берётся последняя ошибка", () => {
    const retry = Object.assign(new Error("Failed after 3 attempts"), {
      lastError: apiError(429, '{"error":{"message":"insufficient_quota"}}'),
    });
    const text = describeAiError(retry);
    expect(text).toContain("код 429");
    expect(text).toContain("insufficient_quota");
  });

  test("HTML-страница ошибки и сеть", () => {
    expect(describeAiError(apiError(502, "<html>Bad gateway</html>"))).toContain(
      "недоступен — попробуйте позже (код 502)",
    );
    expect(describeAiError(new TypeError("fetch failed"))).toContain("AI_GATEWAY_BASE_URL");
  });

  test("длинные токены не попадают в текст", () => {
    const token = "a".repeat(40);
    expect(describeAiError(new Error(`bad token ${token}`))).not.toContain(token);
  });
});
