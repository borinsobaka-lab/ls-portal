/**
 * Эмодзи чатов: полный набор с поиском по-русски и по-английски
 * (данные — emoji-data.ts, создаёт scripts/gen-emoji.ts; грузятся отдельным
 * чанком вместе с окном выбора), недавние — в браузере.
 */
export type EmojiItem = { emoji: string; words: string };
export type EmojiGroup = { key: string; items: EmojiItem[] };

export const EMOJI_GROUP_LABELS: Record<string, string> = {
  recent: "Недавние",
  smileys: "Смайлы и эмоции",
  people: "Люди и жесты",
  nature: "Животные и природа",
  food: "Еда и напитки",
  travel: "Путешествия и места",
  activities: "Спорт и занятия",
  objects: "Предметы",
  symbols: "Символы",
  flags: "Флаги",
};

/** Разбор строк генератора: «эмодзи\tслова». */
export function parseEmojiGroups(raw: [string, string][]): EmojiGroup[] {
  return raw.map(([key, text]) => ({
    key,
    items: text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab < 0
          ? { emoji: line, words: "" }
          : { emoji: line.slice(0, tab), words: ` ${line.slice(tab + 1)}` };
      }),
  }));
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim();

/**
 * Поиск: каждое слово запроса — начало слова в названии или словах эмодзи
 * («серд» → ❤️, «смех» → 😂). Выше — у кого совпало начало названия.
 */
export function searchEmoji(groups: EmojiGroup[], query: string, limit = 120): EmojiItem[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const first: EmojiItem[] = [];
  const rest: EmojiItem[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const it of g.items) {
      if (seen.has(it.emoji)) continue;
      if (!words.every((w) => it.words.includes(` ${w}`))) continue;
      seen.add(it.emoji);
      (it.words.startsWith(` ${words[0]}`) ? first : rest).push(it);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

const RECENT_KEY = "chat_recent_emoji";
export const RECENT_MAX = 32;

/** Недавние — свежие сверху, без повторов. */
export function pushRecent(list: string[], emoji: string, max = RECENT_MAX): string[] {
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, max);
}

export function readRecentEmoji(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): string[] {
  const next = pushRecent(readRecentEmoji(), emoji);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // приватный режим — без недавних
  }
  return next;
}
