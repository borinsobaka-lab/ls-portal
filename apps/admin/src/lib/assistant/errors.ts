/**
 * Ошибка AI-провайдера — понятным текстом для окна Kate. Раньше сотрудник
 * видел только «Не удалось получить ответ», а причина (неверный ключ, нет
 * такой модели, кончились деньги на счёте провайдера) была лишь в логах
 * сервера. Окно Kate — только для сотрудников, поэтому причина видна, а
 * похожее на ключ в тексте провайдера вырезается.
 */

const MAX_DETAIL = 300;

type ApiErrorLike = {
  statusCode?: unknown;
  responseBody?: unknown;
  message?: unknown;
  lastError?: unknown;
  cause?: unknown;
};

/** Ключи и токены (sk-…, длинные base64-строки) не показываем. */
function scrub(text: string) {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_*-]{6,}/g, "$1-…")
    .replace(/[A-Za-z0-9_-]{32,}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/** Текст ошибки из ответа провайдера: { error: { message } } / { message } / как есть. */
function providerMessage(body: unknown): string | null {
  if (typeof body !== "string" || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | unknown;
      message?: unknown;
    };
    const nested =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as { message?: unknown }).message
        : parsed.error;
    const message = typeof nested === "string" ? nested : parsed.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // не JSON — берём как есть (HTML-страницы ошибок отрезаем ниже)
  }
  return body.trimStart().startsWith("<") ? null : body;
}

/** Последняя «настоящая» ошибка: RetryError хранит её в lastError. */
function rootError(error: unknown): ApiErrorLike | null {
  let current = error as ApiErrorLike | null;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    if (typeof current.statusCode === "number") return current;
    const next = current.lastError ?? current.cause;
    if (!next || typeof next !== "object") break;
    current = next as ApiErrorLike;
  }
  return error && typeof error === "object" ? (error as ApiErrorLike) : null;
}

const HINTS: Record<number, string> = {
  400: "провайдер отклонил запрос",
  401: "ключ API не подходит — проверьте AI_GATEWAY_API_KEY",
  402: "на счёте провайдера закончились деньги",
  403: "у ключа нет доступа к этой модели — проверьте AI_GATEWAY_API_KEY и AI_CHAT_MODEL",
  404: "нет такой модели или адреса API — проверьте AI_CHAT_MODEL и AI_GATEWAY_BASE_URL (обычно оканчивается на /v1)",
  408: "провайдер не ответил вовремя",
  413: "слишком длинный запрос для модели",
  422: "провайдер отклонил запрос",
  429: "превышен лимит запросов или закончился баланс у провайдера",
};

export function describeAiError(error: unknown): string {
  const root = rootError(error);
  const status = typeof root?.statusCode === "number" ? root.statusCode : null;
  const raw =
    providerMessage(root?.responseBody) ??
    (typeof root?.message === "string" ? root.message : null) ??
    (error instanceof Error ? error.message : null);
  const detail = raw ? scrub(raw).slice(0, MAX_DETAIL) : "";

  let hint: string;
  if (status !== null) {
    hint =
      HINTS[status] ??
      (status >= 500 ? "сервис модели сейчас недоступен — попробуйте позже" : "ошибка провайдера");
    hint = `${hint} (код ${status})`;
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw ?? "")) {
    hint = "нет связи с сервисом модели — проверьте AI_GATEWAY_BASE_URL";
  } else {
    hint = "ошибка при ответе модели";
  }
  return `Kate не смогла ответить: ${hint}.${detail ? ` Ответ сервиса: «${detail}»` : ""}`;
}
