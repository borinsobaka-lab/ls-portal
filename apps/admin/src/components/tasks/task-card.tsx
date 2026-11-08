/**
 * Карточка задачи (план, 3.4): слева — название, описание (редактор базы
 * знаний: картинки, файлы, оформление), чек-листы, файлы, «Обсуждение» и
 * «История»; справа — статус и действия, срок, люди, «Требует проверки»,
 * напоминания, уведомления; этап 2 — подзадачи, результат, «Подзадача к» и
 * «Из сообщения в чате». Открывается панелью поверх списка (`?task=`) и
 * своей страницей `/tasks/1234`. Что можно — taskPerms (lib/tasks/logic.ts),
 * последнее слово — у базы.
 */
import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Bell,
  Copy,
  CopyCheck,
  CornerLeftUp,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DeadlinePicker } from "@/components/tasks/deadline-picker";
import { TaskChecklists } from "@/components/tasks/task-checklists";
import { TaskDiscussion, TaskHistory } from "@/components/tasks/task-discussion";
import { TaskFiles } from "@/components/tasks/task-files";
import { TaskOrigin, TaskResult, TaskSubtasks } from "@/components/tasks/task-subtasks";
import { useConfirm } from "@/components/confirm-dialog";
import { TemplateDialog } from "@/components/tasks/templates-page";
import {
  AbsentNote,
  PeopleField,
  PersonLine,
  ProjectTag,
  TaskStatusChip,
  UrgentMark,
} from "@/components/tasks/task-bits";
import { PeoplePicker } from "@/components/chats/dialogs";
import { useAutosave, type AutosaveResult } from "@/components/kb/use-autosave";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { formatDateTime } from "@/lib/format";
import {
  projectQuery,
  setTaskResult,
  setTaskStatus,
  taskAction,
  taskRpc,
  taskErrorText,
  updateTask,
  useMyProjects,
  useTaskCard,
  useTaskClock,
  useWorkCalendar,
} from "@/lib/tasks/data";
import {
  assigneeOf,
  creatorOf,
  formatMoment,
  isOverdue,
  memberIds,
  plural,
  REMINDER_OPTIONS,
  taskPerms,
  type StatusAction,
} from "@/lib/tasks/logic";
import type { TaskFull } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const NONE = "none";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

const TIPS = {
  review: "Исполнитель не завершит сам — отправит на проверку, постановщик примет или вернёт.",
  result: "Исполнитель не завершит задачу, пока не напишет результат: что сделано, ссылка, цифры.",
  notify:
    "«Только моё» — когда от вас нужно действие (поставили, на проверке, вернули, срок). Своё напоминание приходит всегда.",
};

type Ask = {
  title: string;
  description: string;
  label: string;
  required: boolean;
  confirm: string;
  /** Текст в поле сразу (правка результата). */
  initial?: string;
  rows?: number;
  run: (text: string) => Promise<void>;
};

export function TaskCard({ number, onClose }: { number: number; onClose?: () => void }) {
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
  return <TaskCardBody key={task.id} task={task} onClose={onClose} />;
}

function TaskCardBody({ task, onClose }: { task: TaskFull; onClose?: () => void }) {
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
        description:
          "Она уйдёт в завершённые со статусом «Отменена». Вернуть можно кнопкой «Возобновить».",
        label: "Причина",
        required: false,
        confirm: "Отменить задачу",
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

  // «Завершить»: открытые подзадачи — спросить; «Нужен результат» — сначала результат.
  const complete = async () => {
    const open = task.subtasks.filter((s) => s.status !== "done" && s.status !== "cancelled");
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
        description: "Постановщик просит результат: без него задачу не завершить.",
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

  const attachParent = () =>
    setAsk({
      title: "Сделать подзадачей",
      description: "Номер задачи, к которой относится эта, — например 1234.",
      label: "Номер родительской задачи",
      required: true,
      confirm: "Привязать",
      rows: 1,
      run: async (text) => {
        const n = Number(text.replace(/\D/g, ""));
        if (!n) {
          toast.error("Нужен номер задачи");
          throw new Error("bad number");
        }
        await run(
          (async () => {
            const parent = await taskRpc<{ id: string }>("task_get", { p_number: n });
            await updateTask(qc, task, { parent_id: parent.id });
          })(),
          `Теперь это подзадача #${n}`,
        );
      },
    });

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

  const save = async (doc: unknown[]): Promise<AutosaveResult> => {
    try {
      await updateTask(qc, task, { description: doc });
      return "ok";
    } catch {
      return "error";
    }
  };
  const { state: saveState, schedule, setBaseline } = useAutosave(save, 1500);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* ---- Основное ---- */}
      <div className="min-w-0 space-y-6">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium hover:text-foreground"
              title="Скопировать ссылку на задачу"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${window.location.origin}/tasks/${task.number}`)
                  .then(() => toast.success("Ссылка скопирована"))
              }
            >
              #{task.number} <Copy className="size-3.5" />
            </button>
            <TaskStatusChip status={task.status} />
            {task.urgent && <UrgentMark />}
            {late && <span className="font-medium text-destructive">Просрочена</span>}
          </div>
          {editTitle !== null ? (
            <Input
              autoFocus
              value={editTitle}
              maxLength={300}
              className="text-lg font-semibold"
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => {
                const v = editTitle.trim();
                setEditTitle(null);
                if (v && v !== task.title) quiet(updateTask(qc, task, { title: v }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditTitle(null);
              }}
            />
          ) : (
            <h2 className="group flex items-start gap-2 text-xl font-semibold break-words">
              <span className="min-w-0">{task.title}</span>
              {perms.edit && (
                <button
                  type="button"
                  aria-label="Изменить название"
                  className="mt-1 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
                  onClick={() => setEditTitle(task.title)}
                >
                  <Pencil className="size-4" />
                </button>
              )}
            </h2>
          )}
          <TaskOrigin task={task} canEdit={perms.edit} />
          {perms.actions.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 lg:hidden">
              <StatusButtons perms={perms} onAction={status} />
            </div>
          )}
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
          canWrite={perms.worker}
          doer={task.my_roles.includes("assignee") || task.my_roles.includes("coassignee")}
          onEdit={editResult}
        />
        <TaskChecklists task={task} canWork={perms.work} me={me} />
        <TaskFiles task={task} canWork={perms.work} canRemoveAll={perms.boss} me={me} />
        <TaskSubtasks task={task} tz={tz} />

        <Tabs defaultValue="discussion">
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
      <aside className="space-y-5 lg:border-l lg:pl-6">
        {perms.actions.length > 0 && (
          <div className="hidden flex-wrap gap-2 lg:flex">
            <StatusButtons perms={perms} onAction={status} />
          </div>
        )}
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
        {task.status !== "done" && task.status !== "cancelled" && (
          <AbsentNote ids={[...(assignee ? [assignee] : []), ...co]} until={task.deadline} />
        )}
        <FormField label="Соисполнители" htmlFor={null}>
          {perms.boss ? (
            <PeopleField
              value={co}
              onChange={(ids) => setMembers({ co: ids })}
              exclude={assignee ? [assignee] : []}
            />
          ) : co.length ? (
            <div className="flex flex-col gap-1.5">
              {co.map((id) => (
                <PersonLine key={id} id={id} />
              ))}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </FormField>
        <FormField label="Наблюдатели" htmlFor={null}>
          {perms.boss ? (
            <PeopleField
              value={watchers}
              onChange={(ids) => setMembers({ watchers: ids })}
              exclude={[...(assignee ? [assignee] : []), ...co]}
            />
          ) : watchers.length ? (
            <div className="flex flex-col gap-1.5">
              {watchers.map((id) => (
                <PersonLine key={id} id={id} />
              ))}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </FormField>
        <WatchButton task={task} me={me} />
        {perms.edit && (
          <div className="space-y-3">
            <SwitchRow
              title="Требует проверки"
              tip={TIPS.review}
              checked={task.requires_review}
              onCheckedChange={(v) => quiet(updateTask(qc, task, { requires_review: v }))}
            />
            <SwitchRow
              title="Нужен результат"
              tip={TIPS.result}
              checked={task.result_required}
              onCheckedChange={(v) => quiet(updateTask(qc, task, { result_required: v }))}
            />
            <SwitchRow
              title="Срочно"
              checked={task.urgent}
              onCheckedChange={(v) => quiet(updateTask(qc, task, { urgent: v }))}
            />
          </div>
        )}
        {!perms.edit && task.requires_review && (
          <InfoNote>Требует проверки: постановщик примет работу или вернёт.</InfoNote>
        )}
        <Reminders task={task} tz={tz} />
        {perms.member && (
          <FormField label="Уведомления по задаче" tip={TIPS.notify}>
            <Select
              value={task.notify}
              onValueChange={(v) =>
                quiet(taskAction(qc, "task_set_notify", { p_task: task.id, p_level: v }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все</SelectItem>
                <SelectItem value="mine">Только когда нужно моё действие</SelectItem>
                <SelectItem value="none">Ничего</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        )}
        {perms.edit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setAsTemplate(true)}>
              <CopyCheck className="size-4" /> Сохранить как шаблон
            </Button>
            {!task.parent_id && (
              <Button variant="outline" size="sm" onClick={attachParent}>
                <CornerLeftUp className="size-4" /> Сделать подзадачей
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {task.recurrence_id ? "Регулярная задача · " : ""}Поставлена{" "}
          {formatDateTime(task.created_at)}
          {task.completed_at ? ` · закрыта ${formatDateTime(task.completed_at)}` : ""}
        </p>
        {onClose && (
          <Button variant="outline" className="w-full lg:hidden" onClick={onClose}>
            Закрыть
          </Button>
        )}
      </aside>

      <AskTextDialog ask={ask} onClose={() => setAsk(null)} />
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

function StageField({ task, canMove }: { task: TaskFull; canMove: boolean }) {
  const qc = useQueryClient();
  const member = task.my_roles.includes("project") || task.my_roles.includes("manager");
  const { data: project } = useQuery({ ...projectQuery(task.project_id ?? ""), enabled: member });
  if (!project) return null;
  const stage = project.stages.find((s) => s.id === task.stage_id) ?? project.stages[0];
  return (
    <FormField label="Стадия проекта" htmlFor={null}>
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

function StatusButtons({
  perms,
  onAction,
}: {
  perms: ReturnType<typeof taskPerms>;
  onAction: (a: StatusAction) => void;
}) {
  return (
    <>
      {perms.actions.map((a) => (
        <Button
          key={a.action}
          size="sm"
          variant={a.primary ? "default" : a.danger ? "ghost" : "outline"}
          className={cn(a.danger && "text-destructive hover:text-destructive")}
          onClick={() => onAction(a.action)}
        >
          {a.label}
        </Button>
      ))}
    </>
  );
}

function DelegateButton({ task }: { task: TaskFull }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
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
        void taskAction(qc, "task_watch", { p_task: task.id, p_on: !watching }).catch((e) =>
          toast.error(taskErrorText(e)),
        )
      }
    >
      {watching ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      {watching ? "Перестать наблюдать" : "Наблюдать"}
    </Button>
  );
}

function Reminders({ task, tz }: { task: TaskFull; tz: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const options = REMINDER_OPTIONS.filter((o) => o.value !== "none");
  const add = (v: string) => {
    setValue("");
    if (!task.deadline) {
      toast.info("Напоминание по сроку — сначала поставьте срок");
      return;
    }
    void taskAction(qc, "task_reminder_set", {
      p_task: task.id,
      p_remind_at: v === "0" ? task.deadline : null,
      p_before_minutes: v === "0" ? null : Number(v),
    }).catch((e) => toast.error(taskErrorText(e)));
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
            <button
              type="button"
              aria-label="Удалить напоминание"
              className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              onClick={() =>
                void taskAction(qc, "task_reminder_delete", { p_id: r.id }).catch((e) =>
                  toast.error(taskErrorText(e)),
                )
              }
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <Select value={value} onValueChange={add}>
          <SelectTrigger aria-label="Добавить напоминание">
            <SelectValue placeholder="+ Добавить напоминание" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </FormField>
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
        <Button variant="outline" onClick={onClose}>
          <X className="size-4" /> Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {ask.confirm}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
