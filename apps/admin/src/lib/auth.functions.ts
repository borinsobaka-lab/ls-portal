import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  createAnonClient,
  getSupabaseAdmin,
  hasSupabaseAdmin,
} from "@/integrations/supabase/client.server";
import { isPlaceholderEmail } from "@/lib/access/logic";
import { hasStaffRole } from "@/lib/roles";

/**
 * Вход в админку — только по 6-значному коду из письма, паролей у сотрудников
 * нет.
 *
 * Код генерирует GoTrue и передаёт только в хук писем (/api/auth-email), то
 * есть он существует лишь на сервере и в письме: эта функция его не видит и
 * не возвращает, ответ браузеру — всегда { ok: true }. Сотрудник вводит код
 * на /auth, браузер отдаёт его прямо в GoTrue (verifyOtp) и получает сессию.
 *
 * Письмо отправляем, только если почта принадлежит сотруднику: клиенты
 * приложения живут в том же Supabase, и письмо «вход в админку» им слать
 * нельзя. Проверка роли идёт сервис-ключом, поэтому она здесь, на сервере.
 * Ответ одинаковый для любой почты — по нему нельзя узнать, кто сотрудник.
 */
export const requestStaffLoginCode = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email("Неверный адрес почты"),
        // По хосту этого адреса хук писем понимает, что письмо из админки
        // (тема и текст «вход в админ-панель»). GoTrue пускает только адреса
        // из своего списка redirect URLs.
        redirectTo: z.string().url(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    // Служебный адрес человека без почты (lib/access/logic.ts) — писем нет.
    if (isPlaceholderEmail(data.email)) return { ok: true };
    // Без сервис-ключа роль не проверить. Чтобы не запереть всех снаружи,
    // шлём код как есть: не-сотрудника всё равно не пустит guard
    // (_authenticated/route.tsx), теряется лишь «письма только сотрудникам».
    if (!hasSupabaseAdmin()) {
      console.warn("[auth] APP_SUPABASE_SERVICE_KEY не задан — код без проверки роли");
      return sendCode(data.email, data.redirectTo);
    }
    const admin = getSupabaseAdmin();
    // profiles.email заполняется при создании пользователя (handle_new_user).
    const pattern = data.email.replace(/[\\%_]/g, "\\$&");
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", pattern);
    if (error) throw new Error(error.message);
    const ids = (profiles ?? []).map((p) => p.id as string);
    if (ids.length === 0) return { ok: true };

    // Сотрудник клуба или человек портала с ролями (УК — и без клуба).
    let portal = false;
    for (const id of ids) {
      if (await hasStaffRole(admin, id)) {
        portal = true;
        break;
      }
    }
    if (!portal) return { ok: true };

    return sendCode(data.email, data.redirectTo);
  });

async function sendCode(email: string, redirectTo: string) {
  const { error } = await createAnonClient().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  // Нет такого пользователя (shouldCreateUser: false) — молчим, как и для
  // не-сотрудника.
  if (error && !/signups not allowed|user not found/i.test(error.message)) {
    // Лимит GoTrue на повторную отправку бывает только у сотрудника (прочим
    // письмо не шлём вовсе), поэтому отдельная ошибка выдавала бы, чья почта
    // принадлежит сотруднику. Отвечаем как всем — прежний код ещё действует —
    // а причину пишем в лог сервера.
    if (/seconds|rate limit/i.test(error.message)) {
      console.warn("[auth] лимит повторной отправки кода:", error.message);
      return { ok: true };
    }
    throw new Error(`Не удалось отправить письмо: ${error.message}`);
  }
  // Только признак успеха: код в ответ не попадает никогда.
  return { ok: true };
}
