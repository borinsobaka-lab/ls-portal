/**
 * Набор эмодзи для чатов — из emojibase-data (devDependency): русские
 * названия и слова для поиска, английские — тоже (ищут и «lol»). Пишет
 * src/lib/chats/emoji-data.ts: по строке на группу, эмодзи — «символ\tслова».
 *
 * Без оттенков кожи и без «компонентов» (квадраты оттенков, причёски).
 * Только эмодзи до версии MAX_VERSION: новее — у части телефонов и
 * компьютеров их нет в системном шрифте, вместо значка был бы квадрат.
 *
 * Запуск: bun run scripts/gen-emoji.ts (после обновления emojibase-data).
 */
import { writeFileSync } from "node:fs";

import en from "emojibase-data/en/compact.json";
import ru from "emojibase-data/ru/data.json";

const MAX_VERSION = 15;
/** Группы emojibase → наши разделы (2 — компоненты — не берём). */
const GROUPS: [number, string][] = [
  [0, "smileys"],
  [1, "people"],
  [3, "nature"],
  [4, "food"],
  [5, "travel"],
  [6, "activities"],
  [7, "objects"],
  [8, "symbols"],
  [9, "flags"],
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

const enBy = new Map(en.map((e) => [e.hexcode, e]));
const byGroup = new Map<number, { order: number; line: string }[]>();
for (const e of ru) {
  if (e.group === undefined || e.group === 2 || (e.version ?? 0) > MAX_VERSION) continue;
  const eng = enBy.get(e.hexcode);
  const words = [e.label, ...(e.tags ?? []), eng?.label ?? "", ...(eng?.tags ?? [])];
  const text = [...new Set(words.map(norm).filter(Boolean))].join(" ").replace(/[\t\n]/g, " ");
  const list = byGroup.get(e.group) ?? [];
  list.push({ order: e.order ?? 0, line: `${e.emoji}\t${text}` });
  byGroup.set(e.group, list);
}

const out = [
  "// Создано scripts/gen-emoji.ts из emojibase-data — не править руками.",
  "// Группа — строки «эмодзи\\tслова для поиска» (русские и английские).",
  "export const EMOJI_GROUPS: [string, string][] = [",
  ...GROUPS.map(([g, key]) => {
    const lines = (byGroup.get(g) ?? []).sort((a, b) => a.order - b.order).map((x) => x.line);
    return `  [\n    ${JSON.stringify(key)},\n    ${JSON.stringify(lines.join("\n"))},\n  ],`;
  }),
  "];",
  "",
].join("\n");
writeFileSync(new URL("../src/lib/chats/emoji-data.ts", import.meta.url), out);
console.log(
  "Эмодзи:",
  GROUPS.map(([g, k]) => `${k} ${byGroup.get(g)?.length ?? 0}`).join(", "),
  `— ${(out.length / 1024).toFixed(0)} КБ`,
);
