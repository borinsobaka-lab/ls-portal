import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { accessErrorText, isPlaceholderEmail, NO_EMAIL_DOMAIN } from "@/lib/access/logic";
import type { AccessMe } from "@/lib/access/types";
import { hashPassword } from "@/lib/password.server";
import { STAFF_ROLES } from "@/lib/roles";

/**
 * «Пользователи и роли» (ACCESS.md): то, что требует сервис-ключа GoTrue, —
 * создать учётную запись, сменить почту (логин), аватарку, удалить
 * учётную запись. Всё остальное (данные человека, роли, структура) браузер
 * пишет RPC сам: они проверяют права и пересчитывают доступы.
 *
 * Права проверяет база от имени вызывающего (context.supabase — клиент с
 * его токеном): access_me, access_can_manage, access_user_save и
 * access_assignment_save. Сервис-ключ — только после такой проверки и только
 * для auth.admin.* и полей, которые RLS не даёт.
 */

/** Первая ошибка zod — текстом для тоста. */
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) throw new Error(res.error.issues[0]?.message ?? "Неверные данные");
  return res.data;
}

async function rpcAs<T>(supabase: SupabaseClient, fn: string, args?: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(accessErrorText(error.message, error.details));
  return data as T;
}

/** Сообщения GoTrue приходят по-английски — частые переводим для тоста. */
function authErrorText(message: string) {
  if (/already (been )?registered|already exists|email_exists/i.test(message)) {
    return "Пользователь с такой почтой уже зарегистрирован";
  }
  return message;
}

/** Почта входа: служебный адрес «без почты» вписать руками нельзя. */
const loginEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email("Неверный адрес почты")
  .refine((v) => !isPlaceholderEmail(v), "Неверный адрес почты");

/** Только загруженная в форме картинка (папка staff/ бакета avatars). */
const avatarSchema = z
  .string()
  .regex(/^staff\/[\w-]+\.(webp|png|jpe?g)$/, "Неверная аватарка")
  .nullable();

/**
 * Логин Platrum (db/migrations/2026-11-01_zz_portal_logins.sql): без пробелов,
 * регистр при входе не важен.
 */
const platrumLogin = z
  .string()
  .trim()
  .min(1, "Укажите логин")
  .max(100, "Логин длиннее 100 знаков")
  .regex(/^\S+$/, "В логине не должно быть пробелов");
const platrumPassword = z
  .string()
  .min(4, "Пароль — не короче 4 знаков")
  .max(200, "Пароль длиннее 200 знаков");

/** Логин уже у другого человека? (без регистра) */
async function loginTaken(admin: SupabaseClient, login: string, exceptUser: string | null) {
  let q = admin
    .from("portal_logins")
    .select("user_id")
    .ilike("login", login.replace(/[\\%_]/g, "\\$&"))
    .limit(1);
  if (exceptUser) q = q.neq("user_id", exceptUser);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return !!data?.length;
}

/**
 * Записать логин и пароль (пароль пустой — оставить прежний; нового логина
 * без пароля не бывает). Только сервис-ключом, после проверки прав.
 */
async function writeLogin(
  admin: SupabaseClient,
  userId: string,
  login: string,
  password: string | null,
  actor: string,
) {
  if (await loginTaken(admin, login, userId)) throw new Error("Такой логин уже занят");
  const now = new Date().toISOString();
  const { data: current, error: curErr } = await admin
    .from("portal_logins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (curErr) throw new Error(curErr.message);
  if (!current && !password) throw new Error("Укажите пароль");
  const patch = {
    login,
    updated_at: now,
    updated_by: actor,
    ...(password
      ? {
          password_hash: await hashPassword(password),
          password_set_at: now,
          failed_count: 0,
          locked_until: null,
        }
      : {}),
  };
  const { error } = current
    ? await admin.from("portal_logins").update(patch).eq("user_id", userId)
    : await admin.from("portal_logins").insert({ user_id: userId, ...patch });
  if (error) {
    if (/portal_logins_login_key|duplicate key/i.test(error.message)) {
      throw new Error("Такой логин уже занят");
    }
    throw new Error(error.message);
  }
}

const assignmentSchema = z
  .object({
    role_id: z.string().uuid(),
    scope_type: z.enum(["all", "brands", "studios", "owned"]),
    scope_ids: z.array(z.string().uuid()).max(500),
    valid_until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    first_name: z.string().trim().min(1, "Укажите имя").max(100),
    last_name: z.string().trim().min(1, "Укажите фамилию").max(100),
    /** null — без почты: учётная запись со служебным адресом, войти не сможет. */
    email: loginEmail.nullable(),
    /** Вход по логину и паролю Platrum; можно вместе с почтой. */
    login: platrumLogin.nullable().optional(),
    password: platrumPassword.nullable().optional(),
    phone: z.string().trim().max(40).optional(),
    user_type: z.enum(["hq", "partner", "studio", "contractor", "service"]).nullable(),
    position_id: z.string().uuid().nullable(),
    access_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    note: z.string().trim().max(2000).optional(),
    avatar_url: avatarSchema,
    assignments: z.array(assignmentSchema).max(20),
  })
  .strict();

/**
 * Добавить человека в портал. Есть учётная запись с этой почтой (клиент
 * приложения, сотрудник другого клуба) — только регистрируем в портале и
 * выдаём роли; нет — создаём (вход по коду из письма, пароля нет). Уже
 * человек портала — ошибка с его id: интерфейс откроет карточку.
 */
export const createPortalUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => parseOrThrow(createSchema, data))
  .handler(async ({ context, data }) => {
    const me = await rpcAs<AccessMe>(context.supabase, "access_me");
    if (!me.rights.includes("users.manage")) {
      throw new Error("Добавлять людей может только тот, кто управляет пользователями");
    }
    const admin = getSupabaseAdmin();
    const fullName = `${data.last_name} ${data.first_name}`;
    if (data.login) {
      if (!data.password) throw new Error("Укажите пароль для логина");
      if (await loginTaken(admin, data.login, null)) throw new Error("Такой логин уже занят");
    }

    let userId: string | null = null;
    if (data.email) {
      const pattern = data.email.replace(/[\\%_]/g, "\\$&");
      const { data: found, error: findErr } = await admin
        .from("profiles")
        .select("id")
        .ilike("email", pattern)
        .limit(1);
      if (findErr) throw new Error(findErr.message);
      userId = (found?.[0]?.id as string | undefined) ?? null;
    }
    let created = false;

    if (userId) {
      const { data: portal, error: portalErr } = await admin
        .from("portal_users")
        .select("user_id")
        .eq("user_id", userId)
        .limit(1);
      if (portalErr) throw new Error(portalErr.message);
      if (portal?.length) {
        throw new Error(`already_in_portal:${userId}`);
      }
    } else {
      // Клуб профиля (profiles.studio_id обязателен): первый клуб первой
      // роли, иначе клуб того, кто добавляет. Права это не даёт — их дают роли.
      const first = data.assignments.find((a) => a.scope_type === "studios" && a.scope_ids.length);
      let homeStudioId = first?.scope_ids[0] ?? null;
      if (!homeStudioId) {
        const { data: own } = await admin
          .from("profiles")
          .select("studio_id")
          .eq("id", context.userId)
          .maybeSingle();
        homeStudioId = (own?.studio_id as string | undefined) ?? null;
      }
      if (!homeStudioId) {
        const { data: oldest } = await admin
          .from("studios")
          .select("id")
          .order("created_at")
          .limit(1)
          .maybeSingle();
        homeStudioId = (oldest?.id as string | undefined) ?? null;
      }
      if (!homeStudioId) throw new Error("Сначала заведите хотя бы один клуб");

      // Без почты — служебный адрес в домене .invalid (lib/access/logic.ts):
      // GoTrue без почты или телефона учётную запись не заводит.
      const authEmail = data.email ?? `nomail-${crypto.randomUUID()}@${NO_EMAIL_DOMAIN}`;
      const { data: res, error } = await admin.auth.admin.createUser({
        email: authEmail,
        email_confirm: true,
        // studio_id читает handle_new_user; staff_account — не заводить
        // карточку клиента (db/migrations/…_staff_accounts.sql).
        user_metadata: {
          first_name: data.first_name,
          last_name: data.last_name,
          full_name: fullName,
          studio_id: homeStudioId,
          staff_account: true,
        },
      });
      if (error || !res.user) {
        throw new Error(authErrorText(error?.message ?? "Не удалось создать пользователя"));
      }
      userId = res.user.id;
      created = true;
      const { error: profErr } = await admin
        .from("profiles")
        .upsert({ id: userId, studio_id: homeStudioId, full_name: fullName, email: data.email });
      // profiles.email у человека без почты — пусто (handle_new_user мог вписать служебный).
      if (profErr) {
        await admin.auth.admin.deleteUser(userId);
        throw new Error(profErr.message);
      }
    }

    try {
      // От имени вызывающего: база проверит, можно ли ему.
      await rpcAs(context.supabase, "access_user_save", {
        p_user: userId,
        p: {
          // Имя в найденной учётной записи не перетираем: его мог задать сам
          // человек в приложении (поправить — в карточке).
          ...(created ? { first_name: data.first_name, last_name: data.last_name } : {}),
          ...(data.phone ? { phone: data.phone } : {}),
          user_type: data.user_type ?? "",
          position_id: data.position_id ?? "",
          access_until: data.access_until ?? "",
          note: data.note ?? "",
        },
      });
      for (const a of data.assignments) {
        await rpcAs(context.supabase, "access_assignment_save", {
          p: {
            role_id: a.role_id,
            subject_type: "user",
            user_id: userId,
            scope_type: a.scope_type,
            scope_ids: a.scope_ids,
            valid_until: a.valid_until ?? null,
          },
        });
      }
      if (data.login && data.password) {
        await writeLogin(admin, userId, data.login, data.password, context.userId);
      }
      if (data.avatar_url) {
        const { error: avErr } = await admin
          .from("profiles")
          .update({ avatar_url: data.avatar_url })
          .eq("id", userId);
        if (avErr) throw new Error(avErr.message);
      }
      if (!created) {
        const { data: prof } = await admin
          .from("profiles")
          .select("full_name")
          .eq("id", userId)
          .maybeSingle();
        if (!(prof?.full_name as string | null | undefined)?.trim()) {
          await admin.from("profiles").update({ full_name: fullName }).eq("id", userId);
        }
      }
    } catch (e) {
      if (created) {
        // Каскад снимет и portal_users, и назначения.
        await admin.auth.admin.deleteUser(userId);
      } else {
        await admin
          .from("portal_users")
          .delete()
          .eq("user_id", userId)
          .eq("created_by", context.userId);
      }
      throw e;
    }
    return { ok: true, user_id: userId, existing: !created };
  });

/**
 * Почта (логин) и аватарка. Почту не меняем человеку, связанному с клубами
 * вне управления вызывающего (кроме администратора всех пользователей):
 * иначе можно было бы добавить себе чужого клиента, переписать ему почту и
 * войти под ним в приложение (как и раньше в «Доступах»).
 */
export const updatePortalUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    parseOrThrow(
      z
        .object({
          user_id: z.string().uuid(),
          /** null — не менять почту (у человека без почты — оставить без неё). */
          email: loginEmail.nullable(),
          avatar_url: avatarSchema,
        })
        .strict(),
      data,
    ),
  )
  .handler(async ({ context, data }) => {
    const isSelf = data.user_id === context.userId;
    if (!isSelf) {
      const can = await rpcAs<boolean>(context.supabase, "access_can_manage", {
        p_user: data.user_id,
      });
      if (!can) throw new Error("Нет прав менять этого пользователя");
    }
    const me = await rpcAs<AccessMe>(context.supabase, "access_me");
    const admin = getSupabaseAdmin();
    const { data: current, error: curErr } = await admin.auth.admin.getUserById(data.user_id);
    if (curErr || !current.user) throw new Error(curErr?.message ?? "Учётная запись не найдена");
    const emailChanged = !!data.email && (current.user.email ?? "").toLowerCase() !== data.email;

    if (emailChanged) {
      if (!me.manage_all) {
        const managed = me.manage_studio_ids;
        const notOwned = `(${managed.length ? managed.join(",") : "00000000-0000-0000-0000-000000000000"})`;
        const foreign = await Promise.all([
          admin
            .from("user_roles")
            .select("role")
            .eq("user_id", data.user_id)
            .not("studio_id", "in", notOwned)
            .limit(1),
          admin
            .from("clients")
            .select("id")
            .eq("user_id", data.user_id)
            .not("studio_id", "in", notOwned)
            .limit(1),
          admin
            .from("schedule_bookings")
            .select("id")
            .eq("user_id", data.user_id)
            .not("studio_id", "in", notOwned)
            .limit(1),
        ]);
        for (const { error } of foreign) if (error) throw new Error(error.message);
        if (foreign.some(({ data: rows }) => rows?.length)) {
          throw new Error(
            "Почту не изменить: человек есть в других клубах (сотрудник или клиент) — её меняет администратор всех пользователей",
          );
        }
      }
      const pattern = (data.email ?? "").replace(/[\\%_]/g, "\\$&");
      const { data: taken, error: takenErr } = await admin
        .from("profiles")
        .select("id")
        .ilike("email", pattern)
        .neq("id", data.user_id)
        .limit(1);
      if (takenErr) throw new Error(takenErr.message);
      if (taken?.length) throw new Error("Пользователь с такой почтой уже зарегистрирован");
      const { error: authErr } = await admin.auth.admin.updateUserById(data.user_id, {
        email: data.email ?? undefined,
        email_confirm: true,
      });
      if (authErr) throw new Error(authErrorText(authErr.message));
    }

    const { error } = await admin
      .from("profiles")
      .update({
        ...(emailChanged ? { email: data.email } : {}),
        avatar_url: data.avatar_url,
      })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Вход по логину и паролю Platrum: задать, сменить логин или пароль, убрать.
 * Сам человек или тот, кто им управляет (access_can_manage). login null —
 * убрать вход по логину; password пустой — оставить прежний пароль.
 */
export const setPortalUserLogin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    parseOrThrow(
      z
        .object({
          user_id: z.string().uuid(),
          login: platrumLogin.nullable(),
          password: platrumPassword.nullable(),
        })
        .strict(),
      data,
    ),
  )
  .handler(async ({ context, data }) => {
    if (data.user_id !== context.userId) {
      const can = await rpcAs<boolean>(context.supabase, "access_can_manage", {
        p_user: data.user_id,
      });
      if (!can) throw new Error("Нет прав менять этого пользователя");
    }
    const admin = getSupabaseAdmin();
    if (data.login === null) {
      const { error } = await admin.from("portal_logins").delete().eq("user_id", data.user_id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    await writeLogin(admin, data.user_id, data.login, data.password, context.userId);
    return { ok: true };
  });

/**
 * «Импорт паролей»: логины и пароли Platrum пачкой (до 50 человек за вызов).
 * Каждого проверяем так же, как в setPortalUserLogin (access_can_manage);
 * прежний логин и пароль человека заменяются. Ответ — итог по каждой строке.
 */
export const importPortalLogins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    parseOrThrow(
      z
        .object({
          rows: z
            .array(
              z
                .object({
                  user_id: z.string().uuid(),
                  login: platrumLogin,
                  password: platrumPassword,
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict(),
      data,
    ),
  )
  .handler(async ({ context, data }) => {
    const admin = getSupabaseAdmin();
    const results: { user_id: string; error: string | null }[] = [];
    for (const r of data.rows) {
      try {
        if (r.user_id !== context.userId) {
          const can = await rpcAs<boolean>(context.supabase, "access_can_manage", {
            p_user: r.user_id,
          });
          if (!can) throw new Error("Нет прав менять этого пользователя");
        }
        await writeLogin(admin, r.user_id, r.login, r.password, context.userId);
        results.push({ user_id: r.user_id, error: null });
      } catch (e) {
        results.push({ user_id: r.user_id, error: e instanceof Error ? e.message : "ошибка" });
      }
    }
    return { results };
  });

/**
 * Убрать из портала (RPC access_user_remove — роли и доступ снимаются) и,
 * если учётная запись больше ни к чему не привязана, удалить её. Клиент
 * приложения или сотрудник клуба вне модели остаётся со своим входом.
 */
export const removePortalUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ user_id: z.string().uuid() }).strict().parse(data))
  .handler(async ({ context, data }) => {
    if (data.user_id === context.userId) throw new Error("Нельзя удалить самого себя");
    await rpcAs(context.supabase, "access_user_remove", { p_user: data.user_id });
    const admin = getSupabaseAdmin();
    // Вход по логину Platrum — только в портал: уходит вместе с доступом.
    const { error: loginErr } = await admin
      .from("portal_logins")
      .delete()
      .eq("user_id", data.user_id);
    if (loginErr) throw new Error(loginErr.message);
    const links = await Promise.all([
      admin
        .from("user_roles")
        .select("role")
        .eq("user_id", data.user_id)
        .in("role", STAFF_ROLES)
        .limit(1),
      admin.from("member_profiles").select("user_id").eq("user_id", data.user_id).limit(1),
      admin.from("schedule_bookings").select("id").eq("user_id", data.user_id).limit(1),
      admin.from("clients").select("id").eq("user_id", data.user_id).limit(1),
    ]);
    for (const { error } of links) if (error) throw new Error(error.message);
    if (links.some(({ data: rows }) => rows?.length)) return { ok: true, accountKept: true };
    const { error } = await admin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true, accountKept: false };
  });
