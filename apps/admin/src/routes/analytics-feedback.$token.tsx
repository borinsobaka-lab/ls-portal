import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { AnalyticsFeedbackPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { rvFormQuery, submitFeedback } from "@/lib/analytics/reviews/data";
import { PORTAL_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Публичная форма отзыва партнёра о сотруднике — их /feedback/<токен>
 * (public_staff_feedback_page): открывается без входа по постоянной ссылке
 * из «Аналитика» → «Отзывы» → «Ссылки на отзывы сотрудников». Город, имя
 * партнёра, две оценки от 1 до 5; оценке 4 и ниже нужна рекомендация.
 * Проверяет и сохраняет база (RPC an_rv_feedback_submit, тексты ошибок —
 * их); заполненное скрытое поле «website» (бот) — «спасибо» без записи, как
 * у них.
 */
export const Route = createFileRoute("/analytics-feedback/$token")({
  head: () => ({
    meta: [
      { title: `Оценка сотрудника · ${PORTAL_NAME}` },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  pendingComponent: AnalyticsFeedbackPageSkeleton,
  component: FeedbackPage,
});

const QUESTIONS = {
  professionalism:
    "На сколько профессионально сотрудник провел созвон и решил задачи поставленные на созвоне?",
  nextSteps: "На сколько понятны и полезны вам следующие шаги после созвона?",
};

type Answer = { score: number; comment: string; warning: boolean };
const EMPTY: Answer = { score: 0, comment: "", warning: false };

/** Их проверка перед отправкой: оценке 1–4 нужна рекомендация. */
const needsComment = (a: Answer) => a.score > 0 && a.score <= 4 && !a.comment.trim();

function FeedbackPage() {
  const { token } = Route.useParams();
  const { data, isPending, error, refetch, isRefetching } = useQuery(rvFormQuery(token));
  const [city, setCity] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [prof, setProf] = useState<Answer>(EMPTY);
  const [next, setNext] = useState<Answer>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const profComment = useRef<HTMLTextAreaElement>(null);
  const nextComment = useRef<HTMLTextAreaElement>(null);

  if (isPending) return <AnalyticsFeedbackPageSkeleton />;
  if (error) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Оцените работу сотрудника</h1>
        <InfoNote variant="warning">Не удалось открыть форму: {(error as Error).message}</InfoNote>
        <Button variant="outline" disabled={isRefetching} onClick={() => void refetch()}>
          {isRefetching && <Loader2 className="animate-spin" />}
          Попробовать снова
        </Button>
      </Page>
    );
  }
  if (!data || gone) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Ссылка не найдена</h1>
        <p className="text-muted-foreground">
          Ссылка на форму отзыва недействительна или приостановлена.
        </p>
      </Page>
    );
  }
  if (done !== null) {
    return (
      <Page className="text-center">
        <div
          className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700"
          aria-hidden
        >
          ✓
        </div>
        <h1 className="text-2xl font-semibold">Спасибо за обратную связь</h1>
        <p className="text-muted-foreground">Ваш ответ по сотруднику {done} сохранён.</p>
      </Page>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const profBad = needsComment(prof);
    const nextBad = needsComment(next);
    if (profBad || nextBad) {
      if (profBad) setProf((a) => ({ ...a, warning: true }));
      if (nextBad) setNext((a) => ({ ...a, warning: true }));
      (profBad ? profComment : nextComment).current?.focus();
      return;
    }
    setFailure(null);
    if (website) {
      setDone(data.full_name);
      return;
    }
    setSaving(true);
    try {
      const result = await submitFeedback(token, {
        partnerName: name,
        partnerCity: city,
        professionalismRating: String(prof.score || ""),
        professionalismComment: prof.comment,
        nextStepsRating: String(next.score || ""),
        nextStepsComment: next.comment,
      });
      setDone(result.full_name);
    } catch (err) {
      const message = (err as Error).message;
      if (message === "an_rv_link_gone") setGone(true);
      else setFailure(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page>
      <div>
        <p className="text-xs font-semibold tracking-wide text-brand-on-light uppercase">
          {PORTAL_NAME}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Оцените работу сотрудника</h1>
        <p className="mt-1 text-lg text-muted-foreground">{data.full_name}</p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Город" required htmlFor="fb-city">
            <Input
              id="fb-city"
              name="partner_city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={200}
              placeholder="Например, Казань"
              required
            />
          </FormField>
          <FormField label="Имя партнёра" required htmlFor="fb-name">
            <Input
              id="fb-name"
              name="partner_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="Имя и фамилия"
              autoComplete="name"
              required
            />
          </FormField>
        </div>
        <Question
          field="professionalism_rating"
          label={QUESTIONS.professionalism}
          answer={prof}
          onChange={setProf}
          commentRef={profComment}
        />
        <Question
          field="next_steps_rating"
          label={QUESTIONS.nextSteps}
          answer={next}
          onChange={setNext}
          commentRef={nextComment}
        />
        {/* Ловушка для ботов, как у них: человек это поле не видит. */}
        <input
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="pointer-events-none fixed right-0 bottom-0 size-px opacity-0"
        />
        {failure && <InfoNote variant="warning">{failure}</InfoNote>}
        <div className="flex justify-center">
          <Button type="submit" size="lg" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Отправить
          </Button>
        </div>
      </form>
    </Page>
  );
}

function Page({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-4">
      <section
        className={cn(
          "w-full max-w-xl min-w-0 space-y-5 rounded-xl border bg-background p-6 sm:p-8",
          className,
        )}
      >
        {children}
      </section>
    </main>
  );
}

/** Их rating_group и «Что можно улучшить» под ним. */
function Question({
  field,
  label,
  answer,
  onChange,
  commentRef,
}: {
  field: string;
  label: string;
  answer: Answer;
  onChange: (a: Answer) => void;
  commentRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // Их sync(): предупреждение пропадает при оценке 5 или с текстом.
  const set = (score: number, comment: string) =>
    onChange({ score, comment, warning: answer.warning && score < 5 && !comment.trim() });
  const commentId = `${field}-comment`;
  return (
    <div className="space-y-3">
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm leading-snug font-medium break-words">
          {label} <span className="text-destructive">*</span>
        </legend>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((value) => (
            <label key={value} title={`${value} из 5`} className="relative cursor-pointer">
              <input
                type="radio"
                name={field}
                value={value}
                checked={answer.score === value}
                onChange={() => set(value, answer.comment)}
                required
                aria-label={`${label}: ${value} из 5`}
                className="peer absolute top-0 left-0 size-px opacity-0"
              />
              <span
                aria-hidden
                className={cn(
                  "block rounded-md px-0.5 text-4xl leading-none transition-colors select-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                  value <= answer.score
                    ? "text-amber-400"
                    : "text-muted-foreground/30 hover:text-amber-300",
                )}
              >
                ★
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <FormField
        label="Что можно улучшить"
        htmlFor={commentId}
        error={answer.warning ? "Добавьте рекомендацию" : undefined}
      >
        <Textarea
          id={commentId}
          ref={commentRef}
          name={`${field.replace("_rating", "")}_comment`}
          rows={2}
          maxLength={4000}
          placeholder="Напишите рекомендации для сотрудника"
          value={answer.comment}
          onChange={(e) => set(answer.score, e.target.value)}
        />
      </FormField>
    </div>
  );
}
