/**
 * База знаний — загрузка (React Query + Supabase). Схема и права —
 * db/migrations/2026-10-24_knowledge_base.sql: RLS отдаёт только доступные
 * базы, а читателю — только опубликованное.
 *
 * Дерево базы (папки и статьи без текста) грузится целиком одним queryKey —
 * его читают и боковое меню, и страницы (крошки, содержимое папки); текст
 * статьи — отдельным запросом при открытии.
 */
import { useMemo } from "react";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import type { KbGrant } from "./access";
import {
  groupNodeTags,
  sortTags,
  tagDiff,
  type KbNodeTags,
  type KbTag,
  type KbTagColor,
} from "./tags";
import type { KbBase, KbDraft, KbNodeFull, KbTreeNode } from "./types";

export const KB_BASES_KEY = "kb_bases";
export const KB_GRANTS_KEY = "kb_grants";
export const KB_NODES_KEY = "kb_nodes";
export const KB_NODE_KEY = "kb_node";
export const KB_DRAFTS_KEY = "kb_drafts";
export const KB_TAGS_KEY = "kb_tags";
export const KB_NODE_TAGS_KEY = "kb_node_tags";

const TREE_COLUMNS =
  "id, base_id, parent_id, kind, title, description, icon, protect, feedback_enabled, pager_enabled, sort_order, status, reader_visible, created_at, updated_at, published_at, published_by, author_id";

/** Доступные базы — для вкладок в шапке и прав; заранее грузит проверка входа. */
export const kbBasesQuery = queryOptions({
  queryKey: [KB_BASES_KEY],
  queryFn: () =>
    unwrap<KbBase[]>(
      supabase
        .from("kb_bases")
        .select(
          "id, title, rail_title, icon, description, sort_order, protect_content, brand_color",
        )
        .order("sort_order")
        .order("created_at"),
    ),
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить базы знаний" },
});

/** Свои доступы к базам (RLS отдаёт свои строки; владельцу они не нужны). */
export const kbOwnGrantsQuery = queryOptions({
  queryKey: [KB_GRANTS_KEY, "own"],
  queryFn: async (): Promise<KbGrant[]> => {
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    if (!userId) return [];
    return unwrap<KbGrant[]>(
      supabase
        .from("kb_grants")
        .select("base_id, level")
        .eq("subject_type", "user")
        .eq("subject_id", userId)
        .is("node_id", null),
    );
  },
  // Доступы меняет владелец в «Доступах»; свои он менять не может.
  staleTime: Infinity,
  meta: { errorMessage: "Не удалось загрузить доступы к базам знаний" },
});

export function kbTreeQuery(baseId: string) {
  return queryOptions({
    queryKey: [KB_NODES_KEY, baseId],
    queryFn: () =>
      unwrap<KbTreeNode[]>(
        supabase
          .from("kb_nodes")
          .select(TREE_COLUMNS)
          .eq("base_id", baseId)
          .order("sort_order")
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить содержание базы знаний" },
  });
}

export function useKbTree(baseId: string | null) {
  return useQuery({ ...kbTreeQuery(baseId ?? ""), enabled: !!baseId });
}

export function useKbNode(nodeId: string | null) {
  return useQuery({
    queryKey: [KB_NODE_KEY, nodeId],
    queryFn: async () => {
      const rows = await unwrap<KbNodeFull[]>(
        supabase.from("kb_nodes").select(`${TREE_COLUMNS}, content`).eq("id", nodeId!),
      );
      return rows[0] ?? null;
    },
    enabled: !!nodeId,
    meta: { errorMessage: "Не удалось загрузить статью" },
  });
}

/** Черновики правок базы (только редактору): метка в дереве и в статье. */
export function useKbDrafts(baseId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [KB_DRAFTS_KEY, baseId],
    queryFn: () =>
      unwrap<Omit<KbDraft, "content">[]>(
        supabase.from("kb_drafts").select("node_id, updated_by, updated_at").eq("base_id", baseId!),
      ),
    enabled: !!baseId && enabled,
    meta: { errorMessage: "Не удалось загрузить черновики" },
  });
}

/** Черновик статьи для редактора (null — правок нет). */
export async function loadKbDraft(nodeId: string): Promise<KbDraft | null> {
  const rows = await unwrap<KbDraft[]>(
    supabase
      .from("kb_drafts")
      .select("node_id, content, updated_by, updated_at")
      .eq("node_id", nodeId),
  );
  return rows[0] ?? null;
}

/** После правки дерева, статьи или черновика — меню и страницы не расходятся. */
export function invalidateKb(queryClient: QueryClient, baseId?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: baseId ? [KB_NODES_KEY, baseId] : [KB_NODES_KEY] }),
    queryClient.invalidateQueries({ queryKey: [KB_NODE_KEY] }),
    // Черновики — и списком базы, и у открытой статьи (["kb_drafts", "node", id]).
    queryClient.invalidateQueries({ queryKey: [KB_DRAFTS_KEY] }),
    // Теги статей — корзина и копия возвращают и их.
    queryClient.invalidateQueries({ queryKey: [KB_NODE_TAGS_KEY] }),
  ]);
}

/** Ошибки RPC и триггеров базы знаний — по-русски для тоста. */
export function kbErrorText(error: unknown, fallback = "Не удалось сохранить"): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("kb_draft_conflict"))
    return "Статью только что сохранил другой редактор. Обновите страницу, чтобы не затереть его правки.";
  if (message.includes("kb_move_into_self"))
    return "Нельзя перенести внутрь самой себя или своей вложенной статьи";
  if (message.includes("kb_parent_not_folder")) return "Переносить можно только в папку";
  if (message.includes("kb_folder_in_article"))
    return "Внутрь статьи можно вложить только статью, не папку";
  if (message.includes("kb_already_restored")) return "Это уже вернули из корзины";
  if (message.includes("kb_too_many_tags")) return "У статьи может быть не больше 10 тегов";
  if (message.includes("kb_tags_base_name_key")) return "Такой тег в базе уже есть";
  if (message.includes("kb_tag_empty")) return "Укажите название тега";
  if (message.includes("kb_tag_not_article")) return "Теги ставятся только статьям";
  if (message.includes("kb_bad_author"))
    return "Автором можно выбрать только действующего пользователя портала";
  if (message.includes("kb_not_found")) return "Не нашлось — возможно, уже удалили";
  if (message.includes("kb_forbidden") || message.includes("row-level security"))
    return "Нет права на правку этой базы знаний";
  if (message.includes("foreign key") || message.includes("kb_nodes_parent_id_fkey"))
    return "Внутри есть статьи — сначала перенесите или удалите их";
  return message || fallback;
}

export type KbSearchHit = {
  id: string;
  parent_id: string | null;
  kind: "folder" | "article";
  title: string;
  status: string;
  /** Фрагмент текста: найденное — между ⟦ и ⟧. */
  snippet: string;
  rank: number;
};

/** Поиск по базе (RPC kb_search): русская морфология, начало слова, папка. */
export function useKbSearch(baseId: string, query: string, folderId: string | null) {
  const q = query.trim();
  return useQuery({
    queryKey: ["kb_search", baseId, folderId, q],
    queryFn: () =>
      unwrap<KbSearchHit[]>(
        supabase.rpc("kb_search", {
          p_query: q,
          p_base: baseId,
          p_folder: folderId,
          p_limit: 30,
        }),
      ),
    enabled: q.length >= 2,
    staleTime: 30_000,
    meta: { errorMessage: "Не удалось выполнить поиск" },
  });
}

/** Фрагмент поиска — на куски: { text, hit } (найденное подсвечивается). */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /⟦([^⟧]*)⟧/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

export type KbAuthor = { user_id: string; full_name: string | null; avatar_url: string | null };

/** Авторы и редакторы базы (RPC kb_authors) — один запрос на оба хука ниже. */
function kbAuthorsQuery(baseId: string | null) {
  return {
    queryKey: ["kb_authors", baseId],
    queryFn: () => unwrap<KbAuthor[]>(supabase.rpc("kb_authors", { p_base: baseId })),
    enabled: !!baseId,
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить авторов статей" },
  };
}

/** Имена авторов и редакторов базы: id → «Фамилия Имя». */
export function useKbAuthors(baseId: string | null) {
  return useQuery({
    ...kbAuthorsQuery(baseId),
    select: (rows) => new Map(rows.map((r) => [r.user_id, r.full_name ?? ""])),
  });
}

/** Авторы базы с аватаркой (шапка статьи): id → строка kb_authors. */
export function useKbAuthorProfiles(baseId: string | null) {
  return useQuery({
    ...kbAuthorsQuery(baseId),
    select: (rows) => new Map(rows.map((r) => [r.user_id, r])),
  });
}

/** Черновик правок статьи (редактору): текст и кто правил. */
export function useKbDraft(nodeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [KB_DRAFTS_KEY, "node", nodeId],
    queryFn: () => loadKbDraft(nodeId!),
    enabled: !!nodeId && enabled,
    meta: { errorMessage: "Не удалось загрузить черновик статьи" },
  });
}

/** Версия статьи — снимок при публикации (kb_revisions). */
export type KbRevision = {
  id: string;
  title: string;
  published_by: string | null;
  published_at: string;
};

/** Версии статьи, новые сверху (редакторам). */
export function useKbRevisions(nodeId: string | null) {
  return useQuery({
    queryKey: ["kb_revisions", nodeId],
    queryFn: () =>
      unwrap<KbRevision[]>(
        supabase
          .from("kb_revisions")
          .select("id, title, published_by, published_at")
          .eq("node_id", nodeId!)
          .order("published_at", { ascending: false }),
      ),
    enabled: !!nodeId,
    meta: { errorMessage: "Не удалось загрузить версии статьи" },
  });
}

/** Текст версий — по выбору (список грузится без текста). */
export function useKbRevisionContents(ids: string[]) {
  const key = ids.join(",");
  return useQuery({
    queryKey: ["kb_revisions", "content", key],
    queryFn: async () => {
      const rows = await unwrap<{ id: string; content: unknown[] | null }[]>(
        supabase.from("kb_revisions").select("id, content").in("id", ids),
      );
      return new Map(rows.map((r) => [r.id, r.content ?? []]));
    },
    enabled: ids.length > 0,
    staleTime: Infinity,
    meta: { errorMessage: "Не удалось загрузить текст версии" },
  });
}

/** Шаблон статьи (kb_templates), без текста. Шаблоны общие для всех баз. */
export type KbTemplate = {
  id: string;
  title: string;
  description: string;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
};

export const KB_TEMPLATES_KEY = "kb_templates";

/** Все шаблоны — редакторам любой базы и владельцам (RLS). */
export function useKbTemplates(enabled = true) {
  return useQuery({
    queryKey: [KB_TEMPLATES_KEY],
    queryFn: () =>
      unwrap<KbTemplate[]>(
        supabase
          .from("kb_templates")
          .select("id, title, description, created_by, updated_by, updated_at")
          .order("title"),
      ),
    enabled,
    meta: { errorMessage: "Не удалось загрузить шаблоны" },
  });
}

/** Текст шаблона (документ BlockNote). */
export async function loadKbTemplateContent(id: string): Promise<unknown[]> {
  const rows = await unwrap<{ content: unknown[] }[]>(
    supabase.from("kb_templates").select("content").eq("id", id),
  );
  return rows[0]?.content ?? [];
}

export const KB_FAVORITES_KEY = "kb_favorites";

/** Избранное вошедшего в базе: id статей и папок (свои строки — RLS). */
export function useKbFavorites(baseId: string | null) {
  return useQuery({
    queryKey: [KB_FAVORITES_KEY, baseId],
    queryFn: async () => {
      const rows = await unwrap<{ node_id: string; created_at: string }[]>(
        supabase
          .from("kb_favorites")
          .select("node_id, created_at")
          .eq("base_id", baseId!)
          .order("created_at", { ascending: false }),
      );
      return rows.map((r) => r.node_id);
    },
    enabled: !!baseId,
    meta: { errorMessage: "Не удалось загрузить избранное" },
  });
}

/** Недавно открытые вошедшим статьи базы (его kb_reads), новые сверху. */
export function useKbRecentReads(baseId: string | null, userId: string | undefined) {
  return useQuery({
    queryKey: ["kb_reads", "recent", baseId, userId],
    queryFn: () =>
      unwrap<{ node_id: string; last_read_at: string }[]>(
        supabase
          .from("kb_reads")
          .select("node_id, last_read_at")
          .eq("base_id", baseId!)
          .eq("user_id", userId!)
          .order("last_read_at", { ascending: false })
          .limit(12),
      ),
    enabled: !!baseId && !!userId,
    meta: { errorMessage: "Не удалось загрузить недавние статьи" },
  });
}

/** Свои отметки чек-листов статьи (kb_checks): id пунктов. */
export function useKbChecks(nodeId: string | null) {
  return useQuery({
    queryKey: ["kb_checks", nodeId],
    queryFn: async () => {
      const rows = await unwrap<{ block_id: string }[]>(
        supabase.from("kb_checks").select("block_id").eq("node_id", nodeId!),
      );
      return new Set(rows.map((r) => r.block_id));
    },
    enabled: !!nodeId,
    meta: { errorMessage: "Не удалось загрузить отметки чек-листа" },
  });
}

// --- Теги статей (db/migrations/2026-10-25_zzzzzzzzz_kb_tags.sql) ----------------------------

/** Теги базы — по имени. */
export function useKbTags(baseId: string | null) {
  return useQuery({
    queryKey: [KB_TAGS_KEY, baseId],
    queryFn: async () =>
      sortTags(
        await unwrap<KbTag[]>(
          supabase.from("kb_tags").select("id, name, color").eq("base_id", baseId!),
        ),
      ),
    enabled: !!baseId,
    meta: { errorMessage: "Не удалось загрузить теги базы" },
  });
}

/**
 * Теги статей базы: статья → id тегов (по имени тега). Читателю RLS отдаёт
 * теги только видимых ему статей.
 */
export function useKbNodeTags(baseId: string | null) {
  const tags = useKbTags(baseId);
  const rows = useQuery({
    queryKey: [KB_NODE_TAGS_KEY, baseId],
    queryFn: () =>
      unwrap<{ node_id: string; tag_id: string }[]>(
        supabase.from("kb_node_tags").select("node_id, tag_id").eq("base_id", baseId!),
      ),
    enabled: !!baseId,
    meta: { errorMessage: "Не удалось загрузить теги статей" },
  });
  const data = useMemo<KbNodeTags | undefined>(
    () => (rows.data && tags.data ? groupNodeTags(rows.data, tags.data) : undefined),
    [rows.data, tags.data],
  );
  return { data, tags: tags.data, isLoading: rows.isLoading || tags.isLoading };
}

/** Новый тег базы; имя чистит база («#», пробелы). */
export async function createKbTag(
  baseId: string,
  name: string,
  color: KbTagColor = "gray",
): Promise<KbTag> {
  const { data, error } = await supabase
    .from("kb_tags")
    .insert({ base_id: baseId, name, color })
    .select("id, name, color")
    .single();
  if (error) throw new Error(error.message);
  return data as KbTag;
}

/** Теги статьи — как в `next`: добавить недостающие, снять лишние. */
export async function saveKbNodeTags(
  baseId: string,
  nodeId: string,
  prev: string[],
  next: string[],
): Promise<void> {
  const { add, remove } = tagDiff(prev, next);
  if (remove.length) {
    const { error } = await supabase
      .from("kb_node_tags")
      .delete()
      .eq("node_id", nodeId)
      .in("tag_id", remove);
    if (error) throw new Error(error.message);
  }
  if (add.length) {
    const { error } = await supabase
      .from("kb_node_tags")
      .insert(add.map((tag_id) => ({ node_id: nodeId, tag_id, base_id: baseId })));
    if (error) throw new Error(error.message);
  }
}
