/**
 * Теги статей базы знаний (решение владельца 2026-10-25) — логика без React.
 * Схема — db/migrations/2026-10-25_zzzzzzzzz_kb_tags.sql: теги свои у
 * каждой базы, имя без регистра уникально, у статьи — до 10 тегов.
 */

export type KbTag = { id: string; name: string; color?: KbTagColor | null };

/**
 * Цвета тегов (решение владельца 2026-10-25): текст — насыщенный тон, подложка —
 * светлый того же цвета; в тёмной теме базы — светлый текст на приглушённой
 * подложке. Ключ хранится в kb_tags.color (проверка — в миграции
 * 2026-10-25_zzzzzzzzzzz_kb_tag_colors.sql); null — серый.
 * Классы — целиком строками, чтобы их нашёл Tailwind.
 */
export const KB_TAG_COLORS = [
  {
    key: "gray",
    label: "Серый",
    chip: "bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
    dot: "bg-slate-500",
  },
  {
    key: "red",
    label: "Красный",
    chip: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  {
    key: "orange",
    label: "Оранжевый",
    chip: "bg-orange-100 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  {
    key: "yellow",
    label: "Жёлтый",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-400",
  },
  {
    key: "green",
    label: "Зелёный",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  {
    key: "teal",
    label: "Бирюзовый",
    chip: "bg-teal-100 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
    dot: "bg-teal-500",
  },
  {
    key: "blue",
    label: "Синий",
    chip: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  {
    key: "purple",
    label: "Фиолетовый",
    chip: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  {
    key: "pink",
    label: "Розовый",
    chip: "bg-pink-100 text-pink-700 dark:bg-pink-400/15 dark:text-pink-300",
    dot: "bg-pink-500",
  },
] as const;

export type KbTagColor = (typeof KB_TAG_COLORS)[number]["key"];

/** Цвет тега; незнакомый или пустой — серый. */
export function kbTagColor(color: string | null | undefined) {
  return KB_TAG_COLORS.find((c) => c.key === color) ?? KB_TAG_COLORS[0];
}

/** Теги статей базы: статья → id её тегов. */
export type KbNodeTags = Map<string, string[]>;

export const KB_TAG_MAX_LENGTH = 40;
export const KB_TAGS_PER_ARTICLE = 10;

/** Как имя сохранит база: без «#» в начале, пробелов по краям и двойных пробелов. */
export function normalizeTagName(raw: string): string {
  return raw
    .replace(/^\s*#+/, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, KB_TAG_MAX_LENGTH);
}

const key = (s: string) => normalizeTagName(s).toLocaleLowerCase("ru");

/** Тег с тем же именем (без регистра) — чтобы не заводить второй «Касса». */
export function findTagByName(tags: KbTag[], name: string): KbTag | undefined {
  const k = key(name);
  return k ? tags.find((t) => key(t.name) === k) : undefined;
}

export function sortTags(tags: KbTag[]): KbTag[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/**
 * Теги под строку поиска: имя содержит запрос («#» не мешает). Сначала
 * точное совпадение, затем начинающиеся с запроса, затем остальные по имени.
 */
export function matchTags(tags: KbTag[], query: string): KbTag[] {
  const q = key(query);
  if (!q) return [];
  const rank = (t: KbTag) => {
    const n = key(t.name);
    return n === q ? 0 : n.startsWith(q) ? 1 : 2;
  };
  return tags
    .filter((t) => key(t.name).includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ru"));
}

/** Строки kb_node_tags → статья → её теги (по имени тега). */
export function groupNodeTags(
  rows: { node_id: string; tag_id: string }[],
  tags: KbTag[],
): KbNodeTags {
  const order = new Map(sortTags(tags).map((t, i) => [t.id, i]));
  const map: KbNodeTags = new Map();
  for (const r of rows) {
    if (!order.has(r.tag_id)) continue;
    const list = map.get(r.node_id) ?? [];
    list.push(r.tag_id);
    map.set(r.node_id, list);
  }
  for (const list of map.values()) list.sort((a, b) => order.get(a)! - order.get(b)!);
  return map;
}

/** Сколько статей с каждым тегом — только из тех, что прошли `counts`. */
export function tagArticleCounts(
  nodeTags: KbNodeTags,
  counts: (nodeId: string) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [nodeId, ids] of nodeTags) {
    if (!counts(nodeId)) continue;
    for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Статьи с тегом. */
export function nodesWithTag(nodeTags: KbNodeTags, tagId: string): string[] {
  return [...nodeTags].filter(([, ids]) => ids.includes(tagId)).map(([nodeId]) => nodeId);
}

/** Что поменять в kb_node_tags: какие добавить и какие снять. */
export function tagDiff(prev: string[], next: string[]): { add: string[]; remove: string[] } {
  return {
    add: next.filter((id) => !prev.includes(id)),
    remove: prev.filter((id) => !next.includes(id)),
  };
}
