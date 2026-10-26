/**
 * Видео в статье: своё видео (загруженный файл) и видео с внешних сервисов —
 * YouTube, Kinescope, VK Видео, любой iframe (решение владельца 2026-10-27).
 * Схема — components/kb/kb-document.tsx, разбор ссылок — lib/kb/embed.ts.
 */
import { useContext, useState } from "react";
import { createVideoBlockConfig, videoParse } from "@blocknote/core";
import {
  createReactBlockSpec,
  ResizableFileBlockWrapper,
  useResolveUrl,
  VideoToExternalHTML,
} from "@blocknote/react";
import { Pencil, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EMBED_ICON } from "@/lib/kb/embed-icons";
import {
  KB_EMBED_HINT,
  KB_EMBED_LABEL,
  KB_EMBED_TITLE,
  parseKbEmbed,
  type KbEmbedProvider,
} from "@/lib/kb/embed";
import { KbProtectContext } from "@/lib/kb/protect-context";

// --- Своё видео ------------------------------------------------------------------

/**
 * Видео из файла — тот же блок BlockNote, но в защищённой статье плеер без
 * «Скачать» (controlsList) и «Картинки в картинке», без меню по правой кнопке.
 */
export const KbVideoBlock = createReactBlockSpec(createVideoBlockConfig, (config) => ({
  meta: { fileBlockAccept: ["video/*"] },
  render: (props) => (
    <ResizableFileBlockWrapper
      {...(props as unknown as Parameters<typeof ResizableFileBlockWrapper>[0])}
      buttonIcon={<Video className="size-6" />}
    >
      <VideoPlayer url={props.block.props.url} width={props.block.props.previewWidth} />
    </ResizableFileBlockWrapper>
  ),
  parse: videoParse(config),
  toExternalHTML: VideoToExternalHTML as never,
  runsBefore: ["file"],
}));

function VideoPlayer({ url, width }: { url: string; width: number | undefined }) {
  const resolved = useResolveUrl(url);
  const protect = useContext(KbProtectContext);
  return (
    <video
      // Защиту включили при открытой статье — плеер пересоздаётся.
      key={protect ? "protected" : "open"}
      className="bn-visual-media"
      src={resolved.loadingState === "loading" ? url : resolved.downloadUrl}
      controls
      controlsList={protect ? "nodownload noplaybackrate" : undefined}
      disablePictureInPicture={protect}
      onContextMenu={protect ? (e) => e.preventDefault() : undefined}
      width={width || undefined}
      contentEditable={false}
      draggable={false}
    />
  );
}

// --- Видео с сервисов ------------------------------------------------------------

/** Разрешения плеера — как в коде вставки Kinescope (им хватает и YouTube, и VK). */
const IFRAME_ALLOW =
  "autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer; clipboard-write; screen-wake-lock";

type EmbedEditor = {
  isEditable: boolean;
  updateBlock: (id: string, update: { props: Partial<EmbedProps> }) => unknown;
  removeBlocks: (ids: string[]) => unknown;
};
type EmbedProps = { provider: string; url: string; source: string; caption: string };

/**
 * Видео с YouTube, Kinescope, VK Видео или любой iframe: в документе —
 * адрес плеера (`url`) и что вставил автор (`source`, чтобы поправить).
 * Новый блок сразу открывает окно ссылки с подсказкой; «Отмена» у пустого
 * блока его убирает.
 */
export const EmbedBlock = createReactBlockSpec(
  {
    type: "embed",
    propSchema: {
      provider: { default: "iframe" },
      url: { default: "" },
      source: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <Embed block={block} editor={editor as unknown as EmbedEditor} />
    ),
  },
);

function asProvider(value: string): KbEmbedProvider {
  return value in KB_EMBED_LABEL ? (value as KbEmbedProvider) : "iframe";
}

function Embed({
  block,
  editor,
}: {
  block: { id: string; props: EmbedProps };
  editor: EmbedEditor;
}) {
  const provider = asProvider(block.props.provider);
  const { url, caption } = block.props;
  const editable = editor.isEditable;
  const [open, setOpen] = useState(editable && !url);
  const Icon = EMBED_ICON[provider];

  if (!url && !editable) return null;
  return (
    <div className="kb-embed w-full" contentEditable={false}>
      {url ? (
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          <iframe
            src={url}
            title={caption || `Видео ${KB_EMBED_LABEL[provider]}`}
            allow={IFRAME_ALLOW}
            allowFullScreen
            loading="lazy"
            // Без источника YouTube и Kinescope (разрешённые домены) не играют.
            referrerPolicy="strict-origin-when-cross-origin"
            // Чужой сайт из «iframe» не уведёт портал на свою страницу.
            sandbox={
              provider === "iframe"
                ? "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms"
                : undefined
            }
            className="absolute inset-0 size-full border-0"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-muted/60 px-3 py-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon className="size-5" />
          Вставить: {KB_EMBED_TITLE[provider]}
        </button>
      )}
      {editable && url && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="size-4" />
          <span>{KB_EMBED_LABEL[provider]}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-3.5" />
            Изменить
          </button>
        </div>
      )}
      {caption && <p className="mt-1 text-sm text-muted-foreground">{caption}</p>}
      {editable && (
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o && !url) editor.removeBlocks([block.id]);
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <EmbedForm
              provider={provider}
              source={block.props.source}
              caption={caption}
              onSave={(props) => {
                editor.updateBlock(block.id, { props });
                setOpen(false);
              }}
              onCancel={() => {
                setOpen(false);
                if (!url) editor.removeBlocks([block.id]);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function EmbedForm({
  provider,
  source,
  caption: initialCaption,
  onSave,
  onCancel,
}: {
  provider: KbEmbedProvider;
  source: string;
  caption: string;
  onSave: (props: EmbedProps) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(source);
  const [caption, setCaption] = useState(initialCaption);
  const [error, setError] = useState<string | null>(null);
  const hint = KB_EMBED_HINT[provider];
  const save = () => {
    const res = parseKbEmbed(provider, value, window.location.origin);
    if ("error" in res) {
      setError(res.error);
      return;
    }
    onSave({ provider: res.provider, url: res.src, source: value.trim(), caption: caption.trim() });
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{KB_EMBED_TITLE[provider]}</DialogTitle>
        <DialogDescription>Видео покажется прямо в статье, в плеере сервиса.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <InfoNote variant="info" className="space-y-1.5">
              <p className="font-medium">Что вставить</p>
              {hint.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>
                Например: <code className="break-all">{hint.example}</code>
              </p>
            </InfoNote>
            <FormField
              label={
                provider === "iframe" ? "Код для вставки или адрес" : "Ссылка или код для вставки"
              }
              required
              error={error}
            >
              <Textarea
                value={value}
                autoFocus
                rows={3}
                placeholder={hint.example}
                className="font-mono text-xs"
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  // Enter — вставить (ссылка в одну строку), Shift+Enter — перенос.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    save();
                  }
                }}
              />
            </FormField>
            <FormField label="Подпись под видео" optional>
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit">Вставить</Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
