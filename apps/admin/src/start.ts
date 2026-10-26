import { createStart, createMiddleware } from "@tanstack/react-start";

import { errorResponse } from "./lib/error-page";
import { attachSupabaseAuth } from "./integrations/supabase/auth-attacher";

// Необработанная ошибка SSR или API-роута -> страница/текст 500 (см. errorResponse).
// Ошибки серверных функций сюда не доходят: их сериализует сам Start.
const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next();
  } catch (error) {
    // Redirect/notFound и HTTP-ошибки с кодом — штатный поток, не трогаем.
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return errorResponse(request);
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
  functionMiddleware: [attachSupabaseAuth],
}));
