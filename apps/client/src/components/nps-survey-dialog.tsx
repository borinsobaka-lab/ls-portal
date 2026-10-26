import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { CheckCircle } from "@solar-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { msg, useI18n, useT } from "@/i18n";
import {
  NPS_COMMENT_MAX,
  NPS_FOLLOW_UP,
  NPS_SCORES,
  commentAfterScoreChange,
  npsFormError,
  npsGroup,
  npsSurveyTexts,
  type NpsGroup,
  type NpsSurvey,
} from "@/lib/nps";
import { closeNpsSurvey, markNpsSurveyShown, submitNpsResponse } from "@/lib/nps-data";
import { IS_PACKAGES } from "@/lib/terms";
import { cn } from "@/lib/utils";

const BRAND = IS_PACKAGES ? "Lady Stretch" : "Base40";

/** Цвет выбранной оценки: критик — красный, нейтрал — жёлтый, промоутер — зелёный. */
const SCORE_COLOR: Record<NpsGroup, string> = {
  detractor: "bg-red-500 text-white",
  passive: "bg-amber-400 text-amber-950",
  promoter: "bg-emerald-500 text-white",
};

/** Время анимации закрытия окна. */
const CLOSE_MS = 200;

/**
 * NPS-опрос модальным окном (решение владельца 2026-10-15): оценка 0–10,
 * уточняющий вопрос по оценке (ответ обязателен), «Отправить». Крестик —
 * закрыть и не проходить: опрос больше не показывается. Касание мимо окна
 * его не закрывает — случайно потерять опрос нельзя. Имя и вид опроса не
 * спрашиваются: клиент вошёл, вид выбрала база. Показывает
 * components/nps-survey.tsx.
 */
export default function NpsSurveyDialog({
  survey,
  onDone,
}: {
  survey: NpsSurvey;
  onDone: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(true);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void markNpsSurveyShown(survey);
  }, [survey]);

  const finish = () => {
    if (sending) return;
    setOpen(false);
    // Без ответа — «закрыт»: больше не показывается. Не дошло до базы —
    // опрос покажется при следующем открытии, это не страшно.
    if (!done) void closeNpsSurvey(survey).catch(() => undefined);
    window.setTimeout(onDone, CLOSE_MS);
  };

  const pickScore = (next: number) => {
    setComment((prev) => commentAfterScoreChange(score, next, prev));
    setScore(next);
    setError(null);
  };

  const submit = async () => {
    const formError = npsFormError(score, comment);
    if (formError) {
      setError(formError);
      return;
    }
    setError(null);
    setSending(true);
    try {
      await submitNpsResponse(survey, { score: score!, comment, language: locale });
      setDone(true);
    } catch (e) {
      // Уже ответили с другого телефона — тоже «спасибо».
      if ((e as { hint?: string } | null)?.hint === "already_answered") setDone(true);
      else setError(msg("Что-то пошло не так. Попробуйте ещё раз."));
    } finally {
      setSending(false);
    }
  };

  const texts = npsSurveyTexts(survey.survey_type, IS_PACKAGES);
  const group = score === null ? null : npsGroup(score);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && finish()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-3xl bg-background p-5 pt-6 shadow-xl outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Close
            aria-label={t("Закрыть")}
            disabled={sending}
            // Без подложки; область нажатия — 36px вокруг значка 18px.
            className="absolute right-3 top-[18px] flex h-9 w-9 cursor-pointer items-center justify-center text-muted-foreground transition hover:text-foreground active:scale-90 disabled:opacity-50"
          >
            <X className="h-[18px] w-[18px]" />
          </DialogPrimitive.Close>

          {done ? (
            <div className="flex flex-col items-center py-4 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
                <CheckCircle weight="Bold" className="h-10 w-10 text-emerald-500" />
              </div>
              <DialogPrimitive.Title className="text-xl font-semibold leading-tight">
                {t("Спасибо за ваш отзыв!")}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-2 text-[15px] text-muted-foreground">
                {t("Ваш ответ записан. Мы ценим ваше время.")}
              </DialogPrimitive.Description>
              <Button className="mt-6 w-full" onClick={finish}>
                {t("Закрыть")}
              </Button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <DialogPrimitive.Title className="pr-10 text-xl font-semibold leading-tight">
                {t(texts.title)}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-2 text-[15px] leading-snug text-muted-foreground">
                {t(texts.description, { brand: BRAND })}
              </DialogPrimitive.Description>

              <p id="nps-question" className="mt-5 font-semibold leading-snug">
                {t("Насколько вероятно, что вы порекомендуете нас подруге?")}
              </p>
              <div
                role="radiogroup"
                aria-labelledby="nps-question"
                className="mt-3 grid grid-cols-11 gap-1"
              >
                {NPS_SCORES.map((n) => {
                  const picked = score === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      disabled={sending}
                      onClick={() => pickScore(n)}
                      className={cn(
                        "flex h-11 cursor-pointer items-center justify-center rounded-xl text-[15px] font-semibold tabular-nums transition active:scale-95",
                        picked && group ? SCORE_COLOR[group] : "bg-muted text-foreground",
                      )}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between gap-4 text-xs text-muted-foreground">
                <span>{t("Совсем маловероятно")}</span>
                <span className="text-right">{t("Крайне вероятно")}</span>
              </div>

              {group && (
                <div className="mt-5">
                  <label htmlFor="nps-comment" className="block font-semibold leading-snug">
                    {t(NPS_FOLLOW_UP[group])}
                  </label>
                  <Textarea
                    id="nps-comment"
                    rows={4}
                    maxLength={NPS_COMMENT_MAX}
                    value={comment}
                    disabled={sending}
                    onChange={(e) => {
                      setComment(e.target.value);
                      if (error) setError(null);
                    }}
                    // Клавиатура телефона закрывает низ окна — поле поднимаем.
                    onFocus={(e) => {
                      const el = e.currentTarget;
                      window.setTimeout(() => el.scrollIntoView({ block: "center" }), 300);
                    }}
                    placeholder={t("Расскажите подробнее о вашем опыте…")}
                    className="mt-3 resize-none"
                  />
                </div>
              )}

              {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {t(error)}
                </p>
              )}

              <Button type="submit" className="mt-5 w-full" disabled={sending}>
                {sending ? t("Отправка…") : t("Отправить")}
              </Button>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
