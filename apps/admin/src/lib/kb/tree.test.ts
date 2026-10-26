import { describe, expect, test } from "bun:test";

import {
  ancestorsOf,
  applyMove,
  articleCount,
  articleNeighbors,
  childrenOf,
  dropPlacement,
  indexTree,
  readerNodes,
} from "./tree";
import type { KbTreeNode } from "./types";

let order = 0;
function n(id: string, parent: string | null, kind: "folder" | "article" = "article"): KbTreeNode {
  order += 1;
  return {
    id,
    base_id: "b",
    parent_id: parent,
    kind,
    title: id,
    description: "",
    icon: null,
    sort_order: order,
    status: "published",
    reader_visible: true,
    created_at: "2026-10-24T00:00:00Z",
    updated_at: "2026-10-24T00:00:00Z",
    published_at: null,
    published_by: null,
  };
}

// LS ─┬─ Админ ─┬─ open
//     │         └─ close
//     └─ empty (пустая папка)
// office
const nodes = [
  n("LS", null, "folder"),
  n("admin", "LS", "folder"),
  n("open", "admin"),
  n("close", "admin"),
  n("empty", "LS", "folder"),
  n("office", null),
];
const index = indexTree(nodes);

describe("дерево базы знаний", () => {
  test("дети по порядку и предки", () => {
    expect(childrenOf(index, null).map((x) => x.id)).toEqual(["LS", "office"]);
    expect(ancestorsOf(index, "open").map((x) => x.id)).toEqual(["LS", "admin"]);
    expect(articleCount(index, "LS")).toBe(2);
    expect(articleCount(index, "empty")).toBe(0);
  });

  test("читателю пустые папки не показываются", () => {
    expect(readerNodes(nodes).map((x) => x.id)).toEqual(["LS", "admin", "open", "close", "office"]);
  });

  test("перенос: выше, ниже, внутрь папки", () => {
    expect(dropPlacement(index, "close", "open", "reorder-before")).toEqual({
      parentId: "admin",
      position: 0,
    });
    expect(dropPlacement(index, "office", "open", "reorder-after")).toEqual({
      parentId: "admin",
      position: 1,
    });
    expect(dropPlacement(index, "office", "empty", "combine")).toEqual({
      parentId: "empty",
      position: 0,
    });
    expect(dropPlacement(index, "office", "admin", "combine")).toEqual({
      parentId: "admin",
      position: 2,
    });
  });

  test("папку нельзя в саму себя, в свою вложенную и внутрь статьи", () => {
    expect(dropPlacement(index, "LS", "admin", "combine")).toBeNull();
    expect(dropPlacement(index, "LS", "open", "reorder-after")).toBeNull();
    expect(dropPlacement(index, "empty", "open", "combine")).toBeNull();
    expect(dropPlacement(index, "LS", "LS", "reorder-after")).toBeNull();
  });

  test("статью — внутрь статьи (вложенные статьи)", () => {
    expect(dropPlacement(index, "office", "open", "combine")).toEqual({
      parentId: "open",
      position: 0,
    });
  });

  test("порядок после переноса показывается сразу", () => {
    const moved = applyMove(nodes, "office", "admin", 1);
    const i = indexTree(moved);
    expect(childrenOf(i, "admin").map((x) => x.id)).toEqual(["open", "office", "close"]);
    expect(childrenOf(i, null).map((x) => x.id)).toEqual(["LS"]);
  });
});

test("счётчик читателя — без черновиков и архива", () => {
  const hiddenDraft = { ...n("draft", "admin"), status: "draft" as const, reader_visible: false };
  const i = indexTree([...nodes, hiddenDraft]);
  expect(articleCount(i, "LS")).toBe(3);
  expect(articleCount(i, "LS", true)).toBe(2);
  expect(articleCount(i, null, true)).toBe(3);
});

describe("articleNeighbors", () => {
  test("по порядку дерева через папки, без архива", () => {
    const idx = indexTree(nodes);
    expect(articleNeighbors(idx, "open")).toMatchObject({ prev: null, next: { id: "close" } });
    expect(articleNeighbors(idx, "close")).toMatchObject({
      prev: { id: "open" },
      next: { id: "office" },
    });
    expect(articleNeighbors(idx, "office")).toMatchObject({ prev: { id: "close" }, next: null });
    const archived = nodes.map((x) =>
      x.id === "close" ? { ...x, status: "archived" as const } : x,
    );
    expect(articleNeighbors(indexTree(archived), "open").next?.id).toBe("office");
    expect(articleNeighbors(idx, "nope")).toEqual({ prev: null, next: null });
  });
});

describe("вложенные статьи", () => {
  // guide ─┬─ step1 ─── step1a
  //        └─ step2
  // tail
  const tree = [
    n("guide", null),
    n("step1", "guide"),
    n("step1a", "step1"),
    n("step2", "guide"),
    n("tail", null),
  ];
  const idx = indexTree(tree);

  test("считаются вместе со статьёй-родителем, предки — статьи", () => {
    expect(articleCount(idx, null)).toBe(5);
    expect(articleCount(idx, "guide")).toBe(3);
    expect(ancestorsOf(idx, "step1a").map((x) => x.id)).toEqual(["guide", "step1"]);
  });

  test("«Предыдущая / Следующая» — статья, затем её вложенные", () => {
    expect(articleNeighbors(idx, "guide")).toMatchObject({ prev: null, next: { id: "step1" } });
    expect(articleNeighbors(idx, "step1a")).toMatchObject({
      prev: { id: "step1" },
      next: { id: "step2" },
    });
    expect(articleNeighbors(idx, "tail").prev?.id).toBe("step2");
  });

  test("рядом с вложенной статьёй — внутрь её родителя; папку туда нельзя", () => {
    const withFolder = indexTree([...tree, n("box", null, "folder")]);
    expect(dropPlacement(withFolder, "tail", "step2", "reorder-before")).toEqual({
      parentId: "guide",
      position: 1,
    });
    expect(dropPlacement(withFolder, "box", "step2", "reorder-before")).toBeNull();
    expect(dropPlacement(withFolder, "guide", "step1a", "combine")).toBeNull();
  });
});
