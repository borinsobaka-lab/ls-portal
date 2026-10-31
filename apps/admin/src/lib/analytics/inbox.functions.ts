import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { INBOX_TEXT, InboxError, inboxDisplayName, inboxSecretValid } from "./inbox/rules";
import { encryptSecret } from "./server/secrets.server";
import { inboxNewSecret, inboxSecretHash, resolveVkCommunity } from "./server/vk-inbox.server";

/**
 * «Диалоги VK» → «Подключения»: действия, которым нужен сервер. Токен
 * сообщества шифрует сервер (ANALYTICS_SECRETS_KEY), секрет Callback он же
 * придумывает и хранит только SHA-256; RPC an_inbox_* вызываются от имени
 * вызывающего и сами проверяют администратора аналитики, тексты и журнал.
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

/** Их POST /admin/vk-inbox/communities: группа, затем URL и секрет — один раз. */
export const registerInboxCommunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        brand: z.string().max(100),
        city: z.string().max(1000),
        displayName: z.string().max(1000),
        vkCommunity: z.string().max(500),
        confirmationCode: z.string().max(500),
        token: z.string().max(2000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const token = data.token.trim();
    const code = data.confirmationCode.trim();
    const city = data.city.trim();
    let name = data.displayName.trim();
    if (!name || !city || !token || !code) throw new Error(INBOX_TEXT.requiredFields);
    let vk: { id: number; name: string };
    try {
      vk = await resolveVkCommunity(data.vkCommunity, token);
    } catch (e) {
      throw new Error(e instanceof InboxError ? e.message : INBOX_TEXT.resolveNetwork);
    }
    name = inboxDisplayName(name, vk.name);
    const secret = inboxNewSecret();
    const { data: id, error } = await context.supabase.rpc("an_inbox_community_register", {
      p_vk_community_id: vk.id,
      p_display_name: name,
      p_brand: data.brand.trim(),
      p_city: city,
      p_confirmation_code: code,
      p_secret_hash: inboxSecretHash(secret),
      p_token_cipher: encryptSecret(token),
    });
    if (error) throw new Error(error.message);
    return {
      id: Number(id),
      secret,
      displayName: name,
      message: `Подключение «${name}» создано. Настройте Callback API в VK.`,
    };
  });

/** Их «Синхр.»: текущий секрет Callback из VK — в базу только его SHA-256. */
export const syncInboxSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ id: z.number().int().positive(), secret: z.string().max(2000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    if (!inboxSecretValid(data.secret)) throw new Error(INBOX_TEXT.secretLength);
    const { error } = await context.supabase.rpc("an_inbox_secret_save", {
      p_id: data.id,
      p_secret_hash: inboxSecretHash(data.secret.trim()),
    });
    if (error) throw new Error(error.message);
    return { message: "Секрет Callback API синхронизирован. Отправьте новое тестовое сообщение." };
  });
