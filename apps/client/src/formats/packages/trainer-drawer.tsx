import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Drawer as DrawerPrimitive } from "vaul";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
} from "@/components/ui/squircle-avatar";
import { useLocalize, useT } from "@/i18n";
import { FormattedText } from "@/lib/formatted-text";
import { mediaUrl } from "@/lib/media";
import { trainerInitials } from "./entries";
import {
  MASSAGE_BOOKING_URL,
  STAFF_ROLE_TEXT,
  staffHasRating,
  staffRole,
  staffRoleLabel,
  trainerCardQuery,
  type StudioTrainer,
} from "./queries";
import { RateTrainer, TipButton, TrainerRatingLine } from "./trainer-rating";

/**
 * Карточка сотрудника пакетного приложения — шторка: фото, роль, имя,
 * рейтинг, «Поблагодарить …» (чаевые), под ними «Оцените …» (решение
 * владельца 2026-10-12: оценка выше биографии), биография. У администратора
 * (2026-10-12) — без рейтинга и оценки: только описание и чаевые; массажист
 * — как тренер, плюс закреплённая внизу «Записаться на массаж» (2026-10-15,
 * MASSAGE_BOOKING_URL). Открывается из вкладок «Студии» и из окна тренировки (там —
 * вложенной шторкой, nested, поверх окна).
 *
 * Данные — trainerCardQuery по id; из списка тренеров приходят сразу
 * (initial), из окна тренировки догружаются.
 */
export function TrainerDrawer({
  trainerId,
  initial,
  onClose,
  nested = false,
}: {
  trainerId: string | null;
  initial?: StudioTrainer | null;
  onClose: () => void;
  nested?: boolean;
}) {
  const t = useT();
  // Пока шторка закрывается (анимация), в ней остаётся последний тренер.
  const [shown, setShown] = useState<{ id: string | null; initial?: StudioTrainer | null }>({
    id: trainerId,
    initial,
  });
  if (trainerId && trainerId !== shown.id) setShown({ id: trainerId, initial });
  const query = useQuery({
    ...trainerCardQuery(shown.id),
    placeholderData: shown.initial ?? undefined,
  });
  const trainer = query.data ?? null;
  const masseur = !!trainer && staffRole(trainer) === "masseur";
  const Root = nested ? DrawerPrimitive.NestedRoot : DrawerPrimitive.Root;

  return (
    <Root
      open={trainerId !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      {...(nested ? {} : { shouldScaleBackground: true })}
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-1 mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div
            className={
              masseur
                ? "overflow-y-auto overscroll-contain px-4 pb-6 pt-3"
                : "overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-3"
            }
          >
            {trainer ? (
              <TrainerCard trainer={trainer} />
            ) : query.isError ? (
              <>
                <DrawerPrimitive.Title className="sr-only">{t("Тренер")}</DrawerPrimitive.Title>
                <p className="py-6 text-center text-sm text-destructive">
                  {t("Не удалось загрузить карточку тренера. Попробуйте ещё раз.")}
                </p>
              </>
            ) : (
              <>
                <DrawerPrimitive.Title className="sr-only">{t("Тренер")}</DrawerPrimitive.Title>
                <div className="flex items-center gap-4">
                  <Skeleton className="h-[88px] w-[88px] rounded-3xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-6 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </div>
                <Skeleton className="mt-5 h-16 w-full rounded-2xl" />
              </>
            )}
          </div>
          {masseur && MASSAGE_BOOKING_URL && (
            <div className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button asChild className="w-full">
                <a href={MASSAGE_BOOKING_URL} target="_blank" rel="noopener noreferrer">
                  {t("Записаться на массаж")}
                </a>
              </Button>
            </div>
          )}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </Root>
  );
}

function TrainerCard({ trainer: row }: { trainer: StudioTrainer }) {
  const t = useT();
  const loc = useLocalize();
  const trainer = loc(row);
  const role = staffRole(row);
  const text = STAFF_ROLE_TEXT[role];
  const photo = mediaUrl(trainer.photo_url, "trainer-photos");
  const tipUrl = trainer.tip_url?.trim() ?? "";
  const hasTip = /^https?:\/\//i.test(tipUrl);
  return (
    <>
      <div className="flex items-center gap-4">
        <SquircleAvatar size={88} className="shrink-0">
          {photo && <SquircleAvatarImage src={photo} alt={trainer.full_name} />}
          <SquircleAvatarFallback className="bg-muted text-2xl font-semibold text-muted-foreground">
            {trainerInitials(trainer.full_name)}
          </SquircleAvatarFallback>
        </SquircleAvatar>
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{t(staffRoleLabel(row))}</div>
          <DrawerPrimitive.Title className="text-2xl font-semibold leading-tight">
            {trainer.full_name}
          </DrawerPrimitive.Title>
          {staffHasRating(role) && (
            <div className="mt-1.5">
              <TrainerRatingLine
                avg={trainer.rating_avg}
                count={trainer.rating_count}
                starClass="h-4 w-4"
              />
            </div>
          )}
        </div>
      </div>
      {hasTip && (
        <div className="mt-5">
          <TipButton url={tipUrl} label={t(text.tip)} />
        </div>
      )}
      {text.rate && (
        <div className={hasTip ? "mt-3" : "mt-5"}>
          <RateTrainer key={trainer.id} trainerId={trainer.id} title={t(text.rate)} />
        </div>
      )}
      {trainer.bio?.trim() ? (
        <FormattedText
          text={trainer.bio}
          className="mt-5 text-[15px] leading-relaxed text-foreground/90"
          linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
        />
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">{t(text.noBio)}</p>
      )}
    </>
  );
}
