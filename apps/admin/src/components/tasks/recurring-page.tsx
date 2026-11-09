/**
 * «Регулярные» (TASKS_CHATS_PLAN.md, 4.9; UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 4.9): мои регулярные задачи — шаблон и расписание (каждый день, по
 * рабочим дням, по дням недели, по числу месяца, через N дней после
 * закрытия), время в моём поясе. Задачи не копятся: пока прежняя открыта,
 * следующая ждёт её закрытия или прежняя закрывается как пропущенная
 * («Пропускать, если прежняя не закрыта» — в «Дополнительно»). Чаще всего
 * регулярная заводится из самой задачи — «Повторять» в форме постановки
 * или «Сделать регулярной» в карточке (шаблон тогда свой, скрытый); здесь —
 * список и «Новая регулярная задача» по шаблону. Создаёт задачи сервер
 * (task_tick).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { RecurrenceFields } from "@/components/tasks/recurrence-fields";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { TaskMenu } from "@/components/tasks/task-menu";
import { TaskStatusChip } from "@/components/tasks/task-bits";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  recurrencesQuery,
  taskAction,
  taskErrorText,
  templatesQuery,
  useTaskClock,
} from "@/lib/tasks/data";
import { buildRule, formatMoment, hhmm, recurrenceText, ruleDraft } from "@/lib/tasks/logic";
import type { Recurrence } from "@/lib/tasks/types";

const TIPS = {
  skip: "Задачи не копятся. Выключено — следующая появится, когда закроют прежнюю. Включено — прежняя закроется как пропущенная, и придёт новая.",
};

export function RecurringPage() {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { data = [], isPending } = useQuery(recurrencesQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<Recurrence> | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const save = (r: Recurrence, patch: Partial<Recurrence>) =>
    taskAction(qc, "task_recurrence_save", {
      p_id: r.id,
      p: {
        template_id: r.template_id,
        rule: r.rule,
        at_time: hhmm(r.at_time),
        mode: r.mode,
        active: r.active,
        ...patch,
      },
    })
      .then(() => toast.success(patch.active ? "Регулярная задача включена" : "Выключена"))
      .catch((e) => toast.error(taskErrorText(e)));

  return (
    <AdminShell
      title="Регулярные задачи"
      actions={
        <Button onClick={() => setEditing({})}>
          <Plus className="size-4" /> Новая регулярная задача
        </Button>
      }
    >
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-background px-4 py-10 text-center">
          <p className="max-w-lg text-sm text-muted-foreground">
            Регулярная задача — «каждый понедельник в 10:00 — отчёт за неделю». Проще всего:
            поставьте задачу и включите «Повторять» в «Ещё» — или «Сделать регулярной» в карточке
            уже поставленной.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setCreatingTask(true)}>
              <Plus className="size-4" /> Поставить задачу
            </Button>
            <Button variant="outline" onClick={() => setEditing({})}>
              По шаблону
            </Button>
          </div>
        </div>
      ) : (
        <div className="divide-y rounded-lg border bg-background">
          {data.map((r) => (
            <div key={r.id} className="group flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex items-center gap-2">
                <Switch
                  id={`rec-${r.id}`}
                  checked={r.active}
                  onCheckedChange={(v) => void save(r, { active: v })}
                />
                <Label
                  htmlFor={`rec-${r.id}`}
                  className="w-20 cursor-pointer text-xs font-normal text-muted-foreground"
                >
                  {r.active ? "Включена" : "Выключена"}
                </Label>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.title}</div>
                <div className="text-sm text-muted-foreground">
                  {recurrenceText(r.rule, r.at_time)}
                  {r.template_hidden ? "" : ` · шаблон «${r.template_name}»`}
                  {r.mode === "skip" ? " · прежняя — пропускается" : ""}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {r.active && r.next_run_at && (
                    <span>Следующая: {formatMoment(r.next_run_at, tz)}</span>
                  )}
                  {r.active && !r.next_run_at && <span>Следующая — после закрытия прежней</span>}
                  {r.last_task && (
                    <span className="inline-flex items-center gap-1.5">
                      Последняя:
                      <Link
                        to="/tasks/$number"
                        params={{ number: String(r.last_task.number) }}
                        className="underline"
                      >
                        #{r.last_task.number}
                      </Link>
                      <TaskStatusChip status={r.last_task.status} />
                    </span>
                  )}
                </div>
                {r.last_error && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="size-3.5" />
                    Выключена: {taskErrorText(new Error(r.last_error))}
                  </div>
                )}
              </div>
              <TaskMenu
                label={`«${r.title}»: действия`}
                items={[
                  { label: "Изменить расписание", icon: Pencil, run: () => setEditing(r) },
                  "separator",
                  {
                    label: "Удалить",
                    icon: Trash2,
                    danger: true,
                    run: async () => {
                      const ok = await confirm({
                        title: "Удалить регулярную задачу?",
                        description:
                          "Новые задачи по ней больше не появятся. Поставленные останутся.",
                        confirmLabel: "Удалить",
                      });
                      if (ok)
                        void taskAction(qc, "task_recurrence_delete", { p_id: r.id })
                          .then(() => toast.success("Регулярная задача удалена"))
                          .catch((e) => toast.error(taskErrorText(e)));
                    },
                  },
                ]}
              />
            </div>
          ))}
        </div>
      )}
      <RecurrenceDialog open={!!editing} initial={editing} onClose={() => setEditing(null)} />
      <NewTaskDialog open={creatingTask} onClose={() => setCreatingTask(false)} />
      {confirmDialog}
    </AdminShell>
  );
}

export function RecurrenceDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: Partial<Recurrence> | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-lg">
        {open && initial && (
          <RecurrenceForm key={initial.id ?? "new"} initial={initial} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecurrenceForm({
  initial,
  onClose,
}: {
  initial: Partial<Recurrence>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: templates = [] } = useQuery(templatesQuery);
  const [template, setTemplate] = useState(initial.template_id ?? templates[0]?.id ?? "");
  const [draft, setDraft] = useState(() => ruleDraft(initial.rule));
  const [time, setTime] = useState(hhmm(initial.at_time ?? "09:00"));
  const [skip, setSkip] = useState(initial.mode === "skip");
  const [startNow, setStartNow] = useState(false);
  const [errors, setErrors] = useState<{ template?: string; rule?: string }>({});
  const [saving, setSaving] = useState(false);
  const own = !!initial.template_hidden;

  return (
    <DialogForm
      onSubmit={async () => {
        const r = buildRule(draft);
        const e = {
          template: template ? undefined : "Выберите шаблон",
          rule: r
            ? undefined
            : draft.freq === "weekly"
              ? "Отметьте хотя бы один день"
              : "Проверьте расписание",
        };
        setErrors(e);
        if (e.template || e.rule) return;
        setSaving(true);
        try {
          await taskAction(qc, "task_recurrence_save", {
            p_id: initial.id ?? null,
            p: {
              template_id: template,
              rule: r,
              at_time: time,
              mode: skip ? "skip" : "wait",
              active: initial.active ?? true,
              start_now: startNow,
            },
          });
          toast.success(
            startNow ? "Первая задача появится в течение минуты" : "Расписание сохранено",
          );
          onClose();
        } catch (err) {
          toast.error(taskErrorText(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{initial.id ? "Регулярная задача" : "Новая регулярная задача"}</DialogTitle>
        <DialogDescription>
          Задачу ставите вы: по расписанию, в вашем часовом поясе.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {own ? (
          <FormField label="Задача" htmlFor={null}>
            <p className="text-sm">{initial.title}</p>
          </FormField>
        ) : templates.length ? (
          <FormField label="Шаблон" required error={errors.template}>
            <Select value={template} onValueChange={setTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите шаблон" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : (
          <InfoNote variant="info">
            Шаблонов пока нет. Проще поставить задачу и включить «Повторять» — или сначала{" "}
            <Link to="/tasks/templates" className="underline" onClick={onClose}>
              создать шаблон
            </Link>
            .
          </InfoNote>
        )}
        <RecurrenceFields
          draft={draft}
          onDraft={(d) => {
            setDraft(d);
            setErrors((x) => ({ ...x, rule: undefined }));
          }}
          time={time}
          onTime={setTime}
          error={errors.rule}
        />
        <Collapsible defaultOpen={skip}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <ChevronDown className="size-4" /> Дополнительно
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <SwitchRow
              title="Пропускать, если прежняя не закрыта"
              tip={TIPS.skip}
              checked={skip}
              onCheckedChange={setSkip}
            />
            <SwitchRow
              title="Первую задачу — сразу"
              hint="Не ждать первого дня по расписанию"
              checked={startNow}
              onCheckedChange={setStartNow}
            />
          </CollapsibleContent>
        </Collapsible>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving || (!own && !templates.length)}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {initial.id ? "Сохранить" : "Создать"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
