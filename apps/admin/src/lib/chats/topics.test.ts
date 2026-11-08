import { describe, expect, test } from "bun:test";

import {
  canCreateTopic,
  canManageTopic,
  isForum,
  mergeTopics,
  sortChats,
  topicsOf,
} from "./topics";
import type { ChatRow } from "./types";

const row = (p: Partial<ChatRow>): ChatRow => ({
  id: "x",
  kind: "group",
  title: "Группа",
  description: null,
  settings: {},
  peer_id: null,
  member_count: 3,
  my_role: "member",
  notify: "all",
  muted_until: null,
  pinned_at: null,
  last_seq: 0,
  last_read_seq: 0,
  last_message: null,
  last_message_at: null,
  unread: 0,
  mentions: 0,
  created_at: "2026-11-01T00:00:00Z",
  parent_id: null,
  created_by: null,
  ...p,
});
const msg = (text: string) => ({ seq: 1, author_id: "a", kind: "text" as const, text });

describe("темы в группах", () => {
  const g = row({
    id: "g",
    settings: { topics: true },
    unread: 1,
    last_message: msg("общая"),
    last_message_at: "2026-11-08T08:00:00Z",
  });
  const t1 = row({
    id: "t1",
    kind: "topic",
    parent_id: "g",
    title: "Отчёты",
    unread: 2,
    mentions: 1,
    last_message: msg("отчёт"),
    last_message_at: "2026-11-08T09:00:00Z",
  });
  const t2 = row({
    id: "t2",
    kind: "topic",
    parent_id: "g",
    title: "Мемы",
    unread: 5,
    notify: "none",
    last_message_at: "2026-11-08T07:00:00Z",
  });
  const t3 = row({
    id: "t3",
    kind: "topic",
    parent_id: "g",
    title: "Архив",
    settings: { closed: true },
    last_message_at: "2026-11-08T10:00:00Z",
  });
  const other = row({ id: "o", kind: "direct", last_message_at: "2026-11-08T08:30:00Z" });

  test("свёртка: темы — в строку группы, без звука — не в счёт", () => {
    const merged = mergeTopics([g, t1, t2, t3, other]);
    expect(merged.map((c) => c.id)).toEqual(["g", "o"]);
    const mg = merged[0];
    expect(mg.unread).toBe(3);
    expect(mg.mentions).toBe(1);
    expect(mg.last_topic).toBe("Архив");
    expect(mg.last_message_at).toBe("2026-11-08T10:00:00Z");
    expect(sortChats(merged).map((c) => c.id)).toEqual(["g", "o"]);
  });

  test("темы группы: открытые сверху, свежие первыми", () => {
    expect(topicsOf([g, t1, t2, t3, other], "g").map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("права", () => {
    expect(isForum(g)).toBe(true);
    expect(isForum(other)).toBe(false);
    expect(canCreateTopic(g)).toBe(false);
    expect(canCreateTopic({ ...g, settings: { topics: true, topic_create: "all" } })).toBe(true);
    expect(canCreateTopic({ ...g, my_role: "admin" })).toBe(true);
    expect(canManageTopic({ created_by: "me" }, g, "me")).toBe(true);
    expect(canManageTopic({ created_by: "x" }, g, "me")).toBe(false);
    expect(canManageTopic({ created_by: "x" }, { my_role: "owner" }, "me")).toBe(true);
  });
});
