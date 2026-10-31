/**
 * «Контент» — публикация контент-плана в VK (их content.py: _vk_api,
 * _multipart_upload, _stable_random_id, publish_target, publish_due_posts,
 * verify_media_upload_access). Токен группы — an_secrets kind 'vk_content',
 * ref = id; технический токен пользователя VK для картинок — ref 'media'.
 * Картинки — закрытый бакет an-content.
 *
 * Задача «content_publish» (jobs.server.ts) — раз в минуту, внешняя:
 * выключена, пока её не включат (старый портал публикует те же посты).
 * ANALYTICS_VK_API_ORIGIN — другой адрес api.vk.com только для стенда.
 */
import { createHash } from "node:crypto";

import { CONTENT_TEXT, contentPostUrl, contentUploadType } from "../content/rules";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";
import { vkApiOrigin } from "./vk-inbox.server";

const USER_AGENT = "LadyStretch-ContentPortal/1.0";

/** Их _stable_random_id: sha256 «lady-content:<пост>:<группа>», 63 бита. */
export function contentRandomId(postId: number, communityId: number): string {
  const digest = createHash("sha256").update(`lady-content:${postId}:${communityId}`).digest();
  return (digest.readBigUInt64BE(0) & ((1n << 63n) - 1n)).toString();
}

/** Их ValueError: текст для человека. */
export class ContentError extends Error {}

export const contentTokenRef = (id: number) => ({
  kind: "vk_content",
  ref: String(id),
  name: "token",
});
const MEDIA_TOKEN = { kind: "vk_content", ref: "media", name: "user_token" };

/** Их str(error) urllib для сетевых ошибок. */
const netText = (e: unknown, status?: number, statusText?: string) =>
  status !== undefined
    ? `HTTP Error ${status}: ${statusText ?? ""}`.trim()
    : (e as Error)?.name === "TimeoutError"
      ? "timed out"
      : `<urlopen error ${(e as Error)?.message ?? "connection failed"}>`;

/** Их _vk_api: POST, таймаут 35 с; ошибки — их тексты. */
async function vkApi(method: string, params: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${vkApiOrigin()}/method/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ ...params, v: "5.199" }).toString(),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (e) {
    throw new ContentError(CONTENT_TEXT.apiDown(netText(e)));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ContentError(CONTENT_TEXT.apiDown(netText(null, res.status, res.statusText)));
  }
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch (e) {
    throw new ContentError(CONTENT_TEXT.apiDown((e as Error).message));
  }
  const err = result?.error as Record<string, unknown> | undefined;
  if (err) throw new ContentError(CONTENT_TEXT.apiError(method, err.error_msg, err.error_code));
  if (!("response" in result)) throw new ContentError(CONTENT_TEXT.apiIncomplete);
  return result.response;
}

/** Их _multipart_upload: поле photo, имя файла — исходное, таймаут 60 с. */
async function multipartUpload(url: string, filename: string, mime: string, data: Uint8Array) {
  const boundary =
    "----LadyStretchContent" +
    createHash("sha256")
      .update(Buffer.concat([Buffer.from(filename, "utf8"), Buffer.from(data.subarray(0, 64))]))
      .digest("hex")
      .slice(0, 24);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n`, "utf8"),
    Buffer.from(`Content-Type: ${contentUploadType(filename, mime)}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "User-Agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ContentError(CONTENT_TEXT.uploadFailed(netText(e)));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ContentError(CONTENT_TEXT.uploadFailed(netText(null, res.status, res.statusText)));
  }
  try {
    return JSON.parse(await res.text()) as Record<string, unknown>;
  } catch (e) {
    throw new ContentError(CONTENT_TEXT.uploadFailed((e as Error).message));
  }
}

async function mediaUploadToken(): Promise<string> {
  let token: string | null;
  try {
    token = await readSecret(MEDIA_TOKEN);
  } catch {
    throw new ContentError(CONTENT_TEXT.mediaTokenBroken);
  }
  if (!token) throw new ContentError(CONTENT_TEXT.mediaTokenMissing);
  return token;
}

/** Их verify_media_upload_access: только адрес загрузки фото, пост не создаётся. */
export async function contentVerifyMediaUpload(communityId: number): Promise<string> {
  const { data, error } = await db()
    .from("an_content_communities")
    .select("display_name, vk_community_id")
    .eq("id", communityId)
    .limit(1);
  if (error) throw new Error(error.message);
  const c = (data ?? [])[0] as { display_name: string; vk_community_id: string } | undefined;
  if (!c) throw new ContentError("Тестовая группа не найдена.");
  await vkApi("photos.getWallUploadServer", {
    group_id: c.vk_community_id,
    access_token: await mediaUploadToken(),
  });
  return c.display_name;
}

type Target = {
  post_id: number;
  community_id: number;
  rendered_body: string;
  scheduled_at: number | null;
  status: string;
  publication_status: string;
  vk_post_url: string;
  vk_community_id: string;
  display_name: string;
  media: { path: string; name: string; mime: string }[];
};

/**
 * Их publish_target: картинки — техническим токеном пользователя
 * (photos.getWallUploadServer → файл → photos.saveWallPhoto), пост — токеном
 * группы (wall.post от имени группы, постоянный random_id). Итог — в базу.
 */
export async function contentPublishTarget(
  postId: number,
  communityId: number,
  force = false,
): Promise<{ status: string; url: string; message: string }> {
  const target = (await must(
    db().rpc("an_content_target", { p_post: postId, p_community: communityId }),
  )) as Target | null;
  if (!target) throw new ContentError("Публикация для этой группы не найдена.");
  if (target.publication_status === "published")
    return { status: "published", url: target.vk_post_url, message: "Этот пост уже опубликован." };
  if (target.status !== "scheduled")
    throw new ContentError("Эта публикация отменена или ещё не готова.");
  if (!force && Number(target.scheduled_at ?? 0) > Date.now() / 1000)
    throw new ContentError("Время публикации ещё не наступило.");
  const groupToken = await readSecret(contentTokenRef(communityId)).catch(() => null);
  if (!groupToken) throw new ContentError("У группы не сохранён токен сообщества VK.");
  try {
    const groupId = target.vk_community_id;
    const attachments: string[] = [];
    const uploadToken = target.media.length ? await mediaUploadToken() : "";
    for (const media of target.media) {
      const { data: blob } = await db().storage.from("an-content").download(media.path);
      const raw = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
      if (!raw.length) throw new ContentError(`Не найден файл изображения «${media.name}».`);
      const server = (await vkApi("photos.getWallUploadServer", {
        group_id: groupId,
        access_token: uploadToken,
      })) as Record<string, unknown>;
      const uploaded = await multipartUpload(
        String(server?.upload_url ?? ""),
        media.name,
        media.mime,
        raw,
      );
      if (!("photo" in uploaded) || !("server" in uploaded) || !("hash" in uploaded))
        throw new ContentError(CONTENT_TEXT.photoNotSaved);
      const saved = await vkApi("photos.saveWallPhoto", {
        group_id: groupId,
        photo: String(uploaded.photo),
        server: String(uploaded.server),
        hash: String(uploaded.hash),
        access_token: uploadToken,
      });
      const photo =
        Array.isArray(saved) && saved.length ? (saved[0] as Record<string, unknown>) : null;
      if (!photo || !("owner_id" in photo) || !("id" in photo))
        throw new ContentError(CONTENT_TEXT.photoNotSaved);
      attachments.push(`photo${String(photo.owner_id)}_${String(photo.id)}`);
    }
    const result = await vkApi("wall.post", {
      owner_id: "-" + groupId,
      from_group: "1",
      message: target.rendered_body,
      attachments: attachments.join(","),
      random_id: contentRandomId(postId, communityId),
      access_token: groupToken,
    });
    const vkPostId =
      result && typeof result === "object" && !Array.isArray(result)
        ? String((result as Record<string, unknown>).post_id ?? "")
        : String(result);
    if (!vkPostId || !/^\d+$/.test(vkPostId))
      throw new ContentError("VK не вернул ID опубликованного поста.");
    const url = contentPostUrl(groupId, vkPostId);
    await must(
      db().rpc("an_content_target_result", {
        p_post: postId,
        p_community: communityId,
        p_ok: true,
        p_vk_post_id: vkPostId,
        p_url: url,
        p_error: "",
      }),
    );
    return { status: "published", url, message: `Опубликовано в «${target.display_name}».` };
  } catch (e) {
    const text = e instanceof ContentError ? e.message : String((e as Error)?.message ?? e);
    await must(
      db().rpc("an_content_target_result", {
        p_post: postId,
        p_community: communityId,
        p_ok: false,
        p_vk_post_id: "",
        p_url: "",
        p_error: text.slice(0, 1000),
      }),
    );
    throw e instanceof ContentError ? e : new ContentError(text);
  }
}

/** Задача «content_publish» — их publish_due_posts. */
export async function contentPublishDue(): Promise<JobResult> {
  const due = (await must(db().rpc("an_content_due"))) as {
    post_id: number;
    community_id: number;
  }[];
  let published = 0;
  let errors = 0;
  for (const t of due) {
    try {
      await contentPublishTarget(Number(t.post_id), Number(t.community_id));
      published += 1;
    } catch {
      errors += 1;
    }
  }
  return {
    status: errors ? (published ? "partial" : "error") : "success",
    message: `Опубликовано: ${published}, с ошибкой: ${errors}`,
    details: { published, errors },
  };
}
