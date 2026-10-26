import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export type LightboxImage = { src: string; name: string };

/** Картинки статьи, которые открываются по нажатию (у читателя). */
export const ZOOMABLE_IMAGES = "img.bn-visual-media, .kb-gallery img";

/** Имя файла для «Скачать»: подпись картинки или имя из адреса. */
function fileName(image: LightboxImage): string {
  const fromUrl = decodeURIComponent(new URL(image.src).pathname.split("/").pop() ?? "");
  const name = image.name.trim() || fromUrl || "картинка";
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(fromUrl)?.[1];
  return ext ? `${name}.${ext}` : name;
}

/**
 * Картинка статьи на весь экран (решение владельца 2026-10-25: не уводить в
 * новую вкладку) — отступ от краёв минимальный, сверху «Скачать» и
 * «Закрыть», у нескольких картинок статьи — листание стрелками (и ←/→).
 * У защищённой статьи (`protect`) читатель не скачивает и не копирует.
 */
export function KbImageLightbox({
  images,
  index,
  protect,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  index: number | null;
  protect: boolean;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && !!images[index];
  const image = open ? images[index] : null;
  const many = images.length > 1;
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") onIndex((index! + 1) % images.length);
      if (e.key === "ArrowLeft") onIndex((index! - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, many, index, images.length, onIndex]);

  // Ссылка на файл — с другого адреса (Storage), атрибут download браузер
  // там не слушает: сохраняем через blob, чтобы файл скачался, а не открылся.
  const download = async () => {
    if (!image) return;
    setSaving(true);
    try {
      const res = await fetch(image.src);
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName(image);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error("Не удалось скачать картинку");
    } finally {
      setSaving(false);
    }
  };

  const round =
    "inline-flex size-10 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default disabled:opacity-60 [&_svg]:size-5";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onContextMenu={protect ? (e) => e.preventDefault() : undefined}
          className={cn(
            "fixed inset-2 z-50 flex items-center justify-center outline-none sm:inset-3",
            protect && "kb-no-copy",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {image?.name || "Картинка"}
          </DialogPrimitive.Title>
          {/* Нажатие мимо картинки закрывает окно. */}
          <div className="absolute inset-0" onClick={onClose} aria-hidden />
          {image && (
            <img
              key={image.src}
              src={image.src}
              alt={image.name}
              draggable={!protect}
              className="relative max-h-full max-w-full rounded-md object-contain shadow-2xl"
            />
          )}
          <div className="absolute top-2 right-2 flex gap-2">
            {!protect && (
              <button
                type="button"
                className={round}
                onClick={() => void download()}
                disabled={saving}
                aria-label="Скачать"
                title="Скачать"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Download />}
              </button>
            )}
            <DialogPrimitive.Close className={round} aria-label="Закрыть" title="Закрыть">
              <X />
            </DialogPrimitive.Close>
          </div>
          {many && index !== null && (
            <>
              <button
                type="button"
                className={cn(round, "absolute top-1/2 left-2 -translate-y-1/2")}
                onClick={() => onIndex((index - 1 + images.length) % images.length)}
                aria-label="Предыдущая картинка"
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className={cn(round, "absolute top-1/2 right-2 -translate-y-1/2")}
                onClick={() => onIndex((index + 1) % images.length)}
                aria-label="Следующая картинка"
              >
                <ChevronRight />
              </button>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs text-white tabular-nums">
                {index + 1} из {images.length}
              </span>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
