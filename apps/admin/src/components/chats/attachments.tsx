/**
 * Вложения сообщения: картинки — плиткой (по нажатию — на весь экран с
 * листанием, окно базы знаний), видео — плеером, остальное — карточкой
 * файла со «Скачать». Ссылки на файлы — подписанные (lib/chats/files.ts).
 */
import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { KbImageLightbox, type LightboxImage } from "@/components/kb/image-lightbox";
import { isImage } from "@/lib/chats/content";
import { chatFileUrl, downloadChatFile, formatFileSize, useChatFileUrl } from "@/lib/chats/files";
import type { ChatAttachment } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

function ImageTile({
  file,
  single,
  onOpen,
}: {
  file: ChatAttachment;
  single: boolean;
  onOpen: () => void;
}) {
  const { data: url } = useChatFileUrl(file.path);
  const ratio = file.width && file.height ? file.width / file.height : 4 / 3;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "relative block overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        single ? "max-h-80 w-full max-w-sm" : "aspect-square w-full",
      )}
      style={single ? { aspectRatio: String(Math.min(Math.max(ratio, 0.5), 2.5)) } : undefined}
      aria-label={`Открыть: ${file.name}`}
    >
      {url ? (
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        <Loader2 className="absolute inset-0 m-auto size-5 animate-spin text-muted-foreground" />
      )}
    </button>
  );
}

function VideoTile({ file }: { file: ChatAttachment }) {
  const { data: url } = useChatFileUrl(file.path);
  return url ? (
    <video
      src={url}
      controls
      preload="metadata"
      className="max-h-80 w-full max-w-sm rounded-lg bg-black"
    />
  ) : (
    <div className="flex h-40 w-full max-w-sm items-center justify-center rounded-lg bg-muted">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export function FileCard({ file, mine = false }: { file: ChatAttachment; mine?: boolean }) {
  const [busy, setBusy] = useState(false);
  const ext = /\.([a-z0-9]{1,6})$/i.exec(file.name)?.[1]?.toUpperCase() ?? "ФАЙЛ";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadChatFile(file);
        } catch (e) {
          toast.error(`Не удалось скачать: ${(e as Error).message}`);
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        "flex w-full max-w-sm items-center gap-3 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        mine ? "border-black/10 bg-white/60 hover:bg-white/80" : "bg-background hover:bg-muted",
      )}
      title="Скачать"
    >
      <span className="relative flex size-10 shrink-0 items-center justify-center rounded-md bg-brand/15 text-brand-on-light">
        <FileText className="size-5" />
        <span className="absolute -bottom-1 rounded bg-background px-1 text-[9px] font-bold leading-3 ring-1 ring-border">
          {ext.slice(0, 4)}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        {file.size != null && (
          <span className="block text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
        )}
      </span>
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Download className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

export function Attachments({ files, mine = false }: { files: ChatAttachment[]; mine?: boolean }) {
  const images = files.filter((f) => isImage(f.mime));
  const videos = files.filter((f) => /^video\//.test(f.mime));
  const others = files.filter((f) => !images.includes(f) && !videos.includes(f));
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);

  const open = async (index: number) => {
    try {
      const urls = await Promise.all(images.map((f) => chatFileUrl(f.path)));
      setLightbox({ images: urls.map((src, i) => ({ src, name: images[i].name })), index });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (files.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div
          className={cn("grid gap-1", images.length === 1 ? "grid-cols-1" : "max-w-sm grid-cols-2")}
        >
          {images.map((f, i) => (
            <ImageTile
              key={f.path}
              file={f}
              single={images.length === 1}
              onOpen={() => void open(i)}
            />
          ))}
        </div>
      )}
      {videos.map((f) => (
        <VideoTile key={f.path} file={f} />
      ))}
      {others.map((f) => (
        <FileCard key={f.path} file={f} mine={mine} />
      ))}
      <KbImageLightbox
        images={lightbox?.images ?? []}
        index={lightbox?.index ?? null}
        protect={false}
        onIndex={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}
