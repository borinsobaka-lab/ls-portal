import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { DocumentText } from "@/components/nav-icons";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import { SearchInput } from "@/components/ui/search-input";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { kbBasesQuery, useKbTree } from "@/lib/kb/data";
import { ancestorsOf, indexTree } from "@/lib/kb/tree";
import type { KbTreeNode } from "@/lib/kb/types";

/**
 * Урок из статьи базы знаний: база (из открытых создателю) и опубликованная
 * статья в ней. Урок станет копией текста и файлов статьи (решение
 * владельца: копия + «Обновить»).
 */
export function AcadArticlePicker({
  busy,
  usedIds,
  onPick,
  onCancel,
}: {
  busy: boolean;
  /** Статьи, уже ставшие уроками курса, — помечены и не выбираются второй раз. */
  usedIds: Set<string>;
  onPick: (node: KbTreeNode) => void;
  onCancel: () => void;
}) {
  const { data: bases } = useQuery(kbBasesQuery);
  const [baseId, setBaseId] = useState<string | null>(null);
  const current = baseId ?? bases?.[0]?.id ?? null;
  const { data: nodes, isLoading } = useKbTree(current);
  const index = useMemo(() => indexTree(nodes ?? []), [nodes]);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const articles = (nodes ?? [])
    .filter((n) => n.kind === "article" && n.status === "published" && n.published_at)
    .filter((n) => !term || n.title.toLowerCase().includes(term))
    .slice(0, 60);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Урок из статьи</DialogTitle>
        <DialogDescription>
          Текст и файлы статьи скопируются в урок. Если статью потом опубликуют заново, в
          конструкторе появится «Статья изменилась — обновить».
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {bases && bases.length === 0 ? (
          <InfoNote variant="empty">
            Вам не открыта ни одна база знаний — доступ выдаёт владелец в «Доступах».
          </InfoNote>
        ) : (
          <div className="space-y-3">
            <FormField label="База знаний">
              <Select value={current ?? ""} onValueChange={setBaseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите базу" />
                </SelectTrigger>
                <SelectContent>
                  {(bases ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <SearchInput value={q} onChange={setQ} placeholder="Название статьи" />
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {isLoading ? (
                <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Загружаем статьи…
                </p>
              ) : articles.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Опубликованных статей не нашлось
                </p>
              ) : (
                articles.map((a) => {
                  const used = usedIds.has(a.id);
                  return (
                    <ListItemButton key={a.id} disabled={busy || used} onClick={() => onPick(a)}>
                      <DocumentText className="text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {a.title || "Без названия"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {ancestorsOf(index, a.id)
                            .map((p) => p.title)
                            .join(" › ") || "Верхний уровень"}
                        </span>
                      </span>
                      {used && (
                        <StatusChip tone="neutral" size="sm">
                          Уже в курсе
                        </StatusChip>
                      )}
                    </ListItemButton>
                  );
                })
              )}
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Копируем статью…" : "Отмена"}
        </Button>
      </DialogFooter>
    </>
  );
}
