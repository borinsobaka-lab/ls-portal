/**
 * «Новая задача» (TASKS_CHATS_PLAN.md, 4.1, 4.3; UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 4.4): сверху — название и описание (тот же редактор, что в карточке),
 * проект, исполнители, срок; «Ещё» — соисполнители, наблюдатели,
 * чек-листы, файлы, теги, срочность, «Принять работу после завершения»,
 * «Требовать отчёт о результате», напоминание и «Повторять». Открыто ли
 * «Ещё» — помнит браузер. Несколько исполнителей — «Одна общая задача»
 * (первый — исполнитель, остальные — соисполнители с пунктом чек-листа на
 * каждого) или «Каждому своя». «Заполнить из шаблона» — плашка с названием
 * шаблона и «Сбросить».
 *
 * Картинки описания до постановки ложатся в свою папку `tasks/new/<я>/`
 * бакета kb-media, после постановки копируются в папку задачи
 * (db/migrations/2026-11-09_task_ui_review.sql). После постановки человек
 * остаётся, где был: тост «Задача #N поставлена» с «Открыть».
 *
 * Подзадача (`parent`) и задача из сообщения чата (`fromMessage`: название,
 * описание со ссылкой на сообщение, файлы сообщения) — этап 2.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Paperclip,
  RotateCw,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ChecklistsEditor } from "@/components/tasks/checklists-editor";
import { DeadlinePicker } from "@/components/tasks/deadline-picker";
import { RecurrenceFields } from "@/components/tasks/recurrence-fields";
import { AbsentNote, PeopleField } from "@/components/tasks/task-bits";
import { TaskTagsField } from "@/components/tasks/task-tags";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { copyKbFiles } from "@/lib/kb/files";
import { documentFilePaths, documentIsEmpty } from "@/lib/kb/document";
import {
  formatFileSize,
  signedFileUrl,
  startResumableUpload,
  type ResumableUpload,
  type UploadedFile,
} from "@/lib/resumable-upload";
import {
  TASK_BUCKET,
  createTask,
  makeRecurring,
  taskErrorText,
  templatesQuery,
  updateTask,
  useMyProjects,
  useTaskClock,
  useWorkCalendar,
} from "@/lib/tasks/data";
import {
  buildRule,
  cleanLists,
  createdText,
  localDay,
  localTime,
  plural,
  REMINDER_OPTIONS,
  ruleDraft,
  templateDeadline,
  titleFromMessage,
  workdaysBetween,
  type DraftList,
  type RuleDraft,
} from "@/lib/tasks/logic";
import type { TaskBrief, TaskTemplate, TemplateTask } from "@/lib/tasks/types";
import type { ChatAttachment } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/** Открыто ли «Ещё» — с прошлого раза (вместо прежнего «Всегда открывать полностью»). */
const MORE_KEY = "tasks_form_more";

const NONE = "none";

const TIPS = {
  project: "Задачу проекта видят все его участники; проверка и правило срока — как в проекте.",
  assignees:
    "Исполнитель отвечает за результат. Несколько человек — выберите: одна общая задача или своя каждому.",
  mode: "«Одна общая» — первый исполнитель, остальные помогают (у каждого пункт чек-листа). «Каждому своя» — отдельная задача на каждого с одинаковыми полями.",
  coassignees: "Помогают исполнителю: видят задачу, ведут чек-листы и файлы, но не завершают.",
  watchers: "Только следят: видят задачу и обсуждение, уведомления — по своей настройке.",
  review: "Исполнитель отправит задачу вам на проверку, вы примете или вернёте.",
  result: "Исполнитель не завершит задачу, пока не напишет результат: что сделано, ссылка, цифры.",
  repeat:
    "Эта задача — первая, следующие появятся по расписанию с теми же полями. Расписание — в «Регулярных».",
};

/** Сообщение чата, из которого ставят задачу. */
export type TaskFromMessage = {
  chatId: string;
  seq: number;
  text: string;
  authorName: string;
  attachments: ChatAttachment[];
  /** Бакет файлов сообщения. */
  bucket: string;
};

/** Описание из сообщения: текст и ссылка «Сообщение от …». */
function messageDoc(m: TaskFromMessage): unknown[] {
  const url = `${window.location.origin}/chats/${m.chatId}?m=${m.seq}`;
  const lines = m.text.replace(/\r/g, "").split("\n");
  return [
    ...lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line, styles: {} }] : [],
    })),
    {
      type: "paragraph",
      content: [
        { type: "text", text: `Из чата, автор — ${m.authorName}: `, styles: { italic: true } },
        {
          type: "link",
          href: url,
          content: [{ type: "text", text: "открыть сообщение", styles: {} }],
        },
      ],
    },
  ];
}

const readMore = () => {
  try {
    return window.localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
};
const writeMore = (on: boolean) => {
  try {
    window.localStorage.setItem(MORE_KEY, on ? "1" : "0");
  } catch {
    // без памяти
  }
};

type Upload = {
  key: string;
  name: string;
  size: number;
  progress: number;
  done?: UploadedFile;
  error?: string;
  waiting?: boolean;
};

export function NewTaskDialog({
  open,
  onClose,
  initialAssignee,
  initialProject,
  template,
  parent,
  fromMessage,
  onCreated,
  onOpenTask,
}: {
  open: boolean;
  onClose: () => void;
  initialAssignee?: string;
  /** Задача в проект (страница проекта). */
  initialProject?: string;
  /** Поля из шаблона («Поставить задачу» у шаблона). */
  template?: TaskTemplate;
  /** Подзадача к этой задаче. */
  parent?: Pick<TaskBrief, "id" | "number" | "title">;
  /** Задача из сообщения чата. */
  fromMessage?: TaskFromMessage;
  /** После постановки (номера задач) — например, обновить переписку. */
  onCreated?: (numbers: number[]) => void;
  /** «Открыть» в тосте: карточка панелью на этой странице; иначе — страница задачи. */
  onOpenTask?: (number: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        {open && (
          <TaskForm
            onClose={onClose}
            initialAssignee={initialAssignee}
            initialProject={initialProject}
            template={template}
            parent={parent}
            fromMessage={fromMessage}
            onCreated={onCreated}
            onOpenTask={onOpenTask}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({
  onClose,
  initialAssignee,
  initialProject,
  template,
  parent,
  fromMessage,
  onCreated,
  onOpenTask,
}: {
  onClose: () => void;
  initialAssignee?: string;
  initialProject?: string;
  template?: TaskTemplate;
  parent?: Pick<TaskBrief, "id" | "number" | "title">;
  fromMessage?: TaskFromMessage;
  onCreated?: (numbers: number[]) => void;
  onOpenTask?: (number: number) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: profile } = useStaffProfile();
  const me = profile?.id ?? "";
  const { tz, workdayEnd } = useTaskClock();
  const calendar = useWorkCalendar(tz);
  const [more, setMoreState] = useState(() => readMore() || !!fromMessage);
  const setMore = useCallback((on: boolean) => {
    setMoreState(on);
    writeMore(on);
  }, []);
  const [title, setTitle] = useState(() => (fromMessage ? titleFromMessage(fromMessage.text) : ""));
  const [assignees, setAssignees] = useState<string[]>(initialAssignee ? [initialAssignee] : []);
  const [mode, setMode] = useState<"shared" | "separate">("shared");
  const [deadline, setDeadline] = useState<string | null>(null);
  const [coassignees, setCoassignees] = useState<string[]>([]);
  const [watchers, setWatchers] = useState<string[]>([]);
  // Описание — документ редактора; docKey пересоздаёт редактор (шаблон, «Сбросить»).
  const [descDoc, setDescDoc] = useState<unknown[] | null>(() =>
    fromMessage ? messageDoc(fromMessage) : null,
  );
  const [docKey, setDocKey] = useState(() => crypto.randomUUID());
  const [lists, setLists] = useState<DraftList[]>([]);
  const [project, setProject] = useState(initialProject ?? NONE);
  const projects = useMyProjects();
  const { data: templates = [] } = useQuery(templatesQuery);
  const [applied, setApplied] = useState<TaskTemplate | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [review, setReview] = useState(false);
  const [resultRequired, setResultRequired] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [reminder, setReminder] = useState("none");
  const [repeat, setRepeat] = useState(false);
  const [rule, setRule] = useState<RuleDraft>(() => ruleDraft(null));
  const [repeatTime, setRepeatTime] = useState("09:00");
  const [repeatSkip, setRepeatSkip] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; rule?: string; files?: string }>({});
  const handles = useRef(new Map<string, ResumableUpload>());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const map = handles.current;
    return () => map.forEach((h) => h.cancel(false));
  }, []);

  const applyTemplate = useCallback(
    (tp: TaskTemplate) => {
      const t = tp.task;
      setTitle(t.title ?? "");
      setAssignees(t.assignees ?? []);
      setMode(t.mode ?? "shared");
      setCoassignees(t.coassignees ?? []);
      setWatchers(t.watchers ?? []);
      setDescDoc(Array.isArray(t.description) && t.description.length ? t.description : null);
      setDocKey(crypto.randomUUID());
      setLists(
        (t.checklists ?? []).map((l) => ({
          title: l.title,
          items: l.items.map((i) => ({ ...i })),
        })),
      );
      setUrgent(!!t.urgent);
      setReview(!!t.requires_review);
      setResultRequired(!!t.result_required);
      const d = templateDeadline(
        new Date(),
        tz,
        workdayEnd,
        calendar,
        t.deadline_days,
        t.deadline_time,
      );
      setDeadline(d ? d.toISOString() : null);
      if (tp.project_id) setProject(tp.project_id);
      setApplied(tp);
      if (t.coassignees?.length || t.watchers?.length || t.checklists?.length) setMore(true);
    },
    [tz, workdayEnd, calendar, setMore],
  );

  // Шаблон, с которым открыли форму, — один раз.
  const appliedFirst = useRef(false);
  useEffect(() => {
    if (template && !appliedFirst.current) {
      appliedFirst.current = true;
      applyTemplate(template);
    }
  }, [template, applyTemplate]);

  const resetTemplate = () => {
    setTitle("");
    setAssignees(initialAssignee ? [initialAssignee] : []);
    setMode("shared");
    setCoassignees([]);
    setWatchers([]);
    setDescDoc(null);
    setDocKey(crypto.randomUUID());
    setLists([]);
    setUrgent(false);
    setReview(false);
    setResultRequired(false);
    setDeadline(null);
    setProject(initialProject ?? NONE);
    setApplied(null);
  };

  const addFiles = useCallback(
    (files: File[]) => {
      if (!me) return;
      for (const file of files) {
        const key = crypto.randomUUID();
        const patch = (p: Partial<Upload>) =>
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
        setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0 }]);
        const h = startResumableUpload(TASK_BUCKET, `new/${me}`, file, (s) => {
          if (s.status === "uploading") patch({ progress: s.share, waiting: false });
          else if (s.status === "waiting") patch({ progress: s.share, waiting: true });
          else if (s.status === "done") patch({ progress: 1, done: s.attachment, waiting: false });
          else patch({ error: s.message, waiting: false });
        });
        handles.current.set(key, h);
      }
    },
    [me],
  );

  // Файлы сообщения — копией в задачу (скачать и загрузить заново).
  const copied = useRef(false);
  useEffect(() => {
    if (!fromMessage || !me || copied.current || fromMessage.attachments.length === 0) return;
    copied.current = true;
    void (async () => {
      const files: File[] = [];
      for (const a of fromMessage.attachments) {
        try {
          const res = await fetch(await signedFileUrl(fromMessage.bucket, a.path));
          if (!res.ok) throw new Error(String(res.status));
          files.push(new File([await res.blob()], a.name, { type: a.mime }));
        } catch {
          toast.error(`Не удалось взять файл «${a.name}» из сообщения`);
        }
      }
      addFiles(files);
    })();
  }, [fromMessage, me, addFiles]);

  const removeUpload = (key: string) => {
    handles.current.get(key)?.cancel();
    handles.current.delete(key);
    setUploads((u) => u.filter((x) => x.key !== key));
  };

  const openTask = (n: number) => {
    if (onOpenTask) onOpenTask(n);
    else void navigate({ to: "/tasks/$number", params: { number: String(n) } });
  };

  const submit = async () => {
    const e: typeof errors = {};
    if (!title.trim()) e.title = "Напишите, что сделать";
    if (uploads.some((u) => !u.done)) e.files = "Дождитесь загрузки файлов или уберите их";
    const builtRule = repeat ? buildRule(rule) : null;
    if (repeat && !builtRule)
      e.rule = rule.freq === "weekly" ? "Отметьте хотя бы один день" : "Проверьте расписание";
    setErrors(e);
    if (e.title || e.files || e.rule) {
      if (e.files || e.rule) setMore(true);
      return;
    }
    setSaving(true);
    try {
      const doc = descDoc && !documentIsEmpty(descDoc) ? descDoc : null;
      const r = await createTask(qc, {
        title: title.trim(),
        assignees,
        mode: assignees.length > 1 ? mode : "shared",
        deadline,
        coassignees,
        watchers,
        description: doc,
        checklists: cleanLists(lists),
        project_id: project === NONE ? null : project,
        parent_id: parent?.id ?? null,
        source: fromMessage ? { chat_id: fromMessage.chatId, seq: fromMessage.seq } : null,
        result_required: resultRequired,
        tags,
        files: uploads.flatMap((u) => (u.done ? [u.done] : [])),
        urgent,
        requires_review: review,
        reminder:
          reminder === "none" || !deadline
            ? null
            : {
                before_minutes: reminder === "0" ? undefined : Number(reminder),
                remind_at: reminder === "0" ? deadline : undefined,
              },
      });
      handles.current.clear();

      // Картинки описания — из своей папки в папку каждой задачи.
      let firstDoc = doc;
      if (doc && documentFilePaths(doc).some((p) => p.startsWith("tasks/new/"))) {
        for (const [i, t] of r.tasks.entries()) {
          const { content, failed } = await copyKbFiles(doc, `tasks/${t.id}`);
          if (failed) toast.error("Не все картинки описания удалось перенести в задачу");
          await updateTask(qc, t, { description: content });
          if (i === 0) firstDoc = content;
        }
      }

      if (builtRule) {
        const template: TemplateTask = {
          title: title.trim(),
          description: firstDoc,
          assignees,
          mode: assignees.length > 1 ? mode : "shared",
          coassignees,
          watchers,
          checklists: cleanLists(lists),
          urgent,
          requires_review: review,
          result_required: resultRequired,
          deadline_days: deadline
            ? workdaysBetween(localDay(new Date(), tz), localDay(new Date(deadline), tz), calendar)
            : null,
          deadline_time: deadline ? localTime(new Date(deadline), tz) : null,
        };
        try {
          await makeRecurring(qc, r.tasks[0].id, {
            rule: builtRule,
            at_time: repeatTime,
            mode: repeatSkip ? "skip" : "wait",
            task: template,
          });
        } catch (err) {
          toast.error(`Задача поставлена, но расписание не сохранилось: ${taskErrorText(err)}`);
        }
      }

      onClose();
      const numbers = r.tasks.map((t) => t.number);
      toast.success(
        builtRule ? `${createdText(numbers)} · повторяется по расписанию` : createdText(numbers),
        {
          action: {
            label: "Открыть",
            onClick: () =>
              numbers.length === 1
                ? openTask(numbers[0])
                : void navigate({ to: "/tasks", search: { role: "assigned" } }),
          },
        },
      );
      onCreated?.(numbers);
    } catch (err) {
      toast.error(taskErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const forMe = assignees.length === 0 || (assignees.length === 1 && assignees[0] === me);
  const many = assignees.length > 1;

  return (
    <DialogForm onSubmit={() => void submit()}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{parent ? "Новая подзадача" : "Новая задача"}</DialogTitle>
        <DialogDescription>
          {parent
            ? `К задаче #${parent.number} «${parent.title}».`
            : fromMessage
              ? "Из сообщения: текст и файлы уже подставлены, в чате появится ссылка на задачу."
              : forMe
                ? "Задача себе — она будет в «Делаю»."
                : "Вы — постановщик: примете работу, задача будет в «Поручил»."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {applied ? (
          <InfoNote variant="info" className="flex flex-wrap items-center gap-x-2">
            <span className="min-w-0 flex-1">Заполнено по шаблону «{applied.name}»</span>
            <Button variant="link" size="inline" onClick={resetTemplate}>
              Сбросить
            </Button>
          </InfoNote>
        ) : (
          templates.length > 0 && <TemplatePicker templates={templates} onPick={applyTemplate} />
        )}
        <FormField label="Что сделать" required error={errors.title}>
          <Input
            autoFocus
            value={title}
            maxLength={300}
            placeholder="Например: подготовить отчёт по Казани"
            onChange={(e) => {
              setTitle(e.target.value);
              setErrors((x) => ({ ...x, title: undefined }));
            }}
          />
        </FormField>
        <FormField label="Описание" optional htmlFor={null}>
          <div className="min-h-24 rounded-md border bg-background py-2">
            <Suspense
              fallback={
                <div className="flex h-20 items-center px-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              }
            >
              {me && (
                <KbDocument
                  key={docKey}
                  nodeId={docKey}
                  filesFolder={`tasks/new/${me}`}
                  initial={descDoc}
                  editable
                  onChange={setDescDoc}
                />
              )}
            </Suspense>
          </div>
        </FormField>
        {projects.length > 0 && (
          <FormField label="Проект" tip={TIPS.project}>
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Без проекта</SelectItem>
                {projects.map((pr) => (
                  <SelectItem key={pr.id} value={pr.id}>
                    {pr.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <FormField
          label={many ? "Исполнители" : "Исполнитель"}
          tip={TIPS.assignees}
          hint={assignees.length ? undefined : "Не выбран — задача вам"}
          htmlFor={null}
        >
          <PeopleField value={assignees} onChange={setAssignees} addLabel="Выбрать" />
        </FormField>
        <AbsentNote ids={[...assignees, ...coassignees]} until={deadline} />
        {many && (
          <FormField label="Как поставить" tip={TIPS.mode} htmlFor={null}>
            <SegmentedControl
              aria-label="Как поставить нескольким"
              fullWidth
              value={mode}
              onChange={setMode}
              options={[
                { value: "shared", label: "Одна общая задача" },
                { value: "separate", label: `Каждому своя (${assignees.length})` },
              ]}
            />
          </FormField>
        )}
        <FormField label="Срок" htmlFor="task-deadline">
          <DeadlinePicker
            id="task-deadline"
            value={deadline}
            onChange={setDeadline}
            tz={tz}
            workdayEnd={workdayEnd}
            calendar={calendar}
          />
        </FormField>

        <Button variant="ghost" size="sm" onClick={() => setMore(!more)} aria-expanded={more}>
          {more ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          {more ? "Скрыть дополнительное" : "Ещё: соисполнители, чек-лист, файлы, повтор…"}
        </Button>
        {more && (
          <div className="space-y-4 border-t pt-4">
            <FormField label="Соисполнители" tip={TIPS.coassignees} htmlFor={null}>
              <PeopleField value={coassignees} onChange={setCoassignees} exclude={assignees} />
            </FormField>
            <FormField label="Наблюдатели" tip={TIPS.watchers} htmlFor={null}>
              <PeopleField
                value={watchers}
                onChange={setWatchers}
                exclude={[...assignees, ...coassignees]}
              />
            </FormField>
            <FormField label="Чек-листы" htmlFor={null}>
              <ChecklistsEditor lists={lists} onChange={setLists} />
            </FormField>
            <FormField
              label="Файлы"
              hint="До 200 МБ; оборвётся связь — загрузка продолжится"
              htmlFor={null}
              error={errors.files}
            >
              <div className="space-y-2">
                {uploads.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {uploads.map((u) => (
                      <span
                        key={u.key}
                        className={cn(
                          "relative flex max-w-64 items-center gap-2 overflow-hidden rounded-md border bg-background py-1 pr-1 pl-2 text-xs",
                          u.error && "border-destructive text-destructive",
                        )}
                        title={u.error ?? u.name}
                      >
                        {u.waiting ? (
                          <WifiOff className="size-3.5 shrink-0 text-amber-600" />
                        ) : (
                          !u.done &&
                          !u.error && <Loader2 className="size-3.5 shrink-0 animate-spin" />
                        )}
                        <span className="truncate">{u.name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {u.error
                            ? "ошибка"
                            : u.waiting
                              ? `${Math.round(u.progress * 100)}% · нет связи`
                              : formatFileSize(u.size)}
                        </span>
                        {u.waiting && (
                          <button
                            type="button"
                            className="rounded-full p-0.5 hover:bg-muted"
                            aria-label={`Повторить ${u.name}`}
                            title="Повторить"
                            onClick={() => handles.current.get(u.key)?.resume()}
                          >
                            <RotateCw className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded-full p-0.5 hover:bg-muted"
                          aria-label={`Убрать ${u.name}`}
                          title="Убрать"
                          onClick={() => removeUpload(u.key)}
                        >
                          <X className="size-3.5" />
                        </button>
                        {!u.done && !u.error && (
                          <span
                            className="absolute bottom-0 left-0 h-0.5 bg-chat-accent transition-[width]"
                            style={{ width: `${Math.round(u.progress * 100)}%` }}
                          />
                        )}
                      </span>
                    ))}
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(ev) => {
                    addFiles(Array.from(ev.target.files ?? []));
                    ev.target.value = "";
                    setErrors((x) => ({ ...x, files: undefined }));
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Paperclip className="size-4" /> Прикрепить файлы
                </Button>
              </div>
            </FormField>
            <FormField label="Теги" htmlFor={null} hint="Город, канал, тема — для фильтра в списке">
              <TaskTagsField value={tags} onChange={setTags} />
            </FormField>
            <SwitchRow title="Срочно" checked={urgent} onCheckedChange={setUrgent} />
            <SwitchRow
              title="Принять работу после завершения"
              tip={TIPS.review}
              checked={review}
              onCheckedChange={setReview}
            />
            <SwitchRow
              title="Требовать отчёт о результате"
              tip={TIPS.result}
              checked={resultRequired}
              onCheckedChange={setResultRequired}
            />
            <FormField
              label="Напомнить мне"
              hint={deadline ? undefined : "«За … до срока» — когда поставите срок"}
            >
              <Select value={reminder} onValueChange={setReminder}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REMINDER_OPTIONS.map((o) => (
                    <SelectItem
                      key={o.value}
                      value={o.value}
                      disabled={o.value !== "none" && !deadline}
                    >
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <SwitchRow
              title="Повторять"
              tip={TIPS.repeat}
              checked={repeat}
              onCheckedChange={(v) => {
                setRepeat(v);
                setErrors((x) => ({ ...x, rule: undefined }));
              }}
            />
            {repeat && (
              <div className="rounded-md border p-3">
                <RecurrenceFields
                  draft={rule}
                  onDraft={(d) => {
                    setRule(d);
                    setErrors((x) => ({ ...x, rule: undefined }));
                  }}
                  time={repeatTime}
                  onTime={setRepeatTime}
                  skip={repeatSkip}
                  onSkip={setRepeatSkip}
                  error={errors.rule}
                />
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {many && mode === "separate"
            ? `Поставить ${assignees.length} ${plural(assignees.length, "задачу", "задачи", "задач")}`
            : "Поставить задачу"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

/** «Заполнить из шаблона ▾» — список шаблонов. */
function TemplatePicker({
  templates,
  onPick,
}: {
  templates: TaskTemplate[];
  onPick: (tp: TaskTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Copy className="size-4" /> Заполнить из шаблона
          <ChevronDown className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-72 overflow-y-auto p-1">
        {templates.map((tp) => (
          <ListItemButton
            key={tp.id}
            onClick={() => {
              setOpen(false);
              onPick(tp);
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{tp.name}</span>
              {tp.task.title !== tp.name && (
                <span className="block truncate text-xs text-muted-foreground">
                  {tp.task.title}
                </span>
              )}
            </span>
          </ListItemButton>
        ))}
      </PopoverContent>
    </Popover>
  );
}
