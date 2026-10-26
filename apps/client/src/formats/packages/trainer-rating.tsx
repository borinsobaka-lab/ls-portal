import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AltArrowRight, HandHeart, Star } from "@solar-icons/react";
import { toast } from "sonner";

import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useT, type Translator } from "@/i18n";
import { untypedDb } from "@/lib/untyped-db";
import { cn } from "@/lib/utils";

/**
 * Рейтинг тренера и чаевые в пакетном приложении (решение владельца
 * 2026-10-11). Рейтинг — trainers.rating_avg (до сотых) и rating_count:
 * отзывы из прежнего сервиса + оценки клиентов (trainer_reviews), считает
 * база (db/migrations/2026-10-11_zzzzzzzzzzzzz_trainer_ratings.sql). Клиент
 * ставит одну оценку тренеру и может её изменить. Чаевые — внешняя ссылка
 * trainers.tip_url (задаётся в админке, «Сотрудники»).
 */

/** 4,99 · 5 · 4,8 — до сотых, без лишних нулей (разделитель — по языку). */
export function formatRating(avg: number, t: Translator) {
  return t.number(avg, { maximumFractionDigits: 2 });
}

function reviewsLabel(n: number, t: Translator) {
  return t.plural(n, "{n} отзыв|{n} отзыва|{n} отзывов");
}

/** Золотые звёзды; дробная часть заполняет звезду частично (4,5 — половинка). */
export function RatingStars({
  value,
  className = "h-4 w-4",
}: {
  value: number;
  className?: string;
}) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => {
        const fill = Math.max(0, Math.min(1, value - i));
        return (
          <span key={i} className={`relative inline-block shrink-0 ${className}`}>
            <Star
              weight="Bold"
              className="absolute inset-0 h-full w-full text-muted-foreground/25"
            />
            {fill > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
              >
                <Star weight="Bold" className={`text-amber-400 ${className}`} />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Строка «★★★★★ 4,99 (56 отзывов)» — в списке тренеров и в карточке. */
export function TrainerRatingLine({
  avg,
  count,
  starClass,
  textClass = "text-sm",
}: {
  avg: number | null;
  count: number;
  starClass?: string;
  textClass?: string;
}) {
  const t = useT();
  if (avg == null || count === 0) {
    return <div className={`${textClass} text-muted-foreground`}>{t("Пока нет отзывов")}</div>;
  }
  return (
    <div
      className="flex items-center gap-2"
      aria-label={t("Рейтинг {value} из 5, {reviews}", {
        value: formatRating(avg, t),
        reviews: reviewsLabel(count, t),
      })}
    >
      <RatingStars value={avg} className={starClass} />
      <span className={`${textClass} text-muted-foreground tabular-nums`}>
        {formatRating(avg, t)} ({reviewsLabel(count, t)})
      </span>
    </div>
  );
}

/** «Поблагодарить тренера» (администратора, массажиста) — ссылка на внешний сервис чаевых. */
export function TipButton({ url, label }: { url: string; label: string }) {
  const t = useT();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 transition active:scale-[0.99]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <HandHeart className="h-6 w-6" weight="BoldDuotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block text-sm text-muted-foreground">{t("Оставить чаевые")}</span>
      </span>
      <AltArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * «Оцените тренера» (массажиста — title): ещё не оценивал — звёзды и
 * «Отправить»; оценил — своя оценка и «Изменить». Гостю не показывается.
 */
export function RateTrainer({ trainerId, title }: { trainerId: string; title: string }) {
  const t = useT();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState(0);

  const { data: mine, isPending } = useQuery({
    queryKey: ["trainer-review", trainerId, user?.id],
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await untypedDb
        .from("trainer_reviews")
        .select("rating")
        .eq("trainer_id", trainerId)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data as { rating: number } | null)?.rating ?? null;
    },
    enabled: !!user,
  });

  const save = useMutation({
    mutationFn: async (rating: number) => {
      const { error } = await untypedDb
        .from("trainer_reviews")
        .upsert(
          { trainer_id: trainerId, user_id: user!.id, rating },
          { onConflict: "trainer_id,user_id" },
        );
      if (error) throw error;
    },
    onSuccess: (_, rating) => {
      queryClient.setQueryData(["trainer-review", trainerId, user?.id], rating);
      // Рейтинг пересчитывает база — обновляем все места, где он виден.
      queryClient.invalidateQueries({ queryKey: ["studio-trainers"] });
      queryClient.invalidateQueries({ queryKey: ["trainer-card", trainerId] });
      queryClient.invalidateQueries({ queryKey: ["pack-schedule"] });
      setEditing(false);
      toast.success(mine == null ? t("Спасибо за оценку!") : t("Оценка изменена"));
    },
    onError: () => toast.error(t("Не удалось отправить оценку. Попробуйте ещё раз.")),
  });

  if (!user || isPending) return null;

  const rated = mine != null;
  const showForm = !rated || editing;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="font-semibold">{rated ? t("Ваша оценка") : title}</div>
      {showForm ? (
        <>
          <div
            className="mt-3 flex justify-center gap-2"
            role="radiogroup"
            aria-label={t("Оценка")}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={picked === n}
                aria-label={t("{n} из 5", { n })}
                onClick={() => setPicked(n)}
                className="p-1 transition active:scale-90"
              >
                <Star
                  weight="Bold"
                  className={`h-9 w-9 transition-colors ${
                    n <= picked ? "text-amber-400" : "text-muted-foreground/25"
                  }`}
                />
              </button>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            {rated && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={save.isPending}
                className={cn(buttonVariants({ variant: "outline" }), "flex-1 disabled:opacity-60")}
              >
                {t("Отмена")}
              </button>
            )}
            <button
              type="button"
              onClick={() => save.mutate(picked)}
              disabled={picked === 0 || save.isPending || (rated && picked === mine)}
              className={cn(buttonVariants(), "flex-1 disabled:opacity-60")}
            >
              {save.isPending ? t("Отправляем…") : rated ? t("Сохранить") : t("Отправить")}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-3">
          <RatingStars value={mine} className="h-6 w-6" />
          <button
            type="button"
            onClick={() => {
              setPicked(mine);
              setEditing(true);
            }}
            className="text-sm font-semibold text-primary"
          >
            {t("Изменить")}
          </button>
        </div>
      )}
    </div>
  );
}
