/**
 * Файлы статей базы знаний — закрытый бакет kb-media (только наш Storage,
 * внешних хранилищ и CDN нет — решение владельца 2026-10-24).
 *
 * В документе статьи файл хранится ссылкой `kbfile:<путь в бакете>`, а не
 * адресом: адрес подписанный и живёт час. Показать — resolveKbFileUrl
 * (подписанная ссылка, кэш до истечения). Путь — {база}/{статья}/{файл}:
 * по первой папке Storage проверяет доступ к базе.
 */
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/integrations/supabase/env";
import { documentFilePaths, replaceDocumentFiles } from "@/lib/kb/document";
import { fitImage } from "@/lib/storage";

export const KB_BUCKET = "kb-media";
export const KB_FILE_PREFIX = "kbfile:";
/**
 * Лимит бакета — 200 МБ на файл (решение владельца 2026-10-30, было 50 МБ;
 * бакет — db/migrations/2026-10-30_zz_kb_media_200mb.sql).
 */
export const KB_MAX_FILE_BYTES = 200 * 1024 * 1024;

const SIGNED_TTL_S = 60 * 60;
const cache = new Map<string, { url: string; expires: number }>();

export function isKbFile(url: string | null | undefined): boolean {
  return !!url && url.startsWith(KB_FILE_PREFIX);
}

/** Папка файлов статьи в бакете. */
export const kbArticleFolder = (baseId: string, nodeId: string) => `${baseId}/${nodeId}`;
/** Папка файлов шаблона: шаблоны общие для всех баз. */
export const kbTemplateFolder = (templateId: string) => `templates/${templateId}`;

export function kbFilePath(url: string): string {
  return url.slice(KB_FILE_PREFIX.length);
}

/** Размер файла по-человечески: «12,4 МБ». */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "").replace(".", ",")} МБ`;
}

/** Имя файла в бакете: латиница и цифры, расширение — как у исходного. */
function storageName(file: File): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "bin";
  return `${crypto.randomUUID()}.${ext}`;
}

export class KbFileTooLarge extends Error {}

/** Картинки, которые уменьшаем перед загрузкой (GIF — нет: анимация пропала бы). */
const SHRINK_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
/** Меньше этого не трогаем: схема или скриншот уже лёгкие. */
const SHRINK_FROM_BYTES = 300 * 1024;
/** Длинная сторона картинки в статье — с запасом на широкий экран. */
const SHRINK_MAX_SIDE = 2000;

/**
 * Фото с телефона весит 3–5 МБ, а статье хватает 2000 px в WebP (~200–400
 * КБ): место на сервере и загрузка у читателей — в разы меньше. Не вышло
 * (формат браузеру незнаком) или копия не легче — уходит оригинал.
 */
export async function shrinkKbImage(file: File): Promise<File> {
  if (!SHRINK_TYPES.has(file.type) || file.size < SHRINK_FROM_BYTES) return file;
  try {
    const small = await fitImage(file, SHRINK_MAX_SIDE);
    if (small.size >= file.size) return file;
    const ext = small.type === "image/webp" ? "webp" : "png";
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([small], `${base}.${ext}`, { type: small.type });
  } catch {
    return file;
  }
}

/**
 * Загрузить файл статьи; вернуть ссылку для документа (`kbfile:…`).
 * `onProgress` — доля отправленного (0…1): видео до 200 МБ грузится заметно
 * долго, без полосы казалось, что всё зависло. supabase-js прогресс не
 * отдаёт (fetch), поэтому тот же запрос к Storage — через XMLHttpRequest.
 */
export async function uploadKbFile(
  /** Папка в бакете — kbArticleFolder / kbTemplateFolder. */
  folder: string,
  original: File,
  onProgress?: (share: number) => void,
): Promise<string> {
  const file = await shrinkKbImage(original);
  if (file.size > KB_MAX_FILE_BYTES) {
    throw new KbFileTooLarge(
      `Файл «${file.name}» — ${formatFileSize(file.size)}, а можно до ${formatFileSize(KB_MAX_FILE_BYTES)}. Сожмите его или разделите.`,
    );
  }
  const path = `${folder}/${storageName(file)}`;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? SUPABASE_ANON_KEY;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${KB_BUCKET}/${path}`);
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
      reject(new Error(storageError(xhr)));
    };
    xhr.onerror = () => reject(new Error("нет связи с сервером"));
    xhr.send(file);
  });
  return `${KB_FILE_PREFIX}${path}`;
}

/** Текст ошибки Storage из ответа ({message} / {error}) или код. */
function storageError(xhr: XMLHttpRequest): string {
  if (xhr.status === 413) return "файл больше, чем разрешено";
  try {
    const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
    return body.message || body.error || `ошибка ${xhr.status}`;
  } catch {
    return `ошибка ${xhr.status}`;
  }
}

/** Адрес для показа: у своих файлов — подписанная ссылка на час. */
export async function resolveKbFileUrl(url: string): Promise<string> {
  if (!isKbFile(url)) return url;
  const path = kbFilePath(url);
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now() + 60_000) return hit.url;
  const { data, error } = await supabase.storage
    .from(KB_BUCKET)
    .createSignedUrl(path, SIGNED_TTL_S);
  if (error || !data) throw new Error(error?.message ?? "Файл недоступен");
  cache.set(path, { url: data.signedUrl, expires: Date.now() + SIGNED_TTL_S * 1000 });
  return data.signedUrl;
}

/** Ссылка «Скачать»: браузер сохранит файл под его именем, а не откроет. */
export async function resolveKbDownloadUrl(url: string, name: string): Promise<string> {
  if (!isKbFile(url)) return url;
  const { data, error } = await supabase.storage
    .from(KB_BUCKET)
    .createSignedUrl(kbFilePath(url), SIGNED_TTL_S, { download: name });
  if (error || !data) throw new Error(error?.message ?? "Файл недоступен");
  return data.signedUrl;
}

/**
 * Копии файлов документа — в папку `folder` (статья → шаблон, шаблон →
 * статья другой базы): документ не зависит от того, откуда его взяли, и
 * читателям не нужен доступ к чужой папке. Файл, который скопировать не
 * вышло (нет доступа к исходной базе), остаётся прежней ссылкой — их число
 * в `failed`.
 */
export async function copyKbFiles<T>(
  doc: T,
  folder: string,
): Promise<{ content: T; failed: number }> {
  const storage = supabase.storage.from(KB_BUCKET);
  const moved = new Map<string, string>();
  let failed = 0;
  for (const path of documentFilePaths(doc)) {
    if (path.startsWith(`${folder}/`)) continue;
    const to = `${folder}/${path.split("/").pop()}`;
    const { error } = await storage.copy(path, to);
    // Уже скопирован (повторное сохранение) — тоже годится.
    if (!error || /exists|duplicate/i.test(error.message)) moved.set(path, to);
    else failed += 1;
  }
  return { content: replaceDocumentFiles(doc, moved), failed };
}

/** Убрать из папки файлы, на которые документ больше не ссылается (шаблон после правки). */
export async function pruneKbFolder(folder: string, doc: unknown): Promise<void> {
  const storage = supabase.storage.from(KB_BUCKET);
  const used = new Set(documentFilePaths(doc));
  const { data } = await storage.list(folder, { limit: 1000 });
  const stale = (data ?? []).map((f) => `${folder}/${f.name}`).filter((path) => !used.has(path));
  if (stale.length) await storage.remove(stale);
}
