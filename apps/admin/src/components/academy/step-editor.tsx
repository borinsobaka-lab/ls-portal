import { lazy, Suspense, useCallback, useRef, useState, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CloudOff,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { PublishedNote } from "@/components/academy/parts";
import { AcadQuestionForm } from "@/components/academy/question-form";
import { useConfirm } from "@/components/confirm-dialog";
import { DropIndicator } from "@/components/kb/drop-indicator";
import { useAutosave, type AutosaveResult } from "@/components/kb/use-autosave";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useDragRow, type RowDropOperation } from "@/hooks/use-drag-row";
import { supabase } from "@/integrations/supabase/client";
import {
  acadCourseFolder,
  acadCourseQuery,
  acadQuestionsQuery,
  acadSourcesQuery,
  acadStepContentQuery,
  acadStepsQuery,
  invalidateAcademy,
} from "@/lib/academy/data";
import {
  acadError,
  kbLinkCount,
  plural,
  QUESTION_KIND_LABEL,
  quizzesToRecheck,
  recheckText,
} from "@/lib/academy/logic";
import type { AcadCourse, AcadQuestion, AcadStep } from "@/lib/academy/types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/** Пауза в наборе, после которой урок сохраняется. */
const AUTOSAVE_MS = 1500;

/**
 * Шаг курса в конструкторе: урок — название и текст в редакторе базы знаний
 * (файлы — в папку курса, автосохранение), тест — вопросы и проходной
 * процент. Без права «Создаёт курсы» — только просмотр.
 */
export function StepEditor({
  courseId,
  stepId,
  isNew,
}: {
  courseId: string;
  stepId: string;
  /** Только что создан — курсор в название («Урок 1» легко забыть поменять). */
  isNew?: boolean;
}) {
  const access = useAdminAccess();
  const canEdit = !!access?.academy?.is_admin || !!access?.academy?.can_create;
  const { data: course } = useQuery(acadCourseQuery(courseId));
  const { data: steps, isLoading } = useQuery(acadStepsQuery(courseId));
  const step = steps?.find((s) => s.id === stepId);
  // Текст урока: Enter в названии ставит курсор сюда.
  const bodyRef = useRef<HTMLDivElement>(null);

  if (isLoading) return null;
  if (!step) return <InfoNote variant="warning">Шаг не найден — возможно, его удалили.</InfoNote>;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/academy/courses/$courseId"
          params={{ courseId }}
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-on-light hover:underline"
        >
          <ArrowLeft className="size-3.5" /> {course?.title ?? "Курс"}
        </Link>
      </div>
      {course?.status === "published" && canEdit && <PublishedNote />}
      <TitleField
        step={step}
        canEdit={canEdit}
        autoFocus={isNew}
        onEnter={
          step.kind === "lesson"
            ? () => {
                const editor = bodyRef.current?.querySelector<HTMLElement>(
                  '[contenteditable="true"]',
                );
                editor?.focus();
                return !!editor;
              }
            : undefined
        }
      />
      {step.kind === "lesson" ? (
        <LessonEditor
          courseId={courseId}
          step={step}
          canEdit={canEdit}
          published={course?.status === "published"}
          bodyRef={bodyRef}
        />
      ) : (
        <QuizEditor course={course} steps={steps ?? []} step={step} canEdit={canEdit} />
      )}
    </div>
  );
}

function TitleField({
  step,
  canEdit,
  autoFocus,
  onEnter,
}: {
  step: AcadStep;
  canEdit: boolean;
  autoFocus?: boolean;
  /** Enter: перейти к тексту урока; false — текста нет, просто сохранить. */
  onEnter?: () => boolean;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(step.title);
  // Название выделяется только при первом входе в новый шаг: иначе после
  // Enter и возврата фокуса набранный текст урока затёр бы его.
  const selected = useRef(false);
  const save = async () => {
    const t = title.trim();
    if (!t) {
      setTitle(step.title);
      return;
    }
    if (t === step.title) return;
    const { error } = await supabase.from("acad_steps").update({ title: t }).eq("id", step.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };
  if (!canEdit) return <h2 className="text-xl font-semibold">{step.title}</h2>;
  return (
    <FormField label={step.kind === "quiz" ? "Название теста" : "Название урока"}>
      <Input
        value={title}
        maxLength={200}
        autoFocus={autoFocus}
        onFocus={(e) => {
          if (!autoFocus || selected.current) return;
          selected.current = true;
          e.currentTarget.select();
        }}
        enterKeyHint="next"
        className="text-base font-semibold"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          // Фокус в текст урока сам вызовет onBlur — название сохранится.
          if (!onEnter?.()) e.currentTarget.blur();
        }}
      />
    </FormField>
  );
}

function LessonEditor({
  courseId,
  step,
  canEdit,
  published,
  bodyRef,
}: {
  courseId: string;
  step: AcadStep;
  canEdit: boolean;
  published: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
}) {
  const { data: content, isLoading } = useQuery(acadStepContentQuery(step.id));
  const { data: sources } = useQuery(acadSourcesQuery(courseId));
  const source = sources?.find((s) => s.step_id === step.id);
  // Ссылки на статьи базы — по открытому тексту; правки досчитывает schedule.
  const [kbLinks, setKbLinks] = useState<number | null>(null);
  const links = kbLinks ?? kbLinkCount(content ?? []);
  const qc = useQueryClient();
  const save = useCallback(
    async (doc: unknown[]): Promise<AutosaveResult> => {
      const { error } = await supabase
        .from("acad_steps")
        .update({ content: doc })
        .eq("id", step.id);
      if (error) return "error";
      // Кэш текста урока (staleTime: Infinity) — сохранённый: вернулись к
      // уроку — редактор открывает его, а не текст до правок.
      qc.setQueryData(acadStepContentQuery(step.id).queryKey, doc);
      return "ok";
    },
    [qc, step.id],
  );
  const { state, savedAt, schedule: scheduleSave, setBaseline } = useAutosave(save, AUTOSAVE_MS);
  const schedule = (doc: unknown[]) => {
    setKbLinks(kbLinkCount(doc));
    scheduleSave(doc);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {source
            ? `Копия статьи «${source.node_title}»${
                step.source_published_at ? ` от ${formatDateTime(step.source_published_at)}` : ""
              }. Обновить из статьи — в списке шагов курса.`
            : "Свой текст урока"}
        </span>
        {canEdit && (
          <span className="inline-flex items-center gap-1">
            {state === "error" ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <CloudOff className="size-3.5" /> Нет связи — урок сохранится, когда она вернётся
              </span>
            ) : state === "saving" || state === "pending" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Сохраняем…
              </>
            ) : state === "saved" && savedAt ? (
              <>
                <Check className="size-3.5" /> Сохранено в{" "}
                {savedAt.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}
                {published && " — ученики уже видят"}
              </>
            ) : (
              `Правки сохраняются сами${published ? " и сразу видны ученикам" : ""}`
            )}
          </span>
        )}
      </div>
      {links > 0 && (
        <InfoNote variant="warning" className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            В уроке {links} {plural(links, ["ссылка", "ссылки", "ссылок"])} на статьи базы знаний.
            Ученик без доступа к этой базе их не откроет — перенесите нужный текст в урок или
            добавьте ту статью отдельным уроком.
          </span>
        </InfoNote>
      )}
      <div ref={bodyRef} className="min-h-80 rounded-lg border bg-background py-4">
        {isLoading || !content ? (
          <div className="flex items-center gap-2 px-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Открываем урок…
          </div>
        ) : (
          <Suspense fallback={null}>
            <KbDocument
              nodeId={step.id}
              filesFolder={acadCourseFolder(courseId)}
              initial={content}
              editable={canEdit}
              onReady={setBaseline}
              onChange={canEdit ? schedule : undefined}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function QuizEditor({
  course,
  steps,
  step,
  canEdit,
}: {
  course: AcadCourse | undefined;
  steps: AcadStep[];
  step: AcadStep;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: all } = useQuery(acadQuestionsQuery(step.course_id));
  const questions = (all ?? []).filter((q) => q.step_id === step.id);
  const [editing, setEditing] = useState<AcadQuestion | "new" | null>(null);
  const [pass, setPass] = useState(step.pass_percent ? String(step.pass_percent) : "");
  const counts: Record<string, number> = {};
  for (const q of all ?? []) counts[q.step_id] = (counts[q.step_id] ?? 0) + 1;
  const changed = quizzesToRecheck(steps, counts).get(step.id);

  const savePass = async () => {
    const value = pass.trim() ? Number(pass) : null;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100)) {
      toast.error("Проходной процент — от 1 до 100 или пусто (как у курса)");
      return;
    }
    if (value === step.pass_percent) return;
    const { error } = await supabase
      .from("acad_steps")
      .update({ pass_percent: value })
      .eq("id", step.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const markChecked = async () => {
    const { error } = await supabase
      .from("acad_steps")
      .update({ questions_updated_at: new Date().toISOString() })
      .eq("id", step.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const remove = async (q: AcadQuestion) => {
    const ok = await confirm({
      title: "Удалить вопрос?",
      description: "Ответы учеников на него останутся в их попытках.",
    });
    if (!ok) return;
    const { error } = await supabase.from("acad_questions").delete().eq("id", q.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const reorder = async (sourceId: string, targetId: string, op: RowDropOperation) => {
    const ids = questions.map((q) => q.id).filter((id) => id !== sourceId);
    ids.splice(ids.indexOf(targetId) + (op === "reorder-after" ? 1 : 0), 0, sourceId);
    const { error } = await supabase.rpc("acad_reorder", { p_kind: "questions", p_ids: ids });
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  return (
    <div className="space-y-4">
      {changed && canEdit && (
        <InfoNote variant="warning" className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">
            {recheckText(changed)}. Проверьте, что вопросы ещё совпадают с текстом.
          </span>
          <Button size="sm" variant="outline" onClick={() => void markChecked()}>
            Вопросы проверены
          </Button>
        </InfoNote>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[14rem_1fr]">
        <FormField
          label="Проходной процент"
          tip="Пусто — как у курса. Тест сдан, если набрано не меньше этой доли баллов."
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            disabled={!canEdit}
            placeholder={`${course?.pass_percent ?? 80} (как у курса)`}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onBlur={() => void savePass()}
          />
        </FormField>
        <p className="self-end pb-2 text-xs text-muted-foreground">
          Верные ответы ученик не видит. Не сдал — пересдаёт только вопросы с ошибками.
        </p>
      </div>
      {questions.length === 0 ? (
        <InfoNote variant="empty">Добавьте вопросы по урокам перед тестом.</InfoNote>
      ) : (
        <ol className="space-y-2">
          {questions.map((q, i) => (
            <QuestionRow
              key={q.id}
              question={q}
              index={i}
              canEdit={canEdit}
              onEdit={() => setEditing(q)}
              onDelete={() => void remove(q)}
              onDropRow={(sourceId, op) => void reorder(sourceId, q.id, op)}
            />
          ))}
        </ol>
      )}
      {canEdit && (
        <Button onClick={() => setEditing("new")}>
          <Plus /> Вопрос
        </Button>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl" anchor="top">
          {editing && (
            <AcadQuestionForm
              key={editing === "new" ? "new" : editing.id}
              stepId={step.id}
              question={editing === "new" ? null : editing}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

function QuestionRow({
  question: q,
  index,
  canEdit,
  onEdit,
  onDelete,
  onDropRow,
}: {
  question: AcadQuestion;
  index: number;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDropRow: (sourceId: string, op: RowDropOperation) => void;
}) {
  const drag = useDragRow<HTMLLIElement, HTMLSpanElement>({
    id: q.id,
    type: `acad-question-${q.step_id}`,
    disabled: !canEdit,
    onDrop: onDropRow,
  });
  return (
    <li
      ref={drag.ref}
      className={cn(
        "relative flex items-start gap-2 rounded-lg border bg-background p-3",
        drag.dragging && "opacity-40",
      )}
    >
      <DropIndicator instruction={drag.instruction} />
      {canEdit && (
        <span ref={drag.handleRef} className="mt-0.5 cursor-grab text-muted-foreground" aria-hidden>
          <GripVertical className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          {index + 1}. {QUESTION_KIND_LABEL[q.kind]}
          {q.points > 1 ? ` · ${q.points} ${plural(q.points, ["балл", "балла", "баллов"])}` : ""}
          {q.allow_file ? " · с файлом" : ""}
          {q.kind === "open" && q.review_notes ? " · есть критерии для проверяющего" : ""}
        </p>
        <p className="font-medium whitespace-pre-line">{q.text}</p>
        {q.kind !== "open" && (
          <ul className="mt-1.5 space-y-0.5 text-sm">
            {q.options.map((o) => (
              <li
                key={o.id}
                className={cn(
                  "flex items-start gap-1.5",
                  o.correct ? "text-emerald-700" : "text-muted-foreground",
                )}
              >
                <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
                  {o.correct && <Check className="size-3.5" />}
                </span>
                {o.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canEdit && (
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon" aria-label="Изменить вопрос" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Удалить вопрос" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  );
}
