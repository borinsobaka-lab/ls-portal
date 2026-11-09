/**
 * «Кто из подразделения» — одна общая пара настроек для чатов (состав из
 * оргструктуры), календарей (кому открыт), проектов (участники из
 * подразделения) и базы знаний («Кто видит»): все сотрудники или только
 * руководители и заместители, с подразделениями ниже или без.
 *
 * Для новичка по умолчанию — одна строка «Все сотрудники, включая
 * подразделения ниже · Настроить» (так нужно в 9 случаях из 10); нажатие
 * раскрывает выбор. Уже настроенное не по умолчанию — раскрыто сразу.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { unitScopeText, type UnitScope } from "@/lib/unit-scope";

export function UnitScopeFields({
  scope,
  withSubunits,
  onChange,
  disabled = false,
}: {
  scope: UnitScope;
  withSubunits: boolean;
  onChange: (v: { scope: UnitScope; withSubunits: boolean }) => void;
  disabled?: boolean;
}) {
  const custom = scope !== "all" || !withSubunits;
  const [open, setOpen] = useState(custom);
  if (!open || disabled)
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">{unitScopeText(scope, withSubunits)}</span>
        {!disabled && (
          <Button variant="link" size="inline" onClick={() => setOpen(true)}>
            Настроить
          </Button>
        )}
      </div>
    );
  return (
    <div className="space-y-3">
      <SegmentedControl
        aria-label="Кто из подразделения"
        fullWidth
        value={scope}
        onChange={(s) => onChange({ scope: s, withSubunits })}
        options={[
          { value: "all", label: "Все сотрудники" },
          { value: "heads", label: "Руководители и заместители" },
        ]}
      />
      <SwitchRow
        title="Включая подразделения ниже"
        tip="Люди из подразделений ниже по оргструктуре тоже попадут сюда. Новые сотрудники — сами."
        checked={withSubunits}
        onCheckedChange={(v) => onChange({ scope, withSubunits: v })}
      />
    </div>
  );
}
