import type { Studio } from "@/hooks/use-studios";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Клуб строки в разделах, где собраны данные всех клубов сотрудника
 * («Обратная связь», «Заявки», «NPS-опросы», «Касса»): точка цвета клуба и
 * название. Строка без клуба (старые обращения) — «—».
 */
export function StudioLabel({
  studio,
  className,
}: {
  studio: Pick<Studio, "name" | "brand_color"> | null | undefined;
  className?: string;
}) {
  if (!studio) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: studio.brand_color }}
      />
      {studio.name}
    </span>
  );
}

/** Фильтр по клубу на плашке фильтров: «Все клубы» или один. */
export function StudioFilter({
  studios,
  value,
  onChange,
}: {
  studios: Studio[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48" aria-label="Клуб">
        <SelectValue placeholder="Все клубы" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Все клубы</SelectItem>
        {studios.map((s) => (
          <SelectItem key={s.id} value={s.id} textValue={s.name}>
            <StudioLabel studio={s} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Выбор клуба в форме (новая операция кассы, обращение, ответ NPS). */
export function StudioSelect({
  studios,
  value,
  onChange,
}: {
  studios: Studio[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label="Клуб">
        <SelectValue placeholder="Выберите клуб" />
      </SelectTrigger>
      <SelectContent>
        {studios.map((s) => (
          <SelectItem key={s.id} value={s.id} textValue={s.name}>
            <StudioLabel studio={s} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
