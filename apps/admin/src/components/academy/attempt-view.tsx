import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { AttemptBadge } from "@/components/academy/parts";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { acadAttemptQuery, acadReviewNotesQuery, invalidateAcademy } from "@/lib/academy/data";
import { acadError, QUESTION_KIND_LABEL } from "@/lib/academy/logic";
import type { AcadAttempt, AcadAttemptAnswer } from "@/lib/academy/types";
import { formatDateTime } from "@/lib/format";
import { resolveKbDownloadUrl } from "@/lib/kb/files";
import { cn } from "@/lib/utils";

type Grade = { correct: boolean | null; comment: string };

/**
 * Попытка теста: ответы, баллы, комментарии проверяющего. Ученик видит,
 * где ошибся, но не правильные варианты (их ему не отдаёт acad_attempt);
 * проверяющий у попытки «На проверке» оценивает открытые ответы
 * (acad_review_submit) — «Верно / Неверно» и комментарий к ошибке.
 */
export function AttemptView({
  attemptId,
  fromReview,
}: {
  attemptId: string;
  fromReview?: boolean;
}) {
  const access = useAdminAccess();
  const { data: me } = useStaffProfile();
  const { data: attempt, isLoading, error } = useQuery(acadAttemptQuery(attemptId));
  if (isLoading) return null;
  if (error || !attempt)
    return <InfoNote variant="warning">{acadError(error ?? "Попытка не найдена")}</InfoNote>;
  // Свои ответы не проверяют (база тоже не даст — acad_own_attempt).
  const canReview =
    attempt.status === "review" &&
    attempt.user_id !== me?.id &&
    (!!access?.academy?.is_admin || !!access?.academy?.can_review);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <AttemptHeader attempt={attempt} fromReview={fromReview} />
      {canReview ? (
        <ReviewForm attempt={attempt} />
      ) : attempt.full ? (
        <TeamAnswers attempt={attempt} />
      ) : (
        <ol className="space-y-3">
          {attempt.answers.map((a, i) => (
            <AnswerCard key={a.id} index={i} answer={a} full={false} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** Эталон и критерии свободных ответов попытки — только команде (`full`). */
function useReviewNotes(attempt: AcadAttempt) {
  const ids = attempt.full
    ? attempt.answers.flatMap((a) =>
        a.question.kind === "open" && a.question_id ? [a.question_id] : [],
      )
    : [];
  return useQuery(acadReviewNotesQuery(ids)).data;
}

function TeamAnswers({ attempt }: { attempt: AcadAttempt }) {
  const notes = useReviewNotes(attempt);
  return (
    <ol className="space-y-3">
      {attempt.answers.map((a, i) => (
        <AnswerCard
          key={a.id}
          index={i}
          answer={a}
          full
          notes={a.question_id ? notes?.get(a.question_id) : undefined}
        />
      ))}
    </ol>
  );
}

function AttemptHeader({ attempt: t, fromReview }: { attempt: AcadAttempt; fromReview?: boolean }) {
  const backTo = fromReview ? (
    <Link
      to="/academy/review"
      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-on-light hover:underline"
    >
      <ArrowLeft className="size-3.5" /> Проверка ответов
    </Link>
  ) : (
    <Link
      to="/academy/my/$courseId"
      params={{ courseId: t.course_id }}
      search={{ step: t.step_id }}
      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-on-light hover:underline"
    >
      <ArrowLeft className="size-3.5" /> {t.course_title ?? "Курс"}
    </Link>
  );
  return (
    <div className="space-y-3 rounded-lg border bg-background p-4 sm:p-5">
      {backTo}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{t.step_title ?? "Тест"}</h2>
          <p className="text-sm text-muted-foreground">
            {t.full && t.user_name ? `${t.user_name} · ` : ""}
            Попытка {t.attempt_no} · {formatDateTime(t.submitted_at)}
          </p>
        </div>
        <AttemptBadge status={t.status} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          Баллы: <b className="tabular-nums">{Number(t.score)}</b> из{" "}
          <span className="tabular-nums">{Number(t.max_score)}</span>
        </span>
        <span>
          Результат: <b className="tabular-nums">{Math.round(Number(t.percent))}%</b> (сдан от{" "}
          {t.pass_percent}%)
        </span>
      </div>
      {t.status === "review" && !t.full && (
        <InfoNote variant="warning">
          Свободные ответы проверяет тренер — результат появится здесь. Следующие шаги курса уже
          открыты.
        </InfoNote>
      )}
      {t.status === "failed" && !t.full && (
        <InfoNote variant="muted">
          Пересдать можно из курса: спросим только вопросы с ошибками, верные ответы засчитаны.
        </InfoNote>
      )}
      {t.review_comment && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Комментарий {t.reviewed_by_name ? `· ${t.reviewed_by_name}` : "проверяющего"}
          </p>
          <p className="mt-1 whitespace-pre-line">{t.review_comment}</p>
        </div>
      )}
    </div>
  );
}

function Verdict({ answer: a }: { answer: AcadAttemptAnswer }) {
  if (a.correct === null) return <StatusChip tone="warning">Ждёт проверки</StatusChip>;
  if (a.carried) return <StatusChip tone="positive">Засчитан раньше</StatusChip>;
  return a.correct ? (
    <StatusChip tone="positive">Верно</StatusChip>
  ) : (
    <StatusChip tone="negative">С ошибкой</StatusChip>
  );
}

function AnswerCard({
  index,
  answer: a,
  full,
  notes,
  children,
}: {
  index: number;
  answer: AcadAttemptAnswer;
  full: boolean;
  /** Эталон и критерии для проверяющего (свободный ответ). */
  notes?: string;
  children?: ReactNode;
}) {
  const q = a.question;
  const picked = new Set(a.answer.options ?? []);
  return (
    <li className="rounded-lg border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Вопрос {index + 1} · {QUESTION_KIND_LABEL[q.kind]}
        </p>
        <Verdict answer={a} />
      </div>
      <p className="mt-1 font-medium whitespace-pre-line">{q.text}</p>
      {notes && (
        <p className="mt-2 rounded-md border-l-2 border-sky-400 bg-sky-50 px-3 py-2 text-sm whitespace-pre-line text-sky-950">
          <span className="block text-xs text-sky-800">
            Эталон и критерии (видит только проверяющий)
          </span>
          {notes}
        </p>
      )}
      {q.kind === "open" ? (
        <div className="mt-3 space-y-2">
          {a.answer.text ? (
            <p className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-line">
              {a.answer.text}
            </p>
          ) : null}
          {a.answer.file && <FileLink file={a.answer.file} />}
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {q.options.map((o) => {
            const chosen = picked.has(o.id);
            const known = o.correct !== undefined;
            return (
              <li
                key={o.id}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  chosen && "border-foreground/30 bg-muted/50",
                  known && o.correct && "border-emerald-300 bg-emerald-50",
                  known && chosen && !o.correct && "border-red-200 bg-red-50",
                )}
              >
                <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
                  {known && o.correct ? (
                    <Check className="size-4 text-emerald-600" />
                  ) : known && chosen ? (
                    <X className="size-4 text-destructive" />
                  ) : null}
                </span>
                <span className="flex-1">{o.text}</span>
                {chosen && (
                  <span className="text-xs text-muted-foreground">
                    {full ? "выбран" : "ваш ответ"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {a.correct === false && q.explanation && (
        <p className="mt-3 rounded-md border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {q.explanation}
        </p>
      )}
      {a.comment && (
        <p className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-line">
          <span className="block text-xs text-muted-foreground">Комментарий проверяющего</span>
          {a.comment}
        </p>
      )}
      {!full && a.correct === false && q.kind !== "open" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Правильный ответ не показываем — найдите его в уроке и ответьте при пересдаче.
        </p>
      )}
      {children}
    </li>
  );
}

function FileLink({ file }: { file: string }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const url = await resolveKbDownloadUrl(file, file.split("/").pop() ?? "файл");
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(`Файл недоступен: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void open()} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />}
      Файл к ответу
    </Button>
  );
}

function ReviewForm({ attempt }: { attempt: AcadAttempt }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [grades, setGrades] = useState<Record<string, Grade>>(() =>
    Object.fromEntries(
      attempt.answers
        .filter((a) => !a.carried)
        .map((a) => [a.id, { correct: a.correct, comment: a.comment }]),
    ),
  );
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const notes = useReviewNotes(attempt);
  const pending = attempt.answers.filter((a) => a.correct === null);
  const left = pending.filter((a) => grades[a.id]?.correct == null).length;

  const submit = async () => {
    if (left > 0) {
      toast.error(`Оцените все свободные ответы — осталось ${left}`);
      return;
    }
    setSaving(true);
    try {
      const payload = Object.entries(grades).map(([answer_id, g]) => {
        const a = attempt.answers.find((x) => x.id === answer_id);
        return a?.correct === null
          ? { answer_id, correct: g.correct, comment: g.comment.trim() }
          : { answer_id, comment: g.comment.trim() };
      });
      const { data, error } = await supabase.rpc("acad_review_submit", {
        p_attempt: attempt.id,
        p_grades: payload,
        p_comment: comment.trim(),
      });
      if (error) throw new Error(error.message);
      await invalidateAcademy(qc);
      toast.success(
        data === "passed"
          ? "Проверено: тест сдан"
          : "Проверено: тест не сдан, ученик пересдаст ошибки",
      );
      void navigate({ to: "/academy/review" });
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <InfoNote variant="info">
        Закрытые вопросы база уже проверила. Оцените свободные ответы и, если нужно, напишите
        комментарий к ошибке — ученик увидит его и пересдаст только вопросы с ошибками.
      </InfoNote>
      <ol className="space-y-3">
        {attempt.answers.map((a, i) => (
          <AnswerCard
            key={a.id}
            index={i}
            answer={a}
            full
            notes={a.question_id ? notes?.get(a.question_id) : undefined}
          >
            {!a.carried && (
              <div className="mt-3 space-y-2 border-t pt-3">
                {a.correct === null && (
                  <SegmentedControl
                    aria-label="Оценка ответа"
                    value={grades[a.id]?.correct == null ? "" : grades[a.id].correct ? "yes" : "no"}
                    onChange={(v) =>
                      setGrades((g) => ({ ...g, [a.id]: { ...g[a.id], correct: v === "yes" } }))
                    }
                    options={[
                      { value: "yes", label: "Верно" },
                      { value: "no", label: "Неверно" },
                    ]}
                  />
                )}
                <Textarea
                  rows={2}
                  maxLength={2000}
                  placeholder={
                    a.correct === null ? "Комментарий к ответу" : "Комментарий (необязательно)"
                  }
                  value={grades[a.id]?.comment ?? ""}
                  onChange={(e) =>
                    setGrades((g) => ({ ...g, [a.id]: { ...g[a.id], comment: e.target.value } }))
                  }
                />
              </div>
            )}
          </AnswerCard>
        ))}
      </ol>
      <div className="space-y-3 rounded-lg border bg-background p-4">
        <Textarea
          rows={3}
          maxLength={4000}
          placeholder="Общий комментарий к попытке (необязательно)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {left > 0 ? `Не оценено: ${left}` : "Все свободные ответы оценены"}
          </span>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Завершить проверку
          </Button>
        </div>
      </div>
    </div>
  );
}
