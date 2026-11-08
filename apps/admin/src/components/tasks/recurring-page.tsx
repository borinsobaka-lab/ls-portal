/**
 * «Регулярные» (TASKS_CHATS_PLAN.md, 4.9): мои регулярные задачи — шаблон и
 * расписание (каждый день, по рабочим дням, по дням недели, по числу
 * месяца, через N дней после закрытия), время в моём поясе. Задачи не
 * копятся: пока прежняя открыта, следующая ждёт её закрытия или прежняя
 * закрывается как пропущенная. Создаёт сервер (task_tick).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { TaskStatusChip } from "@/components/tasks/task-bits";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { formatMoment, hhmm, recurrenceText } from "@/lib/tasks/logic";
import type { Recurrence, RecurrenceRule } from "@/lib/tasks/types";

const FREQS: { value: RecurrenceRule["freq"]; label: string }[] = [
  { value: "daily", label: "Каждый день" },
  { value: "workdays", label: "По рабочим дням" },
  { value: "weekly", label: "По дням недели" },
  { value: "monthly", label: "Каждый месяц" },
  { value: "after_close", label: "Через N дней после закрытия прежней" },
];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const TIPS = {
  mode: "Задачи не копятся. «Ждать» — следующая появится, когда закроют прежнюю. «Пропустить» — прежняя закроется как пропущенная.",
};

export function RecurringPage() {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { data = [], isPending } = useQuery(recurrencesQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<Recurrence> | null>(null);
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
    }).catch((e) => toast.error(taskErrorText(e)));

  return (
    <AdminShell
      title="Регулярные задачи"
      actions={
        <Button onClick={() => setEditing({})}>
          <Plus className="size-4" /> Новая регулярная
        </Button>
      }
    >
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : data.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-background px-4 py-10 text-center text-sm text-muted-foreground">
          Регулярная задача — шаблон и расписание: «каждый понедельник в 10:00 — отчёт за неделю».
          Сначала сделайте шаблон в «Шаблонах».
        </p>
      ) : (
        <div className="divide-y rounded-lg border bg-background">
          {data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Switch
                checked={r.active}
                aria-label={r.active ? "Выключить" : "Включить"}
                onCheckedChange={(v) => void save(r, { active: v })}
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.title}</div>
                <div className="text-sm text-muted-foreground">
                  {recurrenceText(r.rule, r.at_time)} · шаблон «{r.template_name}»
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
              <Button
                variant="ghost"
                size="icon"
                aria-label="Изменить"
                onClick={() => setEditing(r)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Удалить"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Удалить регулярную задачу?",
                    description: "Новые задачи по ней больше не появятся. Поставленные останутся.",
                    confirmLabel: "Удалить",
                  });
                  if (ok)
                    void taskAction(qc, "task_recurrence_delete", { p_id: r.id }).catch((e) =>
                      toast.error(taskErrorText(e)),
                    );
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <RecurrenceDialog open={!!editing} initial={editing} onClose={() => setEditing(null)} />
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
  const rule = initial.rule;
  const [template, setTemplate] = useState(initial.template_id ?? templates[0]?.id ?? "");
  const [freq, setFreq] = useState<RecurrenceRule["freq"]>(rule?.freq ?? "weekly");
  const [weekdays, setWeekdays] = useState<number[]>(rule?.freq === "weekly" ? rule.weekdays : [1]);
  const [monthday, setMonthday] = useState(String(rule?.freq === "monthly" ? rule.monthday : 1));
  const [afterDays, setAfterDays] = useState(
    String(rule?.freq === "after_close" ? rule.after_days : 1),
  );
  const [time, setTime] = useState(hhmm(initial.at_time ?? "09:00"));
  const [mode, setMode] = useState<"wait" | "skip">(initial.mode ?? "wait");
  const [startNow, setStartNow] = useState(false);
  const [saving, setSaving] = useState(false);

  const build = (): RecurrenceRule | null => {
    if (freq === "weekly") return weekdays.length ? { freq, weekdays } : null;
    if (freq === "monthly") {
      const d = Number(monthday);
      return d >= 1 && d <= 31 ? { freq, monthday: d } : null;
    }
    if (freq === "after_close") {
      const d = Number(afterDays);
      return d >= 0 && d <= 365 ? { freq, after_days: d } : null;
    }
    return { freq };
  };

  return (
    <DialogForm
      onSubmit={async () => {
        const r = build();
        if (!template) return void toast.info("Выберите шаблон");
        if (!r) return void toast.info("Проверьте расписание");
        setSaving(true);
        try {
          await taskAction(qc, "task_recurrence_save", {
            p_id: initial.id ?? null,
            p: {
              template_id: template,
              rule: r,
              at_time: time,
              mode,
              active: initial.active ?? true,
              start_now: startNow,
            },
          });
          toast.success(
            startNow ? "Первая задача появится в течение минуты" : "Расписание сохранено",
          );
          onClose();
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{initial.id ? "Регулярная задача" : "Новая регулярная задача"}</DialogTitle>
        <DialogDescription>
          Задачу ставите вы: по шаблону, по расписанию, в вашем часовом поясе.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Шаблон" required>
          {templates.length ? (
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
          ) : (
            <p className="text-sm text-muted-foreground">
              Шаблонов нет — сначала создайте в{" "}
              <Link to="/tasks/templates" className="underline" onClick={onClose}>
                «Шаблонах»
              </Link>
              .
            </p>
          )}
        </FormField>
        <FormField label="Повторять">
          <Select value={freq} onValueChange={(v) => setFreq(v as RecurrenceRule["freq"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FREQS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {freq === "weekly" && (
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((w, i) => (
              <label key={w} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={weekdays.includes(i + 1)}
                  onCheckedChange={(v) =>
                    setWeekdays((d) =>
                      v === true ? [...d, i + 1].sort() : d.filter((x) => x !== i + 1),
                    )
                  }
                />
                {w}
              </label>
            ))}
          </div>
        )}
        {freq === "monthly" && (
          <FormField label="Число месяца" hint="31 — в последний день месяца, если дней меньше">
            <Input
              type="number"
              min={1}
              max={31}
              value={monthday}
              onChange={(e) => setMonthday(e.target.value)}
            />
          </FormField>
        )}
        {freq === "after_close" && (
          <FormField label="Через сколько дней после закрытия">
            <Input
              type="number"
              min={0}
              max={365}
              value={afterDays}
              onChange={(e) => setAfterDays(e.target.value)}
            />
          </FormField>
        )}
        <FormField label="Во сколько">
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </FormField>
        <FormField label="Если прежняя ещё открыта" tip={TIPS.mode} htmlFor={null}>
          <SegmentedControl
            aria-label="Если прежняя открыта"
            fullWidth
            value={mode}
            onChange={setMode}
            options={[
              { value: "wait", label: "Ждать закрытия" },
              { value: "skip", label: "Пропустить прежнюю" },
            ]}
          />
        </FormField>
        <SwitchRow title="Первую задачу — сразу" checked={startNow} onCheckedChange={setStartNow} />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving || !templates.length}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
