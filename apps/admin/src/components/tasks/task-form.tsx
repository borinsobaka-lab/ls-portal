/**
 * «Новая задача» (TASKS_CHATS_PLAN.md, 4.1, 4.3): сверху — название,
 * исполнители, срок; «Ещё» — соисполнители, наблюдатели, описание,
 * чек-лист, файлы, срочность, «Требует проверки», напоминание. Несколько
 * исполнителей — «Одна общая задача» (первый — исполнитель, остальные —
 * соисполнители с пунктом чек-листа на каждого) или «Отдельная задача
 * каждому». «Всегда открывать полностью» — память браузера.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Paperclip, Plus, RotateCw, WifiOff, X } from "lucide-react";
import { toast } from "sonner";

import { DeadlinePicker } from "@/components/tasks/deadline-picker";
import { PeopleField } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import {
  formatFileSize,
  startResumableUpload,
  type ResumableUpload,
  type UploadedFile,
} from "@/lib/resumable-upload";
import {
  createTask,
  TASK_BUCKET,
  taskErrorText,
  useTaskClock,
  useWorkCalendar,
} from "@/lib/tasks/data";
import { plural, REMINDER_OPTIONS } from "@/lib/tasks/logic";
import { cn } from "@/lib/utils";

const FULL_KEY = "tasks_form_full";

const TIPS = {
  assignees:
    "Исполнитель отвечает за результат. Несколько человек — выберите: одна общая задача или отдельная каждому.",
  coassignees: "Помогают исполнителю: видят задачу, ведут чек-листы и файлы, но не завершают.",
  watchers: "Только следят: видят задачу и обсуждение, уведомления — по своей настройке.",
  review: "Исполнитель не завершит задачу сам — отправит на проверку, вы примете или вернёте.",
};

/** Текст описания → документ редактора базы знаний (абзацы). */
function textToDoc(text: string): unknown[] | null {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!text.trim()) return null;
  return lines.map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line, styles: {} }] : [],
  }));
}

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
}: {
  open: boolean;
  onClose: () => void;
  initialAssignee?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        {open && <TaskForm onClose={onClose} initialAssignee={initialAssignee} />}
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({ onClose, initialAssignee }: { onClose: () => void; initialAssignee?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: profile } = useStaffProfile();
  const me = profile?.id ?? "";
  const { tz, workdayEnd } = useTaskClock();
  const calendar = useWorkCalendar(tz);
  const [alwaysFull, setAlwaysFull] = useState(() => {
    try {
      return window.localStorage.getItem(FULL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [full, setFull] = useState(alwaysFull);
  const [title, setTitle] = useState("");
  const [assignees, setAssignees] = useState<string[]>(initialAssignee ? [initialAssignee] : []);
  const [mode, setMode] = useState<"shared" | "separate">("shared");
  const [deadline, setDeadline] = useState<string | null>(null);
  const [coassignees, setCoassignees] = useState<string[]>([]);
  const [watchers, setWatchers] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [review, setReview] = useState(false);
  const [reminder, setReminder] = useState("none");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const handles = useRef(new Map<string, ResumableUpload>());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const map = handles.current;
    return () => map.forEach((h) => h.cancel(false));
  }, []);

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

  const removeUpload = (key: string) => {
    handles.current.get(key)?.cancel();
    handles.current.delete(key);
    setUploads((u) => u.filter((x) => x.key !== key));
  };

  const submit = async () => {
    if (!title.trim()) {
      setTitleError("Напишите, что сделать");
      return;
    }
    if (uploads.some((u) => !u.done)) {
      toast.info("Дождитесь загрузки файлов или уберите их");
      setFull(true);
      return;
    }
    if (reminder !== "none" && reminder !== "0" && !deadline) {
      toast.info("Напоминание «за … до срока» — сначала поставьте срок");
      return;
    }
    setSaving(true);
    try {
      const r = await createTask(qc, {
        title: title.trim(),
        assignees,
        mode: assignees.length > 1 ? mode : "shared",
        deadline,
        coassignees,
        watchers,
        description: textToDoc(description),
        checklists: items.some((i) => i.trim())
          ? [{ title: "Чек-лист", items: items.filter((i) => i.trim()).map((text) => ({ text })) }]
          : [],
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
      onClose();
      if (r.tasks.length === 1) {
        toast.success(`Задача #${r.tasks[0].number} поставлена`);
        void navigate({
          to: "/tasks",
          search: (s: Record<string, unknown>) => ({ ...s, task: r.tasks[0].number }),
        });
      } else {
        toast.success(
          `Поставлено ${r.tasks.length} ${plural(r.tasks.length, "задача", "задачи", "задач")}`,
        );
        void navigate({ to: "/tasks", search: { role: "assigned" } });
      }
    } catch (e) {
      toast.error(taskErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={() => void submit()}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Новая задача</DialogTitle>
        <DialogDescription>
          Постановщик — вы: примете работу и увидите задачу в «Поручил».
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Что сделать" required error={titleError}>
          <Input
            autoFocus
            value={title}
            maxLength={300}
            placeholder="Например: подготовить отчёт по Казани"
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleError(null);
            }}
          />
        </FormField>
        <FormField
          label="Исполнитель"
          tip={TIPS.assignees}
          hint={assignees.length ? undefined : "Не выбран — задача вам"}
          htmlFor={null}
        >
          <PeopleField value={assignees} onChange={setAssignees} addLabel="Выбрать" />
        </FormField>
        {assignees.length > 1 && (
          <SegmentedControl
            aria-label="Как поставить нескольким"
            fullWidth
            value={mode}
            onChange={setMode}
            options={[
              { value: "shared", label: "Одна общая задача" },
              { value: "separate", label: `Отдельная каждому (${assignees.length})` },
            ]}
          />
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

        {!full ? (
          <Button variant="ghost" size="sm" onClick={() => setFull(true)}>
            <ChevronDown className="size-4" /> Ещё: соисполнители, описание, чек-лист, файлы…
          </Button>
        ) : (
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
            <FormField
              label="Описание"
              hint="Картинки и оформление — в карточке задачи после постановки"
            >
              <Textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Подробности, ссылки, что считать готовым"
              />
            </FormField>
            <FormField label="Чек-лист" htmlFor={null}>
              <div className="space-y-1.5">
                {items.map((it, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Input
                      value={it}
                      placeholder={`Пункт ${i + 1}`}
                      onChange={(e) =>
                        setItems((l) => l.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setItems((l) => [...l.slice(0, i + 1), "", ...l.slice(i + 1)]);
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Убрать пункт"
                      onClick={() => setItems((l) => l.filter((_, j) => j !== i))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setItems((l) => [...l, ""])}>
                  <Plus className="size-4" /> Пункт
                </Button>
              </div>
            </FormField>
            <FormField
              label="Файлы"
              hint="До 200 МБ; оборвётся связь — загрузка продолжится"
              htmlFor={null}
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
                            className="rounded p-0.5 hover:bg-muted"
                            aria-label={`Повторить ${u.name}`}
                            onClick={() => handles.current.get(u.key)?.resume()}
                          >
                            <RotateCw className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded p-0.5 hover:bg-muted"
                          aria-label={`Убрать ${u.name}`}
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
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Paperclip className="size-4" /> Прикрепить
                </Button>
              </div>
            </FormField>
            <SwitchRow title="Срочно" checked={urgent} onCheckedChange={setUrgent} />
            <SwitchRow
              title="Требует проверки"
              tip={TIPS.review}
              checked={review}
              onCheckedChange={setReview}
            />
            <FormField label="Напомнить мне">
              <Select value={reminder} onValueChange={setReminder}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REMINDER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        )}
      </DialogBody>
      <DialogFooter className="items-center">
        <div className="mr-auto flex items-center gap-2 max-sm:hidden">
          <Checkbox
            id="task-form-full"
            checked={alwaysFull}
            onCheckedChange={(v) => {
              const on = v === true;
              setAlwaysFull(on);
              if (on) setFull(true);
              try {
                window.localStorage.setItem(FULL_KEY, on ? "1" : "0");
              } catch {
                // без памяти
              }
            }}
          />
          <Label htmlFor="task-form-full" className="text-sm font-normal text-muted-foreground">
            Всегда открывать полностью
          </Label>
        </div>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {assignees.length > 1 && mode === "separate"
            ? `Поставить ${assignees.length} ${plural(assignees.length, "задачу", "задачи", "задач")}`
            : "Поставить задачу"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
