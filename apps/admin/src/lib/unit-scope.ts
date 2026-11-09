/** «Кто из подразделения» — подпись выбора (`components/people/unit-scope-fields.tsx`). */
export type UnitScope = "all" | "heads";

export function unitScopeText(scope: UnitScope, withSubunits: boolean): string {
  return `${scope === "heads" ? "Руководители и заместители" : "Все сотрудники"}, ${
    withSubunits ? "включая подразделения ниже" : "без подразделений ниже"
  }`;
}
