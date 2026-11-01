import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  createAnonClient,
  getSupabaseAdmin,
  hasSupabaseAdmin,
} from "@/integrations/supabase/client.server";
import { isPlaceholderEmail } from "@/lib/access/logic";
import { createAttemptLimiter, verifyPassword } from "@/lib/password.server";
import { hasStaffRole } from "@/lib/roles";

/** Итог запроса кода или входа по логину — причина для текста на /auth. */
export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "no_access" | "wrong_password" | "too_many" }
  | { ok: false; reason: "locked"; minutes: number };

/**
 * Вход в админку — только по 6-значному коду из письма, паролей у сотрудников
 * нет.
 *
 * Код генерирует GoTrue и передаёт только в хук писем (/api/auth-email), то
 * есть он существует лишь на сервере и в письме: эта функция его не видит и
 * не возвращает, ответ браузеру — всегда { ok: true }. Сотрудник вводит код
 * на /auth, браузер отдаёт его прямо в GoTrue (verifyOtp) и получает сессию.
 *
 * Письмо отправляем, только если почта принадлежит человеку портала:
 * клиенты приложения живут в том же Supabase, и письмо «вход в админку» им
 * слать нельзя. Проверка роли идёт сервис-ключом, поэтому она здесь, на
 * сервере. Нет такой почты у людей портала — `not_found` (решение владельца
 * 2026-11-01: экран входа подсказывает войти по логину Platrum; прежде ответ
 * был одинаковым для любой почты).
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
  .handler(async ({ data }): Promise<LoginResult> => {
    // Служебный адрес человека без почты (lib/access/logic.ts) — писем нет.
    if (isPlaceholderEmail(data.email)) return { ok: false, reason: "not_found" };
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
    if (ids.length === 0) return { ok: false, reason: "not_found" };

    // Сотрудник клуба или человек портала с ролями (УК — и без клуба).
    let portal = false;
    for (const id of ids) {
      if (await hasStaffRole(admin, id)) {
        portal = true;
        break;
      }
    }
    if (!portal) return { ok: false, reason: "not_found" };

    return sendCode(data.email, data.redirectTo);
  });

async function sendCode(email: string, redirectTo: string): Promise<LoginResult> {
  const { error } = await createAnonClient().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
  });
  // Нет такого пользователя (shouldCreateUser: false).
  if (error && /signups not allowed|user not found/i.test(error.message)) {
    return { ok: false, reason: "not_found" };
  }
  if (error) {
    // Лимит GoTrue на повторную отправку: прежний код ещё действует —
    // отвечаем «отправлено», причину пишем в лог сервера.
    if (/seconds|rate limit/i.test(error.message)) {
      console.warn("[auth] лимит повторной отправки кода:", error.message);
      return { ok: true };
    }
    throw new Error(`Не удалось отправить письмо: ${error.message}`);
  }
  // Только признак успеха: код в ответ не попадает никогда.
  return { ok: true };
}

/**
 * Вход по логину и паролю из Platrum (решение владельца 2026-11-01,
 * db/migrations/2026-11-01_zz_portal_logins.sql). Пару проверяет сервер
 * (хэш scrypt в portal_logins, только сервис-ключом), затем выдаёт сессию
 * GoTrue той же учётной записи: одноразовая ссылка входа генерируется
 * админ-API (письмо при этом не уходит) и сразу погашается здесь же —
 * браузер получает только токены сессии (supabase.auth.setSession).
 *
 * Логина нет — `not_found` (экран входа предлагает войти по почте). После 10
 * неверных паролей подряд логин закрыт на 15 минут (база), с одного адреса —
 * не больше 30 попыток за 15 минут (память процесса).
 */
const loginLimiter = createAttemptLimiter(30, 15 * 60_000);

export const signInWithLogin = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        login: z.string().trim().min(1, "Укажите логин").max(100),
        password: z.string().min(1, "Укажите пароль").max(200),
      })
      .parse(data),
  )
  .handler(
    async ({
      data,
    }): Promise<LoginResult | { ok: true; access_token: string; refresh_token: string }> => {
      if (!hasSupabaseAdmin()) throw new Error("Вход по логину сейчас недоступен");
      const ip =
        (getRequestHeader("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
        getRequestHeader("x-real-ip") ||
        "unknown";
      if (!loginLimiter.take(ip)) return { ok: false, reason: "too_many" };

      const admin = getSupabaseAdmin();
      const pattern = data.login.replace(/[\\%_]/g, "\\$&");
      const { data: rows, error } = await admin
        .from("portal_logins")
        .select("user_id, password_hash, locked_until")
        .ilike("login", pattern)
        .limit(1);
      if (error) throw new Error(error.message);
      const row = rows?.[0] as
        | { user_id: string; password_hash: string; locked_until: string | null }
        | undefined;
      if (!row) return { ok: false, reason: "not_found" };

      const lockedMs = row.locked_until ? Date.parse(row.locked_until) - Date.now() : 0;
      if (lockedMs > 0)
        return { ok: false, reason: "locked", minutes: Math.ceil(lockedMs / 60_000) };

      if (!(await verifyPassword(data.password, row.password_hash))) {
        const { data: until } = await admin.rpc("portal_login_failed", { p_user: row.user_id });
        if (typeof until === "string" && Date.parse(until) > Date.now()) {
          return { ok: false, reason: "locked", minutes: 15 };
        }
        return { ok: false, reason: "wrong_password" };
      }

      // Роли сняты, доступ заблокирован или истёк — пароль верный, но входа нет.
      if (!(await hasStaffRole(admin, row.user_id))) return { ok: false, reason: "no_access" };

      const { data: account, error: accErr } = await admin.auth.admin.getUserById(row.user_id);
      const email = account?.user?.email;
      if (accErr || !email) throw new Error("Учётная запись не найдена");
      const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
      });
      const tokenHash = link?.properties?.hashed_token;
      if (linkErr || !tokenHash) {
        throw new Error(`Не удалось войти: ${linkErr?.message ?? "нет ссылки входа"}`);
      }
      const { data: verified, error: verErr } = await createAnonClient().auth.verifyOtp({
        type: "magiclink",
        token_hash: tokenHash,
      });
      const session = verified?.session;
      if (verErr || !session) {
        throw new Error(`Не удалось войти: ${verErr?.message ?? "нет сессии"}`);
      }
      await admin
        .from("portal_logins")
        .update({ failed_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
        .eq("user_id", row.user_id);
      return {
        ok: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      };
    },
  );
