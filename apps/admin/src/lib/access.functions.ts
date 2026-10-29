import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  authErrorText,
  createStaffAccount,
  findProfileIdByEmail,
  homeStudioFor,
  isPortalUser,
} from "@/lib/access/accounts.server";
import { accessErrorText, isPlaceholderEmail } from "@/lib/access/logic";
import type { AccessMe } from "@/lib/access/types";
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

    let userId = data.email ? await findProfileIdByEmail(admin, data.email) : null;
    let created = false;

    if (userId) {
      if (await isPortalUser(admin, userId)) {
        throw new Error(`already_in_portal:${userId}`);
      }
    } else {
      // Клуб профиля: первый клуб первой роли, иначе клуб того, кто добавляет.
      const first = data.assignments.find((a) => a.scope_type === "studios" && a.scope_ids.length);
      const studioId = await homeStudioFor(admin, first?.scope_ids[0] ?? null, context.userId);
      userId = await createStaffAccount(admin, {
        email: data.email,
        first_name: data.first_name,
        last_name: data.last_name,
        studioId,
      });
      created = true;
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
