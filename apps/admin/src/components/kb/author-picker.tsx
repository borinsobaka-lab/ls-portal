/**
 * «Сменить автора» статьи (решение владельца 2026-10-28) — редакторам базы.
 * Список — люди портала (`kb_mention_candidates`, тот же запрос, что у
 * упоминаний «@»), сначала с доступом к базе. Выбранный автор пишется в
 * `kb_nodes.author_id` и не меняется при следующих публикациях; «Автор —
 * кто опубликовал» возвращает прежнее правило.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, RotateCcw } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import { useKbActions } from "@/components/kb/use-kb-actions";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import type { PersonShort } from "@/lib/people";

type Candidate = PersonShort & { has_access: boolean };

export function KbAuthorPicker({
  baseId,
  nodeId,
  authorId,
}: {
  baseId: string;
  nodeId: string;
  /** Выбранный редактором автор; null — автор тот, кто опубликовал. */
  authorId: string | null;
}) {
  const qc = useQueryClient();
  const actions = useKbActions(baseId);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: people, isLoading } = useQuery({
    queryKey: ["kb_mention_candidates", baseId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("kb_mention_candidates", { p_base: baseId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Candidate[];
    },
    enabled: open,
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить сотрудников" },
  });

  const save = async (next: string | null) => {
    if (next === authorId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      const ok = await actions.update(nodeId, { author_id: next });
      if (ok) {
        // Имя и аватарку нового автора отдаёт kb_authors.
        await qc.invalidateQueries({ queryKey: ["kb_authors", baseId] });
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const withAccess = (people ?? []).filter((p) => p.has_access);
  const withoutAccess = (people ?? []).filter((p) => !p.has_access);
  const item = (p: Candidate) => (
    <CommandItem
      key={p.user_id}
      value={`${p.full_name ?? ""} ${p.position_name ?? ""} ${p.user_id}`}
      onSelect={() => void save(p.user_id)}
      disabled={saving}
    >
      <StaffAvatar value={p.avatar_url} name={p.full_name ?? ""} className="size-6 text-[10px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{p.full_name}</span>
        {p.position_name && (
          <span className="block truncate text-xs text-muted-foreground">{p.position_name}</span>
        )}
      </span>
      {p.user_id === authorId && <Check className="size-4" />}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Сменить автора"
          aria-label="Сменить автора"
          className="ml-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full align-middle text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Найти сотрудника" />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Загружаем сотрудников…" : "Никого не нашлось"}
            </CommandEmpty>
            {authorId && (
              <CommandGroup>
                <CommandItem
                  value="__published_by"
                  onSelect={() => void save(null)}
                  disabled={saving}
                >
                  <RotateCcw />
                  Автор — кто опубликовал
                </CommandItem>
              </CommandGroup>
            )}
            {withAccess.length > 0 && (
              <CommandGroup heading="С доступом к базе">{withAccess.map(item)}</CommandGroup>
            )}
            {withoutAccess.length > 0 && (
              <CommandGroup heading="Без доступа к этой базе">
                {withoutAccess.map(item)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
