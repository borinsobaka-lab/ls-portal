import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Скелетоны контента мобильного приложения: показываем «болванку» реального
 * блока вместо спиннера — экран не прыгает и сразу понятно, что именно грузится.
 */

/** Список занятий в расписании: время + название + кнопка записи. */
export function ScheduleListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="relative">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="relative pb-4">
          <Card className="relative flex w-full items-center gap-3 overflow-hidden rounded-lg p-3 pl-4">
            <span className="absolute bottom-0 left-0 top-0 w-1.5 bg-muted" />
            <div className="flex w-12 shrink-0 flex-col items-center justify-center">
              <Skeleton className="h-4 w-10" />
            </div>
            <div className="ml-1 min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          </Card>
        </div>
      ))}
    </div>
  );
}

/** Карточки абонементов — крупные плитки с обложкой и списком преимуществ. */
export function MembershipCardsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: cards }).map((_, i) => (
        <Card key={i} className="flex w-[85%] shrink-0 flex-col overflow-hidden rounded-xl p-0">
          <Skeleton className="h-32 w-full rounded-none" />
          <div className="space-y-3 p-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <div className="space-y-2 pt-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-4/6" />
            </div>
            <Skeleton className="mt-2 h-12 w-full rounded-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Универсальный список карточек (новости, услуги, уведомления). */
export function CardListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="h-14 w-14 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Горизонтальная карусель (новости, мои тренировки, услуги на главной).
 * Раньше в каждой из трёх каруселей лежал свой инлайновый `animate-pulse`
 * с разным фоном (`bg-background/60`, `bg-card`, `bg-muted`) — одно и то же
 * состояние загрузки выглядело по-разному на одном экране. Размер плитки
 * задаётся снаружи: он у каруселей действительно разный.
 */
export function CarouselSkeleton({ cards = 3, className }: { cards?: number; className?: string }) {
  return (
    <div className="flex gap-3 overflow-hidden px-4 pb-2">
      {Array.from({ length: cards }).map((_, i) => (
        <Skeleton key={i} className={cn("shrink-0 rounded-2xl", className)} />
      ))}
    </div>
  );
}
