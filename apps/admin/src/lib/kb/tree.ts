/**
 * Дерево базы знаний без React: порядок, предки, перенос, что показать
 * читателю. Строки — kb_nodes без текста (lib/kb/data.ts, kbTreeQuery).
 */
import type { KbTreeNode } from "./types";

export type KbTreeIndex = {
  byId: Map<string, KbTreeNode>;
  /** Дети папки (null — верхний уровень) в порядке базы. */
  children: Map<string | null, KbTreeNode[]>;
};

const byOrder = (a: KbTreeNode, b: KbTreeNode) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

export function indexTree(nodes: KbTreeNode[]): KbTreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, KbTreeNode[]>();
  for (const n of nodes) {
    // Родитель не пришёл (читателю не видна папка выше) — строку не показываем:
    // RLS такого не отдаёт, но кэш между запросами может.
    const parent = n.parent_id && byId.has(n.parent_id) ? n.parent_id : null;
    if (n.parent_id && parent === null) continue;
    const list = children.get(parent) ?? [];
    list.push(n);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(byOrder);
  return { byId, children };
}

export function childrenOf(index: KbTreeIndex, parentId: string | null): KbTreeNode[] {
  return index.children.get(parentId) ?? [];
}

/**
 * Может ли узел вида `kind` лежать внутри `parent` (null — верхний уровень).
 * В папке — что угодно, в статье — только статьи (вложенные статьи, решение
 * владельца 2026-10-25); как проверяет база (kb_nodes_biu).
 */
export function canNestIn(
  parent: KbTreeNode | null | undefined,
  kind: KbTreeNode["kind"],
): boolean {
  return !parent || parent.kind === "folder" || kind === "article";
}

/** Папки и статьи выше узла — от верхней к ближайшей. */
export function ancestorsOf(index: KbTreeIndex, id: string): KbTreeNode[] {
  const out: KbTreeNode[] = [];
  let cur = index.byId.get(id);
  const seen = new Set<string>();
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = index.byId.get(cur.parent_id);
    if (!parent) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

/** Лежит ли `id` внутри `ancestorId` (на любой глубине) или это он сам. */
export function isWithin(index: KbTreeIndex, id: string, ancestorId: string): boolean {
  return id === ancestorId || ancestorsOf(index, id).some((a) => a.id === ancestorId);
}

/**
 * Статей внутри узла на любой глубине — и вложенных в статьи (папки не
 * считаются); `onlyVisible` — только те, что видит читатель (без черновиков
 * и архива).
 */
export function articleCount(
  index: KbTreeIndex,
  folderId: string | null,
  onlyVisible = false,
): number {
  return childrenOf(index, folderId).reduce(
    (sum, n) =>
      sum +
      (n.kind === "article" && (!onlyVisible || n.reader_visible) ? 1 : 0) +
      articleCount(index, n.id, onlyVisible),
    0,
  );
}

/**
 * Что видит читатель: RLS уже отдал только опубликованное, здесь убираем
 * пустые папки — в которых нет ни одной статьи (боль брифа: пустые разделы
 * перегружают меню). Редактор видит всё как есть.
 */
export function readerNodes(nodes: KbTreeNode[]): KbTreeNode[] {
  const index = indexTree(nodes);
  return nodes.filter((n) => n.kind === "article" || articleCount(index, n.id) > 0);
}

export type DropOperation = "reorder-before" | "reorder-after" | "combine";

/**
 * Куда встанет узел `sourceId`, уроненный на `targetId`: родитель и место
 * среди его содержимого (как ждёт RPC kb_move_node). null — нельзя (в саму
 * себя или в своё вложенное, папку — внутрь статьи).
 */
export function dropPlacement(
  index: KbTreeIndex,
  sourceId: string,
  targetId: string,
  operation: DropOperation,
): { parentId: string | null; position: number } | null {
  const target = index.byId.get(targetId);
  const source = index.byId.get(sourceId);
  if (!target || !source || sourceId === targetId) return null;
  if (operation === "combine") {
    if (!canNestIn(target, source.kind)) return null;
    if (isWithin(index, target.id, source.id)) return null;
    // Внутрь папки — в конец её содержимого.
    const siblings = childrenOf(index, target.id).filter((n) => n.id !== sourceId);
    return { parentId: target.id, position: siblings.length };
  }
  const parentId = target.parent_id;
  if (parentId && isWithin(index, parentId, source.id)) return null;
  // Рядом со вложенной статьёй — значит внутрь её статьи-родителя.
  if (!canNestIn(parentId ? index.byId.get(parentId) : null, source.kind)) return null;
  const siblings = childrenOf(index, parentId).filter((n) => n.id !== sourceId);
  const at = siblings.findIndex((n) => n.id === targetId);
  return { parentId, position: at + (operation === "reorder-after" ? 1 : 0) };
}

/** Порядок после переноса — чтобы показать его сразу, до ответа базы. */
export function applyMove(
  nodes: KbTreeNode[],
  nodeId: string,
  parentId: string | null,
  position: number,
): KbTreeNode[] {
  const index = indexTree(nodes);
  const siblings = childrenOf(index, parentId).filter((n) => n.id !== nodeId);
  const moved = index.byId.get(nodeId);
  if (!moved) return nodes;
  siblings.splice(Math.max(0, Math.min(position, siblings.length)), 0, moved);
  const order = new Map(siblings.map((n, i) => [n.id, i + 1]));
  return nodes.map((n) =>
    order.has(n.id)
      ? { ...n, sort_order: order.get(n.id)!, parent_id: n.id === nodeId ? parentId : n.parent_id }
      : n,
  );
}

/**
 * Соседи статьи для «Предыдущая / Следующая» внизу статьи: статьи базы по
 * порядку дерева (папки — вглубь, как в меню), без архива. `nodes` — уже
 * то, что видит этот человек (читателю — readerNodes).
 */
export function articleNeighbors(
  index: KbTreeIndex,
  articleId: string,
): { prev: KbTreeNode | null; next: KbTreeNode | null } {
  const order: KbTreeNode[] = [];
  const walk = (parentId: string | null) => {
    for (const n of childrenOf(index, parentId)) {
      if (n.status === "archived") continue;
      // Статья — и сразу её вложенные статьи, как в меню.
      if (n.kind === "article") order.push(n);
      walk(n.id);
    }
  };
  walk(null);
  const at = order.findIndex((n) => n.id === articleId);
  if (at < 0) return { prev: null, next: null };
  return { prev: order[at - 1] ?? null, next: order[at + 1] ?? null };
}
