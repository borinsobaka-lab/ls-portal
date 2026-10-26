/**
 * Документ статьи (BlockNote, массив блоков) без React: оглавление и
 * «пустая ли статья». Схема блоков — components/kb/kb-document.tsx.
 */

export type KbHeading = { id: string; level: number; text: string };

type Inline = {
  type?: string;
  text?: string;
  content?: Inline[] | string;
  props?: Record<string, unknown>;
};
type Block = {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: Inline[] | unknown;
  children?: Block[];
};

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Inline[])
    .map((c) =>
      typeof c === "string"
        ? c
        : c.type === "mention"
          ? `@${String(c.props?.name ?? "")}`
          : (c.text ?? inlineText(c.content)),
    )
    .join("");
}

/** Строка документа для сравнения версий: вид блока, глубина, текст. */
export type KbDocLine = { kind: string; depth: number; text: string };

const KIND_LABEL: Record<string, string> = {
  image: "Картинка",
  video: "Видео",
  audio: "Аудио",
  file: "Файл",
  pdf: "PDF",
  gallery: "Картинки в ряд",
};

function cellText(cell: unknown): string {
  if (Array.isArray(cell)) return inlineText(cell);
  if (cell && typeof cell === "object" && "content" in cell) {
    return inlineText((cell as { content: unknown }).content);
  }
  return "";
}

/**
 * Документ построчно — для «Что изменилось» в версиях: абзац, заголовок,
 * пункт списка — строка с текстом; таблица — строка на ряд («a | b»);
 * файлы и картинки — «Файл: имя».
 */
export function documentLines(doc: unknown[] | null | undefined): KbDocLine[] {
  const out: KbDocLine[] = [];
  const walk = (blocks: Block[], depth: number) => {
    for (const b of blocks) {
      const kind = b.type ?? "paragraph";
      const props = b.props ?? {};
      const content = b.content as { type?: string; rows?: { cells: unknown[] }[] } | unknown;
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const rows = (content as { rows?: { cells: unknown[] }[] }).rows ?? [];
        for (const row of rows) {
          out.push({ kind: "table", depth, text: row.cells.map(cellText).join(" | ") });
        }
      } else if (KIND_LABEL[kind]) {
        const name =
          kind === "gallery"
            ? `${String(props.images ?? "[]").split('"url"').length - 1} шт.`
            : String(props.name ?? props.caption ?? "");
        out.push({ kind, depth, text: `${KIND_LABEL[kind]}${name ? `: ${name}` : ""}` });
      } else {
        const text = inlineText(b.content).trim();
        if (kind !== "columns" && kind !== "column" && (text || kind !== "paragraph")) {
          const mark = kind === "checkListItem" ? (props.checked ? "☑ " : "☐ ") : "";
          out.push({ kind, depth, text: mark + text });
        }
      }
      if (b.children?.length) walk(b.children, depth + 1);
    }
  };
  walk((Array.isArray(doc) ? doc : []) as Block[], 0);
  return out;
}

/** Заголовки документа по порядку (и во вложенных блоках) — оглавление. */
export function documentHeadings(doc: unknown[] | null | undefined): KbHeading[] {
  const out: KbHeading[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === "heading" && b.id) {
        const text = inlineText(b.content).trim();
        if (text) out.push({ id: b.id, level: Number(b.props?.level ?? 1), text });
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk((Array.isArray(doc) ? doc : []) as Block[]);
  return out;
}

/** id пунктов чек-листа документа (и во вложенных блоках). */
export function documentCheckItems(doc: unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === "checkListItem" && b.id) out.push(b.id);
      if (b.children?.length) walk(b.children);
    }
  };
  walk((Array.isArray(doc) ? doc : []) as Block[]);
  return out;
}

/** В документе нет ни текста, ни файлов (новая статья, пустой абзац). */
export function documentIsEmpty(doc: unknown[] | null | undefined): boolean {
  const walk = (blocks: Block[]): boolean =>
    blocks.every((b) => {
      const props = b.props ?? {};
      const hasFile = typeof props.url === "string" && props.url !== "";
      const hasGallery = typeof props.images === "string" && props.images !== "[]";
      const textless = !inlineText(b.content).trim();
      const plain = b.type === "paragraph" || b.type === "heading" || !b.type;
      return plain && textless && !hasFile && !hasGallery && walk(b.children ?? []);
    });
  return walk((Array.isArray(doc) ? doc : []) as Block[]);
}

// `kbfile:<путь>` — и целым полем блока, и внутри строки-JSON (у галереи
// картинки — строка `[{"url":"kbfile:…"}]`).
const FILE_RE = /kbfile:([A-Za-z0-9._/-]+)/g;

/** Пути всех своих файлов документа (в любом поле блока), без повторов. */
export function documentFilePaths(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(FILE_RE)) out.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return [...out];
}

/** Документ с заменой путей файлов (`kbfile:<старый>` → `kbfile:<новый>`). */
export function replaceDocumentFiles<T>(doc: T, paths: Map<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string")
      return v.replace(FILE_RE, (all, path: string) => {
        const to = paths.get(path);
        return to ? `kbfile:${to}` : all;
      });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(doc) as T;
}
