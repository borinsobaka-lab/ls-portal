import { queryOptions } from "@tanstack/react-query";

import { msg } from "@/i18n";
import { untypedDb } from "@/lib/untyped-db";

/**
 * Заявки администратору из «Расписания» пакетного приложения (решение
 * владельца 2026-10-15): на персональные занятия (цели и комментарий) и на
 * диагностику тела. Пишет только RPC create_client_request, клиент читает
 * свои; на портале — «Обратная связь» → «Заявки». Схема —
 * db/migrations/2026-10-15_zz_diagnostics_client_requests.sql.
 */

export type RequestKind = "personal" | "diagnostic";

/** Цели — как в анкете пакетного приложения (formats/packages/onboarding.tsx). */
export type Goal = "flexibility" | "stress_relief" | "body_shape" | "other";

export const GOALS: { v: Goal; label: string }[] = [
  { v: "flexibility", label: msg("Стать гибче") },
  { v: "stress_relief", label: msg("Снять напряжение и стресс") },
  { v: "body_shape", label: msg("Подтянуть фигуру") },
  { v: "other", label: msg("Другое") },
];

/** Неотработанные заявки клиента: вид → когда отправлена. */
export type OpenRequests = Partial<Record<RequestKind, string>>;

export function myOpenRequestsQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["my-client-requests", userId],
    queryFn: async (): Promise<OpenRequests> => {
      // Явный фильтр по user_id: сотруднику RLS отдаёт заявки его студии.
      const { data, error } = await untypedDb
        .from("client_requests")
        .select("kind, created_at")
        .eq("user_id", userId)
        .is("processed_at", null)
        .order("created_at", { ascending: true });
      // Таблицы ещё нет (приложение вышло раньше миграции) — как «заявок нет».
      if (error) return {};
      const out: OpenRequests = {};
      for (const r of (data as { kind: RequestKind; created_at: string }[] | null) ?? [])
        out[r.kind] = r.created_at;
      return out;
    },
    enabled: !!userId,
  });
}

export type MyGoals = { primary_goal: string | null; goal_other: string | null };

/** Цель из анкеты — подставляется в «Ваша цель». */
export function myGoalsQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["my-goals", userId],
    queryFn: async (): Promise<MyGoals | null> => {
      const { data, error } = await untypedDb
        .from("member_profiles")
        .select("primary_goal, goal_other")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return (data as MyGoals | null) ?? null;
    },
    enabled: !!userId,
  });
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "pending"; createdAt: string | null }
  | { ok: false; reason: string };

export async function sendClientRequest(input: {
  kind: RequestKind;
  goals?: Goal[];
  goalOther?: string;
  comment?: string;
}): Promise<SendResult> {
  const { data, error } = await untypedDb.rpc("create_client_request", {
    p_kind: input.kind,
    p_goals: input.goals ?? [],
    p_goal_other: input.goalOther?.trim() || null,
    p_comment: input.comment?.trim() || null,
  });
  if (error) return { ok: false, reason: error.message };
  const res = data as { ok?: boolean; reason?: string; created_at?: string } | null;
  if (res?.ok) return { ok: true };
  if (res?.reason === "pending")
    return { ok: false, reason: "pending", createdAt: res.created_at ?? null };
  return { ok: false, reason: res?.reason ?? "unknown" };
}
