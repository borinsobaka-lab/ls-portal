import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { isHttpUrl } from "@/lib/format";

/**
 * Бакеты Storage для картинок админки. В таблицах хранится ПУТЬ внутри бакета
 * (или полный URL у старых записей), картинку получаем по нему.
 *
 * public — getPublicUrl (синхронно). signed — подписанная ссылка на час: так
 * исторически сделаны фото тренеров и тренировок. По db/*.sql эти бакеты тоже
 * публичные; если в живой базе это подтвердится — перевести на public и
 * убрать запрос на каждую картинку.
 */
export const STORAGE_BUCKETS = {
  news: { id: "news-media", access: "public" },
  services: { id: "services-media", access: "public" },
  memberships: { id: "memberships-media", access: "public" },
  trainers: { id: "trainer-photos", access: "signed" },
  workouts: { id: "workout-photos", access: "signed" },
  studios: { id: "studio-logos", access: "public" },
  // Аватарки сотрудников — папка staff/ (db/migrations/…_staff_avatars.sql);
  // в остальных папках — фото клиентов из приложения.
  avatars: { id: "avatars", access: "public" },
  // Иконки клиентского приложения (lib/app-icons.ts): папка на каждую загрузку.
  appIcons: { id: "app-icons", access: "public" },
  // Фото раздела «О нас» приложения пакетных клубов, папка about/
  // (db/migrations/2026-10-12_zzzzzz_app_about_page.sql).
  studioPhotos: { id: "studio-photos", access: "public" },
} as const;

export type StorageBucket = keyof typeof STORAGE_BUCKETS;

const SIGNED_URL_TTL = 3600;

/** URL картинки по значению из таблицы (путь в бакете или полный URL). */
export function useStorageUrl(bucket: StorageBucket, value: string | null | undefined) {
  const { id, access } = STORAGE_BUCKETS[bucket];
  const isPath = !!value && !isHttpUrl(value);
  const signed = useQuery({
    queryKey: ["storage-url", id, value],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(id)
        .createSignedUrl(value as string, SIGNED_URL_TTL);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
    enabled: isPath && access === "signed",
    // Ссылка живёт час — перезапрашиваем заранее.
    staleTime: (SIGNED_URL_TTL - 600) * 1000,
  });

  if (!value) return null;
  if (!isPath) return value;
  if (access === "signed") return signed.data ?? null;
  return supabase.storage.from(id).getPublicUrl(value).data.publicUrl ?? null;
}

/**
 * Загружает файл в бакет в папку `folder` под случайным именем и возвращает
 * путь — его и сохраняем в таблицу.
 */
export async function uploadToStorage(bucket: StorageBucket, folder: string, file: File) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "jpg";
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKETS[bucket].id).upload(path, file, {
    upsert: false,
    contentType: file.type || (ext === "svg" ? "image/svg+xml" : undefined),
  });
  if (error) throw new Error(error.message);
  return path;
}

/**
 * Квадратная уменьшенная копия картинки (центр, WebP) — для аватарок: в
 * меню и таблице они размером с иконку, оригинал с телефона весил бы мегабайты.
 */
export async function squareImage(file: File, size = 256): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(size, side);
  return drawToWebp(
    bitmap,
    [(bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side],
    out,
    out,
    "avatar",
  );
}

/**
 * Уменьшенная копия фото (WebP, длинная сторона не больше maxSide, пропорции
 * те же) — для фото в приложении: оригинал с камеры весит мегабайты, а
 * телефону клиента хватает ~1600 px.
 */
export async function fitImage(file: File, maxSide = 1600): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  return drawToWebp(
    bitmap,
    [0, 0, bitmap.width, bitmap.height],
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
    "photo",
  );
}

async function drawToWebp(
  bitmap: ImageBitmap,
  [sx, sy, sw, sh]: [number, number, number, number],
  width: number,
  height: number,
  name: string,
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не умеет обрабатывать картинки");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.85),
  );
  if (!blob) throw new Error("Не удалось обработать картинку");
  // Без поддержки WebP браузер отдаёт PNG — расширение по факту.
  return new File([blob], blob.type === "image/webp" ? `${name}.webp` : `${name}.png`, {
    type: blob.type,
  });
}
