import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { answerFromSteps, fromStored, historyForModel, toStored } from "./history";

const msg = (id: string, role: "user" | "assistant", text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("история переписки с Kate", () => {
  test("сохраняется только текст ответа и имена инструментов, строки данных — нет", () => {
    const answer = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-list_clients",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: { rows: [{ phone: "+995555000000" }] },
        },
        { type: "text", text: "Нашла " },
        { type: "text", text: "двоих." },
        {
          type: "tool-list_clients",
          toolCallId: "t2",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
    } as unknown as UIMessage;
    const stored = toStored(answer);
    expect(stored).toEqual({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Нашла двоих." }],
      tools: ["list_clients"],
    });
    expect(JSON.stringify(stored)).not.toContain("+995");
  });

  test("пустое сообщение и чужие роли не сохраняются", () => {
    expect(toStored({ id: "x", role: "assistant", parts: [] })).toBeNull();
    expect(toStored({ id: "x", role: "system", parts: [{ type: "text", text: "a" }] })).toBeNull();
  });

  test("из базы — только текстовые части", () => {
    expect(
      fromStored({
        id: "m",
        role: "user",
        parts: [{ type: "text", text: "hi" }, { type: "file" }],
      }),
    ).toEqual(msg("m", "user", "hi"));
    expect(fromStored({ id: "m", role: "tool", parts: [] })).toBeNull();
    expect(fromStored({ id: "m", role: "user", parts: null })).toEqual({
      id: "m",
      role: "user",
      parts: [],
    });
  });

  test("модели — последние сообщения, начиная с вопроса", () => {
    const all = [
      msg("1", "user", "q1"),
      msg("2", "assistant", "a1"),
      msg("3", "user", "q2"),
      msg("4", "assistant", "a2"),
      msg("5", "user", "q3"),
    ];
    expect(historyForModel(all, 4).map((m) => m.id)).toEqual(["3", "4", "5"]);
    expect(historyForModel(all, 10).map((m) => m.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(historyForModel([msg("1", "assistant", "a")], 5)).toEqual([]);
  });
});

describe("ответ из шагов генерации", () => {
  test("текст всех шагов и инструменты без повторов", () => {
    expect(
      answerFromSteps("a", [
        { text: "", toolCalls: [{ toolName: "list_clients" }, { toolName: "list_sales" }] },
        { text: "", toolCalls: [{ toolName: "list_clients" }] },
        { text: "Итог.", toolCalls: [] },
      ]),
    ).toEqual({
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "Итог." }],
      tools: ["list_clients", "list_sales"],
    });
    expect(answerFromSteps("a", [{ text: " ", toolCalls: [] }])).toBeNull();
  });
});
