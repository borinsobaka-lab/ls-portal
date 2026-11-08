import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { createSpeakRoom, kinescopeConfigured } from "./kinescope.server";
import type { CallStart } from "./calls";

/**
 * Видеозвонки чатов — серверная часть (db/migrations/2026-11-08_zzz_chat_calls.sql).
 * Начать звонок: проверки — в базе от имени человека (`chat_call_start`:
 * участник чата, не «Избранное»); новый звонок — сервер создаёт комнату
 * Kinescope Speak и сервис-ключом пишет её в звонок (`chat_call_set_room`,
 * только service_role) — у остальных звонит. Остальное (принять, отклонить,
 * выйти) браузер делает сам через RPC.
 */

/** Включены ли звонки на этом сервере (ключ Kinescope и сервис-ключ). */
export const getChatCallsConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ enabled: kinescopeConfigured() && hasSupabaseAdmin() }));

export const startChatCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ chatId: z.string().uuid() }).strict().parse(data))
  .handler(async ({ context, data }): Promise<CallStart> => {
    if (!kinescopeConfigured() || !hasSupabaseAdmin()) {
      throw new Error("chat_call_disabled");
    }
    const { data: started, error } = await context.supabase.rpc("chat_call_start", {
      p_chat: data.chatId,
    });
    if (error) throw new Error(error.message);
    const result = started as { call: CallStart["call"]; needs_room: boolean; link: string | null };
    if (!result.needs_room) return { call: result.call, link: result.link };

    const admin = getSupabaseAdmin();
    try {
      const room = await createSpeakRoom(`Звонок портала ${result.call.id.slice(0, 8)}`);
      const { data: call, error: setError } = await admin.rpc("chat_call_set_room", {
        p_call: result.call.id,
        p_room_id: room.id,
        p_link: room.link,
      });
      if (setError) throw new Error(setError.message);
      // null — звонок успели закончить, пока создавалась комната.
      if (!call) throw new Error("chat_call_ended");
      return { call: call as CallStart["call"], link: room.link };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await admin.rpc("chat_call_fail", { p_call: result.call.id, p_error: message });
      throw new Error(message.startsWith("chat_call_") ? message : "chat_call_room_failed");
    }
  });
