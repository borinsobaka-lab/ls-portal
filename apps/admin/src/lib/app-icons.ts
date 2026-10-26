import { supabase } from "@/integrations/supabase/client";
import { STORAGE_BUCKETS } from "@/lib/storage";

/**
 * Иконка клиентского приложения («Мобильное приложение» → «Настройки»):
 * фавикон и значок на рабочем столе, когда приложение сохраняют как PWA.
 *
 * Из загруженной картинки браузер нарезает готовые PNG и кладёт их в одну
 * папку бакета app-icons; папка пишется в app_install_settings.app_icon_path
 * (строка на приложение — формат клубов).
 * Клиент (apps/client/src/lib/app-install.ts) собирает адреса по тем же
 * именам файлов — меняя их здесь, поменяй и там.
 */
export const APP_ICON_FILES = {
  /** Манифест, purpose any. */
  icon512: { name: "icon-512.png", size: 512 },
  icon192: { name: "icon-192.png", size: 192 },
  /**
   * Манифест, purpose maskable: Android обрезает края кругом/скруглением и
   * гарантирует только центральный круг диаметром 80% — картинка ужимается
   * ровно настолько, чтобы рисунок на ней (не фон) влез в этот круг
   * (maskableScale), поля продолжают её края (градиентный фон не рвётся).
   */
  maskable512: { name: "icon-maskable-512.png", size: 512, opaque: true, maskable: true },
  /** iOS: прозрачное он заливает чёрным, поэтому — на белом. */
  appleTouch: { name: "apple-touch-icon.png", size: 180, opaque: true },
  favicon32: { name: "favicon-32.png", size: 32 },
} as const;

/** Радиус безопасного круга maskable-иконки (40% стороны) с запасом на сглаживание. */
const MASKABLE_SAFE_RADIUS = 0.39;

/** Меньше — значок на рабочем столе будет мыльным. */
export const APP_ICON_MIN_SIZE = 512;

export const APP_NAME_MAX = 30;
/** Длиннее — телефоны обрезают подпись под значком многоточием. */
export const APP_NAME_FITS = 12;
export const APP_NAME_DEFAULT = "Lady Stretch";

const BUCKET = STORAGE_BUCKETS.appIcons.id;

/** Публичный адрес файла иконки в папке. */
export function appIconUrl(folder: string, file: keyof typeof APP_ICON_FILES) {
  return supabase.storage.from(BUCKET).getPublicUrl(`${folder}/${APP_ICON_FILES[file].name}`).data
    .publicUrl;
}

/** Картинка через <img>: в отличие от createImageBitmap понимает и SVG. */
function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось прочитать картинку — нужен PNG, JPG или SVG"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** Квадрат из центра картинки в квадрат size×size с левым верхним углом (x, y). */
function drawCenterSquare(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  size: number,
  x = 0,
  y = 0,
) {
  // SVG без width/height бывает с нулевым размером — тогда рисуем целиком.
  if (img.naturalWidth && img.naturalHeight) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const side = Math.min(w, h);
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, x, y, size, size);
  } else {
    ctx.drawImage(img, x, y, size, size);
  }
}

/**
 * Во сколько ужать картинку для maskable-иконки: рисунок (всё, что
 * отличается от фона) должен влезть в безопасный круг. Фон — цвет края
 * в той же строке или в том же столбце, так градиент фона рисунком не
 * считается. Рисунок, который и так в круге, не уменьшается.
 */
function maskableScale(img: HTMLImageElement): number {
  const n = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0.66;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, n, n);
  drawCenterSquare(ctx, img, n);
  const px = ctx.getImageData(0, 0, n, n).data;
  const at = (x: number, y: number) => (y * n + x) * 4;
  const differs = (a: number, b: number) =>
    Math.abs(px[a] - px[b]) + Math.abs(px[a + 1] - px[b + 1]) + Math.abs(px[a + 2] - px[b + 2]) >
    60;
  let maxDist = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = at(x, y);
      const rowEdge = x < n / 2 ? at(0, y) : at(n - 1, y);
      const colEdge = y < n / 2 ? at(x, 0) : at(x, n - 1);
      if (!differs(i, rowEdge) || !differs(i, colEdge)) continue;
      // Дальний угол пикселя от центра, в долях стороны.
      const dx = Math.max(Math.abs(x - n / 2), Math.abs(x + 1 - n / 2)) / n;
      const dy = Math.max(Math.abs(y - n / 2), Math.abs(y + 1 - n / 2)) / n;
      maxDist = Math.max(maxDist, Math.hypot(dx, dy));
    }
  }
  return maxDist ? Math.min(1, MASKABLE_SAFE_RADIUS / maxDist) : 1;
}

/**
 * Квадрат size×size из центра картинки; opaque — на белом фоне; maskable —
 * картинка ужата в безопасную зону Android, поля — её растянутые края.
 */
function renderSquare(
  img: HTMLImageElement,
  size: number,
  opaque: boolean,
  maskable: boolean,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не умеет обрабатывать картинки");
  if (opaque) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
  }
  ctx.imageSmoothingQuality = "high";
  if (maskable) {
    const inner = Math.round(size * maskableScale(img));
    const pad = Math.round((size - inner) / 2);
    const far = pad + inner;
    drawCenterSquare(ctx, img, inner, pad, pad);
    // Поля: крайний ряд и столбец картинки (на пиксель внутрь — без
    // сглаживания границы) растягиваются наружу; столбцы берутся во всю
    // высоту, так что заодно закрывают углы.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, pad, pad + 1, inner, 1, pad, 0, inner, pad);
    ctx.drawImage(canvas, pad, far - 2, inner, 1, pad, far, inner, size - far);
    ctx.drawImage(canvas, pad + 1, 0, 1, size, 0, 0, pad, size);
    ctx.drawImage(canvas, far - 2, 0, 1, size, far, 0, size - far, size);
  } else {
    drawCenterSquare(ctx, img, size);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Не удалось обработать картинку"))),
      "image/png",
    ),
  );
}

/**
 * Проверяет картинку, нарезает все размеры и загружает их в новую папку.
 * Возвращает папку — её сохраняем в club_settings.app_icon_path. Новая папка
 * на каждую загрузку: адреса иконок меняются, и браузеры с установленными
 * приложениями не держат старую картинку из кэша.
 */
export async function uploadAppIcon(file: File): Promise<string> {
  const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  const img = await loadImage(file);
  if (!isSvg && Math.min(img.naturalWidth, img.naturalHeight) < APP_ICON_MIN_SIZE) {
    throw new Error(
      `Картинка ${img.naturalWidth}×${img.naturalHeight} px — нужна не меньше ${APP_ICON_MIN_SIZE}×${APP_ICON_MIN_SIZE} px`,
    );
  }
  const folder = crypto.randomUUID();
  const files = Object.values(APP_ICON_FILES);
  const blobs = await Promise.all(
    files.map((f) =>
      renderSquare(img, f.size, "opaque" in f && f.opaque, "maskable" in f && f.maskable),
    ),
  );
  await Promise.all(
    files.map(async (f, i) => {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(`${folder}/${f.name}`, blobs[i], { upsert: false, contentType: "image/png" });
      if (error) throw new Error(error.message);
    }),
  );
  return folder;
}
