import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  KB_NODES_KEY,
  invalidateKb,
  kbErrorText,
  loadKbTemplateContent,
  saveKbNodeTags,
} from "@/lib/kb/data";
import { documentFilePaths } from "@/lib/kb/document";
import { copyKbFiles, kbArticleFolder } from "@/lib/kb/files";
import { applyMove } from "@/lib/kb/tree";
import type { KbKind, KbStatus, KbTreeNode } from "@/lib/kb/types";

/**
 * Действия редактора с деревом базы: из бокового меню и со страниц. Права
 * проверяет RLS (kb_nodes editor write) и RPC; ошибки — тостом по-русски.
 */
export function useKbActions(baseId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const fail = (e: unknown) => toast.error(kbErrorText(e));

  const create = useCallback(
    async (
      kind: KbKind,
      parentId: string | null,
      title: string,
      description = "",
      icon: string | null = null,
      /** Статья по шаблону: его текст — черновиком новой статьи. */
      templateId: string | null = null,
      /** Теги новой статьи. */
      tags: string[] = [],
    ) => {
      const { data, error } = await supabase
        .from("kb_nodes")
        .insert({
          base_id: baseId,
          parent_id: parentId,
          kind,
          title,
          description,
          icon: kind === "folder" ? icon : null,
          // Папку видно сразу (пустую читателю не покажем), статья — черновик
          // до публикации.
          status: kind === "folder" ? "published" : "draft",
        })
        .select("id")
        .single();
      if (error) {
        fail(error.message);
        return null;
      }
      const id = (data as { id: string }).id;
      if (kind === "article" && tags.length) {
        try {
          await saveKbNodeTags(baseId, id, [], tags);
        } catch (e) {
          toast.error(`Статья создана, но теги не сохранились: ${kbErrorText(e)}`);
        }
      }
      if (kind === "article" && templateId) {
        try {
          // Файлы шаблона — копиями в папку статьи: шаблон общий для всех
          // баз, его папку читатели статьи не видят.
          const copied = await copyKbFiles(
            await loadKbTemplateContent(templateId),
            kbArticleFolder(baseId, id),
          );
          const { error: draftError } = await supabase.rpc("kb_save_draft", {
            p_node: id,
            p_content: copied.content,
            p_expected: null,
          });
          if (draftError) throw new Error(draftError.message);
          if (copied.failed > 0)
            toast.warning(
              `Не удалось скопировать файлов шаблона: ${copied.failed}. Загрузите их в статью заново.`,
            );
        } catch (e) {
          toast.error(`Статья создана, но текст шаблона не подставился: ${kbErrorText(e)}`);
        }
      }
      await invalidateKb(qc, baseId);
      await navigate({
        to: "/kb/$baseId/$nodeId",
        params: { baseId, nodeId: id },
        search: kind === "article" ? { edit: true } : {},
      });
      return id;
    },
    [baseId, qc, navigate],
  );

  const update = useCallback(
    async (
      id: string,
      patch: Partial<
        Pick<
          KbTreeNode,
          | "title"
          | "description"
          | "icon"
          | "protect"
          | "status"
          | "feedback_enabled"
          | "pager_enabled"
          | "author_id"
        >
      >,
    ) => {
      const { error } = await supabase.from("kb_nodes").update(patch).eq("id", id);
      if (error) {
        fail(error.message);
        return false;
      }
      await invalidateKb(qc, baseId);
      return true;
    },
    [baseId, qc],
  );

  const setStatus = useCallback(
    async (node: KbTreeNode, status: KbStatus) => {
      const ok = await update(node.id, { status });
      if (ok) {
        const what = node.kind === "folder" ? "Папка" : "Статья";
        toast.success(
          status === "archived"
            ? `${what} в архиве — читатели её больше не видят`
            : status === "draft"
              ? `${what} снята с публикации`
              : `${what} снова опубликована`,
        );
      }
      return ok;
    },
    [update],
  );

  const move = useCallback(
    async (nodeId: string, parentId: string | null, position: number) => {
      // Порядок — сразу на месте, база пересчитает его одной командой.
      qc.setQueryData<KbTreeNode[]>([KB_NODES_KEY, baseId], (prev) =>
        prev ? applyMove(prev, nodeId, parentId, position) : prev,
      );
      const { error } = await supabase.rpc("kb_move_node", {
        p_node: nodeId,
        p_parent: parentId,
        p_index: position,
      });
      if (error) fail(error.message);
      await invalidateKb(qc, baseId);
      return !error;
    },
    [baseId, qc],
  );

  const copy = useCallback(
    async (nodeId: string) => {
      const { data, error } = await supabase.rpc("kb_copy_node", { p_node: nodeId });
      if (error) {
        fail(error.message);
        return;
      }
      const copyId = data as string;
      // Теги — как у оригинала.
      try {
        const { data: rows } = await supabase
          .from("kb_node_tags")
          .select("tag_id")
          .eq("node_id", nodeId);
        const tagIds = ((rows ?? []) as { tag_id: string }[]).map((r) => r.tag_id);
        if (tagIds.length) await saveKbNodeTags(baseId, copyId, [], tagIds);
      } catch (e) {
        toast.warning(`Копия создана, но теги не скопировались: ${kbErrorText(e)}`);
      }
      // Файлы — копиями в папку копии: иначе копия ссылалась бы на папку
      // оригинала и теряла картинки, когда оригинал удалят навсегда.
      try {
        const { data: draft } = await supabase
          .from("kb_drafts")
          .select("content, updated_at")
          .eq("node_id", copyId)
          .maybeSingle();
        const row = draft as { content: unknown[]; updated_at: string } | null;
        if (row && documentFilePaths(row.content).length) {
          const copied = await copyKbFiles(row.content, kbArticleFolder(baseId, copyId));
          const { error: saveError } = await supabase.rpc("kb_save_draft", {
            p_node: copyId,
            p_content: copied.content,
            p_expected: row.updated_at,
          });
          if (saveError) throw new Error(saveError.message);
          if (copied.failed > 0)
            toast.warning(`Не удалось скопировать файлов: ${copied.failed} — проверьте копию.`);
        }
      } catch (e) {
        toast.warning(`Копия создана, но файлы не скопировались: ${kbErrorText(e)}`);
      }
      await invalidateKb(qc, baseId);
      toast.success("Копия создана — черновиком под оригиналом");
      await navigate({
        to: "/kb/$baseId/$nodeId",
        params: { baseId, nodeId: copyId },
        search: { edit: true },
      });
    },
    [baseId, qc, navigate],
  );

  // В корзину со всем вложенным (kb_trash_node): 30 дней можно вернуть.
  const remove = useCallback(
    async (node: KbTreeNode) => {
      const { error } = await supabase.rpc("kb_trash_node", { p_node: node.id });
      if (error) {
        fail(error.message);
        return false;
      }
      await invalidateKb(qc, baseId);
      await qc.invalidateQueries({ queryKey: ["kb_trash", baseId] });
      toast.success(
        node.kind === "folder"
          ? "Папка в корзине — вернуть можно 30 дней"
          : "Статья в корзине — вернуть можно 30 дней",
      );
      return true;
    },
    [baseId, qc],
  );

  return { create, update, setStatus, move, copy, remove };
}
