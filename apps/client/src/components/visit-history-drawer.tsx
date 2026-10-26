import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Drawer as DrawerPrimitive } from "vaul";
import {
  AltArrowRight,
  CheckCircle,
  ClockCircle,
  CloseCircle,
  DangerCircle,
  Fire,
  History,
} from "@solar-icons/react";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { msg, useLocalize, useT, type Translator } from "@/i18n";
import { visitHistoryQuery } from "@/lib/home-queries";
import { IS_PACKAGES } from "@/lib/terms";
import {
  groupVisitsByMonth,
  visitMinutes,
  visitStatus,
  type VisitRow,
  type VisitStatus,
} from "@/lib/visit-history";
import { workoutTypeMeta } from "@/lib/workout-types";

const STATUS_META: Record<
  VisitStatus,
  { label: string; icon: typeof CheckCircle; className: string }
> = {
  attended: {
    label: msg("Посещено"),
    icon: CheckCircle,
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  },
  cancelled: {
    label: msg("Отменено"),
    icon: CloseCircle,
    className: "bg-muted text-muted-foreground",
  },
  no_show: {
    label: msg("Пропущено"),
    icon: DangerCircle,
    className: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  },
  unmarked: {
    label: msg("Ожидает отметки"),
    icon: ClockCircle,
    className: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  },
};

/** «Октябрь» — текущий год, «Октябрь 2025» — прошлые. */
function monthHeading(ts: number, t: Translator) {
  const d = new Date(ts);
  const month = t.capitalize(t.date(d, { month: "long" }));
  return d.getFullYear() === new Date().getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

/**
 * Плашка «История посещений» под записями на главной (блок «Тренировки»):
 * по нажатию — шторка со списком прошедших занятий клиента.
 */
export function VisitHistoryButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-4 mt-4 flex w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-opacity active:opacity-80"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
        <History className="h-5 w-5 text-foreground" weight="BoldDuotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-snug">{t("История посещений")}</span>
        <span className="block text-xs text-muted-foreground">{t("Прошедшие тренировки")}</span>
      </span>
      <AltArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * Шторка «История посещений»: прошедшие занятия клиента по месяцам, новые
 * сверху — тренировка, тренер, дата, время, длительность, калории (у
 * посещённых, если в анкете есть вес) и статус. Данные — visitHistoryQuery
 * (журнал bookings_log), грузятся при открытии.
 */
export function VisitHistoryDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const query = useQuery({ ...visitHistoryQuery(user?.id ?? null), enabled: open && !!user });
  const groups = useMemo(() => {
    if (!query.data) return null;
    return groupVisitsByMonth(query.data.filter((v) => visitStatus(v.status) !== null));
  }, [query.data]);

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-1 mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <DrawerPrimitive.Title className="px-4 pb-2 pt-3 text-2xl font-semibold">
            {t("История посещений")}
          </DrawerPrimitive.Title>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-1">
            {groups === null && query.isError ? (
              <p className="py-6 text-center text-sm text-destructive">
                {t("Не удалось загрузить историю посещений. Попробуйте ещё раз.")}
              </p>
            ) : groups === null ? (
              <div className="space-y-2 pt-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[76px] w-full rounded-lg" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <History className="h-10 w-10" weight="BoldDuotone" />
                <span className="text-sm">
                  {t("Здесь появятся тренировки, на которых вы были")}
                </span>
              </div>
            ) : (
              <div className="space-y-5 pt-1">
                {groups.map((group) => (
                  <div key={group.ts} className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground">
                      {monthHeading(group.ts, t)}
                    </div>
                    {group.items.map((v) => (
                      <VisitCard key={v.id} visit={v} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

function VisitCard({ visit: v }: { visit: VisitRow }) {
  const t = useT();
  const loc = useLocalize();
  const status = visitStatus(v.status) ?? "unmarked";
  const meta = STATUS_META[status];
  const StatusIcon = meta.icon;
  const workout = loc(v.workout);
  const name = v.diagnostic
    ? t("Диагностика тела")
    : (workout?.name ?? v.workout_name ?? t("Тренировка"));
  const trainerNames = v.trainers.map((tr) => loc(tr).full_name).filter((n): n is string => !!n);
  const minutes = visitMinutes(v);
  const start = new Date(v.starts_at);
  // Полоска слева — как в карточках записей: пакетное — цвет тренировки,
  // подписочное — цвет типа.
  const hex = v.workout?.color?.trim();
  const packColor = IS_PACKAGES && hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
  const stripe = IS_PACKAGES
    ? packColor
      ? ""
      : "bg-muted-foreground/40"
    : workoutTypeMeta(v.workout?.type ?? v.workout_type).stripe;
  const faded = status === "cancelled";

  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-card p-3 pl-4">
      <span
        className={`absolute bottom-0 left-0 top-0 w-1.5 ${stripe} ${faded ? "opacity-40" : ""}`}
        style={packColor ? { backgroundColor: packColor } : undefined}
      />
      <div className="flex w-11 shrink-0 flex-col items-center justify-center">
        <div className="text-xl font-black leading-none tabular-nums">
          {t.date(start, { day: "numeric" })}
        </div>
        <div className="mt-1 text-[11px] font-medium leading-none text-muted-foreground">
          {t.date(start, { month: "short" })}
        </div>
        <div className="mt-0.5 text-[11px] leading-none text-muted-foreground">
          {t.date(start, { weekday: "short" })}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div
            className={`min-w-0 break-words font-semibold leading-snug ${faded ? "text-muted-foreground" : ""}`}
          >
            {name}
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${meta.className}`}
          >
            <StatusIcon className="h-3 w-3" weight="Bold" />
            {t(meta.label)}
          </span>
        </div>
        {trainerNames.length > 0 && (
          <div className="mt-0.5 truncate text-sm text-muted-foreground">
            {trainerNames.join(", ")}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          <span>{t.time(start)}</span>
          {minutes != null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("{n} мин", { n: minutes })}</span>
            </>
          )}
          {status === "attended" && v.calories != null && v.calories > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-0.5 text-orange-600 dark:text-orange-400">
                <Fire className="h-3.5 w-3.5" weight="Bold" />
                {t("{n} ккал", { n: t.number(v.calories) })}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
