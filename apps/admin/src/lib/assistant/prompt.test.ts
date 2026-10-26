import { describe, expect, test } from "bun:test";

import { buildSystemPrompt } from "./prompt";

describe("промпт Kate", () => {
  test("дата с днём недели, клуб и формат", () => {
    const p = buildSystemPrompt({
      today: "2026-10-19",
      studio: { name: "Lady Stretch Ваке", format: "packages" },
      staffName: "Иванова Анна",
    });
    expect(p).toContain("Сегодня 2026-10-19, понедельник");
    expect(p).toContain("«Lady Stretch Ваке»");
    expect(p).toContain("пакетами тренировок");
    expect(p).toContain("list_client_requests");
    expect(p).toContain("Иванова Анна");
    expect(p).toContain("(client:<client_id>)");
  });

  test("подписочный клуб — без заявок и пакетного словаря", () => {
    const p = buildSystemPrompt({
      today: "2026-10-19",
      studio: { name: "Base40", format: "subscription" },
    });
    expect(p).toContain("подписочной моделью");
    expect(p).not.toContain("list_client_requests");
  });
});
