import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false } as const;

/**
 * Клиент от имени пользователя: запросы идут с его JWT, RLS действует.
 * Основной клиент серверного кода.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: SERVER_AUTH,
  });
}

/** Клиент без пользователя — для вызовов Auth от имени приложения (письмо с кодом входа). */
export function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: SERVER_AUTH });
}

/** Задан ли сервис-ключ (без него недоступны операции getSupabaseAdmin). */
export function hasSupabaseAdmin() {
  return !!SUPABASE_URL && !!process.env.APP_SUPABASE_SERVICE_KEY;
}

let admin: SupabaseClient | undefined;

// Предел ожидания ответа базы для сервис-клиента. Без него зависший запрос
// навсегда останавливал бы фоновую рассылку пушей: цикл не начинает новый
// проход, пока не закончился прежний (src/lib/push/push-worker.server.ts).
const ADMIN_FETCH_TIMEOUT_MS = 30_000;

const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
};

/**
 * Клиент с service_role — в обход RLS. Только для того, что RLS не позволяет
 * (auth.admin.*), и только после явной проверки вызывающего.
 * Ключ — runtime-секрет APP_SUPABASE_SERVICE_KEY.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!admin) {
    const serviceKey = process.env.APP_SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !serviceKey) {
      throw new Error("Сервер не настроен: не задан APP_SUPABASE_SERVICE_KEY");
    }
    admin = createClient(SUPABASE_URL, serviceKey, {
      auth: SERVER_AUTH,
      global: { fetch: timedFetch },
    });
  }
  return admin;
}
