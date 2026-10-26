import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

import { CourseCover, ProgressBar, StepIcon } from "@/components/academy/parts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoNote } from "@/components/ui/form-field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  acadAnswersFolder,
  acadCourseViewQuery,
  acadLessonQuery,
  acadQuizQuery,
  invalidateAcademy,
} from "@/lib/academy/data";
import {
  acadError,
  dueLabel,
  plural,
  progressPercent,
  QUESTION_KIND_LABEL,
  unanswered,
} from "@/lib/academy/logic";
import type {
  AcadAnswerInput,
  AcadCourseView,
  AcadQuizQuestion,
  AcadViewStep,
} from "@/lib/academy/types";
import { formatDate, todayISO } from "@/lib/format";
import { formatFileSize, KbFileTooLarge, uploadKbFile } from "@/lib/kb/files";
import { cn } from "@/lib/utils";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/**
 * Прохождение курса: слева — шаги (по порядку, следующий открывается после
 * пройденного, если курс «по порядку»), справа — урок или тест. Команда
 * (создатель, проверяющий) видит курс без записи хода — «Просмотр».
 */
export function CoursePlayer({
  courseId,
  stepId,
  preview,
}: {
  courseId: string;
  stepId?: string;
  /** «Как видит ученик» из конструктора: без записи хода, даже если курс назначен и вам. */
  preview?: boolean;
}) {
  const navigate = useNavigate();
  const { data: loaded, isLoading, error } = useQuery(acadCourseViewQuery(courseId));

  if (isLoading) return null;
  if (error || !loaded)
    return <InfoNote variant="warning">{acadError(error ?? "Курс не найден")}</InfoNote>;
  const view: AcadCourseView = preview
    ? {
        ...loaded,
        learner: false,
        steps: loaded.steps.map((s) => ({ ...s, state: "todo", locked: false })),
      }
    : loaded;

  // Открытый шаг: из адреса, иначе первый непройденный и открытый.
  const current =
    view.steps.find((s) => s.id === stepId) ??
    view.steps.find((s) => !s.locked && s.state !== "done" && s.state !== "passed") ??
    view.steps[0];
  const go = (id: string) =>
    void navigate({
      to: preview ? "/academy/courses/$courseId/preview" : "/academy/my/$courseId",
      params: { courseId },
      search: { step: id },
      replace: true,
    });
  const index = current ? view.steps.findIndex((s) => s.id === current.id) : -1;
  const next = index >= 0 ? view.steps[index + 1] : undefined;
  const prev = index > 0 ? view.steps[index - 1] : undefined;
  const nav = {
    onPrev: prev ? () => go(prev.id) : undefined,
    onNext: next ? () => go(next.id) : undefined,
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <CourseHeader view={view} preview={!!preview} />
      {view.steps.length === 0 ? (
        <InfoNote variant="empty">В курсе пока нет уроков.</InfoNote>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <StepList steps={view.steps} currentId={current?.id} onSelect={go} />
          <div className="min-w-0 flex-1 rounded-lg border bg-background p-4 sm:p-6">
            {current?.locked ? (
              <div className="space-y-4">
                <InfoNote variant="muted">
                  Шаг откроется, когда пройдёте предыдущие — курс проходится по порядку.
                </InfoNote>
                <StepNav onPrev={nav.onPrev} />
              </div>
            ) : current?.kind === "lesson" ? (
              <LessonView
                key={current.id}
                step={current}
                learner={view.learner}
                onPrev={nav.onPrev}
                onNext={nav.onNext}
              />
            ) : current ? (
              <QuizView
                key={current.id}
                courseId={courseId}
                step={current}
                learner={view.learner}
                onPrev={nav.onPrev}
                onNext={next && !next.locked ? nav.onNext : undefined}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** «Назад» к прошлому шагу и, если передан, «Дальше» — внизу шага. */
function StepNav({
  onPrev,
  onNext,
  children,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  children?: ReactNode;
}) {
  if (!onPrev && !onNext && !children) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      {onPrev && (
        <Button variant="ghost" onClick={onPrev}>
          <ArrowLeft /> Назад
        </Button>
      )}
      <div className="ml-auto flex flex-wrap gap-2">
        {children}
        {onNext && (
          <Button variant="outline" onClick={onNext}>
            Дальше <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}

function CourseHeader({ view, preview }: { view: AcadCourseView; preview: boolean }) {
  const done = view.steps.filter((s) => s.state === "done" || s.state === "passed").length;
  const due = view.completed_at ? null : dueLabel(view.due_date, todayISO());
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-background p-4 sm:flex-row sm:p-5">
      <CourseCover
        cover={view.course.cover}
        className="aspect-[16/9] w-full shrink-0 self-start rounded-md sm:w-56"
      />
      <div className="min-w-0 flex-1 space-y-2">
        {preview ? (
          <Link
            to="/academy/courses/$courseId"
            params={{ courseId: view.course.id }}
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-on-light hover:underline"
          >
            <ArrowLeft className="size-3.5" /> В конструктор курса
          </Link>
        ) : (
          <Link
            to={view.learner ? "/academy" : "/academy/courses"}
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-on-light hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            {view.learner ? "Мои курсы" : "Курсы"}
            {view.course.folder_title ? ` · ${view.course.folder_title}` : ""}
          </Link>
        )}
        <h2 className="text-xl font-semibold leading-tight">{view.course.title}</h2>
        {view.course.description && (
          <p className="text-sm whitespace-pre-line text-muted-foreground">
            {view.course.description}
          </p>
        )}
        {view.learner ? (
          <div className="max-w-md space-y-1.5 pt-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Пройдено {done} из {view.steps.length}
              </span>
              <span className={cn(due?.overdue && "font-medium text-destructive")}>
                {view.completed_at
                  ? `Курс пройден ${formatDate(view.completed_at)}`
                  : (due?.text ?? "Без срока")}
              </span>
            </div>
            <ProgressBar value={progressPercent(done, view.steps.length)} />
          </div>
        ) : (
          <InfoNote variant="info" className="max-w-xl">
            Просмотр курса: так его видят ученики. Ход и ответы здесь не сохраняются.
          </InfoNote>
        )}
      </div>
    </div>
  );
}

function StepList({
  steps,
  currentId,
  onSelect,
}: {
  steps: AcadViewStep[];
  currentId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Шаги курса"
      className="rounded-lg border bg-background p-2 lg:w-72 lg:shrink-0"
    >
      <ol className="space-y-0.5">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-current={s.id === currentId ? "step" : undefined}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                s.id === currentId && "bg-muted font-medium",
              )}
            >
              <StepIcon kind={s.kind} state={s.state} locked={s.locked} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">
                  {i + 1}. {s.kind === "quiz" ? "Тест" : "Урок"}
                </span>
                <span className="block leading-snug">{s.title}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LessonView({
  step,
  learner,
  onPrev,
  onNext,
}: {
  step: AcadViewStep;
  learner: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery(acadLessonQuery(step.id));
  const [saving, setSaving] = useState(false);

  const complete = async () => {
    setSaving(true);
    try {
      const { error: err } = await supabase.rpc("acad_lesson_complete", { p_step: step.id });
      if (err) throw new Error(err.message);
      await invalidateAcademy(qc);
      onNext?.();
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Как название статьи базы знаний — крупнее заголовков внутри текста. */}
        <h3 className="text-3xl leading-tight font-semibold break-words">{step.title}</h3>
        {learner && step.state === "done" && (
          <span className="text-xs font-medium text-emerald-700">Урок пройден</span>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Открываем урок…
        </div>
      ) : error || !data ? (
        <InfoNote variant="warning">{acadError(error ?? "Урок не найден")}</InfoNote>
      ) : (
        <div className="-mx-3 sm:-mx-[54px]">
          <Suspense fallback={null}>
            <KbDocument nodeId={step.id} initial={data.content ?? []} editable={false} />
          </Suspense>
        </div>
      )}
      {learner && step.state !== "done" ? (
        <StepNav onPrev={onPrev}>
          <Button onClick={() => void complete()} disabled={saving || isLoading}>
            {saving && <Loader2 className="animate-spin" />}
            Урок пройден{onNext ? " — дальше" : ""}
          </Button>
        </StepNav>
      ) : (
        <StepNav onPrev={onPrev} onNext={onNext} />
      )}
    </article>
  );
}

function QuizView({
  courseId,
  step,
  learner,
  onPrev,
  onNext,
}: {
  courseId: string;
  step: AcadViewStep;
  learner: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [started, setStarted] = useState(!learner);
  const attemptLink = step.last_attempt_id ? (
    <Button asChild variant="outline">
      <Link to="/academy/attempts/$attemptId" params={{ attemptId: step.last_attempt_id }}>
        Посмотреть ответы
      </Link>
    </Button>
  ) : null;

  if (learner && !started) {
    return (
      <div className="space-y-4">
        <h3 className="text-3xl leading-tight font-semibold break-words">{step.title}</h3>
        <p className="text-sm text-muted-foreground">
          {step.questions} {plural(step.questions, ["вопрос", "вопроса", "вопросов"])} · сдан от{" "}
          {step.pass_percent}% верных
          {step.attempts > 0 && ` · попыток: ${step.attempts}`}
        </p>
        {step.state === "passed" ? (
          <InfoNote variant="info">
            Тест сдан{step.last_percent != null ? ` — ${Math.round(step.last_percent)}%` : ""}.
          </InfoNote>
        ) : step.state === "review" ? (
          <InfoNote variant="warning">
            Ответы на проверке у тренера. Следующие шаги курса уже открыты; результат появится
            здесь.
          </InfoNote>
        ) : step.state === "failed" ? (
          <InfoNote variant="warning">
            Не сдан{step.last_percent != null ? ` — ${Math.round(step.last_percent)}%` : ""}. При
            пересдаче — только вопросы с ошибками, верные ответы засчитаны.
          </InfoNote>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(step.state === "todo" || step.state === "failed") && (
            <Button onClick={() => setStarted(true)} disabled={step.questions === 0}>
              {step.state === "failed" ? "Пересдать ошибки" : "Начать тест"}
            </Button>
          )}
          {attemptLink}
        </div>
        {/* «Дальше» — когда следующий шаг открыт (тест его не держит). */}
        <StepNav onPrev={onPrev} onNext={onNext} />
      </div>
    );
  }
  return (
    <QuizForm
      courseId={courseId}
      step={step}
      learner={learner}
      onCancel={() => setStarted(false)}
      onPrev={onPrev}
      onNext={onNext}
    />
  );
}

function QuizForm({
  courseId,
  step,
  learner,
  onCancel,
  onPrev,
  onNext,
}: {
  courseId: string;
  step: AcadViewStep;
  learner: boolean;
  onCancel: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: quiz, isLoading, error } = useQuery(acadQuizQuery(step.id));
  const [answers, setAnswers] = useState<Record<string, AcadAnswerInput>>({});
  const [saving, setSaving] = useState(false);
  const set = (qid: string, patch: Partial<AcadAnswerInput>) =>
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], question_id: qid, ...patch } }));

  if (isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Открываем тест…
      </div>
    );
  if (error || !quiz)
    return <InfoNote variant="warning">{acadError(error ?? "Тест не найден")}</InfoNote>;

  const left = unanswered(quiz.questions, answers);
  const submit = async () => {
    if (left > 0) {
      toast.error(`Осталось ответить: ${left}`);
      return;
    }
    setSaving(true);
    try {
      const { data, error: err } = await supabase.rpc("acad_quiz_submit", {
        p_step: step.id,
        p_answers: quiz.questions.map((q) => answers[q.id]),
      });
      if (err) throw new Error(err.message);
      // Сначала уйти с теста, потом сбросить кэш: иначе открытый тест
      // перезапросил бы acad_quiz_start и на миг показал «Тест уже сдан».
      await navigate({ to: "/academy/attempts/$attemptId", params: { attemptId: data as string } });
      qc.removeQueries({ queryKey: acadQuizQuery(step.id).queryKey });
      void invalidateAcademy(qc);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message.includes("acad_incomplete")) {
        // Пока отвечали, в тест могли добавить вопросы: набор — заново с
        // сервера (ответы на прежние вопросы остаются — они по id).
        const before = quiz.questions.map((q) => q.id).join();
        const fresh = await qc
          .fetchQuery({ ...acadQuizQuery(step.id), staleTime: 0 })
          .catch(() => null);
        if (fresh && fresh.questions.map((q) => q.id).join() !== before) {
          toast.error("Пока вы отвечали, тест изменили — ответьте на новые вопросы");
          return;
        }
      }
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-3xl leading-tight font-semibold break-words">{step.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {quiz.questions.length < quiz.total
            ? `Пересдача: ${quiz.questions.length} из ${quiz.total} — только вопросы с ошибками`
            : `${quiz.total} ${plural(quiz.total, ["вопрос", "вопроса", "вопросов"])}`}{" "}
          · сдан от {quiz.pass_percent}%
        </p>
      </div>
      {quiz.preview && (
        <InfoNote variant="info">
          Просмотр: так ученик видит вопросы. Верные варианты — в конструкторе курса.
        </InfoNote>
      )}
      <ol className="space-y-4">
        {quiz.questions.map((q, i) => (
          <QuestionCard
            key={q.id}
            index={i}
            question={q}
            answer={answers[q.id]}
            onChange={(patch) => set(q.id, patch)}
            disabled={!learner}
          />
        ))}
      </ol>
      {learner && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <span className="mr-auto text-xs text-muted-foreground">
            {left > 0 ? `Без ответа: ${left}` : "Все вопросы отвечены"}
          </span>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Отправить ответы
          </Button>
        </div>
      )}
      {!learner && (
        <StepNav onPrev={onPrev} onNext={onNext}>
          <Button asChild variant="ghost">
            <Link to="/academy/courses/$courseId/$stepId" params={{ courseId, stepId: step.id }}>
              Править вопросы
            </Link>
          </Button>
        </StepNav>
      )}
    </div>
  );
}

function QuestionCard({
  index,
  question: q,
  answer,
  onChange,
  disabled,
}: {
  index: number;
  question: AcadQuizQuestion;
  answer: AcadAnswerInput | undefined;
  onChange: (patch: Partial<AcadAnswerInput>) => void;
  disabled: boolean;
}) {
  const picked = answer?.options ?? [];
  return (
    <li className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">
        Вопрос {index + 1} · {QUESTION_KIND_LABEL[q.kind]}
        {q.points > 1 ? ` · ${q.points} ${plural(q.points, ["балл", "балла", "баллов"])}` : ""}
      </p>
      <p className="mt-1 font-medium whitespace-pre-line">{q.text}</p>
      <div className="mt-3">
        {q.kind === "single" ? (
          <RadioGroup
            value={picked[0] ?? ""}
            onValueChange={(v) => onChange({ options: [v] })}
            disabled={disabled}
          >
            {q.options.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-foreground/40 has-[[data-state=checked]]:bg-muted/50"
              >
                <RadioGroupItem value={o.id} className="mt-0.5" />
                <span>{o.text}</span>
              </label>
            ))}
          </RadioGroup>
        ) : q.kind === "multiple" ? (
          <div className="grid gap-2">
            {q.options.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-foreground/40 has-[[data-state=checked]]:bg-muted/50"
              >
                <Checkbox
                  className="mt-0.5"
                  disabled={disabled}
                  checked={picked.includes(o.id)}
                  onCheckedChange={(v) =>
                    onChange({
                      options: v === true ? [...picked, o.id] : picked.filter((x) => x !== o.id),
                    })
                  }
                />
                <span>{o.text}</span>
              </label>
            ))}
          </div>
        ) : (
          <OpenAnswer question={q} answer={answer} onChange={onChange} disabled={disabled} />
        )}
      </div>
    </li>
  );
}

function OpenAnswer({
  question,
  answer,
  onChange,
  disabled,
}: {
  question: AcadQuizQuestion;
  answer: AcadAnswerInput | undefined;
  onChange: (patch: Partial<AcadAnswerInput>) => void;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const upload = async (file: File) => {
    setUploading(file.name);
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id;
      if (!uid) throw new Error("Войдите заново");
      const ref = await uploadKbFile(acadAnswersFolder(uid), file);
      onChange({ file: ref });
    } catch (e) {
      toast.error(
        e instanceof KbFileTooLarge ? e.message : `Не удалось загрузить: ${(e as Error).message}`,
      );
    } finally {
      setUploading(null);
    }
  };
  const fileName = answer?.file ? "Файл приложен" : null;
  return (
    <div className="space-y-2">
      <Textarea
        rows={4}
        maxLength={4000}
        placeholder="Ваш ответ"
        disabled={disabled}
        value={answer?.text ?? ""}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      {question.allow_file && disabled && (
        // Просмотр: кнопка как у ученика, но без загрузки.
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled>
            <Paperclip /> Приложить файл
          </Button>
          <span className="text-xs text-muted-foreground">
            до {formatFileSize(50 * 1024 * 1024)}
          </span>
        </div>
      )}
      {question.allow_file && !disabled && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {fileName ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
              <Paperclip className="size-3.5" /> {fileName}
              <button
                type="button"
                aria-label="Убрать файл"
                className="cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => onChange({ file: null })}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ) : (
            <Button asChild variant="outline" size="sm">
              <label className="cursor-pointer">
                {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
                {uploading ? `Загружаем ${uploading}…` : "Приложить файл"}
                <input
                  type="file"
                  className="sr-only"
                  disabled={!!uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void upload(f);
                  }}
                />
              </label>
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            до {formatFileSize(50 * 1024 * 1024)}
          </span>
        </div>
      )}
    </div>
  );
}
