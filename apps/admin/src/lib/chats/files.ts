/**
 * Файлы чатов — закрытый бакет `chat-files`, папка — id чата
 * (`<чат>/<uuid>.<расширение>`; имя файла — в сообщении). Показ — подписанные
 * ссылки на час (кэш в памяти). Картинки не уменьшаем: в чатах передают и
 * макеты, им нужен оригинал (бриф, боль № 10).
 *
 * Загрузка — с докачкой (протокол TUS, `/storage/v1/upload/resumable`
 * Supabase Storage, библиотека tus-js-client): файл уходит кусками по 6 МБ
 * (так требует Storage), обрыв связи — повторы с паузой, без сети — ждём
 * `online` и продолжаем с принятого сервером места. Адрес незаконченной
 * загрузки хранится в localStorage (отпечаток — имя, размер, дата файла):
 * тот же файл в том же чате после перезагрузки страницы докачивается, а не
 * начинается заново. Нет TUS на сервере (404/405 на создании или первый
 * запрос не проходит при живой сети — прокси) — прежняя загрузка одним
 * запросом, без докачки.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/integrations/supabase/env";
import { formatFileSize } from "@/lib/kb/files";
import type { ChatAttachment } from "./types";

export const CHAT_BUCKET = "chat-files";
export const CHAT_MAX_FILE_BYTES = 200 * 1024 * 1024;
const SIGNED_TTL_S = 3600;
/** Storage принимает куски TUS ровно по 6 МБ (последний — меньше). */
const TUS_CHUNK = 6 * 1024 * 1024;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000];

export { formatFileSize };

export class ChatFileTooLarge extends Error {}

/** Состояние загрузки для полосы в поле ввода. */
export type ChatUploadState =
  | { status: "uploading"; share: number }
  /** Связь пропала — продолжим сами, когда появится (или по «Повторить»). */
  | { status: "waiting"; share: number }
  | { status: "done"; attachment: ChatAttachment }
  | { status: "error"; message: string };

export type ChatUpload = {
  /** Продолжить после ошибки или паузы — с места, принятого сервером. */
  resume: () => void;
  /**
   * Остановить. `forget` — убрать и с сервера (файл убрали из сообщения);
   * без него недокачанное остаётся: тот же файл в этом чате докачается.
   */
  cancel: (forget?: boolean) => void;
};

function extOf(name: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
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

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? SUPABASE_ANON_KEY;
}

/** Пути, которые сейчас качаются в этой вкладке: один файл дважды — две загрузки. */
const active = new Set<string>();

/**
 * Начать загрузку файла в чат. Ход — в `onState`; итог (вложение для
 * сообщения) — состояние `done`.
 */
export function startChatUpload(
  chatId: string,
  file: File,
  onState: (s: ChatUploadState) => void,
): ChatUpload {
  let stopped = false;
  let resumeNow: (() => void) | null = null;
  let abortNow: ((forget: boolean) => void) | null = null;
  let path = "";
  const report = (s: ChatUploadState) => {
    if (!stopped) onState(s);
  };
  const finish = (s: ChatUploadState) => {
    active.delete(path);
    report(s);
  };

  void (async () => {
    if (file.size > CHAT_MAX_FILE_BYTES) {
      throw new ChatFileTooLarge(
        `Файл «${file.name}» — ${formatFileSize(file.size)}, а можно до ${formatFileSize(CHAT_MAX_FILE_BYTES)}.`,
      );
    }
    report({ status: "uploading", share: 0 });
    const [tus, size] = await Promise.all([import("tus-js-client"), imageSize(file)]);
    const contentType = file.type || "application/octet-stream";
    const attachment = (): ChatAttachment => ({
      path,
      name: file.name || "файл",
      mime: contentType,
      size: file.size,
      ...(size ?? {}),
    });
    if (stopped) return;

    if (!tus.isSupported) {
      path = `${chatId}/${crypto.randomUUID()}.${extOf(file.name)}`;
      await uploadWhole(path, file, (share) => report({ status: "uploading", share }));
      return finish({ status: "done", attachment: attachment() });
    }

    path = `${chatId}/${crypto.randomUUID()}.${extOf(file.name)}`;
    let fallback = false;
    let lastShare = 0;
    let retryTimer = 0;
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      chunkSize: TUS_CHUNK,
      retryDelays: RETRY_DELAYS,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: { apikey: SUPABASE_ANON_KEY, "x-upsert": "false" },
      metadata: {
        bucketName: CHAT_BUCKET,
        objectName: path,
        contentType,
        cacheControl: "3600",
      },
      // Токен входа живёт час — большой файл качается дольше: свежий на каждый кусок.
      onBeforeRequest: async (req) => {
        req.setHeader("authorization", `Bearer ${await accessToken()}`);
      },
      onProgress: (sent, total) => {
        lastShare = total > 0 ? sent / total : 0;
        report({ status: "uploading", share: lastShare });
      },
      // Повторы самой библиотеки (обрыв, 5xx): показываем «нет связи», пока не пошло.
      onShouldRetry: (e, attempt) => {
        const status = e.originalResponse?.getStatus() ?? 0;
        // Первый же запрос не проходит при живой сети (прокси не пускает TUS) —
        // после двух попыток грузим одним запросом (onError ниже).
        if (!upload.url && status === 0 && attempt >= 1 && navigator.onLine) return false;
        const retry =
          (status < 400 || status >= 500 || status === 409 || status === 423) && navigator.onLine;
        if (retry) report({ status: "waiting", share: lastShare });
        return retry;
      },
      onSuccess: () => finish({ status: "done", attachment: attachment() }),
      onError: (e) => {
        const status =
          "originalResponse" in e && e.originalResponse ? e.originalResponse.getStatus() : 0;
        // На сервере нет TUS — одним запросом, как раньше.
        const noTus =
          status === 404 || status === 405 || status === 501 || (status === 0 && navigator.onLine);
        if (!upload.url && noTus) {
          fallback = true;
          uploadWhole(path, file, (share) => report({ status: "uploading", share })).then(
            () => finish({ status: "done", attachment: attachment() }),
            (err: Error) => finish({ status: "error", message: err.message }),
          );
          return;
        }
        if (status === 0 || status >= 500) {
          // Сеть или сервер: ждём связь и продолжаем с принятого места.
          report({ status: "waiting", share: lastShare });
          if (navigator.onLine) retryTimer = window.setTimeout(() => resumeNow?.(), 15_000);
          return;
        }
        finish({ status: "error", message: tusErrorText(status, e.message) });
      },
    });

    // Тот же файл в этом чате уже начинали — продолжаем ту загрузку.
    const previous = (await upload.findPreviousUploads()).find(
      (p) =>
        p.metadata?.bucketName === CHAT_BUCKET &&
        p.metadata?.objectName?.startsWith(`${chatId}/`) &&
        !active.has(p.metadata.objectName),
    );
    if (previous) {
      path = previous.metadata.objectName;
      upload.options.metadata = { ...upload.options.metadata, objectName: path };
      upload.resumeFromPreviousUpload(previous);
    }
    active.add(path);
    if (stopped) return;

    const onOnline = () => resumeNow?.();
    window.addEventListener("online", onOnline);
    resumeNow = () => {
      if (stopped || fallback) return;
      window.clearTimeout(retryTimer);
      report({ status: "uploading", share: lastShare });
      // abort — снять отложенный повтор библиотеки, иначе два запроса разом.
      void upload.abort().then(() => {
        if (!stopped) upload.start();
      });
    };
    abortNow = (forget) => {
      window.clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      void upload.abort(forget).catch(() => {});
    };
    upload.start();
  })().catch((e: Error) => finish({ status: "error", message: e.message }));

  return {
    resume: () => resumeNow?.(),
    cancel: (forget = true) => {
      stopped = true;
      active.delete(path);
      abortNow?.(forget);
    },
  };
}

function tusErrorText(status: number, fallback: string): string {
  if (status === 413) return "файл больше, чем разрешено";
  if (status === 403) return "нет доступа к чату";
  if (status === 409) return "такой файл уже загружен";
  const body = /response text: (.+?), request id/.exec(fallback)?.[1];
  if (body) {
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      if (parsed.message || parsed.error) return (parsed.message || parsed.error)!;
    } catch {
      /* не JSON — ниже общий текст */
    }
  }
  return status ? `ошибка ${status}` : "нет связи с сервером";
}

/** Одним запросом (сервер без TUS): XMLHttpRequest — у supabase-js нет прогресса. */
async function uploadWhole(path: string, file: File, onProgress: (share: number) => void) {
  const token = await accessToken();
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${CHAT_BUCKET}/${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("Cache-Control", "max-age=3600");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
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
