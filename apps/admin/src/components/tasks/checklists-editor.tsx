/**
 * Чек-листы в форме постановки и шаблона: несколько списков с названием,
 * пункты (Enter — следующий пункт).
 */
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DraftList } from "@/lib/tasks/logic";

export function ChecklistsEditor({
  lists,
  onChange,
}: {
  lists: DraftList[];
  onChange: (l: DraftList[]) => void;
}) {
  const setList = (i: number, l: DraftList) => onChange(lists.map((x, j) => (j === i ? l : x)));
  return (
    <div className="space-y-3">
      {lists.map((l, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border p-2.5">
          <div className="flex gap-1.5">
            <Input
              className="font-medium"
              value={l.title}
              aria-label="Название чек-листа"
              placeholder="Чек-лист"
              onChange={(e) => setList(i, { ...l, title: e.target.value })}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Убрать чек-лист"
              onClick={() => onChange(lists.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </div>
          {l.items.map((it, k) => (
            <div key={k} className="flex gap-1.5 pl-3">
              <Input
                value={it.text}
                placeholder={`Пункт ${k + 1}`}
                onChange={(e) =>
                  setList(i, {
                    ...l,
                    items: l.items.map((x, n) => (n === k ? { ...x, text: e.target.value } : x)),
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setList(i, {
                      ...l,
                      items: [...l.items.slice(0, k + 1), { text: "" }, ...l.items.slice(k + 1)],
                    });
                  }
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Убрать пункт"
                onClick={() => setList(i, { ...l, items: l.items.filter((_, n) => n !== k) })}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="ml-3"
            onClick={() => setList(i, { ...l, items: [...l.items, { text: "" }] })}
          >
            <Plus className="size-4" /> Пункт
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...lists, { title: lists.length ? "" : "Чек-лист", items: [{ text: "" }] }])
        }
      >
        <Plus className="size-4" /> Чек-лист
      </Button>
    </div>
  );
}
