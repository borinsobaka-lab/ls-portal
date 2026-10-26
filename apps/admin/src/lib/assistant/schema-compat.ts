/**
 * Схемы инструментов Kate — в виде, который принимают все провайдеры. AI SDK кладёт в них `$schema`, `format: "uuid"`, `pattern`,
 * `default` и `additionalProperties`; OpenAI их принимает, но часть
 * провайдеров (Gemini и др.) отвечает на них 400. Значения всё равно
 * проверяет zod на нашем сервере перед вызовом инструмента (и подставляет
 * значения по умолчанию), поэтому в запрос к модели эти ключи не нужны.
 */
const DROP_KEYS = new Set(["$schema", "format", "pattern", "default", "additionalProperties"]);

function clean(node: unknown, inProperties = false): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Внутри properties ключи — имена полей (поле может зваться «format»).
    if (!inProperties && DROP_KEYS.has(key)) continue;
    out[key] = clean(value, !inProperties && key === "properties");
  }
  return out;
}

type ToolEntry = {
  type?: string;
  strict?: boolean;
  parameters?: unknown;
  function?: { parameters?: unknown };
};

/**
 * Тело запроса к модели: чистит parameters у каждого инструмента.
 * /chat/completions — `tools[].function.parameters`; Responses API OpenAI
 * (/v1/responses) — `tools[].parameters`, и там строгий режим схем включён
 * по умолчанию: под него все поля должны быть обязательными, а у Kate
 * большинство необязательные, — поэтому `strict: false`.
 */
export function portableRequestBody(body: string): string {
  let parsed: { tools?: ToolEntry[] };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.tools)) return body;
  for (const tool of parsed.tools) {
    if (tool?.function?.parameters) tool.function.parameters = clean(tool.function.parameters);
    if (tool?.type === "function" && tool.parameters) {
      tool.parameters = clean(tool.parameters);
      tool.strict = false;
    }
  }
  return JSON.stringify(parsed);
}
