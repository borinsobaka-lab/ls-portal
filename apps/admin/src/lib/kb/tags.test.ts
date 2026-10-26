import { describe, expect, test } from "bun:test";

import {
  findTagByName,
  groupNodeTags,
  matchTags,
  nodesWithTag,
  normalizeTagName,
  tagArticleCounts,
  tagDiff,
} from "./tags";

const tags = [
  { id: "t1", name: "Касса смены" },
  { id: "t2", name: "Касса" },
  { id: "t3", name: "Открытие" },
  { id: "t4", name: "Предкассовая зона" },
];

describe("теги базы знаний", () => {
  test("имя — как сохранит база", () => {
    expect(normalizeTagName("  #Касса   смены ")).toBe("Касса смены");
    expect(normalizeTagName("##")).toBe("");
    expect(normalizeTagName("а".repeat(50))).toHaveLength(40);
  });

  test("тот же тег без регистра и «#»", () => {
    expect(findTagByName(tags, "#касса")?.id).toBe("t2");
    expect(findTagByName(tags, "касса  смены")?.id).toBe("t1");
    expect(findTagByName(tags, "  ")).toBeUndefined();
  });

  test("поиск тегов: точное, затем с начала, затем внутри", () => {
    expect(matchTags(tags, "#касс").map((t) => t.id)).toEqual(["t2", "t1", "t4"]);
    expect(matchTags(tags, "касса").map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(matchTags(tags, "#")).toEqual([]);
  });

  test("теги статей, счётчики и статьи тега", () => {
    const map = groupNodeTags(
      [
        { node_id: "a", tag_id: "t3" },
        { node_id: "a", tag_id: "t2" },
        { node_id: "b", tag_id: "t2" },
        { node_id: "c", tag_id: "gone" },
      ],
      tags,
    );
    expect(map.get("a")).toEqual(["t2", "t3"]);
    expect(map.has("c")).toBe(false);
    expect(tagArticleCounts(map, (id) => id !== "b").get("t2")).toBe(1);
    expect(tagArticleCounts(map, () => true).get("t2")).toBe(2);
    expect(nodesWithTag(map, "t2")).toEqual(["a", "b"]);
  });

  test("что добавить и что снять", () => {
    expect(tagDiff(["t1", "t2"], ["t2", "t3"])).toEqual({ add: ["t3"], remove: ["t1"] });
  });
});
