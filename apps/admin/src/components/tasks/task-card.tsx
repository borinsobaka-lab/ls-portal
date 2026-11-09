/**
 * Карточка задачи (план, 3.4; UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.3): под
 * названием — строка «Статус ▾ · Срок · Исполнитель · Постановщик» с одной
 * главной кнопкой («Завершить» / «На проверку» / «Принять»), остальные
 * переходы — в «Статус ▾»; слева — описание (редактор базы знаний: картинки,
 * файлы, оформление), результат, чек-листы, файлы, подзадачи, «Обсуждение»
 * (поле комментария всегда внизу) и «История»; справа — «Люди», «Параметры»
 * и сворачиваемое «Ещё» (проверка, отчёт, напоминания, уведомления). «⋯» —
 * скопировать ссылку, шаблон, регулярная, подзадача, отменить. Открывается
 * панелью поверх списка (`?task=`) и своей страницей `/tasks/1234`. Что
 * можно — taskPerms (lib/tasks/logic.ts), последнее слово — у базы.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Bell,
  ChevronDown,
  CopyCheck,
  CornerLeftUp,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { DeadlinePicker } from "@/components/tasks/deadline-picker";
import { RecurrenceFields } from "@/components/tasks/recurrence-fields";
import { TaskChecklists } from "@/components/tasks/task-checklists";
import { TaskDiscussion, TaskHistory } from "@/components/tasks/task-discussion";
import { TaskFiles } from "@/components/tasks/task-files";
import { TaskMenu, type TaskMenuEntry } from "@/components/tasks/task-menu";
import { TaskOrigin, TaskResult, TaskSubtasks } from "@/components/tasks/task-subtasks";
import { TaskTagsField } from "@/components/tasks/task-tags";
import { useConfirm } from "@/components/confirm-dialog";
import { TemplateDialog } from "@/components/tasks/templates-page";
import {
  AbsentNote,
  DeadlineText,
  PeopleField,
  PersonLine,
  ProjectTag,
  TaskStatusChip,
  UrgentMark,
} from "@/components/tasks/task-bits";
import { PeoplePicker } from "@/components/chats/dialogs";
import { useAutosave, type AutosaveResult } from "@/components/kb/use-autosave";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import {
  makeRecurring,
  projectQuery,
  setTaskResult,
  setTaskStatus,
  setTaskTags,
  taskAction,
  taskErrorText,
  updateTask,
  useMyProjects,
  useTaskCard,
  useTaskClock,
  useTaskList,
  useWorkCalendar,
} from "@/lib/tasks/data";
import {
  assigneeOf,
  buildRule,
  creatorOf,
  deadlineLockHint,
  formatMoment,
  isClosed,
  isOverdue,
  memberIds,
  plural,
  REMINDER_OPTIONS,
  ruleDraft,
  STATUS_LABEL,
  taskPerms,
  type StatusAction,
  type TaskPerms,
} from "@/lib/tasks/logic";
import type { TaskFull, TaskNotify } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const NONE = "none";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

const TIPS = {
  review: "Исполнитель отправит задачу вам на проверку, вы примете или вернёте.",
  result: "Исполнитель не завершит задачу, пока не напишет результат: что сделано, ссылка, цифры.",
  stage: "Колонка на доске проекта. Статус задачи от неё не зависит.",
  notify:
    "«Только моё» — когда от вас нужно действие (поставили, на проверке, вернули, срок). Своё напоминание приходит всегда.",
  cancel: "Задачи не удаляются — отменённая остаётся в истории, вернуть можно «Возобновить».",
};

const NOTIFY_OPTIONS: { value: TaskNotify; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "mine", label: "Только моё" },
  { value: "none", label: "Ничего" },
];

type Ask = {
  title: string;
  description: string;
  label: string;
  required: boolean;
  confirm: string;
  /** Подпись «Отмена» (у «Отменить задачу» — «Не отменять»). */
  cancel?: string;
  danger?: boolean;
  /** Текст в поле сразу (правка результата). */
  initial?: string;
  rows?: number;
  run: (text: string) => Promise<void>;
};

export function TaskCard({
  number,
  onClose,
  onOpenTask,
}: {
  number: number;
  onClose?: () => void;
  /** Подзадачи и родительская — в той же панели (иначе — страницей). */
  onOpenTask?: (n: number) => void;
}) {
  const { data: task, isPending, error } = useTaskCard(number);
  if (isPending)
    return (
      <div className="flex h-60 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  if (error || !task)
    return (
      <div className="space-y-3 p-6 text-center">
        <p className="font-medium">Задача #{number} не найдена</p>
        <p className="text-sm text-muted-foreground">
          Её удалили, или она видна только участникам и их руководителям.
        </p>
        {onClose && (
          <Button variant="outline" onClick={onClose}>
            Закрыть
          </Button>
        )}
      </div>
    );
  return <TaskCardBody key={task.id} task={task} onClose={onClose} onOpenTask={onOpenTask} />;
}

function TaskCardBody({
  task,
  onClose,
  onOpenTask,
}: {
  task: TaskFull;
  onClose?: () => void;
  onOpenTask?: (n: number) => void;
}) {
  const qc = useQueryClient();
  const { data: profile } = useStaffProfile();
  const me = profile?.id ?? "";
  const { tz, workdayEnd } = useTaskClock();
  const calendar = useWorkCalendar(tz);
  const perms = taskPerms(task);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState(false);
  const [asTemplate, setAsTemplate] = useState(false);
  const [asParent, setAsParent] = useState(false);
  const [asRecurring, setAsRecurring] = useState(false);
  const [tab, setTab] = useState("discussion");
  const { confirm, confirmDialog } = useConfirm();
  const projects = useMyProjects();
  const assignee = assigneeOf(task);
  const creator = creatorOf(task);
  const co = memberIds(task, "coassignee");
  const watchers = memberIds(task, "watcher");
  const late = isOverdue(task);

  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(taskErrorText(e));
      throw e;
    }
  };
  const quiet = (p: Promise<unknown>, ok?: string) => void run(p, ok).catch(() => {});

  const setMembers = (next: { assignee?: string; co?: string[]; watchers?: string[] }) =>
    quiet(
      taskAction(qc, "task_set_members", {
        p_task: task.id,
        p_assignee: next.assignee ?? assignee,
        p_coassignees: next.co ?? co,
        p_watchers: next.watchers ?? watchers,
      }),
    );

  const status = (action: StatusAction) => {
    if (action === "return") {
      setAsk({
        title: task.status === "review" ? "Вернуть на доработку" : "Вернуть в работу",
        description: "Исполнитель получит уведомление с вашим комментарием.",
        label: "Что исправить",
        required: task.status === "review",
        confirm: "Вернуть",
        run: (text) => run(setTaskStatus(qc, task, "return", text)),
      });
      return;
    }
    if (action === "cancel") {
      setAsk({
        title: "Отменить задачу?",
        description: TIPS.cancel,
        label: "Причина",
        required: false,
        confirm: "Да, отменить",
        cancel: "Не отменять",
        danger: true,
        run: (text) => run(setTaskStatus(qc, task, "cancel", text)),
      });
      return;
    }
    if (action === "complete") {
      void complete();
      return;
    }
    quiet(setTaskStatus(qc, task, action));
  };

  const editResult = () =>
    setAsk({
      title: task.result ? "Изменить результат" : "Результат задачи",
      description: "Что сделано: итог, ссылки, цифры. Постановщик увидит его в карточке.",
      label: "Результат",
      required: false,
      confirm: "Сохранить",
      initial: task.result?.text ?? "",
      rows: 6,
      run: (text) => run(setTaskResult(qc, task, text)),
    });

  // «Завершить»: открытые подзадачи — спросить; нужен отчёт — сначала отчёт.
  const complete = async () => {
    const open = task.subtasks.filter((s) => !isClosed(s.status));
    if (
      open.length > 0 &&
      !(await confirm({
        title: "Завершить задачу?",
        description: `Не завершены ${open.length} ${plural(open.length, "подзадача", "подзадачи", "подзадач")}: ${open
          .slice(0, 3)
          .map((s) => `#${s.number}`)
          .join(", ")}${open.length > 3 ? "…" : ""}. Они останутся в работе.`,
        confirmLabel: "Завершить",
        destructive: false,
      }))
    )
      return;
    if (task.result_required && !task.result) {
      setAsk({
        title: "Результат задачи",
        description: "Постановщик просит отчёт: без него задачу не завершить.",
        label: "Что сделано",
        required: true,
        confirm: task.requires_review && !perms.boss ? "На проверку" : "Завершить",
        rows: 6,
        run: async (text) => {
          await run(setTaskResult(qc, task, text));
          await run(setTaskStatus(qc, task, "complete"));
        },
      });
      return;
    }
    quiet(setTaskStatus(qc, task, "complete"));
  };

  const changeDeadline = (iso: string | null) => {
    if (perms.deadline === "reason") {
      setAsk({
        title: "Перенести срок",
        description: `Новый срок — ${formatMoment(iso, tz)}. Постановщик увидит причину в истории и в уведомлении.`,
        label: "Причина переноса",
        required: true,
        confirm: "Перенести",
        run: (text) => run(updateTask(qc, task, { deadline: iso }, text)),
      });
      return;
    }
    quiet(updateTask(qc, task, { deadline: iso }));
  };

  const saveTitle = () => {
    const v = (editTitle ?? "").trim();
    setEditTitle(null);
    if (v && v !== task.title) quiet(updateTask(qc, task, { title: v }), "Название сохранено");
  };

  const save = async (doc: unknown[]): Promise<AutosaveResult> => {
    try {
      await updateTask(qc, task, { description: doc });
      return "ok";
    } catch {
      return "error";
    }
  };
  const { state: saveState, schedule, setBaseline } = useAutosave(save, 1500);

  const copyLink = () =>
    void navigator.clipboard
      .writeText(`${window.location.origin}/tasks/${task.number}`)
      .then(() => toast.success("Ссылка скопирована"));

  const menu: TaskMenuEntry[] = [
    { label: "Скопировать ссылку", icon: Link2, run: copyLink },
    ...(perms.edit
      ? [
          { label: "Сохранить как шаблон", icon: CopyCheck, run: () => setAsTemplate(true) },
          ...(!task.recurrence_id
            ? [{ label: "Сделать регулярной", icon: Repeat, run: () => setAsRecurring(true) }]
            : []),
          ...(!task.parent_id
            ? [{ label: "Сделать подзадачей…", icon: CornerLeftUp, run: () => setAsParent(true) }]
            : []),
        ]
      : []),
    ...(perms.actions.some((a) => a.action === "cancel")
      ? [
          "separator" as const,
          {
            label: "Отменить задачу",
            icon: XCircle,
            danger: true,
            hint: "Не удаляется — останется в истории",
            run: () => status("cancel"),
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* ---- Основное ---- */}
      <div className="min-w-0 space-y-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium tabular-nums">#{task.number}</span>
            {task.urgent && <UrgentMark />}
            {task.recurrence_id && (
              <span className="inline-flex items-center gap-1" title="Регулярная задача">
                <Repeat className="size-3.5" /> регулярная
              </span>
            )}
            <TaskMenu label="Действия с задачей" items={menu} className="ml-auto" />
          </div>
          {editTitle !== null ? (
            <div className="space-y-1">
              <Input
                autoFocus
                value={editTitle}
                maxLength={300}
                aria-label="Название задачи"
                className="text-lg font-semibold"
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditTitle(null);
                }}
              />
              <p className="text-xs text-muted-foreground">Enter — сохранить, Esc — отмена</p>
            </div>
          ) : (
            <h2 className="flex items-start gap-2 text-xl font-semibold break-words">
              <span className="min-w-0">{task.title}</span>
              {perms.edit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Изменить название"
                  title="Изменить название"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => setEditTitle(task.title)}
                >
                  <Pencil />
                </Button>
              )}
            </h2>
          )}
          <TaskOrigin task={task} canEdit={perms.edit} onOpenTask={onOpenTask} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <StatusControl task={task} perms={perms} onAction={status} />
            <span className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">Срок</span>
              <DeadlineText task={task} tz={tz} />
              {late && <span className="sr-only">(просрочена)</span>}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground">Исполнитель</span>
              <PersonLine id={assignee} size="xs" />
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="text-muted-foreground">Постановщик</span>
              <PersonLine id={creator} size="xs" />
            </span>
          </div>
        </header>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">Описание</h3>
            {perms.edit && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setEditDesc((v) => !v)}
              >
                {editDesc ? (
                  <>Готово{saveState === "saving" || saveState === "pending" ? "…" : ""}</>
                ) : (
                  <>
                    <Pencil className="size-4" /> Изменить
                  </>
                )}
              </Button>
            )}
          </div>
          {editDesc || (task.description && task.description.length > 0) ? (
            <div
              className={cn(
                "rounded-lg border bg-background py-3",
                editDesc && "ring-2 ring-chat-accent/30",
              )}
            >
              <Suspense
                fallback={
                  <div className="flex h-16 items-center px-6 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                }
              >
                <KbDocument
                  key={editDesc ? "edit" : "view"}
                  nodeId={task.id}
                  filesFolder={`tasks/${task.id}`}
                  initial={task.description}
                  editable={editDesc}
                  onReady={setBaseline}
                  onChange={editDesc ? schedule : undefined}
                />
              </Suspense>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Без описания</p>
          )}
        </section>

        <TaskResult
          task={task}
          tz={tz}
          canWrite={perms.worker}
          doer={task.my_roles.includes("assignee") || task.my_roles.includes("coassignee")}
          onEdit={editResult}
        />
        <TaskChecklists task={task} canWork={perms.work} me={me} />
        <TaskFiles task={task} canWork={perms.work} canRemoveAll={perms.boss} me={me} />
        <TaskSubtasks task={task} tz={tz} canAdd={perms.work} onOpenTask={onOpenTask} />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="discussion">Обсуждение</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
          </TabsList>
          <TabsContent value="discussion" className="pt-3">
            <TaskDiscussion task={task} me={me} isMember={perms.member} />
          </TabsContent>
          <TabsContent value="history" className="pt-3">
            <TaskHistory task={task} tz={tz} />
          </TabsContent>
        </Tabs>
      </div>

      {/* ---- Сбоку ---- */}
      <aside className="space-y-6 lg:border-l lg:pl-6">
        <AsideGroup title="Люди">
          <FormField label="Постановщик" htmlFor={null}>
            <PersonLine id={creator} />
          </FormField>
          <FormField label="Исполнитель" htmlFor={null}>
            <div className="flex flex-wrap items-center gap-2">
              {perms.boss ? (
                <PeopleField
                  single
                  value={assignee ? [assignee] : []}
                  onChange={(ids) => ids[0] && setMembers({ assignee: ids[0] })}
                />
              ) : (
                <>
                  <PersonLine id={assignee} />
                  {perms.delegate && <DelegateButton task={task} />}
                </>
              )}
            </div>
          </FormField>
          {!isClosed(task.status) && (
            <AbsentNote ids={[...(assignee ? [assignee] : []), ...co]} until={task.deadline} />
          )}
          <FormField label="Соисполнители" htmlFor={null}>
            {perms.boss ? (
              <PeopleField
                value={co}
                onChange={(ids) => setMembers({ co: ids })}
                exclude={assignee ? [assignee] : []}
              />
            ) : (
              <PeopleList ids={co} />
            )}
          </FormField>
          <FormField label="Наблюдатели" htmlFor={null}>
            {perms.boss ? (
              <PeopleField
                value={watchers}
                onChange={(ids) => setMembers({ watchers: ids })}
                exclude={[...(assignee ? [assignee] : []), ...co]}
              />
            ) : (
              <PeopleList ids={watchers} />
            )}
          </FormField>
          <WatchButton task={task} me={me} />
        </AsideGroup>

        <AsideGroup title="Параметры">
          <FormField label="Срок" htmlFor="task-card-deadline">
            <DeadlinePicker
              id="task-card-deadline"
              value={task.deadline}
              onChange={changeDeadline}
              tz={tz}
              workdayEnd={workdayEnd}
              calendar={calendar}
              allowClear={perms.boss}
              disabled={!perms.deadline}
              disabledHint={deadlineLockHint(task)}
              className={cn(late && "border-destructive text-destructive")}
            />
          </FormField>
          <FormField label="Проект" htmlFor={null}>
            {perms.edit ? (
              <Select
                value={task.project_id ?? NONE}
                onValueChange={(v) =>
                  quiet(updateTask(qc, task, { project_id: v === NONE ? null : v }))
                }
              >
                <SelectTrigger aria-label="Проект">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Без проекта</SelectItem>
                  {task.project && !projects.some((p) => p.id === task.project_id) && (
                    <SelectItem value={task.project.id}>{task.project.title}</SelectItem>
                  )}
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : task.project ? (
              <Link
                to="/tasks/projects/$projectId"
                params={{ projectId: task.project.id }}
                className="text-sm hover:underline"
              >
                <ProjectTag project={task.project} />
              </Link>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </FormField>
          {task.project_id && <StageField task={task} canMove={perms.worker} />}
          <FormField label="Теги" htmlFor={null}>
            <TaskTagsField
              value={task.tags.map((t) => t.id)}
              disabled={!perms.worker}
              onChange={(ids) => quiet(setTaskTags(qc, task, ids))}
            />
          </FormField>
          {perms.edit && (
            <SwitchRow
              title="Срочно"
              checked={task.urgent}
              onCheckedChange={(v) => quiet(updateTask(qc, task, { urgent: v }))}
            />
          )}
        </AsideGroup>

        <Collapsible defaultOpen={task.requires_review || task.result_required}>
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground uppercase hover:text-foreground">
            Ещё
            <span className="h-px flex-1 bg-border" />
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-3">
            {perms.edit ? (
              <>
                <SwitchRow
                  title="Принять работу после завершения"
                  tip={TIPS.review}
                  checked={task.requires_review}
                  onCheckedChange={(v) => quiet(updateTask(qc, task, { requires_review: v }))}
                />
                <SwitchRow
                  title="Требовать отчёт о результате"
                  tip={TIPS.result}
                  checked={task.result_required}
                  onCheckedChange={(v) => quiet(updateTask(qc, task, { result_required: v }))}
                />
              </>
            ) : (
              <>
                {task.requires_review && (
                  <InfoNote>Постановщик примет работу после завершения или вернёт её.</InfoNote>
                )}
                {task.result_required && (
                  <InfoNote>
                    Постановщик просит отчёт о результате — без него не завершить.
                  </InfoNote>
                )}
              </>
            )}
            <Reminders task={task} tz={tz} />
            {perms.member && (
              <FormField label="Уведомления по задаче" tip={TIPS.notify} htmlFor={null}>
                <SegmentedControl
                  aria-label="Уведомления по задаче"
                  fullWidth
                  value={task.notify}
                  onChange={(v) =>
                    quiet(taskAction(qc, "task_set_notify", { p_task: task.id, p_level: v }))
                  }
                  options={NOTIFY_OPTIONS}
                />
              </FormField>
            )}
            {perms.edit && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setAsTemplate(true)}>
                  <CopyCheck className="size-4" /> Сохранить как шаблон
                </Button>
                {!task.recurrence_id && (
                  <Button variant="outline" size="sm" onClick={() => setAsRecurring(true)}>
                    <Repeat className="size-4" /> Сделать регулярной
                  </Button>
                )}
                {!task.parent_id && (
                  <Button variant="outline" size="sm" onClick={() => setAsParent(true)}>
                    <CornerLeftUp className="size-4" /> Сделать подзадачей
                  </Button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {task.recurrence_id ? (
                <>
                  <Link to="/tasks/recurring" className="underline">
                    Регулярная задача
                  </Link>
                  {" · "}
                </>
              ) : null}
              Поставлена {formatMoment(task.created_at, tz)}
              {task.completed_at ? ` · закрыта ${formatMoment(task.completed_at, tz)}` : ""}
            </p>
          </CollapsibleContent>
        </Collapsible>

        {onClose && (
          <Button variant="outline" className="w-full lg:hidden" onClick={onClose}>
            Закрыть
          </Button>
        )}
      </aside>

      <AskTextDialog ask={ask} onClose={() => setAsk(null)} />
      <ParentDialog open={asParent} task={task} onClose={() => setAsParent(false)} />
      <MakeRecurringDialog open={asRecurring} task={task} onClose={() => setAsRecurring(false)} />
      {confirmDialog}
      <TemplateDialog
        template={
          asTemplate
            ? {
                name: task.title,
                scope: "personal",
                task: {
                  title: task.title,
                  description: task.description,
                  assignees: assignee ? [assignee] : [],
                  coassignees: co,
                  watchers,
                  checklists: task.checklists.map((l) => ({
                    title: l.title,
                    items: l.items.map((i) => ({ text: i.text, assignee_id: i.assignee_id })),
                  })),
                  urgent: task.urgent,
                  requires_review: task.requires_review,
                  result_required: task.result_required,
                  deadline_days: null,
                },
              }
            : null
        }
        onClose={() => setAsTemplate(false)}
      />
    </div>
  );
}

function AsideGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
        {title}
        <span className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

function PeopleList({ ids }: { ids: string[] }) {
  if (!ids.length) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-1.5">
      {ids.map((id) => (
        <PersonLine key={id} id={id} />
      ))}
    </div>
  );
}

/**
 * Статус: одна главная кнопка (завершить, на проверку, принять, начать,
 * возобновить) и «Статус ▾» — остальные переходы.
 */
function StatusControl({
  task,
  perms,
  onAction,
}: {
  task: TaskFull;
  perms: TaskPerms;
  onAction: (a: StatusAction) => void;
}) {
  const main = perms.actions.find((a) => a.primary) ?? perms.actions.find((a) => !a.danger) ?? null;
  const rest = perms.actions.filter((a) => a !== main);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {rest.length > 0 ? (
        <TaskMenu
          label="Сменить статус"
          items={[
            { heading: "Сменить статус" },
            ...rest.map((a) => ({
              label: a.label,
              danger: a.danger,
              hint: a.action === "cancel" ? "Не удаляется — останется в истории" : undefined,
              run: () => onAction(a.action),
            })),
          ]}
          trigger={
            <button
              type="button"
              aria-label={`Статус: ${STATUS_LABEL[task.status]}. Сменить`}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <TaskStatusChip status={task.status} />
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
      ) : (
        <TaskStatusChip status={task.status} />
      )}
      {main && (
        <Button size="sm" onClick={() => onAction(main.action)}>
          {main.label}
        </Button>
      )}
    </span>
  );
}

function StageField({ task, canMove }: { task: TaskFull; canMove: boolean }) {
  const qc = useQueryClient();
  const member = task.my_roles.includes("project") || task.my_roles.includes("manager");
  const { data: project } = useQuery({ ...projectQuery(task.project_id ?? ""), enabled: member });
  if (!project) return null;
  const stage = project.stages.find((s) => s.id === task.stage_id) ?? project.stages[0];
  return (
    <FormField label="Стадия проекта" tip={TIPS.stage} htmlFor={null}>
      {canMove || project.can_manage ? (
        <Select
          value={stage?.id}
          onValueChange={(v) =>
            void taskAction(qc, "task_set_stage", { p_task: task.id, p_stage: v }).catch((e) =>
              toast.error(taskErrorText(e)),
            )
          }
        >
          <SelectTrigger aria-label="Стадия проекта">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {project.stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-sm">{stage?.title ?? "—"}</span>
      )}
    </FormField>
  );
}

function DelegateButton({ task }: { task: TaskFull }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowLeftRight className="size-4" /> Передать
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] space-y-2 p-3">
        <p className="text-sm text-muted-foreground">
          Новый исполнитель получит задачу, вы останетесь наблюдателем.
        </p>
        <PeoplePicker
          single
          selected={[]}
          exclude={[assigneeOf(task) ?? ""]}
          onToggle={(uid) => {
            setOpen(false);
            void taskAction(qc, "task_delegate", { p_task: task.id, p_user: uid, p_reason: null })
              .then(() => toast.success("Задача передана"))
              .catch((e) => toast.error(taskErrorText(e)));
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function WatchButton({ task, me }: { task: TaskFull; me: string }) {
  const qc = useQueryClient();
  const watching = task.members.some((m) => m.user_id === me && m.role === "watcher");
  const other = task.members.some((m) => m.user_id === me && m.role !== "watcher");
  if (other) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        void taskAction(qc, "task_watch", { p_task: task.id, p_on: !watching })
          .then(() => toast.success(watching ? "Вы больше не наблюдаете" : "Вы наблюдатель задачи"))
          .catch((e) => toast.error(taskErrorText(e)))
      }
    >
      {watching ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      {watching ? "Перестать наблюдать" : "Наблюдать"}
    </Button>
  );
}

function Reminders({ task, tz }: { task: TaskFull; tz: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const options = REMINDER_OPTIONS.filter((o) => o.value !== "none");
  const add = (v: string) => {
    setOpen(false);
    void taskAction(qc, "task_reminder_set", {
      p_task: task.id,
      p_remind_at: v === "0" ? task.deadline : null,
      p_before_minutes: v === "0" ? null : Number(v),
    })
      .then(() => toast.success("Напоминание добавлено"))
      .catch((e) => toast.error(taskErrorText(e)));
  };
  return (
    <FormField label="Напомнить мне" htmlFor={null}>
      <div className="space-y-1.5">
        {task.reminders.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-sm">
            <Bell
              className={cn(
                "size-4 shrink-0",
                r.sent_at ? "text-muted-foreground" : "text-chat-accent",
              )}
            />
            <span
              className={cn("min-w-0 flex-1", r.sent_at && "text-muted-foreground line-through")}
            >
              {formatMoment(r.remind_at, tz)}
              {r.before_minutes
                ? ` · ${REMINDER_OPTIONS.find((o) => o.value === String(r.before_minutes))?.label.toLowerCase() ?? ""}`
                : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Удалить напоминание"
              title="Удалить напоминание"
              className="text-muted-foreground hover:text-destructive"
              onClick={() =>
                void taskAction(qc, "task_reminder_delete", { p_id: r.id }).catch((e) =>
                  toast.error(taskErrorText(e)),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={!task.deadline}>
              <Plus className="size-4" /> Напомнить
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 p-1">
            {options.map((o) => (
              <ListItemButton key={o.value} onClick={() => add(o.value)}>
                {o.label}
              </ListItemButton>
            ))}
          </PopoverContent>
        </Popover>
        {!task.deadline && (
          <p className="text-xs text-muted-foreground">
            Напоминание — относительно срока: сначала поставьте срок
          </p>
        )}
      </div>
    </FormField>
  );
}

/** «Сделать подзадачей»: родительская — поиском по названию или номеру. */
function ParentDialog({
  open,
  task,
  onClose,
}: {
  open: boolean;
  task: TaskFull;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg">
        {open && <ParentPicker task={task} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ParentPicker({ task, onClose }: { task: TaskFull; onClose: () => void }) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 300);
  const { data, isPending } = useTaskList({ role: "all", q: query || undefined });
  const exclude = new Set([task.id, ...task.subtasks.map((s) => s.id)]);
  const rows = (data?.rows ?? []).filter((t) => !exclude.has(t.id));
  return (
    <>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Сделать подзадачей</DialogTitle>
        <DialogDescription>Найдите задачу, частью которой будет эта.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <SearchInput
          autoFocus
          value={q}
          onChange={setQ}
          placeholder="Название или номер"
          aria-label="Поиск задачи"
        />
        {isPending ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ничего не найдено</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.slice(0, 50).map((t) => (
              <li key={t.id}>
                <ListItemButton
                  className="rounded-none px-3 py-2"
                  onClick={() =>
                    void updateTask(qc, task, { parent_id: t.id })
                      .then(() => {
                        toast.success(`Теперь это подзадача #${t.number}`);
                        onClose();
                      })
                      .catch((e) => toast.error(taskErrorText(e)))
                  }
                >
                  <span className="shrink-0 text-muted-foreground tabular-nums">#{t.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.title}</span>
                    <DeadlineText task={t} tz={tz} className="text-xs" />
                  </span>
                  <TaskStatusChip status={t.status} />
                </ListItemButton>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
      </DialogFooter>
    </>
  );
}

/** «Сделать регулярной»: расписание; поля следующих — из этой задачи. */
function MakeRecurringDialog({
  open,
  task,
  onClose,
}: {
  open: boolean;
  task: TaskFull;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-lg">
        {open && <MakeRecurringForm task={task} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function MakeRecurringForm({ task, onClose }: { task: TaskFull; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => ruleDraft(null));
  const [time, setTime] = useState("09:00");
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        const rule = buildRule(draft);
        if (!rule) {
          setError(draft.freq === "weekly" ? "Отметьте хотя бы один день" : "Проверьте расписание");
          return;
        }
        setBusy(true);
        try {
          await makeRecurring(qc, task.id, {
            rule,
            at_time: time,
            mode: skip ? "skip" : "wait",
          });
          toast.success("Задача стала регулярной — расписание в «Регулярных»");
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Сделать регулярной</DialogTitle>
        <DialogDescription>
          Эта задача — первая. Следующие появятся по расписанию с теми же людьми, описанием и
          чек-листами.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <RecurrenceFields
          draft={draft}
          onDraft={(d) => {
            setDraft(d);
            setError(null);
          }}
          time={time}
          onTime={setTime}
          skip={skip}
          onSkip={setSkip}
          error={error}
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Сохранить расписание
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

function AskTextDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {ask && <AskTextForm key={ask.title} ask={ask} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function AskTextForm({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [text, setText] = useState(ask.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (ask.required && !text.trim()) {
          setError("Напишите пару слов");
          return;
        }
        setBusy(true);
        try {
          await ask.run(text.trim());
          onClose();
        } catch {
          // тост уже показан
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{ask.title}</DialogTitle>
        <DialogDescription>{ask.description}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormField label={ask.label} required={ask.required} optional={!ask.required} error={error}>
          <Textarea
            autoFocus
            rows={ask.rows ?? 3}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {ask.cancel ?? "Отмена"}
        </Button>
        <Button type="submit" variant={ask.danger ? "destructive" : "default"} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {ask.confirm}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
