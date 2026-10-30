import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { saveSecret } from "./server/secrets.server";
import {
  evaluateBudgetAlerts,
  TG_GATEWAY_SECRET,
  TG_TOKEN,
  tgChatCandidates,
  tgSendMessage,
  tgSettingsRow,
} from "./server/vk-budget.server";
import { TG_TEST_TEXT, tgChatIdOk, tgSettingsCheck, type TgChat } from "./vk/budget";
import type { VkBudgetOverview } from "./vk/data";

/**
 * VK Ads, «Контроль бюджетов» (их vk_ads_alerts_page и формы
 * /admin/vk-ads/alerts/*): обзор с пересчётом предупреждений, Telegram-бот,
 * тестовое сообщение, привязка чатов партнёров. Только администратору
 * аналитики (an_me от имени вызывающего); журнал — их события.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

async function audit(userId: string, event: string, details = "") {
  await getSupabaseAdmin().rpc("an_audit_add", {
    _user_id: userId,
    _event: event,
    _details: details,
  });
}

async function tgSettingsUpdate(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("an_tg_settings")
    .upsert({ id: true, ...patch }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

export type VkBudgetPage = VkBudgetOverview & { chats: TgChat[]; chat_error: string };

/**
 * Их страница: сначала пересчёт предупреждений, затем данные; чаты бота —
 * только если токен сохранён (ошибка Telegram — текстом на странице).
 */
export const budgetOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<VkBudgetPage> => {
    await requireAnAdmin(context.supabase);
    await evaluateBudgetAlerts();
    const { data, error } = await context.supabase.rpc("an_vk_budget_overview");
    if (error) throw new Error(error.message);
    const overview = data as VkBudgetOverview;
    let chats: TgChat[] = [];
    let chatError = "";
    if (overview.telegram.token_saved) {
      try {
        chats = await tgChatCandidates();
      } catch (e) {
        chatError = (e as Error).message;
      }
    }
    return { ...overview, chats, chat_error: chatError };
  });

/** Их save_telegram_settings: пустой токен, секрет или адрес шлюза — прежние. */
export const saveTelegramSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        token: z.string().max(500),
        botUsername: z.string().max(500),
        testChatId: z.string().max(100),
        gatewayUrl: z.string().max(500),
        gatewaySecret: z.string().max(500),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const v = tgSettingsCheck(data);
    if (v.token) await saveSecret(TG_TOKEN, v.token, context.userId);
    if (v.secret) await saveSecret(TG_GATEWAY_SECRET, v.secret, context.userId);
    const gateway = v.gateway || (await tgSettingsRow()).gateway_url;
    await tgSettingsUpdate({
      bot_username: v.username,
      test_chat_id: v.chatId,
      gateway_url: gateway,
      updated_at: new Date().toISOString(),
    });
    await audit(context.userId, "vk_ads_telegram_saved");
    return { message: "Telegram-настройки сохранены." };
  });

/** Их send_telegram_test: итог — в «последней проверке» у бота. */
export const sendTelegramTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ chatId: z.string().max(100) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const chatId = data.chatId.trim();
    if (!tgChatIdOk(chatId)) {
      throw new Error("Выберите или укажите корректный ID тестового чата.");
    }
    const now = new Date().toISOString();
    try {
      await tgSendMessage(chatId, TG_TEST_TEXT);
    } catch (e) {
      await tgSettingsUpdate({
        last_test_at: now,
        last_test_status: `Ошибка: ${(e as Error).message.slice(0, 180)}`,
      });
      throw e;
    }
    await tgSettingsUpdate({
      test_chat_id: chatId,
      last_test_at: now,
      last_test_status: "Тестовое сообщение отправлено",
    });
    await audit(context.userId, "vk_ads_telegram_test");
    return { message: "Тестовое сообщение отправлено в Telegram." };
  });

/** Их save_partner_notification_channel: чат — только из тех, что писали боту. */
export const bindPartnerChannel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ partnerName: z.string().max(500), chatId: z.string().max(100) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const chat = (await tgChatCandidates()).find((c) => c.id === data.chatId);
    if (!chat) {
      throw new Error(
        "Выбранный чат не найден. Напишите в него новое сообщение и обновите страницу.",
      );
    }
    const partner = data.partnerName.trim();
    const chatId = data.chatId.trim();
    if (!partner) throw new Error("Выберите партнёра.");
    if (!tgChatIdOk(chatId)) throw new Error("Выберите корректный Telegram-чат.");
    const { error } = await getSupabaseAdmin()
      .from("an_vk_partner_channels")
      .upsert(
        {
          partner_name: partner,
          chat_id: chatId,
          chat_title: chat.title.trim().slice(0, 200),
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "partner_name" },
      );
    if (error) throw new Error(error.message);
    await audit(context.userId, "vk_ads_partner_notification_channel_saved", data.partnerName);
    return { message: "Чат партнёра привязан." };
  });
