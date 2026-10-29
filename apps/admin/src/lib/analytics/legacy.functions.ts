import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  createStaffAccount,
  findProfileIdByEmail,
  homeStudioFor,
  isPortalUser,
} from "@/lib/access/accounts.server";
import { accessErrorText, isPlaceholderEmail, splitFullName } from "@/lib/access/logic";
import type { AccessMe } from "@/lib/access/types";
import {
  LEGACY_STARTER_ROLES,
  legacyEmail,
  legacyImportProblem,
  legacyRights,
  legacyRolePlan,
  legacyUserType,
  type LegacyPerson,
} from "./legacy-people";

/**
 * Перенос человека со старого портала аналитики (ANALYTICS_PLAN.md, §10) —
 * один раз, дальше доступ в двух порталах ведётся независимо. Только
 * суперадминистратор. Учётная запись — как в «Пользователях»
 * (createPortalUser): есть с этой почтой — к ней, нет — новая (вход по коду
 * из письма). Данные, роли и связь пишут RPC от имени вызывающего
 * (access_user_save, access_assignment_save / access_personal_save,
 * an_legacy_link): база проверяет права.
 */

async function rpcAs<T>(supabase: SupabaseClient, fn: string, args?: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(accessErrorText(error.message, error.details));
  return data as T;
}

const NOTE = "Перенесено со старого портала аналитики";

/** Должность по названию: есть — она, нет — новая (как у них, строкой). */
async function positionId(
  admin: SupabaseClient,
  supabase: SupabaseClient,
  name: string,
): Promise<string | null> {
  const title = name.trim().replace(/\s+/g, " ");
  if (!title) return null;
  const find = async () => {
    const { data, error } = await admin.from("org_positions").select("id, name");
    if (error) throw new Error(error.message);
    return (data ?? []).find((p) => (p.name as string).trim().toLowerCase() === title.toLowerCase())
      ?.id as string | undefined;
  };
  const found = await find();
  if (found) return found;
  try {
    return await rpcAs<string>(supabase, "org_position_save", { p: { name: title.slice(0, 120) } });
  } catch (e) {
    const again = await find();
    if (again) return again;
    throw e;
  }
}

/** Права стартовых ролей «Аналитики» (system_key → ключи прав) и их id. */
async function starterRoles(admin: SupabaseClient) {
  const { data, error } = await admin
    .from("access_roles")
    .select("id, system_key, access_role_permissions(perm_key)")
    .in("system_key", [...LEGACY_STARTER_ROLES]);
  if (error) throw new Error(error.message);
  const rights: Record<string, string[]> = {};
  const ids: Record<string, string> = {};
  for (const r of data ?? []) {
    const key = r.system_key as string;
    ids[key] = r.id as string;
    rights[key] = ((r.access_role_permissions ?? []) as { perm_key: string }[]).map(
      (p) => p.perm_key,
    );
  }
  return { rights, ids };
}

export type LegacyImportResult = {
  user_id: string;
  /** Учётная запись уже была (человек портала или клиент приложения). */
  existing: boolean;
  /** Стартовая роль (system_key) или личные права. */
  role: string | "personal";
};

export const importLegacyPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        legacy_id: z.number().int().positive(),
        /** Почта вместо логина (у кого логин — не почта). */
        email: z
          .string()
          .trim()
          .toLowerCase()
          .email("Неверный адрес почты")
          .refine((v) => !isPlaceholderEmail(v), "Неверный адрес почты")
          .nullable()
          .optional(),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }): Promise<LegacyImportResult> => {
    const me = await rpcAs<AccessMe>(context.supabase, "access_me");
    if (!me.rights.includes("portal.admin")) {
      throw new Error("Переносит людей со старого портала суперадминистратор");
    }
    const people = await rpcAs<LegacyPerson[]>(context.supabase, "an_legacy_people");
    const person = people.find((p) => p.id === data.legacy_id);
    if (!person) throw new Error("Человек старого портала не найден");
    const email = data.email ?? legacyEmail(person.login);
    const problem = legacyImportProblem(person, email);
    if (problem) throw new Error(problem);

    const admin = getSupabaseAdmin();
    const { rights: starters, ids: starterIds } = await starterRoles(admin);
    const plan = legacyRolePlan(legacyRights(person), starters);
    if (plan.kind === "starter" && !starterIds[plan.systemKey]) {
      throw new Error("Нет стартовой роли «Аналитики» — выполнена ли миграция?");
    }
    const position = await positionId(admin, context.supabase, person.position);

    let userId = await findProfileIdByEmail(admin, email!);
    const existing = userId !== null;
    const inPortal = userId ? await isPortalUser(admin, userId) : false;
    let created = false;
    if (!userId) {
      const name = splitFullName(person.full_name);
      userId = await createStaffAccount(admin, {
        email,
        first_name: name.first_name,
        last_name: name.last_name,
        studioId: await homeStudioFor(admin, null, context.userId),
      });
      created = true;
    }

    try {
      if (!inPortal) {
        const name = splitFullName(person.full_name);
        await rpcAs(context.supabase, "access_user_save", {
          p_user: userId,
          p: {
            ...(created ? name : {}),
            user_type: legacyUserType(person),
            position_id: position ?? "",
            note: NOTE,
          },
        });
      }
      if (plan.kind === "starter") {
        const roleId = starterIds[plan.systemKey];
        const { data: has, error } = await admin
          .from("access_assignments")
          .select("id")
          .eq("role_id", roleId)
          .eq("subject_type", "user")
          .eq("user_id", userId)
          .limit(1);
        if (error) throw new Error(error.message);
        if (!has?.length) {
          await rpcAs(context.supabase, "access_assignment_save", {
            p: {
              role_id: roleId,
              subject_type: "user",
              user_id: userId,
              scope_type: "all",
              scope_ids: [],
              note: NOTE,
            },
          });
        }
      } else {
        // Личные права заменяются целиком: к уже выданным добавляем свои.
        const { data: own, error } = await admin
          .from("access_roles")
          .select("access_role_permissions(perm_key, target_id, level)")
          .eq("personal_user_id", userId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const before = (own?.access_role_permissions ?? []) as {
          perm_key: string;
          target_id: string | null;
          level: string;
        }[];
        const keys = new Set(before.filter((p) => !p.target_id).map((p) => p.perm_key));
        const perms = [
          ...before,
          ...plan.rights
            .filter((k) => !keys.has(k))
            .map((k) => ({ perm_key: k, target_id: null, level: "on" })),
        ];
        await rpcAs(context.supabase, "access_personal_save", { p_user: userId, p_perms: perms });
      }
      await rpcAs(context.supabase, "an_legacy_link", {
        p_legacy_id: person.id,
        p_user: userId,
      });
    } catch (e) {
      if (created) {
        // Каскад снимет и portal_users, и назначения.
        await admin.auth.admin.deleteUser(userId);
      } else if (!inPortal) {
        await admin
          .from("portal_users")
          .delete()
          .eq("user_id", userId)
          .eq("created_by", context.userId);
      }
      throw e;
    }
    return {
      user_id: userId,
      existing,
      role: plan.kind === "starter" ? plan.systemKey : "personal",
    };
  });
