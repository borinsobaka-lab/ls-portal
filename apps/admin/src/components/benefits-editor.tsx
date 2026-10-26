import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Список пунктов (memberships.benefits): поле ввода + «+» (или Enter), у
 * каждого пункта — удаление. «Преимущества» подписочной номенклатуры и «Что
 * входит» пакетной.
 */
export function BenefitsEditor({
  placeholder = "Добавьте преимущество и нажмите +",
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...value, v]);
    setDraft("");
  };

  return (
    <>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" size="icon" onClick={add} aria-label="Добавить пункт">
          <Plus />
        </Button>
      </div>
      {value.length > 0 && (
        <ul className="space-y-1 pt-1">
          {value.map((b, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1 text-sm"
            >
              <span className="truncate" title={b}>
                {b}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Удалить: ${b}`}
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
