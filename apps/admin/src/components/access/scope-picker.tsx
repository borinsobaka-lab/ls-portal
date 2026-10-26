import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { CheckboxOption, InfoNote } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { networkStudiosQuery, orgBrandsQuery } from "@/lib/access/data";
import type { ScopeType } from "@/lib/access/types";

export type Scope = { scope_type: ScopeType; scope_ids: string[] };

/**
 * Где действуют права роли «в клубе»: во всех клубах сети (и в новых), в
 * клубах брендов (и в новых клубах бренда) или в выбранных клубах.
 * allowedStudioIds — управляющий клубами выдаёт только в своих (null — без
 * ограничений, тогда доступны «все» и «бренды»).
 */
export function ScopePicker({
  value,
  onChange,
  allowedStudioIds,
}: {
  value: Scope;
  onChange: (v: Scope) => void;
  allowedStudioIds: string[] | null;
}) {
  const { data: studios } = useQuery(networkStudiosQuery);
  const { data: brands } = useQuery(orgBrandsQuery);
  const [q, setQ] = useState("");
  const restricted = allowedStudioIds !== null;
  const allowed = new Set(allowedStudioIds ?? []);
  const list = (studios ?? []).filter((s) => !restricted || allowed.has(s.id));
  const term = q.trim().toLowerCase();
  const shown = list.filter(
    (s) => !term || `${s.name} ${s.city ?? ""}`.toLowerCase().includes(term),
  );
  const brandName = new Map((brands ?? []).map((b) => [b.id, b.name]));
  const toggle = (id: string, on: boolean) =>
    onChange({
      scope_type: value.scope_type,
      scope_ids: on
        ? [...new Set([...value.scope_ids, id])]
        : value.scope_ids.filter((x) => x !== id),
    });

  return (
    <div className="space-y-2">
      {!restricted && (
        <SegmentedControl
          aria-label="Где действует"
          fullWidth
          value={value.scope_type}
          onChange={(scope_type) => onChange({ scope_type, scope_ids: [] })}
          options={[
            { value: "all", label: "Все клубы" },
            { value: "brands", label: "Бренды" },
            { value: "studios", label: "Выбранные" },
            { value: "owned", label: "Собственника" },
          ]}
        />
      )}
      {value.scope_type === "all" && !restricted && (
        <InfoNote>Во всех клубах сети — и в тех, что появятся позже.</InfoNote>
      )}
      {value.scope_type === "owned" && !restricted && (
        <InfoNote>
          В клубах, где человек собственник («Оргструктура» → «Сеть клубов»), — у каждого свои.
          Сменились собственники — права пересчитаются сами.
        </InfoNote>
      )}
      {value.scope_type === "brands" && (
        <div className="space-y-2 rounded-md border p-3">
          {(brands ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Брендов нет — заведите их в «Оргструктуре» → «Сеть клубов».
            </p>
          ) : (
            (brands ?? []).map((b) => (
              <CheckboxOption
                key={b.id}
                checked={value.scope_ids.includes(b.id)}
                onCheckedChange={(on) => toggle(b.id, on)}
              >
                {b.name}
                <span className="text-muted-foreground">
                  {" "}
                  · клубов: {(studios ?? []).filter((s) => s.brand_id === b.id).length}
                </span>
              </CheckboxOption>
            ))
          )}
          <p className="text-xs text-muted-foreground">Новые клубы бренда войдут сами.</p>
        </div>
      )}
      {(value.scope_type === "studios" || restricted) && (
        <div className="space-y-2">
          {list.length > 8 && (
            <SearchInput value={q} onChange={setQ} placeholder="Клуб или город" />
          )}
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {list.length === 0
                  ? "Нет клубов, где вы управляете пользователями"
                  : "Ничего не нашлось"}
              </p>
            ) : (
              shown.map((s) => (
                <CheckboxOption
                  key={s.id}
                  checked={value.scope_ids.includes(s.id)}
                  onCheckedChange={(on) => toggle(s.id, on)}
                >
                  {s.name}
                  {(s.city || s.brand_id) && (
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {[s.city, s.brand_id ? brandName.get(s.brand_id) : null]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  )}
                </CheckboxOption>
              ))
            )}
          </div>
          {value.scope_ids.length > 0 && (
            <p className="text-xs text-muted-foreground">Отмечено: {value.scope_ids.length}</p>
          )}
        </div>
      )}
    </div>
  );
}
