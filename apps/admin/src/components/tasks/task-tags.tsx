/**
 * Теги задач (TASKS_CHATS_PLAN.md, этап 2, бриф 1.12): общие для портала —
 * по городу, каналу, теме. Пилюля `#Казань` цветом тега (набор — как у
 * тегов базы знаний) и поле выбора с поиском и «Создать тег «…»». Схема —
 * db/migrations/2026-11-08_zzzzzzzzz_task_tags.sql.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { KbTagColorPicker } from "@/components/kb/tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { kbTagColor, normalizeTagName, type KbTagColor } from "@/lib/kb/tags";
import { createTag, tagsQuery, taskErrorText } from "@/lib/tasks/data";
import type { TaskTag } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const TASK_TAGS_MAX = 10;

const chipBase =
  "inline-flex max-w-full items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium";

export function TaskTagChip({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<TaskTag, "name" | "color">;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span className={cn(chipBase, kbTagColor(tag.color).chip, onRemove && "pr-1", className)}>
      <span className="opacity-60">#</span>
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Убрать тег «${tag.name}»`}
          className="ml-0.5 rounded-full p-0.5 hover:bg-foreground/10"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Выбор тегов: пилюли и «+ Тег» — список с поиском и созданием нового. */
export function TaskTagsField({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const { data: tags = [] } = useQuery(tagsQuery);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState<KbTagColor>("gray");
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const selected = value.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
  const name = normalizeTagName(search);
  const lower = name.toLowerCase();
  const exact = tags.find((t) => t.name.toLowerCase() === lower);
  const options = tags
    .filter((t) => !value.includes(t.id))
    .filter((t) => !lower || t.name.toLowerCase().includes(lower))
    .slice(0, 30);
  const full = value.length >= TASK_TAGS_MAX;

  const add = (id: string) => {
    onChange([...value, id]);
    setSearch("");
  };
  const create = async () => {
    if (!name || busy) return;
    setBusy(true);
    try {
      add(await createTag(qc, name, color));
    } catch (e) {
      toast.error(taskErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((t) => (
        <TaskTagChip
          key={t.id}
          tag={t}
          onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== t.id))}
        />
      ))}
      {selected.length === 0 && disabled && (
        <span className="text-sm text-muted-foreground">—</span>
      )}
      {!disabled && !full && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs">
              <Plus className="size-3.5" /> Тег
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-2 p-2">
            <Input
              autoFocus
              value={search}
              maxLength={40}
              placeholder="Найти или создать: Казань, VK…"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (exact && !value.includes(exact.id)) add(exact.id);
                else if (!exact) void create();
              }}
            />
            <div className="max-h-56 overflow-y-auto">
              {options.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => add(t.id)}
                >
                  <TaskTagChip tag={t} />
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {t.count}
                  </span>
                </button>
              ))}
              {options.length === 0 && !name && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Тегов пока нет — создайте первый.
                </p>
              )}
            </div>
            {name && !exact && (
              <div className="space-y-2 border-t pt-2">
                <KbTagColorPicker value={color} onChange={setColor} />
                <Button size="sm" className="w-full" disabled={busy} onClick={() => void create()}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Создать тег «{name}»
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
