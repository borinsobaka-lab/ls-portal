import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Clock,
  CloudOff,
  Copy,
  Ellipsis,
  FilePlus,
  FolderInput,
  FolderPlus,
  Hash,
  History,
  LayoutTemplate,
  Link2,
  Loader2,
  Pencil,
  Send,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
import { DocumentText, Folder } from "@/components/nav-icons";
import { KbArticleBodySkeleton, KbFolderBodySkeleton } from "@/components/page-skeletons";
import { KbBaseForm } from "@/components/kb/base-dialog";
import { KbArticlePager, KbArticleRating } from "@/components/kb/article-footer";
import { KbPageSettingsForm } from "@/components/kb/page-settings-dialog";
import { KbProtectForm } from "@/components/kb/protect-dialog";
import { KbProtectedArea } from "@/components/kb/protected-area";
import { KbSaveTemplateForm } from "@/components/kb/template-dialogs";
import { useReadingTracker } from "@/components/kb/use-reading-tracker";
import { KbVersionsForm } from "@/components/kb/versions-dialog";
import {
  KbArticlePickerForm,
  KbHeadingPickerForm,
  KbMoveForm,
  KbNodeTitleForm,
} from "@/components/kb/node-dialogs";
import { KbDraftBadge, KbStatusBadge } from "@/components/kb/kb-status-badge";
import {
  KbArticleTags,
  KbArticleTagsEditor,
  KbTagChip,
  KbTagsManageForm,
} from "@/components/kb/tags";
import { useDraftAutosave, type AutosaveState } from "@/components/kb/use-draft-autosave";
import { useKbActions } from "@/components/kb/use-kb-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { canEditKb } from "@/lib/kb/access";
import {
  invalidateKb,
  KB_FAVORITES_KEY,
  kbBasesQuery,
  kbErrorText,
  useKbAuthorProfiles,
  useKbAuthors,
  useKbChecks,
  useKbDraft,
  useKbDrafts,
  useKbFavorites,
  useKbNode,
  useKbNodeTags,
  useKbRecentReads,
  useKbTree,
  type KbRevision,
} from "@/lib/kb/data";
import { documentCheckItems, documentIsEmpty, type KbHeading } from "@/lib/kb/document";
import { kbIcon, kbSectionIcon } from "@/lib/kb/icons";
import { kbBlockShown, revealKbBlock } from "@/lib/kb/reveal-block";
import {
  ancestorsOf,
  articleCount,
  childrenOf,
  indexTree,
  readerNodes,
  type KbTreeIndex,
} from "@/lib/kb/tree";
import type { KbBase, KbTreeNode } from "@/lib/kb/types";
import { formatUpdatedAgo } from "@/lib/kb/analytics";
import { nodesWithTag, tagArticleCounts } from "@/lib/kb/tags";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { KbArticleLink } from "@/components/kb/kb-document";

// Редактор (BlockNote, ProseMirror) — отдельным чанком: остальным разделам
// админки он не нужен, а читателю грузится вместе со статьёй.
const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/**
 * Страница базы знаний: главная базы (nodeId — null), папка или статья.
 * Главная и папка — описание и список вложенного (ссылка на папку открывает
 * её содержимое — боль брифа). Статья — текст, оглавление и «Обновлено»; у
 * редактора — правка на месте (автосохранение черновика) и публикация.
 */
export function KbNodePage({
  baseId,
  nodeId,
  edit,
  tagId,
}: {
  baseId: string;
  nodeId: string | null;
  edit?: boolean;
  /** Главная базы: статьи с этим тегом. */
  tagId?: string;
}) {
  const access = useAdminAccess();
  const level = access?.kbAdmin ? "manage" : access?.kb?.[baseId];
  const canEdit = canEditKb(level);
  const { data: bases } = useQuery(kbBasesQuery);
  const base = bases?.find((b) => b.id === baseId);
  const { data: allNodes, isLoading, error } = useKbTree(baseId);
  const nodes = useMemo(
    () => (canEdit ? (allNodes ?? []) : readerNodes(allNodes ?? [])),
    [allNodes, canEdit],
  );
  const index = useMemo(() => indexTree(nodes), [nodes]);
  const node = nodeId ? index.byId.get(nodeId) : undefined;
  const title = base?.title ?? "База знаний";

  if (error && !allNodes) {
    return (
      <AdminShell title={title}>
        <InfoNote variant="warning">{error.message}</InfoNote>
      </AdminShell>
    );
  }
  if (isLoading || !access) {
    return (
      <AdminShell title={title}>
        {nodeId ? <KbArticleBodySkeleton /> : <KbFolderBodySkeleton />}
      </AdminShell>
    );
  }
  if (nodeId && !node) {
    return (
      <AdminShell title={title}>
        <div className="mx-auto max-w-3xl rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
          Статья не найдена: её удалили, перенесли в архив или сняли с публикации.{" "}
          <Link
            to="/kb/$baseId"
            params={{ baseId }}
            className="font-medium text-foreground underline"
          >
            К содержанию базы
          </Link>
        </div>
      </AdminShell>
    );
  }
  if (node?.kind === "article") {
    return (
      <ArticleView
        key={node.id}
        baseId={baseId}
        baseTitle={title}
        baseProtects={!!base?.protect_content}
        node={node}
        nodes={nodes}
        index={index}
        canEdit={canEdit}
        initialEdit={!!edit && canEdit}
      />
    );
  }
  return (
    <FolderView
      baseId={baseId}
      baseTitle={title}
      baseDescription={base?.description ?? ""}
      baseIcon={base?.icon ?? null}
      base={access?.kbAdmin ? base : undefined}
      folder={node ?? null}
      nodes={nodes}
      index={index}
      canEdit={canEdit}
      tagId={nodeId ? undefined : tagId}
    />
  );
}

/** Иконка папки в списке: у раздела (верхний уровень) — своя. */
function ItemFolderIcon({ node }: { node: KbTreeNode }) {
  const Icon = node.parent_id === null ? kbSectionIcon(node.icon) : Folder;
  return <Icon className="size-5 shrink-0 text-muted-foreground" />;
}

/**
 * Сколько статей видят читатели; редактору — ещё и сколько не опубликовано
 * (замечание тестирования: черновики попадали в счётчик).
 */
function ArticleCounter({
  index,
  folderId,
  canEdit,
  long,
}: {
  index: KbTreeIndex;
  folderId: string | null;
  canEdit: boolean;
  long?: boolean;
}) {
  const visible = articleCount(index, folderId, true);
  const hidden = canEdit ? articleCount(index, folderId) - visible : 0;
  const tail = hidden > 0 ? ` + ${hidden} не опубл.` : "";
  return <>{long ? `Опубликовано статей: ${visible}${tail}` : `${visible} ст.${tail}`}</>;
}

/**
 * Главная базы (№4–5): своё избранное, недавно открытые и недавно
 * обновлённые статьи — над списком разделов. Пустые блоки не показываются.
 */
function BaseHomeLists({ baseId, index }: { baseId: string; index: KbTreeIndex }) {
  const { data: me } = useStaffProfile();
  const { data: favorites } = useKbFavorites(baseId);
  const { data: reads } = useKbRecentReads(baseId, me?.id);
  const pick = (ids: string[]) =>
    ids
      .map((id) => index.byId.get(id))
      .filter((n): n is KbTreeNode => !!n && n.status !== "archived")
      .slice(0, 5);
  const fav = pick(favorites ?? []);
  const recent = pick((reads ?? []).map((r) => r.node_id));
  const updated = [...index.byId.values()]
    .filter((n) => n.kind === "article" && n.reader_visible && n.published_at)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, 5);
  const blocks = [
    {
      title: "Избранное",
      icon: Star,
      nodes: fav,
      empty: "Нажмите ☆ у статьи — она появится здесь.",
    },
    { title: "Недавно открывали", icon: History, nodes: recent, empty: "" },
    { title: "Обновлено недавно", icon: Clock, nodes: updated, empty: "" },
  ].filter((b) => b.nodes.length > 0 || b.empty);
  if (blocks.every((b) => b.nodes.length === 0) && !updated.length) return null;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {blocks.map((b) => (
        <section key={b.title} className="min-w-0 rounded-lg border bg-background p-3">
          {/* Шапка плашки — светло-серой полосой с линией во всю ширину (решения владельца 2026-10-25). */}
          <h3 className="-mx-3 -mt-3 mb-2 flex items-center gap-1.5 rounded-t-lg border-b bg-muted/50 px-4 py-2.5 text-sm font-semibold">
            <b.icon className="size-4 text-muted-foreground" />
            {b.title}
          </h3>
          {b.nodes.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{b.empty}</p>
          ) : (
            <ul className="space-y-0.5">
              {b.nodes.map((n) => (
                <li key={n.id}>
                  <Link
                    to="/kb/$baseId/$nodeId"
                    params={{ baseId, nodeId: n.id }}
                    className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/60"
                  >
                    {n.kind === "folder" ? (
                      <ItemFolderIcon node={n} />
                    ) : (
                      <DocumentText className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 truncate">{n.title || "Без названия"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * Теги базы на её главной (решение владельца 2026-10-25): пилюли с числом
 * статей, нажатие — статьи с тегом (`?tag=`), повторное — снять выбор.
 * Читателю — только теги видимых ему статей; редактору — все теги базы и
 * «Настроить» (переименовать, удалить).
 */
function BaseTags({
  baseId,
  index,
  canEdit,
  tagId,
  onManage,
}: {
  baseId: string;
  index: KbTreeIndex;
  canEdit: boolean;
  tagId?: string;
  onManage: () => void;
}) {
  const { data: nodeTags, tags } = useKbNodeTags(baseId);
  const counts = useMemo(
    () =>
      nodeTags
        ? tagArticleCounts(nodeTags, (id) => {
            const n = index.byId.get(id);
            return !!n && n.kind === "article" && n.status !== "archived";
          })
        : new Map<string, number>(),
    [nodeTags, index],
  );
  const list = (tags ?? []).filter((t) => canEdit || (counts.get(t.id) ?? 0) > 0 || t.id === tagId);
  if (list.length === 0) return null;
  return (
    <section className="mb-3 rounded-lg border bg-background p-3">
      <h3 className="-mx-3 -mt-3 mb-2.5 flex items-center gap-1.5 rounded-t-lg border-b bg-muted/50 px-4 py-2.5 text-sm font-semibold">
        <Hash className="size-4 text-muted-foreground" />
        Теги
        {canEdit && (
          <Button
            variant="link"
            size="inline"
            className="ml-auto text-xs font-normal text-muted-foreground"
            onClick={onManage}
          >
            Настроить
          </Button>
        )}
      </h3>
      <ul aria-label="Теги базы" className="flex flex-wrap gap-1.5">
        {list.map((t) => (
          <li key={t.id}>
            <KbTagChip
              baseId={baseId}
              tag={t}
              count={counts.get(t.id) ?? 0}
              active={t.id === tagId}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Статьи с выбранным тегом — на главной базы вместо разделов. */
function TaggedArticles({
  baseId,
  index,
  tagId,
  canEdit,
}: {
  baseId: string;
  index: KbTreeIndex;
  tagId: string;
  canEdit: boolean;
}) {
  const { data: nodeTags, tags } = useKbNodeTags(baseId);
  const tag = tags?.find((t) => t.id === tagId);
  const items = nodeTags
    ? nodesWithTag(nodeTags, tagId)
        .map((id) => index.byId.get(id))
        .filter((n): n is KbTreeNode => !!n && n.status !== "archived")
        .sort((a, b) => a.title.localeCompare(b.title, "ru"))
    : [];
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 text-base font-semibold">
          {tag ? (
            <>
              Статьи с тегом <span className="text-brand-on-light">#{tag.name}</span>
            </>
          ) : tags ? (
            "Такого тега больше нет"
          ) : (
            "Статьи с тегом"
          )}
        </h3>
        {nodeTags && <span className="text-sm text-muted-foreground">{items.length}</span>}
        <Button variant="attention" asChild className="ml-auto">
          <Link to="/kb/$baseId" params={{ baseId }} search={{}}>
            <X />
            Сбросить
          </Link>
        </Button>
      </div>
      {!nodeTags ? (
        <div className="space-y-2 rounded-lg border bg-background p-4">
          {["w-2/3", "w-1/2", "w-3/5"].map((w) => (
            <div key={w} className={cn("h-4 animate-pulse rounded bg-muted", w)} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
          Статей с этим тегом пока нет.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-background">
          {items.map((n) => {
            const path = ancestorsOf(index, n.id)
              .map((a) => a.title || "Без названия")
              .join(" › ");
            return (
              <li key={n.id}>
                <Link
                  to="/kb/$baseId/$nodeId"
                  params={{ baseId, nodeId: n.id }}
                  className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <DocumentText className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate font-medium",
                        n.status !== "published" && "text-muted-foreground",
                      )}
                    >
                      {n.title || "Без названия"}
                    </span>
                    {path && (
                      <span className="block truncate text-xs text-muted-foreground">{path}</span>
                    )}
                  </span>
                  {canEdit && n.status !== "published" && (
                    <KbStatusBadge status={n.status} size="sm" />
                  )}
                  {n.published_at && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(n.published_at)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Звёздочка «В избранное» — своё избранное читателя (kb_favorites). Красится
 * сразу по нажатию (решение владельца 2026-10-25): список в кэше меняется до
 * ответа сервера, не получилось — возвращается и выходит предупреждение.
 * Выключена — серая залитая, включена — золотая, один цвет.
 */
function FavoriteButton({ baseId, nodeId }: { baseId: string; nodeId: string }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: favorites } = useKbFavorites(baseId);
  const on = !!favorites?.includes(nodeId);
  const busy = useRef(false);
  const toggle = async () => {
    if (busy.current || !favorites) return;
    busy.current = true;
    const key = [KB_FAVORITES_KEY, baseId];
    const before = favorites;
    qc.setQueryData<string[]>(key, (list = []) =>
      on ? list.filter((id) => id !== nodeId) : [nodeId, ...list],
    );
    try {
      const { error } = on
        ? await supabase.from("kb_favorites").delete().eq("node_id", nodeId)
        : await supabase.from("kb_favorites").insert({ node_id: nodeId, base_id: baseId });
      if (error) throw error;
      void qc.invalidateQueries({ queryKey: key });
    } catch {
      qc.setQueryData(key, before);
      await confirm({
        title: on ? "Не удалось убрать из избранного" : "Не удалось добавить в избранное",
        description: "Сервер не сохранил изменение. Проверьте интернет и попробуйте ещё раз.",
        confirmLabel: "Понятно",
        destructive: false,
        hideCancel: true,
      });
    } finally {
      busy.current = false;
    }
  };
  const label = on ? "Убрать из избранного" : "В избранное";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        disabled={!favorites}
        aria-pressed={on}
        aria-label={label}
        title={label}
        onClick={() => void toggle()}
      >
        <Star
          className={cn(
            "fill-current transition-colors",
            on ? "text-amber-400" : "text-muted-foreground/45",
          )}
        />
      </Button>
      {confirmDialog}
    </>
  );
}

/**
 * «Скопировать ссылку» на статью: её отправляют коллеге, по ней статья
 * открывается сразу (не вошёл — после входа, см. /auth?redirect).
 */
function CopyLinkButton({ baseId, nodeId }: { baseId: string; nodeId: string }) {
  const copy = () => {
    const url = `${window.location.origin}/kb/${baseId}/${nodeId}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success("Ссылка на статью скопирована"),
      () => toast.error("Не удалось скопировать — скопируйте адрес из строки браузера"),
    );
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0"
      aria-label="Скопировать ссылку на статью"
      title="Скопировать ссылку на статью"
      onClick={copy}
    >
      <Link2 />
    </Button>
  );
}

/**
 * Где статья или папка — надзаголовок над названием (решение владельца
 * 2026-10-25): полужирный, цветом брендинга клуба (--brand-on-light —
 * читаемый на белом оттенок).
 */
function Crumbs({
  baseId,
  baseTitle,
  index,
  nodeId,
}: {
  baseId: string;
  baseTitle: string;
  index: KbTreeIndex;
  nodeId: string;
}) {
  const path = ancestorsOf(index, nodeId);
  return (
    <nav
      aria-label="Где статья"
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1 text-sm font-semibold text-brand-on-light"
    >
      <Link to="/kb/$baseId" params={{ baseId }} className="hover:underline">
        {baseTitle}
      </Link>
      {path.map((p) => (
        <span key={p.id} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3.5 shrink-0 opacity-60" />
          <Link
            to="/kb/$baseId/$nodeId"
            params={{ baseId, nodeId: p.id }}
            className="truncate hover:underline"
          >
            {p.title || "Без названия"}
          </Link>
        </span>
      ))}
    </nav>
  );
}

// --- Папка и главная базы ------------------------------------------------------------

function FolderView({
  baseId,
  baseTitle,
  baseDescription,
  baseIcon,
  base,
  folder,
  nodes,
  index,
  canEdit,
  tagId,
}: {
  baseId: string;
  baseTitle: string;
  baseDescription: string;
  baseIcon: string | null;
  /** Есть — владельцу на главной базы «Настройки базы» (название, иконка, подпись вкладки). */
  base?: KbBase;
  folder: KbTreeNode | null;
  nodes: KbTreeNode[];
  index: KbTreeIndex;
  canEdit: boolean;
  tagId?: string;
}) {
  const actions = useKbActions(baseId);
  const { data: drafts } = useKbDrafts(baseId, canEdit);
  const draftIds = new Set((drafts ?? []).map((d) => d.node_id));
  const [dialog, setDialog] = useState<
    "article" | "folder" | "rename" | "move" | "base" | "tags" | null
  >(null);
  const items = childrenOf(index, folder?.id ?? null);
  // Раздел (папка верхнего уровня) — со своей иконкой, как в меню.
  const Icon = folder
    ? folder.parent_id === null
      ? kbSectionIcon(folder.icon)
      : Folder
    : kbIcon(baseIcon);
  const description = folder ? folder.description : baseDescription;

  return (
    <AdminShell
      title={baseTitle}
      actions={
        canEdit ? (
          <>
            <Button variant="outline" onClick={() => setDialog("folder")}>
              <FolderPlus />
              Папка
            </Button>
            <Button onClick={() => setDialog("article")}>
              <FilePlus />
              Статья
            </Button>
          </>
        ) : null
      }
    >
      {/* Раздел на белом (решение владельца 2026-10-25): шапка без карточки — вровень со списком. */}
      <div className="mx-auto max-w-3xl">
        <header className="flex items-start gap-4 pt-2 pb-5 sm:pb-6">
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-lg",
              // Иконка базы — её цветом на осветлённой подложке (решение владельца 2026-10-25).
              folder ? "bg-muted text-muted-foreground" : "bg-brand/15 text-brand",
            )}
          >
            <Icon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            {folder && (
              <Crumbs baseId={baseId} baseTitle={baseTitle} index={index} nodeId={folder.id} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl leading-tight font-semibold">
                {folder ? folder.title || "Без названия" : baseTitle}
              </h2>
              {canEdit && folder && folder.status !== "published" && (
                <KbStatusBadge status={folder.status} />
              )}
            </div>
            {description && (
              <p className="mt-1.5 text-sm whitespace-pre-line text-muted-foreground">
                {description}
              </p>
            )}
            {!folder && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                <ArticleCounter index={index} folderId={null} canEdit={canEdit} long />
              </p>
            )}
          </div>
          {canEdit && folder && (
            <NodeMenu
              baseId={baseId}
              node={folder}
              hasChildren={items.length > 0}
              onRename={() => setDialog("rename")}
              onMove={() => setDialog("move")}
            />
          )}
          {!folder && base && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Настройки базы"
              title="Настройки базы: название, описание, иконка, подпись вкладки"
              onClick={() => setDialog("base")}
            >
              <Pencil />
            </Button>
          )}
        </header>

        {!folder && (
          <BaseTags
            baseId={baseId}
            index={index}
            canEdit={canEdit}
            tagId={tagId}
            onManage={() => setDialog("tags")}
          />
        )}
        {!folder && tagId ? (
          <TaggedArticles baseId={baseId} index={index} tagId={tagId} canEdit={canEdit} />
        ) : (
          <>
            {!folder && <BaseHomeLists baseId={baseId} index={index} />}
            <FolderItems
              baseId={baseId}
              items={items}
              index={index}
              canEdit={canEdit}
              draftIds={draftIds}
            />
          </>
        )}
      </div>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-lg">
          {(dialog === "article" || dialog === "folder") && (
            <KbNodeTitleForm
              kind={dialog}
              node={null}
              place={{ nodes, baseTitle, parentId: folder?.id ?? null, baseId }}
              onSave={(t, d, p, i, tpl, tags) => actions.create(dialog, p, t, d, i, tpl, tags)}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "rename" && folder && (
            <KbNodeTitleForm
              kind="folder"
              node={folder}
              onSave={(t, d, _p, i) =>
                actions.update(folder.id, { title: t, description: d, icon: i })
              }
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "base" && base && <KbBaseForm base={base} onDone={() => setDialog(null)} />}
          {dialog === "tags" && <KbTagsManageForm baseId={baseId} onDone={() => setDialog(null)} />}
          {dialog === "move" && folder && (
            <KbMoveForm
              node={folder}
              nodes={nodes}
              baseTitle={baseTitle}
              onMove={(p, pos) => actions.move(folder.id, p, pos)}
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Содержимое папки или разделы главной — списком. */
function FolderItems({
  baseId,
  items,
  index,
  canEdit,
  draftIds,
}: {
  baseId: string;
  items: KbTreeNode[];
  index: KbTreeIndex;
  canEdit: boolean;
  draftIds: Set<string>;
}) {
  return items.length === 0 ? (
    <div className="mt-3 rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
      {canEdit
        ? "Здесь пока пусто. Добавьте папку-раздел или статью — кнопки справа внизу."
        : "Здесь пока ничего не опубликовано."}
    </div>
  ) : (
    <ul className="mt-3 divide-y rounded-lg border bg-background">
      {items.map((n) => (
        <li key={n.id}>
          <Link
            to="/kb/$baseId/$nodeId"
            params={{ baseId, nodeId: n.id }}
            className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {n.kind === "folder" ? (
              <ItemFolderIcon node={n} />
            ) : (
              <DocumentText className="size-5 shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-medium",
                n.status !== "published" && "text-muted-foreground",
              )}
            >
              {n.title || "Без названия"}
            </span>
            {canEdit && n.status !== "published" && <KbStatusBadge status={n.status} size="sm" />}
            {canEdit && draftIds.has(n.id) && n.status === "published" && (
              <KbDraftBadge size="sm" />
            )}
            <span className="shrink-0 text-xs text-muted-foreground">
              {n.kind === "folder" ? (
                <ArticleCounter index={index} folderId={n.id} canEdit={canEdit} />
              ) : n.published_at ? (
                formatDate(n.published_at)
              ) : (
                ""
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// --- Меню «⋯» папки и статьи ------------------------------------------------------------

function NodeMenu({
  baseId,
  node,
  hasChildren,
  onAddChild,
  onRename,
  onMove,
  onVersions,
  onSaveTemplate,
  onProtect,
  onSettings,
}: {
  baseId: string;
  node: KbTreeNode;
  hasChildren?: boolean;
  /** Статья: «Вложенная статья». */
  onAddChild?: () => void;
  onRename: () => void;
  onMove: () => void;
  onVersions?: () => void;
  onSaveTemplate?: () => void;
  onProtect?: () => void;
  onSettings?: () => void;
}) {
  const actions = useKbActions(baseId);
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const isFolder = node.kind === "folder";
  const item = (
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    run: () => void,
    destructive = false,
  ) => (
    <ListItemButton
      key={label}
      className={cn(destructive && "text-destructive hover:text-destructive")}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <Icon className={cn(!destructive && "text-muted-foreground")} />
      {label}
    </ListItemButton>
  );

  const remove = async () => {
    const ok = await confirm({
      title: isFolder ? `Удалить папку «${node.title}»?` : `Удалить статью «${node.title}»?`,
      description:
        isFolder && hasChildren
          ? "Папка уйдёт в корзину вместе со всем, что в ней. 30 дней её можно вернуть — с версиями и отметками о прочтении, потом она удалится навсегда."
          : hasChildren
            ? "Статья уйдёт в корзину вместе с вложенными статьями. 30 дней её можно вернуть — с версиями и отметками о прочтении, потом она удалится навсегда."
            : "Статья уйдёт в корзину. 30 дней её можно вернуть — с версиями и отметками о прочтении, потом она удалится навсегда.",
      confirmLabel: "В корзину",
    });
    if (ok && (await actions.remove(node))) {
      await navigate(
        node.parent_id
          ? { to: "/kb/$baseId/$nodeId", params: { baseId, nodeId: node.parent_id } }
          : { to: "/kb/$baseId", params: { baseId } },
      );
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="-mr-2 shrink-0" aria-label="Действия">
            <Ellipsis />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-1">
          {item(
            isFolder
              ? node.parent_id === null
                ? "Название, иконка, описание"
                : "Название и описание"
              : "Переименовать",
            Pencil,
            onRename,
          )}
          {onAddChild && item("Вложенная статья", FilePlus, onAddChild)}
          {item("Переместить…", FolderInput, onMove)}
          {!isFolder && item("Сделать копию", Copy, () => actions.copy(node.id))}
          {onVersions && item("Версии…", History, onVersions)}
          {onSaveTemplate && item("Сохранить как шаблон…", LayoutTemplate, onSaveTemplate)}
          {onSettings && item("Настройки страницы…", Settings2, onSettings)}
          {onProtect && item("Защита содержимого…", ShieldCheck, onProtect)}
          {isFolder &&
            node.status === "draft" &&
            item("Опубликовать папку", Send, () => actions.setStatus(node, "published"))}
          {node.status === "published" &&
            item("Снять с публикации", Undo2, () => actions.setStatus(node, "draft"))}
          {node.status === "archived"
            ? item("Вернуть из архива", ArchiveRestore, () =>
                actions.setStatus(node, isFolder ? "published" : "draft"),
              )
            : item("В архив", Archive, () => actions.setStatus(node, "archived"))}
          {item("Удалить", Trash2, remove, true)}
        </PopoverContent>
      </Popover>
      {confirmDialog}
    </>
  );
}

/**
 * Вложенные статьи — под текстом статьи (решение владельца 2026-10-25:
 * вложенность статей многоуровневая). Читателю — только опубликованное
 * (дерево уже отфильтровано), редактору — всё, черновики с пометкой.
 */
function NestedArticles({
  baseId,
  index,
  nodeId,
  canEdit,
}: {
  baseId: string;
  index: KbTreeIndex;
  nodeId: string;
  canEdit: boolean;
}) {
  const items = childrenOf(index, nodeId);
  if (items.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Вложенные статьи</h2>
      <ul className="divide-y rounded-lg border bg-background">
        {items.map((n) => {
          const nested = articleCount(index, n.id, !canEdit);
          return (
            <li key={n.id}>
              <Link
                to="/kb/$baseId/$nodeId"
                params={{ baseId, nodeId: n.id }}
                className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <DocumentText className="size-5 shrink-0 text-muted-foreground" />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-medium",
                    n.status !== "published" && "text-muted-foreground",
                  )}
                >
                  {n.title || "Без названия"}
                </span>
                {canEdit && n.status !== "published" && (
                  <KbStatusBadge status={n.status} size="sm" />
                )}
                {nested > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    вложенных: {nested}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Статья -------------------------------------------------------------------------------

function ArticleView({
  baseId,
  baseTitle,
  baseProtects,
  node,
  nodes,
  index,
  canEdit,
  initialEdit,
}: {
  baseId: string;
  baseTitle: string;
  baseProtects: boolean;
  node: KbTreeNode;
  nodes: KbTreeNode[];
  index: KbTreeIndex;
  canEdit: boolean;
  initialEdit: boolean;
}) {
  const qc = useQueryClient();
  const protectOn = node.protect === "on" || (node.protect === "inherit" && baseProtects);
  const navigate = useNavigate();
  const actions = useKbActions(baseId);
  const { confirm, confirmDialog } = useConfirm();
  const { data: full, isLoading } = useKbNode(node.id);
  const {
    data: draft,
    isLoading: draftLoading,
    refetch: refetchDraft,
  } = useKbDraft(node.id, canEdit);
  const { data: authors } = useKbAuthors(baseId);
  const [editing, setEditing] = useState(initialEdit);
  // Номер открытия редактора: редактор и автосохранение заводятся заново только
  // при новом открытии, а не на каждое сохранение черновика.
  const [session, setSession] = useState(0);
  const startEdit = async () => {
    await refetchDraft();
    setSession((n) => n + 1);
    setEditing(true);
  };
  const [headings, setHeadings] = useState<KbHeading[]>([]);
  const [dialog, setDialog] = useState<
    | "rename"
    | "move"
    | "link"
    | "heading"
    | "versions"
    | "template"
    | "protect"
    | "settings"
    | "child"
    | null
  >(null);
  const [pickHeadings, setPickHeadings] = useState<KbHeading[]>([]);
  const [publishing, setPublishing] = useState(false);
  const linkResolver = useRef<((link: KbArticleLink | null) => void) | null>(null);
  const name = (id: string | null | undefined) => (id ? authors?.get(id) || "сотрудник" : "");

  // «Открыл статью» — в отчёт по чтению (повтор чаще раза в 30 минут база не считает).
  // Запрос PostgREST ленивый: без then он не уходит.
  useEffect(() => {
    void supabase.rpc("kb_mark_read", { p_node: node.id }).then(() => undefined);
  }, [node.id]);

  // Убрать ?edit=1 из адреса: обновление страницы не должно снова открывать правку.
  useEffect(() => {
    if (initialEdit)
      void navigate({
        to: "/kb/$baseId/$nodeId",
        params: { baseId, nodeId: node.id },
        search: {},
        replace: true,
      });
  }, [initialEdit, baseId, node.id, navigate]);

  const published = (full?.content ?? null) as unknown[] | null;
  // Черновик статьи-черновика редактор видит и без режима правки — это и есть статья.
  const showDraft = canEdit && !!draft && (editing || node.status !== "published");
  const doc = showDraft ? draft!.content : published;

  // Чек-лист читателя: свои отметки (kb_checks) — сразу на месте, база вслед.
  const { data: checked } = useKbChecks(node.id);
  const checkItems = useMemo(() => documentCheckItems(doc), [doc]);
  const doneCount = checkItems.filter((id) => checked?.has(id)).length;
  const toggleCheck = useCallback(
    async (blockId: string) => {
      const on = !qc.getQueryData<Set<string>>(["kb_checks", node.id])?.has(blockId);
      qc.setQueryData<Set<string>>(["kb_checks", node.id], (prev) => {
        const next = new Set(prev);
        if (on) next.add(blockId);
        else next.delete(blockId);
        return next;
      });
      const { error } = on
        ? await supabase
            .from("kb_checks")
            .insert({ node_id: node.id, base_id: baseId, block_id: blockId })
        : await supabase.from("kb_checks").delete().eq("node_id", node.id).eq("block_id", blockId);
      if (error) toast.error(kbErrorText(error.message));
      await qc.invalidateQueries({ queryKey: ["kb_checks", node.id] });
    },
    [qc, node.id, baseId],
  );
  const checks = useMemo(
    () => (checked ? { checked, onToggle: (id: string) => void toggleCheck(id) } : undefined),
    [checked, toggleCheck],
  );

  const discardDraft = async () => {
    const ok = await confirm({
      title: "Отменить правки?",
      description:
        node.status === "published"
          ? "Черновик правок удалится, статья останется такой, как её видят читатели."
          : "Текст черновика удалится — статья станет пустой.",
    });
    if (!ok) return;
    const { error } = await supabase.from("kb_drafts").delete().eq("node_id", node.id);
    if (error) {
      toast.error(kbErrorText(error.message));
      return;
    }
    setEditing(false);
    await invalidateKb(qc, baseId);
    toast.success("Правки отменены");
  };

  // Публикация — только через подтверждение: «Опубликовать» не должно
  // срабатывать от случайного (двойного) нажатия.
  const publish = async (flush: () => Promise<boolean>) => {
    const ok = await confirm({
      title: node.published_at ? "Опубликовать правки?" : "Опубликовать статью?",
      description: node.published_at
        ? `Читатели сразу увидят новый текст «${node.title || "Без названия"}».`
        : `Статья «${node.title || "Без названия"}» появится у всех, у кого есть доступ к базе.`,
      destructive: false,
      confirmLabel: "Опубликовать",
    });
    if (!ok) return;
    setPublishing(true);
    try {
      if (!(await flush())) {
        toast.error(
          "Правки не сохранились — опубликовать нельзя. Проверьте связь и попробуйте ещё раз.",
        );
        return;
      }
      const { error } = await supabase.rpc("kb_publish", { p_node: node.id });
      if (error) {
        toast.error(kbErrorText(error.message));
        return;
      }
      await invalidateKb(qc, baseId);
      setEditing(false);
      toast.success("Опубликовано — читатели видят новый текст");
    } finally {
      setPublishing(false);
    }
  };

  // «Закрыть редактор»: правки уже в черновике — читатели их не видят.
  const closeEditor = async (flush: () => Promise<boolean>, saved: boolean) => {
    setPublishing(true);
    try {
      await flush();
      setEditing(false);
      if (saved || draft)
        toast.info("Правки сохранены черновиком. Читатели увидят их после «Опубликовать».");
    } finally {
      setPublishing(false);
    }
  };

  // Вернуть версию: её текст — в черновик правок (и прежнее название), дальше
  // редактор проверяет и публикует.
  const restoreVersion = async (revision: KbRevision, content: unknown[]) => {
    const ok = await confirm({
      title: "Вернуть эту версию?",
      description: draft
        ? `Текст версии от ${formatDateTime(revision.published_at)} заменит неопубликованные правки — они пропадут. Читатели увидят его после «Опубликовать».`
        : `Текст версии от ${formatDateTime(revision.published_at)} встанет в черновик правок. Читатели увидят его после «Опубликовать».`,
      destructive: !!draft,
      confirmLabel: "Вернуть",
    });
    if (!ok) return;
    const { error } = await supabase.rpc("kb_save_draft", {
      p_node: node.id,
      p_content: content,
      p_expected: draft?.updated_at ?? null,
    });
    if (error) {
      toast.error(kbErrorText(error.message));
      return;
    }
    if (revision.title && revision.title !== node.title)
      await actions.update(node.id, { title: revision.title });
    await invalidateKb(qc, baseId);
    setDialog(null);
    toast.success("Версия в черновике — проверьте и опубликуйте");
    void startEdit();
  };

  const pickArticle = () =>
    new Promise<KbArticleLink | null>((resolve) => {
      linkResolver.current = resolve;
      setDialog("link");
    });
  const pickHeading = (list: KbHeading[]) =>
    new Promise<KbArticleLink | null>((resolve) => {
      linkResolver.current = resolve;
      setPickHeadings(list);
      setDialog("heading");
    });

  const loading = isLoading || (canEdit && draftLoading);
  const hasDraft = !!draft;
  // Время чтения и докуда дочитал — в аналитику базы (не в режиме правки).
  const articleRef = useRef<HTMLElement>(null);
  useReadingTracker(node.id, articleRef, !editing && !loading);

  return (
    <EditorShell
      key={editing ? `edit:${session}` : "read"}
      title={baseTitle}
      editing={editing}
      nodeId={node.id}
      expected={draft?.updated_at ?? null}
      onStartEdit={canEdit ? () => void startEdit() : undefined}
      render={(autosave) => (
        <div className="mx-auto flex max-w-6xl gap-8 pb-24">
          <article ref={articleRef} className="min-w-0 max-w-3xl flex-1">
            {editing && (
              <EditBar
                autosave={autosave}
                publishing={publishing}
                onClose={() => void closeEditor(autosave.flush, !!autosave.savedAt)}
                onPublish={() => void publish(autosave.flush)}
              />
            )}
            {/* Текст — прямо на белом, без карточки; отступы прежние: слева от
                текста — место под ручку блока редактора (-mx-[54px] ниже). */}
            <KbProtectedArea
              enabled={protectOn && !editing}
              canCopy={canEdit}
              className="px-5 py-5 sm:px-10 sm:py-8"
            >
              <header className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <Crumbs baseId={baseId} baseTitle={baseTitle} index={index} nodeId={node.id} />
                  {editing ? (
                    <TitleInput
                      value={node.title}
                      onSave={(title) => actions.update(node.id, { title })}
                    />
                  ) : (
                    <h2 className="text-3xl leading-tight font-semibold break-words">
                      {node.title || "Без названия"}
                    </h2>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {/* Одной строкой (решение владельца 2026-10-25): статус
                        (редактору), теги, чек-лист; автор — строкой ниже. */}
                    {canEdit && <KbStatusBadge status={node.status} />}
                    {!editing && <KbArticleTags baseId={baseId} nodeId={node.id} />}
                    {!editing && checkItems.length > 0 && (
                      <span title="Отметки чек-листа — ваши, их видите только вы">
                        Чек-лист: {doneCount} из {checkItems.length}
                      </span>
                    )}
                    {protectOn && (
                      <span
                        className="inline-flex items-center gap-1"
                        title="Копирование и печать закрыты, поверх текста — водяной знак с почтой и датой"
                      >
                        <ShieldCheck className="size-3.5" />
                        Защищено
                      </span>
                    )}
                    {canEdit && hasDraft && node.status === "published" && <KbDraftBadge />}
                    {!node.published_at && <span>Ещё не опубликована</span>}
                  </div>
                  {editing && <KbArticleTagsEditor baseId={baseId} nodeId={node.id} />}
                  {node.published_at && (
                    <ArticleAuthor
                      baseId={baseId}
                      userId={node.published_by}
                      publishedAt={node.published_at}
                    />
                  )}
                </div>
                <FavoriteButton baseId={baseId} nodeId={node.id} />
                <CopyLinkButton baseId={baseId} nodeId={node.id} />
                {canEdit && (
                  <NodeMenu
                    baseId={baseId}
                    node={node}
                    hasChildren={childrenOf(index, node.id).length > 0}
                    onAddChild={() => setDialog("child")}
                    onRename={() => setDialog("rename")}
                    onMove={() => setDialog("move")}
                    onVersions={() => setDialog("versions")}
                    onSaveTemplate={() => setDialog("template")}
                    onProtect={() => setDialog("protect")}
                    onSettings={() => setDialog("settings")}
                  />
                )}
              </header>

              {canEdit && !editing && (hasDraft || node.status !== "published") && (
                <InfoNote
                  variant={node.status === "archived" ? "muted" : "info"}
                  className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {node.status === "archived" ? (
                      "Статья в архиве — читатели её не видят."
                    ) : node.status === "draft" ? (
                      "Черновик — читатели его не видят, пока вы не опубликуете."
                    ) : (
                      <>
                        Есть неопубликованные правки
                        {draft?.updated_by && (
                          <>
                            {" — "}
                            <PersonButton
                              userId={draft.updated_by}
                              className="inline font-medium hover:underline"
                            >
                              {name(draft.updated_by)}
                            </PersonButton>
                            , {formatDateTime(draft.updated_at)}
                          </>
                        )}
                        . Читатели видят прежний текст.
                      </>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void startEdit()}>
                      {hasDraft ? "Продолжить правку" : "Редактировать"}
                    </Button>
                    {/* Отмена правок — здесь, у плашки черновика (решение владельца
                        2026-10-25: в меню «⋯» её не находили). */}
                    {hasDraft && (
                      <Button size="sm" variant="outline" onClick={() => void discardDraft()}>
                        <Undo2 />
                        Отменить правки
                      </Button>
                    )}
                    {node.status !== "archived" && (
                      <Button
                        size="sm"
                        disabled={publishing}
                        onClick={() => void publish(async () => true)}
                      >
                        <Send />
                        Опубликовать…
                      </Button>
                    )}
                  </span>
                </InfoNote>
              )}
              {autosave.state === "conflict" && (
                <InfoNote
                  variant="warning"
                  className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    Статью только что сохранил другой редактор. Ваши последние правки не сохранены —
                    скопируйте их, обновите статью и внесите заново.
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void startEdit()}>
                    Обновить
                  </Button>
                </InfoNote>
              )}

              <div className="mt-6 -mx-3 sm:-mx-[54px]">
                {loading ? (
                  <div className="space-y-3 px-3 sm:px-[54px]">
                    {["w-full", "w-11/12", "w-4/5", "w-2/3"].map((w) => (
                      <div key={w} className={cn("h-4 animate-pulse rounded bg-muted", w)} />
                    ))}
                  </div>
                ) : !editing && documentIsEmpty(doc) ? (
                  <p className="px-3 text-sm text-muted-foreground sm:px-[54px]">
                    {canEdit
                      ? "Статья пока пустая — нажмите «Редактировать»."
                      : "Статья пока пустая."}
                  </p>
                ) : (
                  <Suspense
                    fallback={
                      <div className="flex items-center gap-2 px-3 text-sm text-muted-foreground sm:px-[54px]">
                        <Loader2 className="size-4 animate-spin" /> Открываем статью…
                      </div>
                    }
                  >
                    <KbDocument
                      key={
                        editing
                          ? `edit:${session}`
                          : showDraft
                            ? `draft:${draft?.updated_at}`
                            : `pub:${full?.published_at ?? ""}`
                      }
                      baseId={baseId}
                      nodeId={node.id}
                      initial={doc}
                      editable={editing}
                      onChange={editing ? autosave.schedule : undefined}
                      onReady={editing ? autosave.setBaseline : undefined}
                      onHeadings={setHeadings}
                      onPickArticle={pickArticle}
                      onPickHeading={pickHeading}
                      checks={editing ? undefined : checks}
                    />
                  </Suspense>
                )}
              </div>
              {!editing && (
                <NestedArticles baseId={baseId} index={index} nodeId={node.id} canEdit={canEdit} />
              )}
              {!editing && !loading && node.status === "published" && node.feedback_enabled && (
                <KbArticleRating node={node} />
              )}
              {!editing && node.pager_enabled && (
                <KbArticlePager baseId={baseId} index={index} nodeId={node.id} />
              )}
            </KbProtectedArea>
          </article>
          <Toc headings={headings} />
        </div>
      )}
    >
      <Dialog
        open={!!dialog}
        onOpenChange={(o) => {
          if (o) return;
          if (dialog === "link" || dialog === "heading") {
            linkResolver.current?.(null);
            linkResolver.current = null;
          }
          setDialog(null);
        }}
      >
        <DialogContent className={cn("max-w-lg", dialog === "versions" && "max-w-4xl")}>
          {dialog === "rename" && (
            <KbNodeTitleForm
              kind="article"
              node={node}
              onSave={(t) => actions.update(node.id, { title: t })}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "move" && (
            <KbMoveForm
              node={node}
              nodes={nodes}
              baseTitle={baseTitle}
              onMove={(p, pos) => actions.move(node.id, p, pos)}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "child" && (
            <KbNodeTitleForm
              kind="article"
              node={null}
              place={{ nodes, baseTitle, parentId: node.id, baseId }}
              onSave={(t, d, p, i, tpl, tags) => actions.create("article", p, t, d, i, tpl, tags)}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "versions" && (
            <KbVersionsForm
              baseId={baseId}
              node={node}
              authorName={name}
              canRestore={!editing}
              onRestore={restoreVersion}
            />
          )}
          {dialog === "template" && (
            <KbSaveTemplateForm
              content={(draft?.content ?? published ?? []) as unknown[]}
              defaultTitle={node.title}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "protect" && (
            <KbProtectForm
              value={node.protect}
              baseProtects={baseProtects}
              onSave={(protect) => actions.update(node.id, { protect })}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "settings" && (
            <KbPageSettingsForm
              value={node}
              onSave={(patch) => actions.update(node.id, patch)}
              onDone={() => setDialog(null)}
            />
          )}
          {dialog === "heading" && (
            <KbHeadingPickerForm
              headings={pickHeadings}
              onPick={(link) => {
                linkResolver.current?.(link);
                linkResolver.current = null;
                setDialog(null);
              }}
            />
          )}
          {dialog === "link" && (
            <KbArticlePickerForm
              baseId={baseId}
              nodes={nodes}
              excludeId={node.id}
              onPick={(link) => {
                linkResolver.current?.(link);
                linkResolver.current = null;
                setDialog(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </EditorShell>
  );
}

/**
 * Автор статьи под названием (решение владельца 2026-10-25, по образцу
 * справочных центров): аватарка, «Автор: Имя» — кто опубликовал последнюю
 * версию, ниже — «Обновлено 11 дней назад» (точная дата — в подсказке).
 */
function ArticleAuthor({
  baseId,
  userId,
  publishedAt,
}: {
  baseId: string;
  userId: string | null;
  publishedAt: string;
}) {
  const { data: authors } = useKbAuthorProfiles(baseId);
  const author = userId ? authors?.get(userId) : undefined;
  const fullName = author?.full_name || (userId ? "Сотрудник" : "");
  return (
    <div className="mt-4 flex items-center gap-3 text-sm">
      {fullName && (
        <PersonButton userId={userId} className="shrink-0 rounded-full">
          <StaffAvatar value={author?.avatar_url} name={fullName} className="size-10 text-sm" />
        </PersonButton>
      )}
      <div className="min-w-0 leading-snug text-muted-foreground">
        {fullName && (
          <p className="truncate">
            Автор:{" "}
            <PersonButton
              userId={userId}
              className="inline font-medium text-foreground hover:underline"
            >
              {fullName}
            </PersonButton>
          </p>
        )}
        <p title={formatDateTime(publishedAt)}>
          Обновлено{" "}
          <span className="font-medium text-foreground">{formatUpdatedAgo(publishedAt)}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Шапка страницы статьи: в режиме чтения — плавающая «Редактировать», в
 * режиме правки плавающих кнопок нет (панель правки — сверху статьи,
 * `EditBar`). Здесь же живёт автосохранение: оно заводится заново на каждое
 * открытие редактора (метка черновика — его).
 */
function EditorShell({
  title,
  editing,
  nodeId,
  expected,
  onStartEdit,
  render,
  children,
}: {
  title: string;
  editing: boolean;
  nodeId: string;
  expected: string | null;
  onStartEdit?: () => void;
  render: (autosave: ReturnType<typeof useDraftAutosave>) => React.ReactNode;
  /** Окна и подтверждения страницы. */
  children?: React.ReactNode;
}) {
  const autosave = useDraftAutosave(nodeId, expected);
  return (
    <AdminShell
      title={title}
      actions={
        !editing && onStartEdit ? (
          <Button onClick={onStartEdit}>
            <Pencil />
            Редактировать
          </Button>
        ) : null
      }
    >
      {render(autosave)}
      {children}
    </AdminShell>
  );
}

/**
 * Панель правки — закреплена сверху статьи, пока идёт правка: что
 * происходит с правками и два разных действия. «Закрыть редактор» оставляет
 * правки черновиком (читатели их не видят), «Опубликовать…» — с
 * подтверждением. Раньше «Готово» и «Опубликовать» плавали внизу рядом и
 * путались (замечание тестирования 2026-10-25).
 */
function EditBar({
  autosave,
  publishing,
  onClose,
  onPublish,
}: {
  autosave: ReturnType<typeof useDraftAutosave>;
  publishing: boolean;
  onClose: () => void;
  onPublish: () => void;
}) {
  return (
    // Белая подложка (раздел на белом) закрывает отступ рабочей области над
    // прилипшей плашкой — иначе в этой полосе был виден прокручиваемый текст.
    <div className="sticky -top-3 z-30 -mt-3 bg-background pt-3 pb-3 sm:-top-4 sm:-mt-4 sm:pt-4 lg:-top-6 lg:-mt-6 lg:pt-6">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow-sm sm:px-3">
        <div className="min-w-0 basis-full text-sm sm:basis-0 sm:flex-1">
          <span className="font-medium">Редактирование</span>
          <span className="block text-xs text-muted-foreground">
            <AutosaveLabel state={autosave.state} savedAt={autosave.savedAt} />
          </span>
        </div>
        <Button
          variant="outline"
          className="flex-1 sm:flex-none"
          disabled={publishing}
          onClick={onClose}
        >
          Закрыть редактор
        </Button>
        <Button
          className="flex-1 sm:flex-none"
          disabled={publishing || autosave.state === "conflict"}
          onClick={onPublish}
        >
          {publishing ? <Loader2 className="animate-spin" /> : <Send />}
          Опубликовать…
        </Button>
      </div>
    </div>
  );
}

/**
 * Что с правками: «Сохраняем…» — только если сохранение идёт дольше
 * полсекунды (иначе крутилка мигала бы на каждом слове), в остальное
 * время — когда сохранён черновик.
 */
function AutosaveLabel({ state, savedAt }: { state: AutosaveState; savedAt: Date | null }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (state !== "saving") {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 500);
    return () => clearTimeout(t);
  }, [state]);

  if (state === "saving" && slow)
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" /> Сохраняем черновик…
      </span>
    );
  if (state === "error")
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <CloudOff className="size-3" /> Нет связи — правки сохранятся, когда она вернётся
      </span>
    );
  if (savedAt)
    return (
      <span>
        Черновик сохранён в{" "}
        {savedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} — читатели
        увидят правки после «Опубликовать»
      </span>
    );
  return <span>Правки сохраняются сами черновиком — читатели увидят их после «Опубликовать»</span>;
}

/** Название статьи в режиме правки: крупное поле, сохраняется при уходе из поля. */
function TitleInput({
  value,
  onSave,
}: {
  value: string;
  onSave: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(value);
  const save = () => {
    const t = title.trim();
    if (!t) {
      setTitle(value);
      return;
    }
    if (t !== value) void onSave(t);
  };
  return (
    <textarea
      aria-label="Название статьи"
      value={title}
      rows={1}
      maxLength={200}
      placeholder="Название статьи"
      onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className="field-sizing-content w-full resize-none rounded-md bg-transparent text-3xl leading-tight font-semibold outline-none placeholder:text-muted-foreground/60 focus-visible:bg-muted/40"
    />
  );
}

/** Оглавление статьи — справа на широком экране (боль брифа: длинные статьи без оглавления). */
/** Отступ от верха области прокрутки: заголовок выше него — «текущий» (больше, чем scroll-margin у блоков в режиме правки, styles.css). */
const TOC_SPY_OFFSET = 136;

/**
 * Какой раздел статьи сейчас на экране: последний заголовок, поднявшийся
 * выше верхней трети окна; докрутили до конца — последний. Прокручивается
 * рабочая область админки (`.admin-main`), а не окно.
 */
function useActiveHeading(ids: string[], anchor: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState<string | null>(null);
  // Заголовки — по содержимому: новый массив с теми же id приходит на
  // каждую правку текста, эффект от этого перезапускаться не должен.
  const key = ids.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const scroller = anchor.current?.closest<HTMLElement>(".admin-main");
    if (!scroller || ids.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + TOC_SPY_OFFSET;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      let current: string | null = null;
      for (const id of ids) {
        const el = scroller.querySelector(`[data-id="${CSS.escape(id)}"]`);
        // Свёрнутый (внутри спойлера) — не на экране, подсвечивать нечего.
        if (!el || !kbBlockShown(el)) continue;
        if (el.getBoundingClientRect().top <= top) current = id;
        else break;
      }
      if (atEnd && scroller.scrollTop > 0) current = ids[ids.length - 1];
      setActive(current ?? ids[0]);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, anchor]);
  return [active, setActive] as const;
}

function Toc({ headings }: { headings: KbHeading[] }) {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useActiveHeading(
    headings.map((h) => h.id),
    ref,
  );
  if (headings.length < 2) return <div className="hidden w-56 shrink-0 xl:block" />;
  const go = (id: string) => {
    // Заголовок внутри свёрнутого спойлера — сначала раскрыть.
    const el = revealKbBlock(document, id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
    // Адрес раздела — в строке браузера: его можно скопировать и прислать.
    window.history.replaceState(null, "", `#${id}`);
  };
  return (
    <aside ref={ref} className="hidden w-56 shrink-0 xl:block">
      <nav
        aria-label="Оглавление"
        className="sidebar-scroll sticky top-0 max-h-[calc(100dvh-6rem)] overflow-y-auto pt-9"
      >
        <p className="mb-2 text-sm font-medium text-muted-foreground">Содержание</p>
        <ul className="space-y-1 border-l">
          {headings.map((h) => {
            const current = h.id === active;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => go(h.id)}
                  aria-current={current ? "location" : undefined}
                  className={cn(
                    "-ml-px block w-full cursor-pointer border-l py-0.5 text-left text-sm transition-colors",
                    current
                      ? "border-brand-on-light font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground",
                  )}
                  style={{ paddingLeft: 12 + (Math.min(h.level, 3) - 1) * 12 }}
                >
                  {h.text}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
