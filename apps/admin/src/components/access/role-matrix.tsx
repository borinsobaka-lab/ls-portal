import { useQuery } from "@tanstack/react-query";

import { CheckboxOption, InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FieldHint } from "@/components/ui/field-hint";
import { accessKbBasesQuery } from "@/lib/access/data";
import {
  clubSectionPerms,
  groupCatalog,
  LEVEL_LABEL,
  permLevel,
  setPerm,
  TIER_LABEL,
} from "@/lib/access/logic";
import type { PermissionDef, RolePerm, Tier } from "@/lib/access/types";

const NONE = "none";

/**
 * Матрица прав роли по блокам каталога (access_permissions): уровень
 * доступа к данным клуба и разделы клуба, разделы админки, базы знаний и
 * Академия, управление порталом. networkOnly — личные права человека (без
 * прав «в клубе»). canSuperadmin — показывать ли «Суперадминистратора»
 * (выдаёт только суперадминистратор).
 */
export function RoleMatrix({
  catalog,
  value,
  onChange,
  disabled,
  networkOnly,
  canSuperadmin,
}: {
  catalog: PermissionDef[];
  value: RolePerm[];
  onChange: (v: RolePerm[]) => void;
  disabled?: boolean;
  networkOnly?: boolean;
  canSuperadmin?: boolean;
}) {
  const { data: bases } = useQuery(accessKbBasesQuery);
  const groups = groupCatalog(
    catalog.filter(
      (p) =>
        (!networkOnly || p.scope === "network") &&
        (p.key !== "portal.admin" || canSuperadmin || !!permLevel(value, "portal.admin")),
    ),
  );
  const set = (key: string, level: string | null, target: string | null = null) =>
    onChange(setPerm(value, key, level, target));

  const tier = permLevel(value, "studio.tier") as Tier | null;
  const allSections = !!permLevel(value, "club.all") || tier === "owner";
  const kbAll = permLevel(value, "kb.base");

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        // Белая карточка на канве, заголовок — внутри (float снимает «вырез»
        // legend в рамке fieldset), как у AccessSection.
        <fieldset
          key={g.block}
          className="space-y-3 rounded-lg border bg-background p-4"
          disabled={disabled}
        >
          <legend className="float-left w-full font-semibold">{g.label}</legend>
          <p className="clear-left -mt-2 text-xs text-muted-foreground">{g.hint}</p>

          {g.block === "club" && (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1 text-sm font-medium">
                  Доступ к данным клуба
                  <FieldHint>{catalog.find((p) => p.key === "studio.tier")?.hint}</FieldHint>
                </div>
                <SegmentedControl
                  aria-label="Доступ к данным клуба"
                  fullWidth
                  value={tier ?? NONE}
                  onChange={(v) => {
                    let next = setPerm(value, "studio.tier", v === NONE ? null : v);
                    // Без доступа к данным разделы клуба ничего не дают.
                    if (v === NONE) next = next.filter((p) => !p.perm_key.startsWith("club."));
                    onChange(next);
                  }}
                  options={[
                    { value: NONE, label: "Нет" },
                    ...(["trainer", "admin", "owner"] as const).map((t) => ({
                      value: t,
                      label: TIER_LABEL[t],
                    })),
                  ]}
                />
              </div>
              {tier && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Разделы клуба</div>
                  {tier === "owner" ? (
                    <InfoNote>Владельцу клуба открыты все разделы клуба.</InfoNote>
                  ) : (
                    <>
                      <CheckboxOption
                        checked={allSections}
                        onCheckedChange={(on) => {
                          let next = value.filter(
                            (p) => !(p.perm_key.startsWith("club.") && p.perm_key !== "club.all"),
                          );
                          next = setPerm(next, "club.all", on ? "on" : null);
                          onChange(next);
                        }}
                        disabled={disabled}
                      >
                        Все разделы — и те, что появятся позже
                      </CheckboxOption>
                      {!allSections && (
                        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                          {clubSectionPerms(catalog).map((p) => (
                            <CheckboxOption
                              key={p.key}
                              checked={!!permLevel(value, p.key)}
                              onCheckedChange={(on) => set(p.key, on ? "on" : null)}
                              disabled={disabled}
                            >
                              {p.label}
                            </CheckboxOption>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {g.items
            .filter((p) => p.block !== "club")
            .map((p) =>
              p.target === "kb_base" ? (
                <div key={p.key} className="space-y-2">
                  <LevelRow
                    label="Все базы знаний"
                    hint="И базы, которые появятся позже."
                    levels={p.levels}
                    value={kbAll}
                    onChange={(lvl) => set("kb.base", lvl)}
                  />
                  {(bases ?? []).length > 0 && (
                    <div className="divide-y rounded-md border">
                      {(bases ?? []).map((b) => {
                        const own = permLevel(value, "kb.base", b.id);
                        return (
                          <div key={b.id} className="px-3 py-2">
                            <LevelRow
                              label={b.title}
                              levels={p.levels}
                              value={own}
                              note={kbAll && !own ? `по «Всем базам»: ${LEVEL_LABEL[kbAll]}` : null}
                              onChange={(lvl) => set("kb.base", lvl, b.id)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : p.levels.length > 1 ? (
                <LevelRow
                  key={p.key}
                  label={p.label}
                  hint={p.hint}
                  levels={p.levels}
                  value={permLevel(value, p.key)}
                  onChange={(lvl) => set(p.key, lvl)}
                />
              ) : (
                <div key={p.key} className="flex items-center gap-1">
                  <CheckboxOption
                    checked={!!permLevel(value, p.key)}
                    onCheckedChange={(on) => set(p.key, on ? "on" : null)}
                    disabled={disabled}
                  >
                    {p.label}
                  </CheckboxOption>
                  {p.hint && <FieldHint>{p.hint}</FieldHint>}
                </div>
              ),
            )}
        </fieldset>
      ))}
    </div>
  );
}

function LevelRow({
  label,
  hint,
  levels,
  value,
  note,
  onChange,
}: {
  label: string;
  hint?: string | null;
  levels: string[];
  value: string | null;
  note?: string | null;
  onChange: (level: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-sm font-medium">
          <span className="truncate">{label}</span>
          {hint && <FieldHint>{hint}</FieldHint>}
        </div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </div>
      <SegmentedControl
        aria-label={label}
        value={value ?? NONE}
        onChange={(v) => onChange(v === NONE ? null : v)}
        options={[
          { value: NONE, label: "Нет" },
          ...levels.map((l) => ({ value: l, label: capitalize(LEVEL_LABEL[l] ?? l) })),
        ]}
      />
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
