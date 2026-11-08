/**
 * Файлы чатов — закрытый бакет `chat-files`, папка — id чата
 * (`<чат>/<uuid>.<расширение>`; имя файла — в сообщении). Загрузка — с
 * полосой прогресса (XMLHttpRequest: у supabase-js прогресса нет), показ —
 * подписанные ссылки на час (кэш в памяти). Картинки не уменьшаем: в чатах
 * передают и макеты, им нужен оригинал (бриф, боль № 10).
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/integrations/supabase/env";
import { formatFileSize } from "@/lib/kb/files";
import type { ChatAttachment } from "./types";

export const CHAT_BUCKET = "chat-files";
export const CHAT_MAX_FILE_BYTES = 200 * 1024 * 1024;
const SIGNED_TTL_S = 3600;

export { formatFileSize };

export class ChatFileTooLarge extends Error {}

function storageName(file: File): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "bin";
  return `${crypto.randomUUID()}.${ext}`;
}

async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!/^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(file.type)) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

export async function uploadChatFile(
  chatId: string,
  file: File,
  onProgress?: (share: number) => void,
): Promise<ChatAttachment> {
  if (file.size > CHAT_MAX_FILE_BYTES) {
    throw new ChatFileTooLarge(
      `Файл «${file.name}» — ${formatFileSize(file.size)}, а можно до ${formatFileSize(CHAT_MAX_FILE_BYTES)}.`,
    );
  }
  const path = `${chatId}/${storageName(file)}`;
  const size = await imageSize(file);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? SUPABASE_ANON_KEY;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${CHAT_BUCKET}/${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("Cache-Control", "max-age=3600");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 413) return reject(new Error("файл больше, чем разрешено"));
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        reject(new Error(body.message || body.error || `ошибка ${xhr.status}`));
      } catch {
        reject(new Error(`ошибка ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("нет связи с сервером"));
    xhr.send(file);
  });
  return {
    path,
    name: file.name || "файл",
    mime: file.type || "application/octet-stream",
    size: file.size,
    ...(size ?? {}),
  };
}

const cache = new Map<string, { url: string; expires: number }>();

export async function chatFileUrl(path: string, download?: string): Promise<string> {
  const key = download ? `${path}|${download}` : path;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now() + 60_000) return hit.url;
  const { data, error } = await supabase.storage
    .from(CHAT_BUCKET)
    .createSignedUrl(path, SIGNED_TTL_S, download ? { download } : undefined);
  if (error || !data) throw new Error(error?.message ?? "Файл недоступен");
  cache.set(key, { url: data.signedUrl, expires: Date.now() + SIGNED_TTL_S * 1000 });
  return data.signedUrl;
}

export function useChatFileUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["chat_file_url", path],
    queryFn: () => chatFileUrl(path!),
    enabled: !!path,
    staleTime: 50 * 60_000,
    gcTime: 55 * 60_000,
  });
}

/** Скачать под исходным именем. */
export async function downloadChatFile(a: ChatAttachment) {
  const url = await chatFileUrl(a.path, a.name);
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
