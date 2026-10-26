import { CheckboxOption, FormField } from "@/components/ui/form-field";
import { useStudioNames } from "@/hooks/use-app-studios";
import { useStudios } from "@/hooks/use-studios";

/**
 * Клубы у записей «Мобильного приложения» (новости, услуги, пуши —
 * `studio_ids`, db/migrations/2026-10-11_zzzzzzzzzz_app_content_by_studio.sql).
 * Сотрудник выбирает только свои клубы (где у него есть роль); чужие клубы
 * записи видны, но не меняются — их оставляет и проверяет база. Хуки —
 * hooks/use-app-studios.ts.
 */

/** Клубы записи в таблице: названия через запятую. */
export function StudioNamesCell({ ids }: { ids: string[] }) {
  const { data: names } = useStudioNames();
  const { data: mine = [] } = useStudios();
  if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
  // Все свои клубы (и только они) — короче.
  if (mine.length > 1 && ids.length === mine.length && mine.every((s) => ids.includes(s.id))) {
    return <span className="text-sm">Все клубы</span>;
  }
  const list = ids.map((id) => names?.get(id) ?? "…");
  return (
    <span className="line-clamp-2 text-sm" title={list.join(", ")}>
      {list.join(", ")}
    </span>
  );
}

/**
 * Поле «Клубы» в форме: свои клубы — чекбоксами, чужие — строкой под ними.
 * value — выбранные свои клубы; locked — чужие клубы записи (сохраняются).
 */
export function AppStudiosField({
  value,
  onChange,
  locked,
  tip,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  locked: string[];
  tip: string;
}) {
  const { data: studios = [] } = useStudios();
  const { data: names } = useStudioNames();
  const all = studios.length > 0 && studios.every((s) => value.includes(s.id));
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...new Set([...value, id])] : value.filter((x) => x !== id));

  return (
    <FormField label="Клубы" tip={tip} htmlFor={null} required>
      <div className="space-y-2 rounded-md border p-3">
        {studios.length > 1 && (
          <CheckboxOption
            checked={all}
            onCheckedChange={(v) => onChange(v ? studios.map((s) => s.id) : [])}
          >
            Все мои клубы
          </CheckboxOption>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {studios.map((s) => (
            <CheckboxOption
              key={s.id}
              checked={value.includes(s.id)}
              onCheckedChange={(v) => toggle(s.id, v)}
            >
              {s.name}
            </CheckboxOption>
          ))}
        </div>
        {locked.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Ещё в клубах, к которым у вас нет доступа:{" "}
            {locked.map((id) => names?.get(id) ?? "…").join(", ")}. Их можно поменять только с
            доступом к этим клубам.
          </p>
        )}
      </div>
    </FormField>
  );
}
