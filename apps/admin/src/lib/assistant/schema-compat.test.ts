import { describe, expect, test } from "bun:test";

import { portableRequestBody } from "./schema-compat";

describe("схемы инструментов для любых провайдеров", () => {
  test("служебные ключи убраны, поля с такими именами — нет", () => {
    const body = JSON.stringify({
      model: "m",
      tools: [
        {
          type: "function",
          function: {
            name: "t",
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", format: "uuid" },
                from: { type: "string", pattern: "^\\d{4}$" },
                limit: { type: "number", default: 10, minimum: 1 },
                format: { type: "string", enum: ["a", "b"] },
                ids: { type: "array", items: { type: "string", format: "uuid" } },
              },
              required: ["id"],
            },
          },
        },
      ],
    });
    const out = JSON.parse(portableRequestBody(body));
    expect(out.model).toBe("m");
    expect(out.tools[0].function.parameters).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        from: { type: "string" },
        limit: { type: "number", minimum: 1 },
        format: { type: "string", enum: ["a", "b"] },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    });
  });

  test("Responses API: parameters на верхнем уровне, строгий режим выключен", () => {
    const body = JSON.stringify({
      tools: [
        {
          type: "function",
          name: "t",
          parameters: { type: "object", additionalProperties: false, properties: {} },
        },
        { type: "web_search" },
      ],
    });
    const out = JSON.parse(portableRequestBody(body));
    expect(out.tools[0]).toEqual({
      type: "function",
      name: "t",
      parameters: { type: "object", properties: {} },
      strict: false,
    });
    expect(out.tools[1]).toEqual({ type: "web_search" });
  });

  test("тело без инструментов и не JSON — как есть", () => {
    expect(portableRequestBody('{"model":"m"}')).toBe('{"model":"m"}');
    expect(portableRequestBody("x")).toBe("x");
  });
});
