import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ClipboardList,
  Ellipsis,
  Eye,
  FileText,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { AcadArticlePicker } from "@/components/academy/article-picker";
import { AcadAssignmentForm } from "@/components/academy/assignment-form";
import { AcadCourseForm } from "@/components/academy/course-form";
import {
  CourseCover,
  CourseStatusBadge,
  PersonCell,
  ProgressBadge,
  ProgressBar,
  PublishedNote,
  StepIcon,
} from "@/components/academy/parts";
import { useConfirm } from "@/components/confirm-dialog";
import { DropIndicator } from "@/components/kb/drop-indicator";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useDragRow, type RowDropOperation } from "@/hooks/use-drag-row";
import { useTableSort } from "@/hooks/use-table-sort";
import { supabase } from "@/integrations/supabase/client";
import { copyArticleForLesson } from "@/lib/academy/article-copy";
import {
  acadAssignmentsQuery,
  acadCourseQuery,
  acadCourseReportQuery,
  acadFoldersQuery,
  acadQuestionStatsQuery,
  acadQuestionsQuery,
  acadSourcesQuery,
  acadStaffQuery,
  acadStepsQuery,
  invalidateAcademy,
} from "@/lib/academy/data";
import {
  acadError,
  assignmentDueText,
  dueLabel,
  learnersCount,
  plural,
  progressPercent,
  publishIssues,
  quizzesToRecheck,
  type RecheckLesson,
  recheckText,
  ROLE_LABEL,
  staleLessons,
} from "@/lib/academy/logic";
import type {
  AcadAssignment,
  AcadCourse,
  AcadReportRow,
  AcadSource,
  AcadStep,
} from "@/lib/academy/types";
import { formatDate, formatDateTime, todayISO } from "@/lib/format";
import type { KbTreeNode } from "@/lib/kb/types";
import type { SortGetters } from "@/lib/table-sort";
import { cn } from "@/lib/utils";
import { useAccessNames } from "@/hooks/use-access-names";

export type BuilderTab = "content" | "learners" | "errors";

/**
 * Конструктор курса: шапка (статус, настройки, просмотр глазами ученика),
 * вкладки «Содержание» (уроки и тесты по порядку, перетаскиванием),
 * «Ученики» (назначения и ход) и «Ошибки» (разбор по вопросам, №68).
 * Править — право «Создаёт курсы»; проверяющий видит всё без правки.
 */
export function CourseBuilder({ courseId, tab }: { courseId: string; tab: BuilderTab }) {
  const navigate = useNavigate();
  const access = useAdminAccess();
  const canEdit = !!access?.academy?.is_admin || !!access?.academy?.can_create;
  const { data: course, isLoading, error } = useQuery(acadCourseQuery(courseId));
  const setTab = (t: string) =>
    void navigate({
      to: "/academy/courses/$courseId",
      params: { courseId },
      search: { tab: t === "content" ? undefined : (t as BuilderTab) },
      replace: true,
    });

  if (isLoading) return null;
  if (error || !course)
    return <InfoNote variant="warning">{acadError(error ?? "Курс не найден")}</InfoNote>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <CourseHead course={course} canEdit={canEdit} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="content">Содержание</TabsTrigger>
          <TabsTrigger value="learners">Ученики</TabsTrigger>
          <TabsTrigger value="errors">Ошибки</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "content" ? (
        <ContentTab course={course} canEdit={canEdit} />
      ) : tab === "learners" ? (
        <LearnersTab course={course} canEdit={canEdit} />
      ) : (
        <ErrorsTab courseId={course.id} />
      )}
    </div>
  );
}

function CourseHead({ course, canEdit }: { course: AcadCourse; canEdit: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const { data: folders } = useQuery(acadFoldersQuery);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const folder = folders?.find((f) => f.id === course.folder_id)?.title;

  const setStatus = async (status: AcadCourse["status"]) => {
    setMenu(false);
    if (status === "published") {
      // Пустые тесты окно публикации называет: у ученика их не сдать.
      let issues: string[] = [];
      try {
        const [steps, questions] = await Promise.all([
          qc.fetchQuery(acadStepsQuery(course.id)),
          qc.fetchQuery(acadQuestionsQuery(course.id)),
        ]);
        const counts: Record<string, number> = {};
        for (const q of questions) counts[q.step_id] = (counts[q.step_id] ?? 0) + 1;
        issues = publishIssues(steps, counts, course.sequential);
      } catch {
        // Не проверили — публикуем с обычным предупреждением.
      }
      const ok = await confirm({
        title: issues.length ? "Опубликовать курс с недоделками?" : "Опубликовать курс?",
        description: [
          ...issues,
          "Курс увидят все, кому он назначен. Черновика правок у курса нет: после публикации каждая правка урока или вопроса сразу видна ученикам.",
        ].join(" "),
        confirmLabel: issues.length ? "Всё равно опубликовать" : "Опубликовать",
        destructive: false,
      });
      if (!ok) return;
    }
    const { error } = await supabase.from("acad_courses").update({ status }).eq("id", course.id);
    if (error) toast.error(acadError(error));
    else
      toast.success(
        status === "published"
          ? "Курс опубликован"
          : status === "archived"
            ? "Курс в архиве"
            : "Курс снят с публикации",
      );
    await invalidateAcademy(qc);
  };

  const remove = async () => {
    setMenu(false);
    const { count } = await supabase
      .from("acad_attempts")
      .select("id", { count: "exact", head: true })
      .eq("course_id", course.id);
    const ok = await confirm({
      title: `Удалить курс «${course.title}»?`,
      description: count
        ? `Удалятся уроки, тесты и ответы учеников (попыток: ${count}). Чтобы сохранить историю, отправьте курс в архив.`
        : "Удалятся уроки, тесты и назначения. Вернуть нельзя.",
    });
    if (!ok) return;
    const { error } = await supabase.from("acad_courses").delete().eq("id", course.id);
    if (error) {
      toast.error(acadError(error));
      return;
    }
    toast.success("Курс удалён");
    await invalidateAcademy(qc);
    void navigate({ to: "/academy/courses" });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-background p-4 sm:flex-row sm:p-5">
      <CourseCover
        cover={course.cover}
        // self-start: в строке flex растягивал обложку на высоту текста —
        // рамка выходила ~4:3 и резала картинку по краям.
        className="aspect-[16/9] w-full shrink-0 self-start rounded-md sm:w-52"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <Link
          to="/academy/courses"
          className="text-xs font-semibold text-brand-on-light hover:underline"
        >
          Курсы{folder ? ` · ${folder}` : ""}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold leading-tight">{course.title}</h2>
          <CourseStatusBadge status={course.status} />
        </div>
        {course.description && (
          <p className="text-sm whitespace-pre-line text-muted-foreground">{course.description}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {course.sequential ? "По порядку" : "В любом порядке"} · тесты сданы от{" "}
          {course.pass_percent}%
          {course.default_due_days
            ? ` · срок ${course.default_due_days} ${plural(course.default_due_days, ["день", "дня", "дней"])} с назначения`
            : ""}
          {course.published_at ? ` · опубликован ${formatDate(course.published_at)}` : ""}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild variant="outline" size="sm">
            <Link to="/academy/courses/$courseId/preview" params={{ courseId: course.id }}>
              <Eye /> Как видит ученик
            </Link>
          </Button>
          {canEdit && (
            <>
              {course.status !== "published" && (
                <Button size="sm" onClick={() => void setStatus("published")}>
                  Опубликовать
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Settings2 /> Настройки
              </Button>
              <Popover open={menu} onOpenChange={setMenu}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Ещё действия с курсом">
                    <Ellipsis />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1">
                  {course.status === "published" && (
                    <ListItemButton onClick={() => void setStatus("draft")}>
                      Снять с публикации
                    </ListItemButton>
                  )}
                  {course.status !== "archived" && (
                    <ListItemButton onClick={() => void setStatus("archived")}>
                      Отправить в архив
                    </ListItemButton>
                  )}
                  <ListItemButton
                    className="text-destructive hover:text-destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2 /> Удалить курс
                  </ListItemButton>
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>
      </div>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-lg">
          {editing && <AcadCourseForm course={course} onDone={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Содержание

function ContentTab({ course, canEdit }: { course: AcadCourse; canEdit: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const { data: steps, isLoading } = useQuery(acadStepsQuery(course.id));
  const { data: questions } = useQuery(acadQuestionsQuery(course.id));
  const { data: sources } = useQuery(acadSourcesQuery(course.id));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = steps ?? [];
  const counts: Record<string, number> = {};
  for (const q of questions ?? []) counts[q.step_id] = (counts[q.step_id] ?? 0) + 1;
  const stale = staleLessons(list, sources ?? []);
  const recheck = quizzesToRecheck(list, counts);
  const sourceOf = new Map((sources ?? []).map((s) => [s.step_id, s]));

  const add = async (kind: "lesson" | "quiz") => {
    setBusy(true);
    try {
      const n = list.filter((s) => s.kind === kind).length + 1;
      const { data, error } = await supabase
        .from("acad_steps")
        .insert({
          course_id: course.id,
          kind,
          title: kind === "quiz" ? `Тест ${n}` : `Урок ${n}`,
          content: kind === "lesson" ? [] : null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await invalidateAcademy(qc);
      // Сразу в название: «Урок 1» легко забыть поменять.
      void navigate({
        to: "/academy/courses/$courseId/$stepId",
        params: { courseId: course.id, stepId: (data as { id: string }).id },
        search: { new: 1 },
      });
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setBusy(false);
    }
  };

  const addFromArticle = async (node: KbTreeNode) => {
    setBusy(true);
    try {
      const copy = await copyArticleForLesson(node.id, course.id);
      const { error } = await supabase.from("acad_steps").insert({
        course_id: course.id,
        kind: "lesson",
        title: copy.title || "Урок",
        content: copy.content,
        source_node_id: node.id,
        source_published_at: copy.publishedAt,
      });
      if (error) throw new Error(error.message);
      toast.success(
        copy.failed
          ? `Урок добавлен, но ${copy.failed} ${plural(copy.failed, ["файл", "файла", "файлов"])} не скопировать — проверьте урок`
          : "Урок добавлен из статьи",
      );
      setPicking(false);
      await invalidateAcademy(qc);
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (step: AcadStep, src: AcadSource) => {
    const ok = await confirm({
      title: `Обновить урок «${step.title}» из статьи?`,
      description:
        "Текст урока заменится текущей версией статьи «" +
        src.node_title +
        "». Правки, сделанные прямо в уроке, пропадут. После обновления проверьте вопросы теста.",
      confirmLabel: "Обновить",
      destructive: false,
    });
    if (!ok) return;
    try {
      const copy = await copyArticleForLesson(src.node_id, course.id);
      const { error } = await supabase
        .from("acad_steps")
        .update({ content: copy.content, source_published_at: copy.publishedAt })
        .eq("id", step.id);
      if (error) throw new Error(error.message);
      toast.success("Урок обновлён — проверьте вопросы теста после него");
      await invalidateAcademy(qc);
    } catch (e) {
      toast.error(acadError(e));
    }
  };

  const markChecked = async (step: AcadStep) => {
    const { error } = await supabase
      .from("acad_steps")
      .update({ questions_updated_at: new Date().toISOString() })
      .eq("id", step.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const removeStep = async (step: AcadStep) => {
    const { count } = await supabase
      .from("acad_attempts")
      .select("id", { count: "exact", head: true })
      .eq("step_id", step.id);
    const ok = await confirm({
      title: `Удалить ${step.kind === "quiz" ? "тест" : "урок"} «${step.title}»?`,
      description:
        step.kind === "quiz" && count
          ? `Удалятся вопросы и ответы учеников (попыток: ${count}).`
          : "Вернуть нельзя.",
    });
    if (!ok) return;
    const { error } = await supabase.from("acad_steps").delete().eq("id", step.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const reorder = async (sourceId: string, targetId: string, op: RowDropOperation) => {
    const ids = list.map((s) => s.id).filter((id) => id !== sourceId);
    ids.splice(ids.indexOf(targetId) + (op === "reorder-after" ? 1 : 0), 0, sourceId);
    qc.setQueryData<AcadStep[]>(acadStepsQuery(course.id).queryKey, (prev) =>
      prev
        ? ids.flatMap((id, i) =>
            prev.filter((s) => s.id === id).map((s) => ({ ...s, sort_order: i + 1 })),
          )
        : prev,
    );
    const { error } = await supabase.rpc("acad_reorder", { p_kind: "steps", p_ids: ids });
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  return (
    <div className="space-y-3">
      {course.status === "published" && canEdit && <PublishedNote />}
      {list.length === 0 && !isLoading ? (
        <InfoNote variant="empty">
          Добавьте первый урок: свой текст или копию статьи базы знаний. После уроков — тест с
          вопросами по ним.
        </InfoNote>
      ) : (
        <ol className="divide-y rounded-lg border bg-background">
          {list.map((s, i) => (
            <StepRow
              key={s.id}
              courseId={course.id}
              step={s}
              index={i}
              canEdit={canEdit}
              questions={counts[s.id] ?? 0}
              source={sourceOf.get(s.id)}
              stale={stale.has(s.id)}
              recheck={recheck.get(s.id)}
              onRefresh={(src) => void refresh(s, src)}
              onRechecked={() => void markChecked(s)}
              onDelete={() => void removeStep(s)}
              onDropRow={(sourceId, op) => void reorder(sourceId, s.id, op)}
            />
          ))}
        </ol>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void add("lesson")}>
            <FileText /> Урок
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setPicking(true)}>
            <Plus /> Урок из статьи
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void add("quiz")}>
            <ClipboardList /> Тест
          </Button>
          {busy && <Loader2 className="size-5 animate-spin self-center text-muted-foreground" />}
        </div>
      )}
      <Dialog open={picking} onOpenChange={(o) => !busy && setPicking(o)}>
        <DialogContent className="max-w-lg">
          {picking && (
            <AcadArticlePicker
              busy={busy}
              usedIds={new Set(list.flatMap((st) => st.source_node_id ?? []))}
              onPick={(node) => void addFromArticle(node)}
              onCancel={() => setPicking(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

function StepRow({
  courseId,
  step,
  index,
  canEdit,
  questions,
  source,
  stale,
  recheck,
  onRefresh,
  onRechecked,
  onDelete,
  onDropRow,
}: {
  courseId: string;
  step: AcadStep;
  index: number;
  canEdit: boolean;
  questions: number;
  source?: AcadSource;
  stale: boolean;
  recheck?: RecheckLesson[];
  onRefresh: (src: AcadSource) => void;
  onRechecked: () => void;
  onDelete: () => void;
  onDropRow: (sourceId: string, op: RowDropOperation) => void;
}) {
  const drag = useDragRow<HTMLLIElement, HTMLSpanElement>({
    id: step.id,
    type: `acad-step-${courseId}`,
    disabled: !canEdit,
    onDrop: onDropRow,
  });
  return (
    <li
      ref={drag.ref}
      className={cn("relative flex items-center gap-1 pr-2", drag.dragging && "opacity-40")}
    >
      <DropIndicator instruction={drag.instruction} />
      {canEdit && (
        <span
          ref={drag.handleRef}
          className="flex cursor-grab items-center self-stretch pl-2 text-muted-foreground"
          aria-hidden
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <Link
        to="/academy/courses/$courseId/$stepId"
        params={{ courseId, stepId: step.id }}
        draggable={false}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md p-3 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StepIcon kind={step.kind} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted-foreground">
            {index + 1}. {step.kind === "quiz" ? "Тест" : "Урок"}
            {step.kind === "quiz" &&
              ` · ${questions} ${plural(questions, ["вопрос", "вопроса", "вопросов"])}`}
            {source && ` · из статьи «${source.node_title}»`}
          </span>
          <span className="block font-medium">{step.title}</span>
          {step.kind === "quiz" && questions === 0 && (
            <span className="mt-1 flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" /> В тесте нет вопросов
            </span>
          )}
          {recheck && (
            <span className="mt-1 flex items-start gap-1 text-xs text-amber-700">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              {recheckText(recheck)} — проверьте вопросы
            </span>
          )}
          {stale && source && (
            <span className="mt-1 flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" /> Статья изменилась{" "}
              {source.published_at ? formatDateTime(source.published_at) : ""}
            </span>
          )}
        </span>
      </Link>
      {canEdit && recheck && (
        // Напоминание снимается и отсюда, не заходя в тест.
        <Button variant="outline" size="sm" onClick={onRechecked}>
          <Check /> Вопросы проверены
        </Button>
      )}
      {canEdit && stale && source?.available && (
        <Button variant="outline" size="sm" onClick={() => onRefresh(source)}>
          <RefreshCw /> Обновить
        </Button>
      )}
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Удалить «${step.title}»`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Ученики

const REPORT_SORT: SortGetters<AcadReportRow> = {
  name: (r) => r.full_name ?? "",
  progress: (r) => progressPercent(r.steps_done, r.steps_total),
  due: (r) => r.due_date,
  activity: (r) => r.last_activity_at,
  score: (r) => r.avg_percent,
};

function LearnersTab({ course, canEdit }: { course: AcadCourse; canEdit: boolean }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: assignments } = useQuery(acadAssignmentsQuery(course.id));
  const { data: staff } = useQuery(acadStaffQuery);
  const { data: report, isLoading } = useQuery(acadCourseReportQuery(course.id));
  const { data: studios } = useQuery({
    queryKey: ["acad", "studios"],
    queryFn: async () => {
      const { data, error } = await supabase.from("studios").select("id, name");
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 10 * 60_000,
  });
  const [adding, setAdding] = useState(false);
  const sort = useTableSort<AcadReportRow>(REPORT_SORT);
  const nameOf = new Map(
    (staff ?? []).map((p) => [p.user_id, p.full_name || p.email || "Сотрудник"]),
  );
  const accessNames = useAccessNames(false);
  const studioName = new Map((studios ?? []).map((s) => [s.id, s.name]));
  const list = assignments ?? [];
  const today = todayISO();

  const describe = (a: AcadAssignment) =>
    a.subject_type === "user"
      ? (nameOf.get(a.user_id ?? "") ?? "Сотрудник")
      : a.subject_type === "unit"
        ? `Подразделение «${accessNames.unit.get(a.unit_id ?? "") ?? "—"}»${a.with_subunits ? " и ниже" : ""}`
        : a.subject_type === "position"
          ? `Должность «${accessNames.position.get(a.position_id ?? "") ?? "—"}»`
          : a.subject_type === "access_role"
            ? `Роль «${accessNames.role.get(a.access_role_id ?? "")?.name ?? "—"}»`
            : `${ROLE_LABEL[a.role ?? "admin"]} ${
                a.studio_ids.length
                  ? `клубов ${a.studio_ids.map((id) => `«${studioName.get(id) ?? "клуб"}»`).join(", ")}`
                  : "всех клубов"
              }`;

  const remove = async (a: AcadAssignment) => {
    const ok = await confirm({
      title: "Снять назначение?",
      description: `${describe(a)} больше не увидят курс (если он не назначен им иначе). Пройденное сохранится.`,
      confirmLabel: "Снять",
    });
    if (!ok) return;
    const { error } = await supabase.from("acad_assignments").delete().eq("id", a.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">Кому назначен</h3>
            <p className="text-xs text-muted-foreground">
              Сейчас курс получат: {learnersCount(staff ?? [], list)}{" "}
              {plural(learnersCount(staff ?? [], list), ["сотрудник", "сотрудника", "сотрудников"])}
              {course.status !== "published" && " — после публикации"}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Назначить
            </Button>
          )}
        </div>
        {list.length === 0 ? (
          <InfoNote variant="empty">Курс пока никому не назначен.</InfoNote>
        ) : (
          <ul className="divide-y">
            {list.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{describe(a)}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.subject_type !== "user" ? "Правило · " : ""}
                    {assignmentDueText(a)}
                  </span>
                </span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Снять назначение"
                    onClick={() => void remove(a)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Ход учеников</h3>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead {...sort.head("name")}>Сотрудник</TableHead>
                <TableHead {...sort.head("progress")}>Пройдено</TableHead>
                <TableHead {...sort.head("score")}>Тесты</TableHead>
                <TableHead {...sort.head("due")}>Срок</TableHead>
                <TableHead {...sort.head("activity")}>Последнее действие</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableSkeletonRows columns={5} rows={3} />
              ) : (report ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Учеников пока нет
                  </TableCell>
                </TableRow>
              ) : (
                sort.apply(report ?? []).map((r) => {
                  const due = r.completed_at ? null : dueLabel(r.due_date, today);
                  return (
                    <TableRow key={r.user_id}>
                      <TableCell>
                        <PersonCell name={r.full_name} avatar={r.avatar_url} />
                      </TableCell>
                      <TableCell className="min-w-44">
                        <span className="mb-1 flex items-center justify-between gap-2 text-xs">
                          <span className="tabular-nums">
                            {r.steps_done} из {r.steps_total}
                          </span>
                          <ProgressBadge status={r.status} overdue={r.overdue} />
                        </span>
                        <ProgressBar value={progressPercent(r.steps_done, r.steps_total)} />
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {r.avg_percent != null ? `${Math.round(Number(r.avg_percent))}%` : "—"}
                        {r.attempts > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            попыток: {r.attempts}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={cn("text-sm", due?.overdue && "text-destructive")}>
                        {r.completed_at
                          ? `Пройден ${formatDate(r.completed_at)}`
                          : (due?.text ?? "—")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.last_activity_at ? formatDateTime(r.last_activity_at) : "Не открывал"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-lg">
          {adding && (
            <AcadAssignmentForm
              courseId={course.id}
              existing={list}
              defaultDueDays={course.default_due_days}
              onDone={() => setAdding(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ошибки

function ErrorsTab({ courseId }: { courseId: string }) {
  const { data, isLoading } = useQuery(acadQuestionStatsQuery(courseId));
  const rows = [...(data ?? [])].sort(
    (a, b) => (b.answers ? b.wrong / b.answers : -1) - (a.answers ? a.wrong / a.answers : -1),
  );
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Где ошибаются чаще: доля неверных ответов по каждому вопросу (пересдачи считаются, перенос
        верных — нет). Высокая доля — повод поправить урок или формулировку вопроса.
      </p>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Вопрос</TableHead>
              <TableHead>Ответов</TableHead>
              <TableHead>С ошибкой</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={3} rows={4} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                  В курсе пока нет вопросов
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const share = r.answers ? Math.round((r.wrong * 100) / r.answers) : null;
                return (
                  <TableRow key={r.question_id}>
                    <TableCell className="max-w-xl">
                      <span className="block text-xs text-muted-foreground">{r.step_title}</span>
                      <span className="line-clamp-2 text-sm">{r.text}</span>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {r.answers}
                      <span className="block text-xs text-muted-foreground">
                        {r.people} {plural(r.people, ["человек", "человека", "человек"])}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-36">
                      {share == null ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <>
                          <span
                            className={cn(
                              "text-sm font-medium tabular-nums",
                              share >= 50
                                ? "text-destructive"
                                : share >= 25
                                  ? "text-amber-700"
                                  : "",
                            )}
                          >
                            {share}%
                          </span>
                          <span className="ml-1 text-xs text-muted-foreground">({r.wrong})</span>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
