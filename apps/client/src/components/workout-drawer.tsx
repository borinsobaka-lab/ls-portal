import { useEffect, useState } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import {
  AltArrowRight,
  Calendar,
  CloseCircle,
  MapPoint,
  Star,
  UsersGroupRounded,
} from "@solar-icons/react";
import { toast } from "sonner";
// Заглушка без фото тренировки: PNG/WebP 336×336 вместо прежнего SVG на 1,4 МБ
// (тысячи контуров карты — долго грузился и рисовался при открытии шторки).
import logoSrc from "@/assets/brand-placeholder.webp";
import { workoutTypeMeta } from "@/lib/workout-types";
import { formatCancelDeadline } from "@/hooks/use-club-settings";
import { useFormatStudios } from "@/hooks/use-viewed-studio";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
} from "@/components/ui/squircle-avatar";
import { googleCalendarUrl, outlookLiveUrl, downloadICS, type CalendarEvent } from "@/lib/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AppleCalendarIcon,
  GoogleCalendarIcon,
  IcsFileIcon,
  OutlookIcon,
} from "@/components/calendar-icons";
import { SubstitutionChip } from "@/formats/packages/workout-card";
import { FormattedText } from "@/lib/formatted-text";
import { TrainerDrawer } from "@/formats/packages/trainer-drawer";
import { formatRating } from "@/formats/packages/trainer-rating";
import { useLocalize, useT, type Translator } from "@/i18n";

export type WorkoutDrawerData = {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  photo: string | null;
  trainerName: string | null;
  trainerPhoto: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  // Пакетное приложение (formats/packages/entries.ts): цвет тренировки вместо
  // типа, тренеры крупно — каждый с аватаркой, свободные места.
  color?: string | null;
  trainers?: {
    id: string;
    name: string;
    photo: string | null;
    rating?: number | null;
    /** Замена (2026-10-13): кого заменяет этот тренер — показывается неактивным. */
    replaced?: { id: string; name: string; photo: string | null } | null;
  }[];
  spotsLabel?: string | null;
  spotsLeft?: number | null;
  /** Студия занятия — название и адрес в шторке (куда записывается клиент). */
  studioId?: string | null;
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** «Пн, 13 октября · 19:00–20:00 · 60 мин». */
function whenLabel(startsAt: string, endsAt: string | null | undefined, t: Translator) {
  const start = new Date(startsAt);
  const raw = t.date(start, {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
  const day = t.capitalize(raw);
  const time = (d: Date) => t.time(d);
  if (!endsAt) return `${day} · ${time(start)}`;
  const end = new Date(endsAt);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return `${day} · ${time(start)}–${time(end)}${minutes > 0 ? ` · ${t("{n} мин", { n: minutes })}` : ""}`;
}

export function WorkoutDrawer({
  data,
  open,
  onOpenChange,
  onBook,
  isBooked,
  isWaitlisted = false,
  isFull = false,
  isPending,
  cancelMinutes,
  bookingNote,
}: {
  data: WorkoutDrawerData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBook: () => void;
  isBooked: boolean;
  isWaitlisted?: boolean;
  isFull?: boolean;
  isPending: boolean;
  cancelMinutes?: number;
  /** Записаться нельзя (другая студия) — текст вместо кнопки «Записаться». */
  bookingNote?: string | null;
}) {
  const t = useT();
  const loc = useLocalize();
  const isPack = !!data?.trainers;
  const typeMeta = data && !isPack ? workoutTypeMeta(data.type) : null;
  const TypeIcon = typeMeta?.icon ?? null;
  const { data: studios } = useFormatStudios();
  const studio =
    isPack && data?.studioId ? loc(studios?.find((s) => s.id === data.studioId)) : null;
  const [calendarPickerOpen, setCalendarPickerOpen] = useState(false);
  // Окно «Отменить запись?» — подтверждение, чтобы не отменить случайным касанием.
  const [cancelOpen, setCancelOpen] = useState(false);
  // Карточка тренера (пакетное) — вложенной шторкой поверх окна тренировки.
  const [trainerId, setTrainerId] = useState<string | null>(null);

  useEffect(() => {
    setCancelOpen(false);
    setTrainerId(null);
  }, [data?.id, open]);

  const cancelLocked =
    isBooked &&
    typeof cancelMinutes === "number" &&
    !!data?.startsAt &&
    new Date(data.startsAt).getTime() - Date.now() < cancelMinutes * 60_000;

  const calendarEvent: CalendarEvent | null =
    data && data.startsAt && data.endsAt
      ? {
          id: data.id,
          title: data.name,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          description: data.description,
        }
      : null;

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
    setCalendarPickerOpen(false);
  };

  const calendarOptions = calendarEvent
    ? [
        {
          label: t("Google Календарь"),
          Icon: GoogleCalendarIcon,
          onClick: () => openExternal(googleCalendarUrl(calendarEvent)),
        },
        {
          label: t("Apple Календарь"),
          Icon: AppleCalendarIcon,
          onClick: () => {
            downloadICS(calendarEvent);
            setCalendarPickerOpen(false);
          },
        },
        {
          label: "Outlook",
          Icon: OutlookIcon,
          onClick: () => openExternal(outlookLiveUrl(calendarEvent)),
        },
        {
          label: t("Другой (.ics файл)"),
          Icon: IcsFileIcon,
          onClick: () => {
            downloadICS(calendarEvent);
            setCalendarPickerOpen(false);
          },
        },
      ]
    : [];

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border-t border-border bg-background outline-none max-h-[90vh]"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 pb-5">
            {data && (
              <>
                {isPack ? (
                  <PackHeader data={data} studio={studio ?? null} onOpenTrainer={setTrainerId} />
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <DrawerPrimitive.Title className="text-2xl font-bold leading-tight break-words">
                        {data.name}
                      </DrawerPrimitive.Title>

                      {typeMeta && (
                        <div
                          className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${typeMeta.bg} ${typeMeta.color}`}
                        >
                          {TypeIcon && <TypeIcon className="h-3.5 w-3.5" />}
                          {t(typeMeta.label)}
                        </div>
                      )}

                      {data.trainerName && (
                        <div className="mt-3 flex items-center gap-2">
                          <SquircleAvatar size={32}>
                            {data.trainerPhoto && (
                              <SquircleAvatarImage src={data.trainerPhoto} alt={data.trainerName} />
                            )}
                            <SquircleAvatarFallback className="bg-muted text-xs font-semibold text-muted-foreground">
                              {data.trainerName
                                .split(/\s+/)
                                .map((p) => p[0])
                                .filter(Boolean)
                                .slice(0, 2)
                                .join("")
                                .toUpperCase()}
                            </SquircleAvatarFallback>
                          </SquircleAvatar>
                          <div className="text-sm text-muted-foreground truncate">
                            {data.trainerName}
                          </div>
                        </div>
                      )}
                    </div>
                    <img
                      src={data.photo ?? logoSrc}
                      alt=""
                      className={`w-28 h-28 rounded-full object-cover shrink-0 bg-muted ${data.photo ? "" : "brand-art"}`}
                    />
                  </div>
                )}

                {data.description?.trim() && (
                  <FormattedText
                    text={data.description}
                    className="mt-4 text-[15px] leading-relaxed text-foreground/90"
                    linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
                  />
                )}

                {/* Подсказки — в прокрутке; кнопки — ниже, закреплены (решение
                    владельца 2026-10-12: «Записаться» не должна уезжать за край
                    длинного описания); размер — общий у кнопок действий
                    (`buttonVariants`, 2026-10-13). «Отменить запись» —
                    через окно подтверждения (2026-10-21). */}
                {isBooked ? null : isWaitlisted ? (
                  <div className="mt-6 rounded-2xl bg-blue-50 p-4 text-sm text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                    {t(
                      "Вы в листе ожидания. Если освободится место, с вами свяжется администратор.",
                    )}
                  </div>
                ) : bookingNote ? (
                  <div className="mt-6 rounded-2xl bg-muted p-4 text-sm text-muted-foreground">
                    {bookingNote}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {data && (isBooked || isWaitlisted || !bookingNote) && (
            <div className="shrink-0 border-t border-border/60 bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)]">
              {isBooked ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (cancelLocked) {
                        toast.error(
                          t("Тренировку можно отменить не позже чем за {time} до начала", {
                            time: formatCancelDeadline(cancelMinutes!, t),
                          }),
                        );
                        return;
                      }
                      setCancelOpen(true);
                    }}
                    disabled={isPending}
                    className={cn(
                      buttonVariants(),
                      // Не акцентная (решение владельца 2026-10-19): белая с
                      // чёрной обводкой, красный текст; акцент — «В календарь».
                      "flex-1 border border-foreground bg-white text-red-500 hover:bg-white/90 disabled:opacity-60",
                      cancelLocked && "opacity-60",
                    )}
                  >
                    {isPending ? "..." : t("Отменить запись")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalendarPickerOpen(true)}
                    disabled={!calendarEvent}
                    className={cn(buttonVariants(), "flex-1 disabled:opacity-60")}
                  >
                    <Calendar weight="BoldDuotone" />
                    {t("В календарь")}
                  </button>
                </div>
              ) : isWaitlisted ? (
                <button
                  type="button"
                  onClick={() => onBook()}
                  disabled={isPending}
                  className={cn(
                    buttonVariants(),
                    "w-full bg-red-500 text-white hover:bg-red-500/90 disabled:opacity-60",
                  )}
                >
                  {isPending ? "..." : t("Выйти из очереди")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onBook()}
                  disabled={isPending}
                  className={cn(buttonVariants(), "w-full disabled:opacity-60")}
                >
                  {isPending ? "..." : isFull ? t("Встать в очередь") : t("Записаться")}
                </button>
              )}
            </div>
          )}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>

      {isPack && <TrainerDrawer nested trainerId={trainerId} onClose={() => setTrainerId(null)} />}

      {/* Отмена записи (решение владельца 2026-10-21): только подтверждение,
          без вопроса о причине; после отмены экран предлагает выбрать другое
          время (RescheduleOfferDialog). */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("Отменить запись?")}</DialogTitle>
            {data && (
              <DialogDescription>
                <span className="block font-medium text-foreground">{data.name}</span>
                {data.startsAt && (
                  <span className="block">{whenLabel(data.startsAt, data.endsAt, t)}</span>
                )}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setCancelOpen(false)}
              className={cn(buttonVariants(), "flex-1 bg-muted text-foreground hover:bg-muted/80")}
            >
              {t("Не отменять")}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setCancelOpen(false);
                onBook();
              }}
              className={cn(
                buttonVariants(),
                "flex-1 bg-red-500 text-white hover:bg-red-500/90 disabled:opacity-60",
              )}
            >
              {t("Отменить запись")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={calendarPickerOpen} onOpenChange={setCalendarPickerOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("Выберите календарь")}</DialogTitle>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-2">
            {calendarOptions.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={opt.onClick}
                className={cn(
                  buttonVariants(),
                  "relative w-full bg-muted px-4 text-foreground hover:bg-muted/80 [&_svg]:size-6",
                )}
              >
                <opt.Icon className="h-6 w-6 absolute left-4 top-1/2 -translate-y-1/2" />
                <span className="w-full text-center">{opt.label}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </DrawerPrimitive.Root>
  );
}

/**
 * Шапка окна тренировки пакетного приложения (решение владельца 2026-10-12):
 * название (и фото тренировки справа), под ним — плашка: дата и время,
 * свободные места, студия; иконки — в одинаковых кружках, полоска слева —
 * цвет тренировки, как на карточке в расписании. Ниже тренеры со средним
 * рейтингом — по нажатию открывается карточка тренера.
 */
function PackHeader({
  data,
  studio,
  onOpenTrainer,
}: {
  data: WorkoutDrawerData;
  studio: { name: string; address?: string | null } | null;
  onOpenTrainer: (id: string) => void;
}) {
  const t = useT();
  const full = data.spotsLeft === 0;
  const rows = [
    data.startsAt
      ? {
          key: "when",
          icon: <Calendar className="h-[18px] w-[18px]" weight="BoldDuotone" />,
          content: <span className="font-medium">{whenLabel(data.startsAt, data.endsAt, t)}</span>,
        }
      : null,
    data.spotsLabel
      ? {
          key: "spots",
          icon: full ? (
            <CloseCircle className="h-[18px] w-[18px] text-red-500" weight="BoldDuotone" />
          ) : (
            <UsersGroupRounded className="h-[18px] w-[18px]" weight="BoldDuotone" />
          ),
          content: (
            <span className={`font-medium ${full ? "text-red-500" : ""}`}>{data.spotsLabel}</span>
          ),
        }
      : null,
    studio
      ? {
          key: "studio",
          icon: <MapPoint className="h-[18px] w-[18px]" weight="BoldDuotone" />,
          content: (
            <span className="min-w-0">
              <span className="block font-medium">{studio.name}</span>
              {studio.address && (
                <span className="block text-muted-foreground">{studio.address}</span>
              )}
            </span>
          ),
        }
      : null,
  ].filter((r): r is NonNullable<typeof r> => !!r);

  return (
    <>
      <div className="flex items-start gap-3">
        <DrawerPrimitive.Title className="min-w-0 flex-1 text-2xl font-bold leading-tight break-words">
          {data.name}
        </DrawerPrimitive.Title>
        {data.photo && (
          <img
            src={data.photo}
            alt=""
            className="h-20 w-20 shrink-0 rounded-full bg-muted object-cover"
          />
        )}
      </div>

      {rows.length > 0 && (
        <div className="relative mt-3 overflow-hidden rounded-2xl bg-muted/70 py-1 pl-1.5">
          <span
            className={`absolute bottom-0 left-0 top-0 w-1.5 ${data.color ? "" : "bg-muted-foreground/40"}`}
            style={data.color ? { backgroundColor: data.color } : undefined}
          />
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background text-foreground/70">
                {r.icon}
              </span>
              {r.content}
            </div>
          ))}
        </div>
      )}

      {data.trainers!.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {data.trainers!.map((tr) => (
            <div key={tr.id} className="flex flex-col gap-1">
              {/* Замена: прежний тренер — неактивным, под ним «Замена» и новый. */}
              {tr.replaced && (
                <>
                  <div className="-mx-1 flex items-center gap-3 px-1 py-1 opacity-45">
                    <SquircleAvatar size={48}>
                      {tr.replaced.photo && (
                        <SquircleAvatarImage src={tr.replaced.photo} alt={tr.replaced.name} />
                      )}
                      <SquircleAvatarFallback className="bg-muted text-sm font-semibold text-muted-foreground">
                        {initialsOf(tr.replaced.name)}
                      </SquircleAvatarFallback>
                    </SquircleAvatar>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground">{t("Тренер")}</div>
                      <div className="truncate text-base font-semibold line-through decoration-1">
                        {tr.replaced.name}
                      </div>
                    </div>
                  </div>
                  <div className="ml-[3.75rem]">
                    <SubstitutionChip />
                  </div>
                </>
              )}
              <button
                type="button"
                onClick={() => onOpenTrainer(tr.id)}
                className="-mx-1 flex items-center gap-3 rounded-2xl px-1 py-1 text-left transition active:bg-muted"
              >
                <SquircleAvatar size={48}>
                  {tr.photo && <SquircleAvatarImage src={tr.photo} alt={tr.name} />}
                  <SquircleAvatarFallback className="bg-muted text-sm font-semibold text-muted-foreground">
                    {initialsOf(tr.name)}
                  </SquircleAvatarFallback>
                </SquircleAvatar>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">{t("Тренер")}</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-base font-semibold">{tr.name}</span>
                    {tr.rating != null && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-sm font-semibold tabular-nums"
                        aria-label={t("Рейтинг {value} из 5", {
                          value: formatRating(tr.rating, t),
                        })}
                      >
                        <Star className="h-4 w-4 text-amber-400" weight="Bold" />
                        {formatRating(tr.rating, t)}
                      </span>
                    )}
                  </div>
                </div>
                <AltArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
