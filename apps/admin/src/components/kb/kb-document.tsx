/**
 * Документ статьи базы знаний — редактор BlockNote (MPL-2.0, собран в наш
 * бандл, облака и внешних запросов нет; эмодзи — данные emoji-mart из
 * бандла, системные, без картинок). Один компонент на чтение и правку: `editable={false}` — читатель
 * видит ту же разметку. Грузится отдельным чанком (lazy).
 *
 * Блоки: все стандартные, кроме блока кода (по брифу не нужен), и свои —
 * «PDF» (просмотр в статье) и «Галерея» (картинки в ряд). Файлы — в закрытом
 * бакете kb-media (lib/kb/files.ts): в документе ссылка `kbfile:…`, на
 * показ — подписанная ссылка. Внешние адреса в документ не попадают: панель
 * файлов — только «Загрузить», картинки из вставленного текста (Word, Google
 * Docs) перезаливаются к нам.
 */
import "@blocknote/shadcn/style.css";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  filterSuggestionItems,
  type PartialBlock,
} from "@blocknote/core";
import { FilePanelExtension } from "@blocknote/core/extensions";
import { ru } from "@blocknote/core/locales";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  FileBlockWrapper,
  FilePanelController,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SuggestionMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useResolveUrl,
  type DefaultReactSuggestionItem,
  type FilePanelProps,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { flip, offset, shift } from "@floating-ui/react";

import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Download,
  Eraser,
  ExternalLink,
  FileText,
  Hash,
  Columns2,
  Columns3,
  Images,
  Link2,
  Loader2,
  Music,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  formatFileSize,
  isKbFile,
  KB_MAX_FILE_BYTES,
  KbFileTooLarge,
  resolveKbDownloadUrl,
  resolveKbFileUrl,
  kbArticleFolder,
  uploadKbFile,
} from "@/lib/kb/files";
import { documentHeadings, type KbHeading } from "@/lib/kb/document";
import { revealKbBlock } from "@/lib/kb/reveal-block";
import { setUploadProgress, useUploadProgress } from "@/lib/kb/upload-progress";
import { cn } from "@/lib/utils";
import { useKbDarkTheme } from "@/lib/kb/theme";
import { railSectionKey } from "@/lib/nav-sections";
import {
  KbImageLightbox,
  ZOOMABLE_IMAGES,
  type LightboxImage,
} from "@/components/kb/image-lightbox";

// --- Тексты ----------------------------------------------------------------------

/**
 * Русский словарь BlockNote с нашими правками: подсказки короче и по-человечески
 * (замечания тестирования 2026-10-25: «Введите текст или введите «/»…»,
 * «Пустой переключатель…», «Изменить URL» у новой ссылки).
 */
const dictionary = {
  ...ru,
  placeholders: {
    ...ru.placeholders,
    default: "Начните писать или нажмите «/»",
    toggleListItem: "Сворачиваемый пункт",
  },
  slash_menu: {
    ...ru.slash_menu,
    // Спойлер (№18) — сворачиваемый блок: заголовок, по нажатию — текст.
    toggle_list: {
      ...ru.slash_menu.toggle_list,
      title: "Спойлер (сворачиваемый блок)",
      subtext: "Заголовок, по нажатию раскрывается текст внутри",
      aliases: [...ru.slash_menu.toggle_list.aliases, "спойлер", "скрытый", "раскрыть", "spoiler"],
    },
    // Чек-лист (№19): читатель отмечает пункты у себя.
    check_list: {
      ...ru.slash_menu.check_list,
      title: "Чек-лист",
      subtext: "Пункты, которые читатель отмечает у себя",
      aliases: [...ru.slash_menu.check_list.aliases, "чек-лист", "чеклист", "задачи"],
    },
  },
  file_blocks: {
    ...ru.file_blocks,
    // У своего блока PDF — своя подпись (иначе «Добавить файл», как у файла).
    add_button_text: { ...ru.file_blocks.add_button_text, pdf: "Добавить PDF" },
  },
  toggle_blocks: {
    ...ru.toggle_blocks,
    add_block_button: "Внутри пусто — нажмите, чтобы добавить текст",
  },
  link_toolbar: {
    ...ru.link_toolbar,
    form: {
      ...ru.link_toolbar.form,
      url_placeholder: "Вставьте ссылку",
      title_placeholder: "Текст ссылки",
    },
  },
};

// --- Файл и аудио ---------------------------------------------------------------

/** Подпись и цвет значка файла по расширению. */
function fileKind(name: string): { ext: string; color: string } {
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(name)?.[1] ?? "").toLowerCase();
  const color =
    ext === "pdf"
      ? "#e5484d"
      : ["doc", "docx", "odt", "rtf", "txt"].includes(ext)
        ? "#3e63dd"
        : ["xls", "xlsx", "ods", "csv"].includes(ext)
          ? "#30a46c"
          : ["ppt", "pptx", "odp", "key"].includes(ext)
            ? "#f76b15"
            : ["zip", "rar", "7z"].includes(ext)
              ? "#8e8c99"
              : "#6e56cf";
  return { ext: ext ? ext.toUpperCase().slice(0, 4) : "ФАЙЛ", color };
}

/**
 * Файл — карточкой: значок формата, имя, размер и «Скачать» (стандартный
 * блок BlockNote выглядел как строка текста — замечание тестирования).
 * Тот же тип «file», что у BlockNote, плюс размер — старые документы
 * открываются как есть.
 */
const KbFileBlock = createReactBlockSpec(
  {
    type: "file",
    propSchema: {
      backgroundColor: { default: "default" },
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
      size: { default: 0 },
    },
    content: "none",
  },
  {
    render: (props) =>
      props.block.props.url ? (
        <FileCard
          url={props.block.props.url}
          name={props.block.props.name}
          size={props.block.props.size}
          caption={props.block.props.caption}
        />
      ) : (
        <FileBlockWrapper {...(props as unknown as Parameters<typeof FileBlockWrapper>[0])} />
      ),
  },
);

function FileCard({
  url,
  name,
  size,
  caption,
}: {
  url: string;
  name: string;
  size: number;
  caption: string;
}) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    resolveKbDownloadUrl(url, name || "файл")
      .then((u) => alive && setHref(u))
      .catch(() => alive && setHref(null));
    return () => {
      alive = false;
    };
  }, [url, name]);
  const kind = fileKind(name);
  return (
    <div className="kb-file w-full" contentEditable={false}>
      <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-md text-[10px] font-bold tracking-wide text-white"
          style={{ background: kind.color }}
        >
          {kind.ext}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name || "Файл"}</span>
          <span className="block text-xs text-muted-foreground">
            {kind.ext}
            {size > 0 && ` · ${formatFileSize(size)}`}
          </span>
        </span>
        <a
          href={href ?? undefined}
          download={name || true}
          aria-disabled={!href}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium no-underline hover:bg-muted"
        >
          <Download className="size-4" />
          Скачать
        </a>
      </div>
      {caption && <p className="mt-1 text-sm text-muted-foreground">{caption}</p>}
    </div>
  );
}

/** Аудио — с названием над плеером (у стандартного блока его не было). */
const KbAudioBlock = createReactBlockSpec(
  {
    type: "audio",
    propSchema: {
      backgroundColor: { default: "default" },
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
      showPreview: { default: true },
    },
    content: "none",
  },
  {
    meta: { fileBlockAccept: ["audio/*"] },
    render: (props) => (
      <FileBlockWrapper
        {...(props as unknown as Parameters<typeof FileBlockWrapper>[0])}
        buttonIcon={<Music className="size-6" />}
      >
        <AudioPlayer url={props.block.props.url} name={props.block.props.name} />
      </FileBlockWrapper>
    ),
  },
);

function AudioPlayer({ url, name }: { url: string; name: string }) {
  const resolved = useResolveUrl(url);
  return (
    <div className="kb-audio w-full rounded-lg border bg-background p-3" contentEditable={false}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Music className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{name || "Аудиозапись"}</span>
      </div>
      {resolved.loadingState === "loaded" ? (
        <audio controls preload="metadata" src={resolved.downloadUrl} className="w-full" />
      ) : (
        <div className="h-10 animate-pulse rounded bg-muted" />
      )}
    </div>
  );
}

// --- PDF ----------------------------------------------------------------------

/**
 * PDF в статье: просмотр браузера (через blob — ему не мешают заголовки
 * Storage о встраивании) и «Открыть» в новой вкладке. Высота — у блока.
 */
const PdfBlock = createReactBlockSpec(
  {
    type: "pdf",
    propSchema: {
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
      showPreview: { default: true },
    },
    content: "none",
  },
  {
    meta: { fileBlockAccept: ["application/pdf"] },
    render: (props) => (
      // Обёртка файлового блока (кнопка «Добавить файл», подпись) типизирована
      // под стандартный блок файла — свойства у PDF те же.
      <FileBlockWrapper
        {...(props as unknown as Parameters<typeof FileBlockWrapper>[0])}
        buttonIcon={<FileText className="size-6" />}
      >
        <PdfPreview url={props.block.props.url} name={props.block.props.name} />
      </FileBlockWrapper>
    ),
  },
);

function PdfPreview({ url, name }: { url: string; name: string }) {
  const resolved = useResolveUrl(url);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const href = resolved.loadingState === "loaded" ? resolved.downloadUrl : null;

  useEffect(() => {
    if (!href) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(href)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
        setBlobUrl(objectUrl);
      })
      .catch(() => setBlobUrl(null));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href]);

  return (
    <div
      className="kb-pdf w-full overflow-hidden rounded-lg border bg-muted/30"
      contentEditable={false}
    >
      <div className="flex items-center gap-2 border-b bg-background px-3 py-2 text-sm">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{name || "Документ PDF"}</span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
            Открыть
          </a>
        )}
      </div>
      {blobUrl ? (
        <iframe
          title={name || "PDF"}
          src={blobUrl}
          className="h-[70vh] max-h-[900px] w-full bg-white"
        />
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Загружаем документ…
        </div>
      )}
    </div>
  );
}

// --- Галерея ------------------------------------------------------------------

type GalleryImage = { url: string; name: string };

/** Что галерее нужно от редактора (типы BlockNote зависят от схемы). */
type GalleryEditor = {
  isEditable: boolean;
  uploadFile?: (file: File, blockId?: string) => Promise<string | Record<string, unknown>>;
  updateBlock: (id: string, update: { props: { images: string } }) => unknown;
  getBlock: (id: string) => { props: { images: string } } | undefined;
};

function parseImages(raw: string): GalleryImage[] {
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list)
      ? list.filter((i): i is GalleryImage => !!i && typeof (i as GalleryImage).url === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Несколько картинок в один ряд (по брифу: «нельзя поставить 2 картинки в
 * ряд»). Колонок — сколько картинок, до четырёх; дальше — следующий ряд.
 * На телефоне — по две.
 */
const GalleryBlock = createReactBlockSpec(
  {
    type: "gallery",
    propSchema: {
      images: { default: "[]" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <Gallery block={block} editor={editor as unknown as GalleryEditor} />
    ),
  },
);

function Gallery({
  block,
  editor,
}: {
  block: { id: string; props: { images: string } };
  editor: GalleryEditor;
}) {
  const images = parseImages(block.props.images);
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const progress = useUploadProgress(block.id);
  const editable = editor.isEditable;
  const set = (list: GalleryImage[]) =>
    editor.updateBlock(block.id, { props: { images: JSON.stringify(list) } });

  const add = async (files: FileList | null) => {
    if (!files?.length || !editor.uploadFile) return;
    const picked = [...files].filter((f) => f.type.startsWith("image/"));
    setUploading((n) => n + picked.length);
    const added: GalleryImage[] = [];
    for (const f of picked) {
      try {
        const url = (await editor.uploadFile(f, block.id)) as string;
        added.push({ url, name: f.name });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось загрузить картинку");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    // Документ мог поменяться, пока грузили, — берём свежий блок.
    const current = editor.getBlock(block.id);
    if (current) set([...parseImages(current.props.images), ...added]);
  };

  const cols = Math.min(Math.max(images.length, 1), 4);
  return (
    <div className="kb-gallery w-full" contentEditable={false}>
      {images.length > 0 && (
        <div
          className="grid gap-2 max-sm:!grid-cols-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {images.map((img, i) => (
            <GalleryItem
              key={`${img.url}-${i}`}
              image={img}
              editable={editable}
              onRemove={() => set(images.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      {editable && (
        <div className={cn("flex items-center gap-2", images.length > 0 && "mt-2")}>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : images.length ? (
              <Plus className="size-4" />
            ) : (
              <Images className="size-4" />
            )}
            {uploading
              ? `Загружаем${uploading > 1 ? ` (ещё ${uploading})` : ""}… ${Math.round((progress ?? 0) * 100)}%`
              : images.length
                ? "Добавить картинки"
                : "Картинки в ряд — выберите файлы"}
          </button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void add(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}

function GalleryItem({
  image,
  editable,
  onRemove,
}: {
  image: GalleryImage;
  editable: boolean;
  onRemove: () => void;
}) {
  const resolved = useResolveUrl(image.url);
  return (
    <figure className="group/gi relative overflow-hidden rounded-md bg-muted/40">
      {resolved.loadingState === "loaded" ? (
        // У читателя нажатие открывает картинку в окне (KbImageLightbox).
        <img
          src={resolved.downloadUrl}
          alt={image.name}
          className="h-full max-h-[420px] w-full object-cover"
        />
      ) : (
        <div className="aspect-[4/3] animate-pulse" />
      )}
      {editable && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Убрать «${image.name}»`}
          className="absolute top-1.5 right-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/gi:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-4" />
        </button>
      )}
    </figure>
  );
}

// --- Колонки -----------------------------------------------------------------------

/**
 * Колонки (№17) — свои блоки, без платного пакета BlockNote: «Колонки» —
 * ряд, его вложенные блоки «Колонка» встают рядом (CSS-сетка в styles.css),
 * внутри колонки — обычные блоки. Сами блоки-обёртки невидимы; на
 * телефоне колонки идут друг под другом.
 */
const ColumnsBlock = createReactBlockSpec(
  { type: "columns", propSchema: {}, content: "none" },
  {
    // В правке — подпись над рядом (за неё ряд перетаскивают и удаляют
    // целиком), у читателя её нет.
    render: ({ editor }) => (
      <div className="kb-columns-anchor" contentEditable={false}>
        {editor.isEditable ? "Колонки" : null}
      </div>
    ),
  },
);
const ColumnBlock = createReactBlockSpec(
  { type: "column", propSchema: {}, content: "none" },
  { render: () => <div className="kb-column-anchor" contentEditable={false} /> },
);

/** Новый ряд колонок: в каждой — пустой абзац, куда сразу писать. */
function columnsBlock(count: number) {
  return {
    type: "columns" as const,
    children: Array.from({ length: count }, () => ({
      type: "column" as const,
      children: [{ type: "paragraph" as const }],
    })),
  };
}

/** Курсор — в первую колонку нового ряда (иначе текст уходил мимо). */
function focusFirstColumn(editor: KbEditor, columnsId: string | undefined) {
  const first = columnsId ? editor.getBlock(columnsId)?.children[0]?.children[0] : undefined;
  if (first) editor.setTextCursorPosition(first, "start");
}

/**
 * Колонка без содержимого — пустой абзац в неё (иначе в неё не поставить
 * курсор); ряд без колонок удаляется.
 */
function normalizeColumns(editor: KbEditor) {
  for (const b of walkBlocks(editor.document as unknown as AnyBlock[])) {
    if (b.type === "columns" && !b.children?.length) {
      editor.removeBlocks([b.id]);
      return;
    }
    if (b.type === "column" && !b.children?.length) {
      editor.updateBlock(b.id, { children: [{ type: "paragraph" }] } as never);
      return;
    }
  }
}

// --- Упоминания ----------------------------------------------------------------------

/** Упоминание сотрудника (№28): «@Имя» в тексте — меню по «@» в редакторе. */
const Mention = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: { userId: { default: "" }, name: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <span className="kb-mention" data-user-id={inlineContent.props.userId}>
        @{inlineContent.props.name}
      </span>
    ),
  },
);

type MentionCandidate = { user_id: string; full_name: string; avatar_url: string | null };

// --- Схема ----------------------------------------------------------------------

// Блок кода по брифу не нужен — из схемы и меню «/» его убираем.
const { codeBlock: _codeBlock, ...blockSpecs } = defaultBlockSpecs;

const kbSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...blockSpecs,
    file: KbFileBlock(),
    audio: KbAudioBlock(),
    pdf: PdfBlock(),
    gallery: GalleryBlock(),
    columns: ColumnsBlock(),
    column: ColumnBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: Mention,
  },
});

/** Заголовки 4–6 уровня базе знаний не нужны — из меню «/» убраны. */
const HIDDEN_SLASH_ITEMS = new Set(["heading_4", "heading_5", "heading_6"]);

/**
 * Пустой абзац после блока-файла в конце документа: иначе под PDF или
 * галереей последним блоком не поставить курсор (замечание тестирования).
 */
function ensureTrailingParagraph(editor: KbEditor) {
  const doc = editor.document;
  const last = doc[doc.length - 1];
  if (last && last.type !== "paragraph" && !Array.isArray(last.content)) {
    editor.insertBlocks([{ type: "paragraph" }], last, "after");
  }
}

type KbEditor = typeof kbSchema.BlockNoteEditor;

/** Ссылка на статью базы для меню «/» и всплывающего «Ссылка на статью». */
export type KbArticleLink = { title: string; href: string };

function slashItems(
  editor: KbEditor,
  onPickArticle?: () => Promise<KbArticleLink | null>,
  onPickHeading?: (headings: KbHeading[]) => Promise<KbArticleLink | null>,
): DefaultReactSuggestionItem[] {
  const insertBlock = (block: PartialBlock<typeof kbSchema.blockSchema>) => {
    const cur = editor.getTextCursorPosition().block;
    const empty = Array.isArray(cur.content) && cur.content.length === 0;
    const inserted = empty
      ? editor.replaceBlocks([cur], [block]).insertedBlocks
      : editor.insertBlocks([block], cur, "after");
    ensureTrailingParagraph(editor);
    return inserted[0]?.id;
  };
  const items = getDefaultReactSlashMenuItems(editor).filter(
    (i) => !("key" in i) || !HIDDEN_SLASH_ITEMS.has(String(i.key)),
  );
  // Меню группирует подряд идущие пункты: свой пункт встаёт сразу после
  // последнего из его группы, иначе группа выходит в меню дважды.
  const add = (item: DefaultReactSuggestionItem) => {
    const groups = items.map((i) => i.group);
    const at = groups.lastIndexOf(item.group);
    items.splice(at < 0 ? items.length : at + 1, 0, item);
  };
  const media = ru.slash_menu.image.group;
  const basic = ru.slash_menu.paragraph.group;
  const custom: DefaultReactSuggestionItem[] = [
    {
      title: "PDF",
      subtext: "Документ с просмотром прямо в статье",
      aliases: ["pdf", "пдф", "документ"],
      group: media,
      icon: <FileText className="size-[18px]" />,
      onItemClick: () => {
        // Сразу окно выбора файла — как у картинки, видео и аудио.
        const id = insertBlock({ type: "pdf" });
        if (id) editor.getExtension(FilePanelExtension)?.showMenu(id);
      },
    },
    {
      title: "Две колонки",
      subtext: "Текст, картинки и списки рядом — в две колонки",
      aliases: ["колонки", "столбцы", "columns", "две"],
      group: basic,
      icon: <Columns2 className="size-[18px]" />,
      onItemClick: () => focusFirstColumn(editor, insertBlock(columnsBlock(2))),
    },
    {
      title: "Три колонки",
      subtext: "Три колонки рядом",
      aliases: ["колонки", "столбцы", "columns", "три"],
      group: basic,
      icon: <Columns3 className="size-[18px]" />,
      onItemClick: () => focusFirstColumn(editor, insertBlock(columnsBlock(3))),
    },
    {
      title: "Картинки в ряд",
      subtext: "Две-четыре картинки рядом",
      aliases: ["галерея", "ряд", "картинки", "фото"],
      group: media,
      icon: <Images className="size-[18px]" />,
      onItemClick: () => insertBlock({ type: "gallery" }),
    },
  ];
  custom.forEach(add);
  if (onPickArticle) {
    add({
      title: "Ссылка на статью",
      subtext: "Другая статья этой базы знаний",
      aliases: ["ссылка", "статья", "link"],
      group: basic,
      icon: <Link2 className="size-[18px]" />,
      onItemClick: async () => {
        const link = await onPickArticle();
        if (!link) return;
        editor.insertInlineContent([{ type: "link", href: link.href, content: link.title }, " "]);
      },
    });
  }
  if (onPickHeading) {
    add({
      title: "Ссылка на заголовок",
      subtext: "Раздел этой статьи — по ссылке читатель перейдёт к нему",
      aliases: ["заголовок", "раздел", "якорь", "anchor"],
      group: basic,
      icon: <Hash className="size-[18px]" />,
      onItemClick: async () => {
        const headings = documentHeadings(editor.document as unknown[]);
        if (headings.length === 0) {
          toast.info("В статье пока нет заголовков — добавьте их, и на них можно будет сослаться.");
          return;
        }
        const link = await onPickHeading(headings);
        if (!link) return;
        editor.insertInlineContent([{ type: "link", href: link.href, content: link.title }, " "]);
      },
    });
  }
  return items;
}

/**
 * «Очистить форматирование» в панели над выделением: снимает жирный,
 * курсив, подчёркивание, зачёркивание, код в строке и цвета (ссылки
 * остаются).
 */
function ClearFormattingButton() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  if (!Components || !editor.isEditable) return null;
  return (
    <Components.FormattingToolbar.Button
      mainTooltip="Очистить форматирование"
      label="Очистить форматирование"
      icon={<Eraser className="size-4" />}
      onClick={() => {
        editor.removeStyles({
          bold: true,
          italic: true,
          underline: true,
          strike: true,
          code: true,
          textColor: "default",
          backgroundColor: "default",
        });
        editor.focus();
      }}
    />
  );
}

function KbFormattingToolbar() {
  return (
    <FormattingToolbar>
      {getFormattingToolbarItems()}
      <ClearFormattingButton key="clearFormattingButton" />
    </FormattingToolbar>
  );
}

/** Прокрутить к блоку статьи (ссылка на заголовок, `#<id блока>` в адресе). */
function scrollToBlock(root: HTMLElement | null, id: string, smooth: boolean): boolean {
  const el = revealKbBlock(root, id);
  if (!el) return false;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  return true;
}

// --- Перезаливка картинок из вставленного текста ----------------------------------

type AnyBlock = { id: string; type: string; props: Record<string, unknown>; children?: AnyBlock[] };

function* walkBlocks(blocks: AnyBlock[]): Generator<AnyBlock> {
  for (const b of blocks) {
    yield b;
    if (b.children?.length) yield* walkBlocks(b.children);
  }
}

/** Картинки из Word (data:) и Google Docs (временные ссылки) — к нам в бакет. */
async function reuploadForeignImages(
  editor: KbEditor,
  pending: Set<string>,
  upload: (file: File) => Promise<string>,
) {
  for (const b of walkBlocks(editor.document as unknown as AnyBlock[])) {
    if (b.type !== "image") continue;
    const url = String(b.props.url ?? "");
    if (!url || isKbFile(url) || pending.has(b.id)) continue;
    pending.add(b.id);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg").slice(0, 5);
      const file = new File([blob], `pasted.${ext}`, { type: blob.type || "image/png" });
      const kbUrl = await upload(file);
      if (editor.getBlock(b.id)) editor.updateBlock(b.id, { props: { url: kbUrl } } as never);
    } catch {
      toast.error(
        "Картинку из вставленного текста не удалось перенести к нам — загрузите её файлом (кнопка «Загрузить» у картинки).",
      );
    } finally {
      pending.delete(b.id);
    }
  }
}

/** Какие файлы выбирать в панели — по типу блока. */
const FILE_ACCEPT: Record<string, string> = {
  image: "image/*",
  video: "video/mp4,video/quicktime,video/webm,video/*",
  audio: "audio/*",
  pdf: "application/pdf",
};
/** Подходит ли файл блоку: в блок «Картинка» PDF не загрузить. */
const FILE_FITS: Record<string, (f: File) => boolean> = {
  image: (f) => f.type.startsWith("image/"),
  video: (f) => f.type.startsWith("video/"),
  audio: (f) => f.type.startsWith("audio/"),
  pdf: (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
};
const FILE_WHAT: Record<string, string> = {
  image: "картинка",
  video: "видео",
  audio: "аудиозапись",
  pdf: "PDF",
};
const FILE_HINT: Record<string, string> = {
  image: "PNG, JPG, GIF или WEBP",
  video: "MP4 (H.264) — играет во всех браузерах; MOV с iPhone — не везде",
  audio: "MP3, WAV или M4A — например, запись звонка",
  pdf: "Документ PDF — откроется прямо в статье",
  file: "Любой документ: Word, Excel, презентация, архив",
};

/**
 * Панель файла — только загрузка с компьютера: вкладка «Ссылка» BlockNote
 * вставляла бы файл с чужого сервера (решение владельца — всё на нашем).
 * Своя вёрстка вместо голого «Choose File» браузера: кнопка, что подходит,
 * лимит.
 */
function UploadOnlyFilePanel({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor();
  const input = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState<File | null>(null);
  const progress = useUploadProgress(blockId);
  const block = editor.getBlock(blockId);
  const type = block?.type ?? "file";

  const pick = async (file: File | undefined) => {
    if (!file || !editor.uploadFile) return;
    const fits = FILE_FITS[type];
    if (fits && !fits(file)) {
      toast.error(`«${file.name}» — не ${FILE_WHAT[type]}. ${FILE_HINT[type]}.`);
      return;
    }
    setLoading(file);
    try {
      const url = await editor.uploadFile(file, blockId);
      editor.updateBlock(blockId, {
        props:
          type === "file" ? { name: file.name, url, size: file.size } : { name: file.name, url },
      } as never);
    } catch {
      // текст ошибки уже показал uploadFile
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="bn-panel w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
      {loading ? (
        <UploadProgress file={loading} share={progress} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            Выбрать файл
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            {FILE_HINT[type] ?? FILE_HINT.file}. До {formatFileSize(KB_MAX_FILE_BYTES)}.
          </p>
        </>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={FILE_ACCEPT[type]}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Кружок с инициалами в меню «@». */
function MentionAvatar({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
      {letters}
    </span>
  );
}

/** Полоса загрузки: имя, сколько отправлено из скольких, проценты. */
function UploadProgress({ file, share }: { file: File; share: number | null }) {
  const pct = Math.round((share ?? 0) * 100);
  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatFileSize(Math.round((share ?? 0) * file.size))} из {formatFileSize(file.size)}
      </p>
    </div>
  );
}

/**
 * Tab в последней ячейке таблицы — новая строка и курсор в её первую ячейку
 * (как в Word и Google Docs; у BlockNote Tab там ничего не делал).
 */
function addTableRowAtEnd(editor: KbEditor): boolean {
  const { $from } = editor.prosemirrorState.selection;
  let d = $from.depth;
  while (d > 0 && !["tableCell", "tableHeader"].includes($from.node(d).type.name)) d--;
  if (d < 2) return false;
  const row = $from.node(d - 1);
  const table = $from.node(d - 2);
  if ($from.index(d - 1) !== row.childCount - 1 || $from.index(d - 2) !== table.childCount - 1)
    return false;
  const block = editor.getTextCursorPosition().block;
  if (block.type !== "table" || !block.content || Array.isArray(block.content)) return false;
  const content = block.content as {
    type: "tableContent";
    rows: { cells: unknown[] }[];
  };
  const lastRow = content.rows[content.rows.length - 1];
  const empty = lastRow.cells.map((c) =>
    Array.isArray(c) ? [] : { ...(c as Record<string, unknown>), content: [] },
  );
  editor.updateBlock(block, {
    content: { ...content, rows: [...content.rows, { cells: empty }] },
  } as never);
  // Курсор — в первую ячейку новой строки: тот же Tab из предпоследней
  // ячейки таблица уже умеет. Сразу, в этом же обработчике: отложенный
  // переход (через кадр) опаздывал, если печатать сразу после Tab, — текст
  // уходил в прежнюю ячейку (замечание тестирования 2026-10-25).
  const view = editor.prosemirrorView;
  const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
  view.someProp("handleKeyDown", (handle) => handle(view, tab));
  return true;
}

// --- Компонент --------------------------------------------------------------------

export function KbDocument({
  baseId,
  nodeId,
  initial,
  editable,
  onChange,
  onHeadings,
  onPickArticle,
  onPickHeading,
  onReady,
  checks,
  filesFolder,
}: {
  /** База статьи; без неё (урок «Академии») — без упоминаний «@», файлы — в filesFolder. */
  baseId?: string;
  nodeId: string;
  /** Куда грузить новые файлы; по умолчанию — папка статьи (у шаблона — kbTemplateFolder). */
  filesFolder?: string;
  /** Документ BlockNote (массив блоков); null или пусто — пустая статья. */
  initial: unknown[] | null;
  editable: boolean;
  onChange?: (doc: unknown[]) => void;
  /** Заголовки — для оглавления (при каждой правке). */
  onHeadings?: (headings: KbHeading[]) => void;
  /** «Ссылка на статью» в меню «/»: окно выбора статьи. */
  onPickArticle?: () => Promise<KbArticleLink | null>;
  /** «Ссылка на заголовок» в меню «/»: окно выбора заголовка этой статьи. */
  onPickHeading?: (headings: KbHeading[]) => Promise<KbArticleLink | null>;
  /** Документ, каким его открыли (уже с id блоков) — точка отсчёта правок. */
  onReady?: (doc: unknown[]) => void;
  /**
   * Чек-лист у читателя: свои отметки (kb_checks), а не те, что в тексте
   * у автора. Без него — пункты как в документе.
   */
  checks?: { checked: Set<string>; onToggle: (blockId: string) => void };
}) {
  const navigate = useNavigate();
  // Тёмная тема базы знаний — только в самой базе (редактор берёт и «Академия»).
  const [kbDark] = useKbDarkTheme();
  const inKb = useRouterState({ select: (st) => railSectionKey(st.location.pathname) === "kb" });
  const dark = kbDark && inKb;
  // Кого можно упомянуть через «@» — только в режиме правки.
  const { data: candidates } = useQuery({
    queryKey: ["kb_mention_candidates", baseId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("kb_mention_candidates", { p_base: baseId });
      if (error) throw new Error(error.message);
      return (data ?? []) as MentionCandidate[];
    },
    enabled: editable && !!baseId,
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить сотрудников для упоминаний" },
  });
  const pending = useRef(new Set<string>());
  const upload = useMemo(
    () => async (file: File, blockId?: string) => {
      try {
        // Прогресс — по блоку: его показывает панель файла или галерея.
        return await uploadKbFile(
          filesFolder ?? kbArticleFolder(baseId ?? "", nodeId),
          file,
          blockId ? (share) => setUploadProgress(blockId, share) : undefined,
        );
      } catch (e) {
        toast.error(
          e instanceof KbFileTooLarge
            ? e.message
            : `Не удалось загрузить файл: ${(e as Error).message}`,
        );
        throw e;
      } finally {
        if (blockId) setUploadProgress(blockId, null);
      }
    },
    [baseId, nodeId, filesFolder],
  );

  const editor = useCreateBlockNote(
    {
      schema: kbSchema,
      dictionary,
      initialContent:
        Array.isArray(initial) && initial.length > 0
          ? (initial as PartialBlock<typeof kbSchema.blockSchema>[])
          : undefined,
      uploadFile: upload,
      resolveFileUrl: resolveKbFileUrl,
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      tabBehavior: "prefer-indent",
    },
    [nodeId],
  );

  // Панель форматирования не выходит за края текста статьи: по умолчанию
  // её держит только край рабочей области, и справа она наезжала на
  // оглавление (замечание тестирования 2026-10-25).
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const toolbarFloating = useMemo(
    () => ({
      useFloatingOptions: {
        middleware: [
          offset(10),
          shift({ boundary: box ?? "clippingAncestors", padding: 16 }),
          flip(),
        ],
      },
    }),
    [box],
  );

  // Оглавление и точка отсчёта — при открытии документа; дальше — onChange.
  const mountRef = useRef({ onHeadings, onReady });
  mountRef.current = { onHeadings, onReady };
  useEffect(() => {
    const doc = editor.document as unknown[];
    mountRef.current.onHeadings?.(documentHeadings(doc));
    mountRef.current.onReady?.(doc);
  }, [editor]);

  // Адрес с #id блока (ссылка на заголовок из другой статьи или
  // присланная) — сразу к нему, когда документ нарисован.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || !box) return;
    const t = window.setTimeout(() => scrollToBlock(box, id, false), 150);
    return () => window.clearTimeout(t);
  }, [box, nodeId]);

  // Картинка статьи по нажатию — в окне на весь экран, а не в новой вкладке.
  const [lightbox, setLightbox] = useState<{
    images: LightboxImage[];
    index: number;
    protect: boolean;
  } | null>(null);
  const openImage = (img: HTMLImageElement) => {
    const all = [...(box?.querySelectorAll<HTMLImageElement>(ZOOMABLE_IMAGES) ?? [])].filter(
      (el) => el.currentSrc || el.src,
    );
    const index = Math.max(all.indexOf(img), 0);
    setLightbox({
      images: all.map((el) => ({ src: el.currentSrc || el.src, name: el.alt })),
      index,
      protect: !!img.closest(".kb-no-copy"),
    });
  };

  return (
    <>
      <div
        ref={setBox}
        className={cn(
          "kb-document",
          !editable && "kb-document-read",
          !editable && checks && "kb-own-checks",
        )}
        onKeyDownCapture={(e) => {
          if (editable && e.key === "Tab" && !e.shiftKey && addTableRowAtEnd(editor)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={(e) => {
          // Ссылки на статьи базы — переходом внутри админки, без перезагрузки;
          // на заголовок этой статьи — прокруткой к нему (адрес с #id можно
          // скопировать и прислать).
          if (editable) return;
          const img = (e.target as HTMLElement).closest<HTMLImageElement>(ZOOMABLE_IMAGES);
          if (img) {
            e.preventDefault();
            openImage(img);
            return;
          }
          if (checks) {
            const item = (e.target as HTMLElement).closest<HTMLElement>(
              '[data-content-type="checkListItem"] > div:has(> input)',
            );
            const id = item?.closest("[data-id]")?.getAttribute("data-id");
            if (id) {
              checks.onToggle(id);
              return;
            }
          }
          const a = (e.target as HTMLElement).closest("a");
          const href = a?.getAttribute("href");
          if (href?.startsWith("#") && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            const id = decodeURIComponent(href.slice(1));
            if (scrollToBlock(box, id, true)) window.history.replaceState(null, "", `#${id}`);
            return;
          }
          if (!href || !href.startsWith("/kb/") || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          void navigate({ to: href });
        }}
      >
        {checks && !editable && (
          // Галочка и зачёркивание — у своих отметок читателя, а не у
          // отмеченного автором (флажок BlockNote скрыт, рисует styles.css).
          <style>
            {[...checks.checked]
              .map((id) => {
                const item = `.kb-own-checks [data-id="${CSS.escape(id)}"] > .bn-block > [data-content-type="checkListItem"]`;
                return `${item} .bn-inline-content{text-decoration:line-through;opacity:.6}${item} > div:has(> input)::before{background-color:var(--primary);border-color:var(--primary);background-image:var(--kb-check-mark)}`;
              })
              .join("")}
          </style>
        )}
        <BlockNoteView
          editor={editor}
          editable={editable}
          theme={dark ? "dark" : "light"}
          filePanel={false}
          slashMenu={false}
          formattingToolbar={false}
          onChange={() => {
            const doc = editor.document as unknown[];
            onChange?.(doc);
            onHeadings?.(documentHeadings(doc));
            if (editable) {
              normalizeColumns(editor);
              ensureTrailingParagraph(editor);
              void reuploadForeignImages(editor, pending.current, upload);
            }
          }}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(slashItems(editor, onPickArticle, onPickHeading), query)
            }
          />
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) =>
              filterSuggestionItems(
                (candidates ?? []).map((c) => ({
                  title: c.full_name,
                  aliases: c.full_name.split(/\s+/),
                  group: "Сотрудники с доступом к базе",
                  icon: <MentionAvatar name={c.full_name} />,
                  onItemClick: () =>
                    editor.insertInlineContent([
                      { type: "mention", props: { userId: c.user_id, name: c.full_name } },
                      " ",
                    ]),
                })),
                query,
              )
            }
          />
          <FilePanelController filePanel={UploadOnlyFilePanel} />
          <FormattingToolbarController
            formattingToolbar={KbFormattingToolbar}
            floatingUIOptions={toolbarFloating}
          />
        </BlockNoteView>
      </div>
      {lightbox && (
        <KbImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          protect={lightbox.protect}
          onIndex={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
