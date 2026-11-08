/**
 * Файлы задачи (план, 4.6, боль № 10): отдельным блоком плиткой с числом в
 * заголовке — не теряются; картинки — превью. Загрузка — с докачкой
 * (lib/resumable-upload.ts, бакет task-files, папка задачи), затем
 * task_file_add. Убрать — кто загрузил или постановщик.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Paperclip, RotateCw, WifiOff, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  downloadStorageFile,
  formatFileSize,
  startResumableUpload,
  useSignedFileUrl,
  type ResumableUpload,
} from "@/lib/resumable-upload";
import { TASK_BUCKET, taskAction, taskErrorText } from "@/lib/tasks/data";
import type { TaskFile, TaskFull } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

type Upload = { key: string; name: string; progress: number; waiting?: boolean; error?: string };

export function TaskFiles({
  task,
  canWork,
  canRemoveAll,
  me,
}: {
  task: TaskFull;
  canWork: boolean;
  canRemoveAll: boolean;
  me: string;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const handles = useRef(new Map<string, ResumableUpload>());
  const [uploads, setUploads] = useState<Upload[]>([]);

  useEffect(() => {
    const map = handles.current;
    return () => map.forEach((h) => h.cancel(false));
  }, []);

  const add = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const patch = (p: Partial<Upload>) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      const h = startResumableUpload(TASK_BUCKET, task.id, file, (s) => {
        if (s.status === "uploading") patch({ progress: s.share, waiting: false });
        else if (s.status === "waiting") patch({ progress: s.share, waiting: true });
        else if (s.status === "error") patch({ error: s.message, waiting: false });
        else {
          handles.current.delete(key);
          taskAction(qc, "task_file_add", { p_task: task.id, p_files: [s.attachment] })
            .then(() => setUploads((u) => u.filter((x) => x.key !== key)))
            .catch((e) => patch({ error: taskErrorText(e) }));
        }
      });
      handles.current.set(key, h);
    }
  };

  if (!task.files.length && !canWork) return null;
  return (
    <section
      className="space-y-3"
      onDragOver={(e) => {
        if (canWork && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!canWork) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Paperclip className="size-4 text-muted-foreground" /> Файлы
          {task.files.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground">{task.files.length}</span>
          )}
        </h3>
        {canWork && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => input.current?.click()}
            >
              <Paperclip className="size-4" /> Прикрепить
            </Button>
          </>
        )}
      </div>
      {task.files.length === 0 && uploads.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          Перетащите файлы сюда или нажмите «Прикрепить»
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {task.files.map((f) => (
            <FileTile
              key={f.id}
              file={f}
              onRemove={
                canRemoveAll || (canWork && f.uploaded_by === me)
                  ? () =>
                      void taskAction(qc, "task_file_delete", { p_id: f.id }).catch((e) =>
                        toast.error(taskErrorText(e)),
                      )
                  : undefined
              }
            />
          ))}
          {uploads.map((u) => (
            <div
              key={u.key}
              className={cn(
                "relative flex h-24 flex-col justify-end overflow-hidden rounded-lg border bg-muted/40 p-2 text-xs",
                u.error && "border-destructive text-destructive",
              )}
            >
              <span className="flex items-center gap-1.5">
                {u.waiting ? (
                  <WifiOff className="size-3.5 text-amber-600" />
                ) : (
                  !u.error && <Loader2 className="size-3.5 animate-spin" />
                )}
                <span className="truncate">{u.name}</span>
              </span>
              <span className="text-muted-foreground">
                {u.error ??
                  (u.waiting ? "нет связи — докачаем" : `${Math.round(u.progress * 100)}%`)}
              </span>
              <span className="absolute top-1 right-1 flex gap-0.5">
                {u.waiting && (
                  <button
                    type="button"
                    aria-label={`Повторить ${u.name}`}
                    className="rounded bg-background/80 p-0.5"
                    onClick={() => handles.current.get(u.key)?.resume()}
                  >
                    <RotateCw className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Убрать ${u.name}`}
                  className="rounded bg-background/80 p-0.5"
                  onClick={() => {
                    handles.current.get(u.key)?.cancel();
                    handles.current.delete(u.key);
                    setUploads((l) => l.filter((x) => x.key !== u.key));
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </span>
              {!u.error && (
                <span
                  className={cn(
                    "absolute bottom-0 left-0 h-0.5",
                    u.waiting ? "bg-amber-500" : "bg-chat-accent",
                  )}
                  style={{ width: `${Math.round(u.progress * 100)}%` }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FileTile({ file, onRemove }: { file: TaskFile; onRemove?: () => void }) {
  const image = /^image\//.test(file.mime);
  const { data: url } = useSignedFileUrl(TASK_BUCKET, image ? file.path : null);
  return (
    <div className="group relative h-24 overflow-hidden rounded-lg border bg-background">
      <button
        type="button"
        title={`Скачать «${file.name}»`}
        className="flex size-full flex-col text-left"
        onClick={() =>
          void downloadStorageFile(TASK_BUCKET, file).catch((e) => toast.error(String(e)))
        }
      >
        {image && url ? (
          <img
            src={url}
            alt={file.name}
            className="min-h-0 w-full flex-1 object-cover"
            loading="lazy"
          />
        ) : (
          <span className="flex min-h-0 flex-1 items-center justify-center bg-muted/40">
            <FileText className="size-7 text-muted-foreground" />
          </span>
        )}
        <span className="block truncate px-2 py-1 text-xs">
          {file.name}
          <span className="ml-1 text-muted-foreground">{formatFileSize(file.size)}</span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Убрать файл «${file.name}»`}
          className="absolute top-1 right-1 rounded bg-background/90 p-0.5 opacity-0 shadow-xs group-hover:opacity-100 focus:opacity-100"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
