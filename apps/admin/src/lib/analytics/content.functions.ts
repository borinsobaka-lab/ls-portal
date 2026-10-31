import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { CONTENT_TEXT } from "./content/rules";
import { encryptSecret } from "./server/secrets.server";
import {
  ContentError,
  contentPublishTarget,
  contentVerifyMediaUpload,
} from "./server/vk-content.server";

/**
 * «Контент»: действия, которым нужен сервер — токены шифрует сервер
 * (ANALYTICS_SECRETS_KEY), проверку загрузки и «Опубликовать сейчас»
 * выполняет он же. Только администратору аналитики (RPC проверяют сами).
 */

async function requireAnAdmin(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("an_me");
  if (error) throw new Error(error.message);
  if (!(data as { admin?: boolean } | null)?.admin) {
    throw new Error("Доступно только администратору аналитики");
  }
}

const audit = (userId: string, event: string, details: string) =>
  getSupabaseAdmin().rpc("an_audit_add", { _user_id: userId, _event: event, _details: details });

/** Их «Сохранить группу»: тот же ID VK — обновление, пустой токен — прежний. */
export const saveContentCommunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        brand: z.string().max(100),
        displayName: z.string().max(1000),
        city: z.string().max(1000),
        vkCommunity: z.string().max(500),
        timezone: z.string().max(100),
        trialLink: z.string().max(2000),
        scheduleLink: z.string().max(2000),
        token: z.string().max(2000),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const token = data.token.trim();
    const { error } = await context.supabase.rpc("an_content_community_save", {
      p_brand: data.brand,
      p_display_name: data.displayName,
      p_city: data.city,
      p_vk_community_id: data.vkCommunity,
      p_timezone: data.timezone,
      p_trial_link: data.trialLink,
      p_schedule_link: data.scheduleLink,
      p_token_cipher: token ? encryptSecret(token) : "",
    });
    if (error) throw new Error(error.message);
    return { message: "Группа и настройки сохранены." };
  });

/** Их «Сохранить и проверить подключение» / «Заменить токен». */
export const saveContentMediaToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ token: z.string().max(2000) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    const token = data.token.trim();
    if (!token) throw new Error(CONTENT_TEXT.mediaTokenEmpty);
    const { error } = await context.supabase.rpc("an_content_media_token_save", {
      p_cipher: encryptSecret(token),
    });
    if (error) throw new Error(error.message);
    return {
      message: "Технический токен сохранён. Выберите тестовую группу и выполните проверку.",
    };
  });

/** Их «Проверить загрузку картинки»: только адрес загрузки, пост не создаётся. */
export const testContentMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ communityId: z.number().int() }).strict().parse(data))
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    if (data.communityId <= 0) throw new Error(CONTENT_TEXT.chooseGroup);
    try {
      const name = await contentVerifyMediaUpload(data.communityId);
      await audit(context.userId, "content_media_upload_verified", name);
      return {
        message: `Права на загрузку картинок в «${name}» подтверждены. Теперь можно публиковать тестовый пост.`,
      };
    } catch (e) {
      throw new Error(e instanceof ContentError ? e.message : (e as Error).message);
    }
  });

/** Их «Опубликовать сейчас» для одной группы поста. */
export const publishContentNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ postId: z.number().int().positive(), communityId: z.number().int().positive() })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    await requireAnAdmin(context.supabase);
    try {
      const outcome = await contentPublishTarget(data.postId, data.communityId, true);
      await audit(
        context.userId,
        "content_post_published_now",
        `${data.postId}:${data.communityId}`,
      );
      return outcome;
    } catch (e) {
      throw new Error(e instanceof ContentError ? e.message : (e as Error).message);
    }
  });
