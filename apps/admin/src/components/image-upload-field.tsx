import { useRef, useState, type ReactNode } from "react";
import { ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { uploadToStorage, useStorageUrl, type StorageBucket } from "@/lib/storage";
import { cn } from "@/lib/utils";

/** Превью картинки из Storage; без картинки — серая плашка с иконкой. */
export function StorageImage({
  bucket,
  value,
  alt,
  className = "h-12 w-16",
  imgClassName = "object-cover",
}: {
  bucket: StorageBucket;
  value: string | null | undefined;
  alt: string;
  /** Размер превью (и плашки-заглушки). */
  className?: string;
  imgClassName?: string;
}) {
  const src = useStorageUrl(bucket, value);
  if (!src) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md bg-muted text-muted-foreground",
          className,
        )}
      >
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  return <img src={src} alt={alt} className={cn("rounded-md", className, imgClassName)} />;
}

/**
 * Поле «картинка» в форме: превью + Загрузить/Заменить + Удалить.
 * value — путь в бакете (или старый полный URL), onChange получает новый путь
 * или null. Сам файл при «Удалить» из Storage не удаляется.
 */
export function ImageUploadField({
  bucket,
  folder,
  value,
  onChange,
  preview,
  accept = "image/*",
  uploadLabel = "Загрузить",
  replaceLabel = "Заменить",
  disabled,
  prepare,
}: {
  bucket: StorageBucket;
  /** Папка внутри бакета, обычно `${studioId}` или `${studioId}/cover`. */
  folder: string;
  value: string | null;
  onChange: (path: string | null) => void;
  /** Своё превью (аватар и т. п.); по умолчанию — StorageImage. */
  preview?: ReactNode;
  accept?: string;
  uploadLabel?: string;
  replaceLabel?: string;
  disabled?: boolean;
  /** Обработать файл перед загрузкой (например, squareImage для аватарок). */
  prepare?: (file: File) => Promise<File>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      onChange(await uploadToStorage(bucket, folder, prepare ? await prepare(file) : file));
    } catch (err) {
      toast.error("Ошибка загрузки: " + (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // Превью в формах — одной высоты (64px), ширина по пропорции картинки;
  // кнопки — в строку справа, «Удалить» красным текстом, как у других
  // разрушающих действий.
  return (
    <div className="flex items-center gap-3">
      {preview ?? <StorageImage bucket={bucket} value={value} alt="Превью" className="h-16 w-24" />}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Сбрасываем, чтобы повторный выбор того же файла тоже срабатывал.
            e.target.value = "";
            if (file) upload(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading || disabled}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="animate-spin" /> Загрузка…
            </>
          ) : value ? (
            replaceLabel
          ) : (
            uploadLabel
          )}
        </Button>
        {value && (
          <Button type="button" variant="destructive" size="sm" onClick={() => onChange(null)}>
            Удалить
          </Button>
        )}
      </div>
    </div>
  );
}
