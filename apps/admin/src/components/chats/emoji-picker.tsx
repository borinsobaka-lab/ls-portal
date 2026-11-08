/**
 * Окно выбора эмодзи (решение владельца 2026-11-08: «весь набор, с
 * поиском»): поиск по-русски и по-английски, разделы с переходом по
 * значкам, «Недавние» — в браузере. Отдельный чанк вместе с данными
 * (lib/chats/emoji-data.ts, ~80 КБ gzip) — грузится по первому открытию.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Apple,
  Cat,
  Clock,
  Dumbbell,
  Flag,
  Hand,
  Heart,
  Lightbulb,
  Plane,
  Smile,
} from "lucide-react";

import { SearchInput } from "@/components/ui/search-input";
import { EMOJI_GROUPS } from "@/lib/chats/emoji-data";
import {
  EMOJI_GROUP_LABELS,
  parseEmojiGroups,
  readRecentEmoji,
  rememberEmoji,
  searchEmoji,
  type EmojiGroup,
} from "@/lib/chats/emoji";
import { cn } from "@/lib/utils";

const GROUPS = parseEmojiGroups(EMOJI_GROUPS);

const ICONS: Record<string, typeof Smile> = {
  recent: Clock,
  smileys: Smile,
  people: Hand,
  nature: Cat,
  food: Apple,
  travel: Plane,
  activities: Dumbbell,
  objects: Lightbulb,
  symbols: Heart,
  flags: Flag,
};

export default function EmojiPicker({
  onPick,
  autoFocus,
}: {
  onPick: (emoji: string) => void;
  /** Курсор в поиск: с мышью — да, на телефоне — нет (выскочила бы клавиатура). */
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecentEmoji);
  const [active, setActive] = useState("smileys");
  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups: EmojiGroup[] = useMemo(
    () =>
      recent.length
        ? [{ key: "recent", items: recent.map((emoji) => ({ emoji, words: "" })) }, ...GROUPS]
        : GROUPS,
    [recent],
  );
  const found = useMemo(() => (query.trim() ? searchEmoji(GROUPS, query) : null), [query]);

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const pick = (emoji: string) => {
    onPick(emoji);
    setRecent(rememberEmoji(emoji));
  };

  const jump = (key: string) => {
    setQuery("");
    setActive(key);
    // После сброса поиска разделы снова в DOM — прокрутка следующим кадром.
    requestAnimationFrame(() => {
      const box = scroller.current;
      const el = box?.querySelector<HTMLElement>(`[data-emoji-group="${key}"]`);
      if (box && el) box.scrollTo({ top: el.offsetTop - box.offsetTop });
    });
  };

  const onScroll = () => {
    const box = scroller.current;
    if (!box || found) return;
    let current = groups[0]?.key ?? "smileys";
    for (const el of box.querySelectorAll<HTMLElement>("[data-emoji-group]")) {
      if (el.offsetTop - box.offsetTop <= box.scrollTop + 8) current = el.dataset.emojiGroup!;
    }
    if (current !== active) setActive(current);
  };

  const cell = (emoji: string, title?: string) => (
    <button
      key={emoji}
      type="button"
      title={title}
      aria-label={title ?? emoji}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(emoji)}
      className="flex aspect-square items-center justify-center rounded-md text-[22px] leading-none hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      {emoji}
    </button>
  );

  return (
    <div className="flex h-[min(380px,60dvh)] w-full flex-col">
      <div className="p-2 pb-1">
        <SearchInput
          ref={searchRef}
          value={query}
          onChange={setQuery}
          placeholder="Поиск эмодзи"
          aria-label="Поиск эмодзи"
          onKeyDown={(e) => {
            if (e.key === "Enter" && found?.[0]) {
              e.preventDefault();
              pick(found[0].emoji);
            }
          }}
        />
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2"
      >
        {found ? (
          found.length ? (
            <div className="grid grid-cols-8 gap-0.5 pb-2">
              {found.map((it) => cell(it.emoji, it.words.trim().split(" ").slice(0, 3).join(" ")))}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">Ничего не нашлось</p>
          )
        ) : (
          groups.map((g) => (
            <section key={g.key} data-emoji-group={g.key} className="pb-2">
              <h3 className="sticky top-0 z-10 bg-popover/95 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                {EMOJI_GROUP_LABELS[g.key] ?? g.key}
              </h3>
              <div className="grid grid-cols-8 gap-0.5 [content-visibility:auto]">
                {g.items.map((it) => cell(it.emoji))}
              </div>
            </section>
          ))
        )}
      </div>
      <div
        role="tablist"
        aria-label="Разделы эмодзи"
        className="flex shrink-0 justify-between border-t px-1 py-1"
      >
        {groups.map((g) => {
          const Icon = ICONS[g.key] ?? Smile;
          const on = !found && active === g.key;
          return (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={EMOJI_GROUP_LABELS[g.key]}
              title={EMOJI_GROUP_LABELS[g.key]}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => jump(g.key)}
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
                on && "bg-muted text-chat-accent",
              )}
            >
              <Icon className="size-4" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
