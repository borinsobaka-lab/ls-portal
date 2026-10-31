/**
 * «Диалоги VK» — сервер (их vk_inbox.py: _vk_request, resolve_vk_community,
 * handle_callback, refresh_missing_customer_profiles,
 * refresh_first_message_dates). Токен сообщества — an_secrets (kind
 * 'vk_inbox', ref = id подключения, name 'token'), секрет Callback — только
 * SHA-256 в подключении. Пишет сервисным ключом через RPC an_inbox_*.
 *
 * Задачи (jobs.server.ts): «inbox_profiles» — имена и аватарки клиентов
 * (users.get, до 500 диалогов; у них — при открытии диалогов, у нас — ещё и
 * раз в 10 минут), «inbox_first_messages» — даты самых ранних сообщений
 * переписки (messages.getHistory по одному сообщению, пауза 0,4 с; у них —
 * постоянный поток, у нас — раз в минуту до 45 секунд). Обе только читают VK.
 *
 * ANALYTICS_VK_API_ORIGIN — другой адрес api.vk.com только для стенда.
 */
import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  INBOX_SEND_TEXT,
  photoAttachment,
  replyText,
  savedPhoto,
  sentMessageId,
  uploadHttpError,
  uploadResult,
  uploadUrlAllowed,
  uploadedPhotoParams,
  validateReplyImages,
  type InboxImage,
  INBOX_FIRST_BATCH,
  INBOX_FIRST_GROUP_RETRY_MS,
  INBOX_FIRST_PAUSE_MS,
  INBOX_PROFILES_BATCH,
  INBOX_TEXT,
  InboxError,
  VK_API_VERSION,
  firstHistoryTimestamp,
  inboxCallbackParse,
  inboxProfileUpdates,
  vkCommunityRef,
  vkGroupFromResponse,
  vkMethodResponse,
  type InboxProfileCandidate,
} from "../inbox/rules";
import type { JobResult } from "./jobs.server";
import { readSecret } from "./secrets.server";
import { db, must } from "./vk-ads.server";

const USER_AGENT = "LadyStretch-VKInbox/1.0";

export const vkApiOrigin = () =>
  process.env.ANALYTICS_VK_API_ORIGIN?.replace(/\/+$/, "") || "https://api.vk.com";

export const inboxTokenRef = (id: number) => ({ kind: "vk_inbox", ref: String(id), name: "token" });

/** Их _hash_secret. */
export const inboxSecretHash = (secret: string) =>
  createHash("sha256").update(secret, "utf8").digest("hex");

/** Их callback_secret: secrets.token_hex(24) — латиница и цифры. */
export const inboxNewSecret = () => randomBytes(24).toString("hex");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST https://api.vk.com/method/<метод> (форма); сеть, HTTP и не JSON — null. */
async function vkPost(
  method: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: true; payload: unknown } | { ok: false }> {
  try {
    const res = await fetch(`${vkApiOrigin()}/method/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Их urlopen: ответ не 2xx — HTTPError.
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    return { ok: true, payload: JSON.parse(await res.text()) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Их _vk_request (таймаут 25 с): ответ VK или InboxError с их текстом. */
export async function vkMethod(method: string, params: Record<string, string>): Promise<unknown> {
  const r = await vkPost(method, { ...params, v: VK_API_VERSION }, 25_000);
  if (!r.ok) throw new InboxError(INBOX_TEXT.vkNetwork);
  return vkMethodResponse(r.payload);
}

/** Их resolve_vk_community: ID группы и её название из VK (по короткому адресу). */
export async function resolveVkCommunity(
  value: string,
  token: string,
): Promise<{ id: number; name: string }> {
  const ref = vkCommunityRef(value, token);
  if ("id" in ref) return { id: ref.id, name: "" };
  const r = await vkPost(
    "groups.getById",
    { group_id: ref.shortName, access_token: token.trim(), v: VK_API_VERSION },
    20_000,
  );
  if (!r.ok) throw new InboxError(INBOX_TEXT.resolveNetwork);
  return vkGroupFromResponse(r.payload);
}

export type CallbackReply = { status: number; text: string };

/**
 * Их /api/vk-inbox/callback/<id> + handle_callback: строка подтверждения
 * или 'ok'; ошибка события — 'error' 400 (причина — в журнал сервера, без
 * содержимого события), база недоступна — 'error' 503.
 */
export async function inboxHandleCallback(id: number, payload: unknown): Promise<CallbackReply> {
  const reject = (reason: string, status = 400): CallbackReply => {
    console.warn(`[inbox] событие VK для подключения ${id} отклонено: ${reason}`);
    return { status, text: "error" };
  };
  let parsed;
  try {
    parsed = inboxCallbackParse(payload, Date.now() / 1000);
  } catch (e) {
    return reject(e instanceof InboxError ? e.message : INBOX_TEXT.badEvent);
  }
  const { data, error } = await db().rpc("an_inbox_callback", {
    p_id: id,
    p_type: parsed.type,
    p_secret_hash: parsed.secret ? inboxSecretHash(parsed.secret) : "",
    p_message: parsed.message,
  });
  if (error) {
    // Ошибка самой функции (подключение, секрет, данные события) — 400,
    // нет связи с базой — 503, как их InboxUnavailable.
    const db = !error.code || /fetch|network|timeout/i.test(error.message);
    return reject(error.message.slice(0, 200), db ? 503 : 400);
  }
  return { status: 200, text: String(data ?? "ok") };
}

/** Их refresh_missing_customer_profiles: имена и аватарки из users.get. */
export async function inboxRefreshProfiles(limit = INBOX_PROFILES_BATCH): Promise<JobResult> {
  const candidates = (await must(
    db().rpc("an_inbox_profiles_pending", { p_limit: limit }),
  )) as InboxProfileCandidate[];
  const byCommunity = new Map<number, InboxProfileCandidate[]>();
  for (const c of candidates) {
    const list = byCommunity.get(c.community_id) ?? [];
    list.push(c);
    byCommunity.set(c.community_id, list);
  }
  const updates: { id: number; name: string; avatar: string }[] = [];
  let failed = 0;
  for (const [community, items] of byCommunity) {
    let token: string | null;
    try {
      token = await readSecret(inboxTokenRef(community));
    } catch {
      token = null;
    }
    if (!token) continue;
    for (let i = 0; i < items.length; i += INBOX_PROFILES_BATCH) {
      const batch = items.slice(i, i + INBOX_PROFILES_BATCH);
      let response: unknown;
      try {
        response = await vkMethod("users.get", {
          user_ids: batch.map((b) => String(b.customer_vk_id)).join(","),
          fields: "photo_100",
          access_token: token,
        });
      } catch {
        failed += 1;
        continue;
      }
      updates.push(...inboxProfileUpdates(response, batch));
    }
  }
  const saved = updates.length
    ? Number(await must(db().rpc("an_inbox_profiles_store", { p_rows: updates })))
    : 0;
  return {
    status: failed ? "partial" : "success",
    message: `Диалогов без имени или аватарки: ${candidates.length}, обновлено: ${saved}${failed ? `, запросов VK с ошибкой: ${failed}` : ""}`,
    details: { candidates: candidates.length, saved, failed },
  };
}

/** Их _history_group_retry: сообщество → до какого времени не спрашивать (процесс). */
const g = globalThis as typeof globalThis & { __lsInboxHistoryRetry?: Map<number, number> };
const groupRetry = (g.__lsInboxHistoryRetry ??= new Map());

type FirstPending = {
  id: number;
  peer_id: number;
  community_id: number;
  vk_community_id: number;
  oldest_local: string | null;
};

/** Один проход их refresh_first_message_dates (до 100 диалогов). */
async function inboxFirstBatch(): Promise<{ processed: number; confirmed: number }> {
  const now = Date.now();
  const skip = [...groupRetry].filter(([, until]) => until > now).map(([id]) => id);
  const dialogs = (await must(
    db().rpc("an_inbox_first_pending", { p_skip: skip, p_limit: INBOX_FIRST_BATCH }),
  )) as FirstPending[];
  const tokens = new Map<number, string | null>();
  let confirmed = 0;
  for (const d of dialogs) {
    if ((groupRetry.get(d.community_id) ?? 0) > Date.now()) continue;
    let stamp: Date | null = null;
    let received = false;
    try {
      if (!tokens.has(d.community_id)) {
        tokens.set(
          d.community_id,
          await readSecret(inboxTokenRef(d.community_id)).catch(() => null),
        );
      }
      const token = tokens.get(d.community_id);
      if (!token) throw new InboxError("Нет токена сообщества.");
      const payload = await vkMethod("messages.getHistory", {
        peer_id: String(d.peer_id),
        group_id: String(d.vk_community_id),
        count: "1",
        offset: "0",
        rev: "1",
        access_token: token,
      });
      received = true;
      if (!d.oldest_local) throw new InboxError(INBOX_TEXT.noLocal);
      stamp = firstHistoryTimestamp(payload, d.peer_id, new Date(d.oldest_local));
    } catch {
      // Как у них: ответа VK не получили (токен, сеть, ошибка VK) — всё
      // сообщество ждёт час. Ответы VK, токены и тексты в журнал не пишутся.
      if (!received) groupRetry.set(d.community_id, Date.now() + INBOX_FIRST_GROUP_RETRY_MS);
    }
    await must(
      db().rpc("an_inbox_first_store", {
        p_dialog: d.id,
        p_first_at: stamp ? stamp.toISOString() : null,
      }),
    );
    if (stamp) confirmed += 1;
    await sleep(INBOX_FIRST_PAUSE_MS);
  }
  return { processed: dialogs.length, confirmed };
}

/** Задача «inbox_first_messages»: проходы подряд, пока есть работа и не дольше 45 с. */
export async function inboxRefreshFirstMessages(budgetMs = 45_000): Promise<JobResult> {
  const started = Date.now();
  let processed = 0;
  let confirmed = 0;
  do {
    const r = await inboxFirstBatch();
    processed += r.processed;
    confirmed += r.confirmed;
    if (!r.processed) break;
  } while (Date.now() - started < budgetMs);
  return {
    status: "success",
    message: `Проверено диалогов: ${processed}, дата первого сообщения подтверждена: ${confirmed}`,
    details: { processed, confirmed },
  };
}

// --- Ответ из портала (их send_operator_message) ---

/** Отказ VK «нет файла в запросе» (4606): повторить загрузку другим полем. */
class MissingPhotoFile extends InboxError {}

/** Ответ не длиннее limit байт (их response.read(1_000_001)); длиннее — null. */
async function readLimited(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Их _post_message_photo: multipart с полем photo (или file1), переходы —
 * только на проверенные адреса VK (не больше 3), таймаут 60 с.
 */
async function postMessagePhoto(url: string, image: InboxImage, field: string) {
  const stand = process.env.ANALYTICS_VK_API_ORIGIN;
  if (!uploadUrlAllowed(url, stand)) throw new InboxError(INBOX_SEND_TEXT.badUploadUrl);
  const boundary = "LadyInbox" + randomBytes(16).toString("hex");
  const filename = image.mime === "image/png" ? "image.png" : "image.jpg";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${image.mime}\r\n\r\n`,
    ),
    Buffer.from(image.data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  let target = url;
  let method = "POST";
  let res: Response | null = null;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetch(target, {
        method,
        headers:
          method === "POST"
            ? {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "User-Agent": USER_AGENT,
                Accept: "application/json",
              }
            : { "User-Agent": USER_AGENT, Accept: "application/json" },
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = new URL(res.headers.get("location") ?? "", target).toString();
      await res.body?.cancel().catch(() => undefined);
      if (!uploadUrlAllowed(next, stand)) throw new InboxError(INBOX_SEND_TEXT.badUploadUrl);
      if (hop === 3) throw new InboxError(INBOX_SEND_TEXT.uploadNetwork);
      // Как urllib: 307/308 повторяют POST, 301/302/303 — GET без тела.
      if (res.status !== 307 && res.status !== 308) method = "GET";
      target = next;
    }
  } catch (e) {
    if (e instanceof InboxError) throw e;
    throw new InboxError(INBOX_SEND_TEXT.uploadNetwork);
  }
  if (!res) throw new InboxError(INBOX_SEND_TEXT.uploadNetwork);
  if (!res.ok) {
    const text = (await readLimited(res, 65_536).catch(() => null)) ?? "";
    const r = uploadHttpError(res.status, text);
    throw r.missing ? new MissingPhotoFile(r.error) : new InboxError(r.error);
  }
  let raw: string | null;
  try {
    raw = await readLimited(res, 1_000_000);
  } catch {
    throw new InboxError(INBOX_SEND_TEXT.uploadNetwork);
  }
  const r = uploadResult(raw);
  if (!r.ok) throw r.missing ? new MissingPhotoFile(r.error) : new InboxError(r.error);
  return r.uploaded;
}

/** Их _upload_message_photo: сервер загрузки, файл, photos.saveMessagesPhoto. */
async function uploadMessagePhoto(peerId: number, token: string, image: InboxImage) {
  const server = await vkMethod("photos.getMessagesUploadServer", {
    peer_id: String(peerId),
    access_token: token,
  });
  const url =
    server && typeof server === "object" && !Array.isArray(server)
      ? String((server as Record<string, unknown>).upload_url ?? "")
      : "";
  let uploaded: Record<string, unknown>;
  try {
    uploaded = await postMessagePhoto(url, image, "photo");
  } catch (e) {
    // Повтор — только на явный отказ «нет файла»; messages.send ещё не вызывали.
    if (!(e instanceof MissingPhotoFile)) throw e;
    uploaded = await postMessagePhoto(url, image, "file1");
  }
  const saved = await vkMethod("photos.saveMessagesPhoto", {
    ...uploadedPhotoParams(uploaded),
    access_token: token,
  });
  return savedPhoto(saved);
}

/**
 * Их send_operator_message: проверки, токен группы, картинки по очереди,
 * messages.send, запись в переписку (an_inbox_reply_store). Диалог — в
 * доступе вызывающего (RPC от его имени).
 */
export async function inboxSendReply(
  supabase: SupabaseClient,
  userId: string,
  dialogId: number,
  body: string,
  images: InboxImage[],
): Promise<void> {
  validateReplyImages(images);
  const text = replyText(body, images.length);
  const { data: target, error } = await supabase.rpc("an_inbox_reply_target", {
    p_dialog: dialogId,
  });
  if (error) throw new InboxError(error.message);
  const t = target as { id: number; community_id: number; peer_id: number };
  const token = await readSecret(inboxTokenRef(t.community_id));
  if (!token) throw new InboxError("Нет токена сообщества — переподключите группу.");
  const photos: Record<string, unknown>[] = [];
  for (const image of images) photos.push(await uploadMessagePhoto(t.peer_id, token, image));
  const response = await vkMethod("messages.send", {
    peer_id: String(t.peer_id),
    message: text,
    random_id: String(randomBytes(4).readUInt32BE() % 2_000_000_000),
    attachment: photos.map(photoAttachment).join(","),
    access_token: token,
  });
  const messageId = sentMessageId(response);
  await must(
    db().rpc("an_inbox_reply_store", {
      p_user: userId,
      p_dialog: dialogId,
      p_vk_message_id: messageId,
      p_text: text,
      p_photos: photos,
    }),
  );
}
