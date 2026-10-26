import { useMemo, useState } from "react";
import { Hash, LayoutTemplate, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { DocumentText, Folder, Notebook } from "@/components/nav-icons";
import { SearchInput } from "@/components/ui/search-input";
import { KbStatusBadge } from "@/components/kb/kb-status-badge";
import { KbTagsField } from "@/components/kb/tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useKbTemplates } from "@/lib/kb/data";
import { KB_SECTION_DEFAULT_ICON, KB_SECTION_ICONS, kbSectionIcon } from "@/lib/kb/icons";
import { ancestorsOf, canNestIn, childrenOf, indexTree, isWithin } from "@/lib/kb/tree";
import type { KbHeading } from "@/lib/kb/document";
import type { KbKind, KbTreeNode } from "@/lib/kb/types";
import { cn } from "@/lib/utils";

/**
 * Куда можно положить узел вида `kind` — по порядку дерева с глубиной, для
 * выбора «куда»: папки, а для статьи — и статьи (вложенные статьи); `skip` —
 * без этой ветки (переносимый узел и его вложенное).
 */
function parentOptions(
  nodes: KbTreeNode[],
  kind: KbKind,
  skip?: string,
): { node: KbTreeNode; depth: number }[] {
  const index = indexTree(nodes);
  const out: { node: KbTreeNode; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of childrenOf(index, parent)) {
      if (!canNestIn(n, kind) || (skip && isWithin(index, n.id, skip))) continue;
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Значок места: раздел — своей иконкой, папка, статья. */
function placeIcon(n: KbTreeNode, depth: number) {
  if (n.kind === "article") return DocumentText;
  return depth === 0 ? kbSectionIcon(n.icon) : Folder;
}

const ROOT = "__root__";
const NO_TEMPLATE = "__none__";

/**
 * Новая папка или статья (название и где создать), правка названия и
 * описания папки. «Где создать» видно всегда: кнопки «Папка» / «Статья» в
 * меню и на странице папки создают в разных местах — окно показывает, где
 * именно, и даёт поменять. У раздела — папки верхнего уровня — ещё иконка
 * (в меню базы она есть только у разделов).
 */
export function KbNodeTitleForm({
  kind,
  node,
  place,
  onSave,
  onDone,
}: {
  kind: KbKind;
  /** null — новая. */
  node: KbTreeNode | null;
  /** Для новой: дерево базы и папка по умолчанию (null — верхний уровень). */
  place?: {
    nodes: KbTreeNode[];
    baseTitle: string;
    parentId: string | null;
    /** База — для выбора шаблона новой статьи. */
    baseId?: string;
    /** Шаблон, выбранный заранее (страница «Шаблоны»). */
    templateId?: string;
  };
  onSave: (
    title: string,
    description: string,
    parentId: string | null,
    /** Иконка раздела (ключ KB_SECTION_ICONS); null — обычная папка. */
    icon: string | null,
    /** Шаблон новой статьи; null — пустая. */
    templateId: string | null,
    /** Теги новой статьи (id тегов базы). */
    tags: string[],
  ) => Promise<boolean | string | null>;
  onDone: () => void;
}) {
  const [parentId, setParentId] = useState<string | null>(place?.parentId ?? null);
  const folders = useMemo(() => (place ? parentOptions(place.nodes, kind) : []), [place, kind]);
  const [title, setTitle] = useState(node?.title ?? "");
  const [description, setDescription] = useState(node?.description ?? "");
  const [icon, setIcon] = useState(node?.icon ?? KB_SECTION_DEFAULT_ICON);
  const [templateId, setTemplateId] = useState(place?.templateId ?? NO_TEMPLATE);
  const [tags, setTags] = useState<string[]>([]);
  const { data: templates } = useKbTemplates(!node && kind === "article" && !!place?.baseId);
  const template = templates?.find((t) => t.id === templateId);
  const [saving, setSaving] = useState(false);
  const isFolder = kind === "folder";
  // Раздел — папка на верхнем уровне базы: новая — по «Где создать».
  const isSection = isFolder && (node ? node.parent_id === null : parentId === null);

  const save = async () => {
    const t = title.trim();
    if (!t) {
      toast.error(isFolder ? "Укажите название папки" : "Укажите название статьи");
      return;
    }
    setSaving(true);
    try {
      // У вложенной папки иконку не показываем и не трогаем — вернётся
      // с ней наверх при переносе.
      const sectionIcon = isSection
        ? icon === KB_SECTION_DEFAULT_ICON
          ? null
          : icon
        : isFolder
          ? (node?.icon ?? null)
          : null;
      const tpl = templateId === NO_TEMPLATE ? null : templateId;
      if (await onSave(t, description.trim(), parentId, sectionIcon, tpl, tags)) onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {node
            ? isFolder
              ? isSection
                ? "Раздел"
                : "Папка"
              : "Название статьи"
            : isFolder
              ? isSection
                ? "Новый раздел"
                : "Новая папка"
              : "Новая статья"}
        </DialogTitle>
        <DialogDescription>
          {isSection
            ? "Раздел — папка верхнего уровня базы: в меню он с иконкой и выделен. Собирает статьи и папки; пустой читателям не виден."
            : isFolder
              ? "Папка собирает статьи и другие папки. Читателям пустая папка не видна."
              : "Статья создаётся черновиком: читатели увидят её после публикации."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            {place && !node && (
              <FormField
                label="Где создать"
                tip={
                  isFolder
                    ? "Папка, в которой появится новая папка. Потом её можно перенести перетаскиванием в меню."
                    : "Папка или статья, в которой появится новая статья (вложенная — на любую глубину). Потом её можно перенести перетаскиванием в меню."
                }
              >
                <Select
                  value={parentId ?? ROOT}
                  onValueChange={(v) => setParentId(v === ROOT ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT}>{place.baseTitle} — верхний уровень</SelectItem>
                    {folders.map(({ node: f, depth }) => {
                      const FolderIcon = placeIcon(f, depth);
                      return (
                        <SelectItem key={f.id} value={f.id} textValue={f.title}>
                          <span
                            style={{ paddingLeft: depth * 14 }}
                            className="flex items-center gap-2"
                          >
                            <FolderIcon className="size-4 text-muted-foreground" />
                            {f.title || "Без названия"}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {!!templates?.length && (
              <FormField
                label="Шаблон"
                tip="Статья начнётся с текста шаблона — дальше правьте как обычно. Шаблоны базы — «Шаблоны» внизу меню."
              >
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>Пустая статья</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id} textValue={t.title}>
                        <span className="flex items-center gap-2">
                          <LayoutTemplate className="size-4 text-muted-foreground" />
                          {t.title}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {template?.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
                )}
              </FormField>
            )}
            <FormField label="Название" required>
              <Input
                autoFocus
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            {!node && !isFolder && place?.baseId && (
              <FormField
                label="Теги"
                tip="По тегу статью находят в поиске и на главной базы. Выберите из тегов базы или впишите новый — он сразу появится в базе."
              >
                <KbTagsField baseId={place.baseId} value={tags} onChange={setTags} />
              </FormField>
            )}
            {isSection && (
              <FormField
                label="Иконка"
                tip="Видна у раздела в меню базы, на её главной и в окнах выбора папки. Вложенные папки и статьи — без иконок."
              >
                <Select value={icon} onValueChange={setIcon}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KB_SECTION_ICONS.map((i) => (
                      <SelectItem key={i.key} value={i.key} textValue={i.label}>
                        <span className="flex items-center gap-2">
                          <i.icon className="size-4 text-muted-foreground" />
                          {i.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {isFolder && (
              <FormField
                label="Описание"
                tip="Короткое вступление над списком статей папки — что в ней и для кого."
              >
                <Textarea
                  value={description}
                  maxLength={1000}
                  rows={3}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </FormField>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {node ? "Сохранить" : "Создать"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * «Переместить…» — выбор папки из списка: запасной путь к перетаскиванию
 * (на телефоне, в длинном дереве). Узел встаёт в конец выбранной папки.
 */
export function KbMoveForm({
  node,
  nodes,
  baseTitle,
  onMove,
  onDone,
}: {
  node: KbTreeNode;
  nodes: KbTreeNode[];
  baseTitle: string;
  onMove: (parentId: string | null, position: number) => Promise<boolean>;
  onDone: () => void;
}) {
  const index = useMemo(() => indexTree(nodes), [nodes]);
  const [target, setTarget] = useState<string | null>(node.parent_id);
  const [saving, setSaving] = useState(false);

  // Куда можно: папки (статье — и статьи) с отступом по глубине, без самого
  // узла и его вложенных.
  const folders = parentOptions(nodes, node.kind, node.id);

  const save = async () => {
    if (target === node.parent_id) {
      onDone();
      return;
    }
    setSaving(true);
    try {
      const count = childrenOf(index, target).filter((n) => n.id !== node.id).length;
      if (await onMove(target, count)) onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Переместить «{node.title || "Без названия"}»</DialogTitle>
        <DialogDescription>
          {node.kind === "folder"
            ? "Выберите папку — папка встанет в её конец."
            : "Выберите папку или статью — статья встанет в конец (внутрь статьи — вложенной)."}{" "}
          Порядок меняется перетаскиванием в меню.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-0.5">
            <ListItemButton active={target === null} onClick={() => setTarget(null)}>
              <Notebook className="text-muted-foreground" />
              {baseTitle} — верхний уровень
            </ListItemButton>
            {folders.map(({ node: f, depth }) => {
              const Icon = f.kind === "article" ? DocumentText : Folder;
              return (
                <ListItemButton
                  key={f.id}
                  active={target === f.id}
                  onClick={() => setTarget(f.id)}
                  style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
                >
                  <Icon className="text-muted-foreground" />
                  <span className="truncate">{f.title || "Без названия"}</span>
                </ListItemButton>
              );
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Переместить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * «Ссылка на статью» из меню «/» редактора: выбор статьи этой базы по
 * названию. Ссылка — адрес статьи в админке (/kb/база/статья): переименование
 * её не ломает.
 */
export function KbArticlePickerForm({
  baseId,
  nodes,
  excludeId,
  onPick,
}: {
  baseId: string;
  nodes: KbTreeNode[];
  excludeId: string;
  onPick: (link: { title: string; href: string } | null) => void;
}) {
  const index = useMemo(() => indexTree(nodes), [nodes]);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const articles = nodes
    .filter((n) => n.kind === "article" && n.id !== excludeId && n.status !== "archived")
    .filter((n) => !term || n.title.toLowerCase().includes(term))
    // Опубликованные — первыми: ссылку на черновик читатель не откроет.
    .sort((a, b) => Number(!a.reader_visible) - Number(!b.reader_visible))
    .slice(0, 50);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Ссылка на статью</DialogTitle>
        <DialogDescription>
          Ссылка встанет на место курсора. Переименование статьи её не сломает. Статью-черновик
          читатели по ссылке не откроют, пока её не опубликуют.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-3">
          <SearchInput autoFocus value={q} onChange={setQ} placeholder="Название статьи" />
          <div className="space-y-0.5">
            {articles.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Ничего не нашлось</p>
            ) : (
              articles.map((a) => (
                <ListItemButton
                  key={a.id}
                  onClick={() => onPick({ title: a.title, href: `/kb/${baseId}/${a.id}` })}
                >
                  <DocumentText className="text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{a.title || "Без названия"}</span>
                      {!a.reader_visible && (
                        <KbStatusBadge
                          status={a.status === "published" ? "draft" : a.status}
                          size="sm"
                        />
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {ancestorsOf(index, a.id)
                        .map((p) => p.title)
                        .join(" › ") || "Верхний уровень"}
                    </span>
                  </span>
                </ListItemButton>
              ))
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onPick(null)}>
          Отмена
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * «Ссылка на заголовок» — раздел этой же статьи. Ссылка — `#<id блока>`:
 * id заголовка не меняется при правке текста, так что ссылка не ломается.
 */
export function KbHeadingPickerForm({
  headings,
  onPick,
}: {
  headings: KbHeading[];
  onPick: (link: { title: string; href: string } | null) => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Ссылка на заголовок</DialogTitle>
        <DialogDescription>
          Ссылка встанет на место курсора; по ней читатель перейдёт к этому разделу статьи.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-0.5">
          {headings.map((h) => (
            <ListItemButton
              key={h.id}
              onClick={() => onPick({ title: h.text, href: `#${h.id}` })}
              style={{ paddingLeft: 12 + (Math.min(h.level, 3) - 1) * 16 }}
            >
              <Hash className="text-muted-foreground" />
              <span className={cn("min-w-0 truncate", h.level === 1 && "font-medium")}>
                {h.text}
              </span>
            </ListItemButton>
          ))}
        </div>
      </DialogBody>
    </>
  );
}
