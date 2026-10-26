import { setActiveStudioId, useActiveStudioId } from "@/hooks/use-active-studio";
import { useStudios } from "@/hooks/use-studios";
import { STUDIO_FORMAT_LABEL } from "@/lib/studio-formats";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Переключатель студий. Список — студии, где пользователь сотрудник; выбор
 * по умолчанию и брендинг держит StudioBranding в layout.
 */
export function StudioSwitcher({ triggerClassName }: { triggerClassName?: string }) {
  const { data: studios = [], isLoading } = useStudios();
  const active = useActiveStudioId();

  // Пока список студий грузится — болванка поля той же ширины. Цвет поля
  // (на тёмном меню — bg-white/5) приходит из triggerClassName.
  if (isLoading) return <Skeleton className={cn("h-10 w-60", triggerClassName)} />;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Select
        value={studios.some((s) => s.id === active) ? (active ?? undefined) : undefined}
        onValueChange={setActiveStudioId}
        disabled={studios.length === 0}
      >
        {/* Тип студии — только в выпадающем списке, в поле хватает названия. */}
        <SelectTrigger
          aria-label="Клуб"
          className={cn("w-60 [&_.studio-format]:hidden", triggerClassName)}
        >
          <SelectValue placeholder={studios.length === 0 ? "Нет клубов" : "Выберите клуб"} />
        </SelectTrigger>
        <SelectContent>
          {studios.map((s) => (
            <SelectItem key={s.id} value={s.id} textValue={s.name}>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: s.brand_color }}
                />
                <span className="truncate">{s.name}</span>
                {studios.length > 1 && (
                  <span className="studio-format truncate text-xs text-muted-foreground">
                    {STUDIO_FORMAT_LABEL[s.format]}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
