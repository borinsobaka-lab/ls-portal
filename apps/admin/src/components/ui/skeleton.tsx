import { cn } from "@/lib/utils";

/**
 * Заглушка загружающегося блока.
 *
 * Фон — только нейтральный серый. Раньше здесь стоял `bg-primary/10`, то есть
 * заливка фирменным цветом: в клиентском приложении primary — жёлтый, и все
 * скелетоны шли жёлтыми пятнами поверх серых карточек. Брендовый цвет в
 * состоянии загрузки не несёт смысла и только шумит, поэтому берём
 * `muted-foreground` с низкой прозрачностью: он нейтрален, читается и на белом,
 * и на карточке, и сам инвертируется в тёмной теме.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted-foreground/20", className)} {...props} />
  );
}

export { Skeleton };
