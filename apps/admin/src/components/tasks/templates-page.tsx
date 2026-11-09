/**
 * «Шаблоны» (TASKS_CHATS_PLAN.md, 4.9; UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 4.9): «Только мне», «Проекту» (ведут владелец и модераторы), «Всем»
 * («Администратор задач»). В шаблоне — поля новой задачи в том же порядке,
 * что в форме постановки, и срок «через N рабочих дней». «Поставить задачу»
 * — форма новой задачи с полями шаблона, «Сделать регулярной» —
 * расписание. Сохранить карточку задачи шаблоном — «⋯» в карточке.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Pencil, Plus, Repeat, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { ChecklistsEditor } from "@/components/tasks/checklists-editor";
import { RecurrenceDialog } from "@/components/tasks/recurring-page";
import { PeopleField, ProjectTag } from "@/components/tasks/task-bits";
import { NewTaskDialog } from "@/components/tasks/task-form";
import { TaskMenu } from "@/components/tasks/task-menu";
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
import { StatusChip } from "@/components/ui/status-chip";
import { Textarea } from "@/components/ui/textarea";
import { TimeField } from "@/components/ui/date-field";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { documentLines } from "@/lib/kb/document";
import { projectsQuery, taskAction, taskErrorText, templatesQuery } from "@/lib/tasks/data";
import { cleanLists, plural, type DraftList } from "@/lib/tasks/logic";
import type { TaskTemplate, TemplateTask } from "@/lib/tasks/types";

const SCOPE_LABEL: Record<TaskTemplate["scope"], string> = {
  personal: "Только мне",
  project: "Проекту",
  shared: "Всем",
};

const TIPS = {
  scope:
    "Только мне — шаблон видите вы. Проекту — участники проекта (правят владелец и модераторы). Всем — все сотрудники портала.",
  review: "Исполнитель отправит задачу на проверку, постановщик примет или вернёт.",
  result: "Исполнитель не завершит задачу, пока не напишет результат: что сделано, ссылка, цифры.",
  mode: "«Одна общая» — первый исполнитель, остальные помогают. «Каждому своя» — отдельная задача на каждого.",
};

export function TemplatesPage() {
  const qc = useQueryClient();
  const { data = [], isPending } = useQuery(templatesQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<TaskTemplate> | null>(null);
  const [using, setUsing] = useState<TaskTemplate | null>(null);
  const [repeat, setRepeat] = useState<TaskTemplate | null>(null);

  return (
    <AdminShell
      title="Шаблоны задач"
      actions={
        <Button onClick={() => setEditing({})}>
          <Plus className="size-4" /> Создать шаблон
        </Button>
      }
    >
      <div className="space-y-3">
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-background px-4 py-10 text-center">
            <p className="max-w-lg text-sm text-muted-foreground">
              Шаблон — заготовка задачи: название, люди, чек-листы, срок «через N рабочих дней». Из
              него ставят задачу в два клика и делают регулярные. Готовую задачу можно сохранить
              шаблоном из её карточки — «⋯».
            </p>
            <Button onClick={() => setEditing({})}>
              <Plus className="size-4" /> Создать шаблон
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-lg border bg-background">
            {data.map((tp) => (
              <div key={tp.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{tp.name}</span>
                    <StatusChip tone={tp.scope === "shared" ? "info" : "neutral"}>
                      {SCOPE_LABEL[tp.scope]}
                    </StatusChip>
                    {tp.project && <ProjectTag project={tp.project} className="text-sm" />}
                  </div>
                  <div className="truncate text-sm text-muted-foreground">
                    {tp.task.title}
                    {tp.task.deadline_days !== null && tp.task.deadline_days !== undefined
                      ? ` · срок через ${tp.task.deadline_days} ${plural(tp.task.deadline_days, "рабочий день", "рабочих дня", "рабочих дней")}`
                      : ""}
                  </div>
                </div>
                <Button size="sm" onClick={() => setUsing(tp)}>
                  Поставить задачу
                </Button>
                <TaskMenu
                  label={`Шаблон «${tp.name}»: действия`}
                  items={[
                    { label: "Сделать регулярной", icon: Repeat, run: () => setRepeat(tp) },
                    ...(tp.can_edit
                      ? [{ label: "Изменить", icon: Pencil, run: () => setEditing(tp) }]
                      : [
                          {
                            label: "Сделать личную копию",
                            icon: Copy,
                            run: () =>
                              setEditing({
                                ...tp,
                                id: undefined,
                                scope: "personal",
                                project_id: null,
                                name: `${tp.name} (копия)`,
                              }),
                          },
                        ]),
                    ...(tp.can_edit
                      ? [
                          "separator" as const,
                          {
                            label: "Удалить шаблон",
                            icon: Trash2,
                            danger: true,
                            run: async () => {
                              const ok = await confirm({
                                title: `Удалить шаблон «${tp.name}»?`,
                                description:
                                  "Регулярные задачи по нему тоже удалятся. Поставленные задачи останутся.",
                                confirmLabel: "Удалить",
                              });
                              if (ok)
                                void taskAction(qc, "task_template_delete", { p_id: tp.id })
                                  .then(() => toast.success("Шаблон удалён"))
                                  .catch((e) => toast.error(taskErrorText(e)));
                            },
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <TemplateDialog template={editing} onClose={() => setEditing(null)} />
      <NewTaskDialog open={!!using} template={using ?? undefined} onClose={() => setUsing(null)} />
      <RecurrenceDialog
        open={!!repeat}
        initial={repeat ? { template_id: repeat.id } : null}
        onClose={() => setRepeat(null)}
      />
      {confirmDialog}
    </AdminShell>
  );
}

/** Шаблон: новый ({}), правка (с id) или из задачи (без id, с task). */
export function TemplateDialog({
  template,
  onClose,
}: {
  template: Partial<TaskTemplate> | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        {template && (
          <TemplateForm key={template.id ?? "new"} template={template} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({
  template,
  onClose,
}: {
  template: Partial<TaskTemplate>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const access = useAdminAccess();
  const isAdmin = !!access && hasRight(access, "tasks.admin");
  const { data: projects = [] } = useQuery(projectsQuery);
  const managed = projects.filter((p) => p.can_manage && !p.archived_at);
  const t: TemplateTask = template.task ?? { title: "" };
  const [name, setName] = useState(template.name ?? "");
  const [scope, setScope] = useState<TaskTemplate["scope"]>(template.scope ?? "personal");
  const [project, setProject] = useState(template.project_id ?? managed[0]?.id ?? "");
  const [title, setTitle] = useState(t.title ?? "");
  const [assignees, setAssignees] = useState<string[]>(t.assignees ?? []);
  const [mode, setMode] = useState<"shared" | "separate">(t.mode ?? "shared");
  const [coassignees, setCoassignees] = useState<string[]>(t.coassignees ?? []);
  const [watchers, setWatchers] = useState<string[]>(t.watchers ?? []);
  const doc = Array.isArray(t.description) && t.description.length ? t.description : null;
  const [descDoc, setDescDoc] = useState<unknown[] | null>(doc);
  const [description, setDescription] = useState(
    doc
      ? documentLines(doc)
          .map((l) => l.text)
          .join("\n")
      : "",
  );
  const [lists, setLists] = useState<DraftList[]>(t.checklists ?? []);
  const [days, setDays] = useState(
    t.deadline_days === null || t.deadline_days === undefined ? "" : String(t.deadline_days),
  );
  const [time, setTime] = useState(t.deadline_time ?? "");
  const [urgent, setUrgent] = useState(!!t.urgent);
  const [review, setReview] = useState(!!t.requires_review);
  const [resultRequired, setResultRequired] = useState(!!t.result_required);
  const [errors, setErrors] = useState<{ name?: string; title?: string }>({});
  const [saving, setSaving] = useState(false);

  const scopes: { value: TaskTemplate["scope"]; label: string }[] = [
    { value: "personal", label: SCOPE_LABEL.personal },
    ...(managed.length ? [{ value: "project" as const, label: SCOPE_LABEL.project }] : []),
    ...(isAdmin ? [{ value: "shared" as const, label: SCOPE_LABEL.shared }] : []),
  ];

  return (
    <DialogForm
      onSubmit={async () => {
        const e = {
          name: name.trim() ? undefined : "Назовите шаблон",
          title: title.trim() ? undefined : "Название задачи",
        };
        setErrors(e);
        if (e.name || e.title) return;
        setSaving(true);
        try {
          const n = days.trim() === "" ? null : Math.max(0, Math.min(365, Number(days)));
          await taskAction(qc, "task_template_save", {
            p_id: template.id ?? null,
            p: {
              name: name.trim(),
              scope,
              project_id: scope === "project" ? project : null,
              task: {
                title: title.trim(),
                description:
                  descDoc ??
                  (description.trim()
                    ? description.split("\n").map((line) => ({
                        type: "paragraph",
                        content: line ? [{ type: "text", text: line, styles: {} }] : [],
                      }))
                    : null),
                assignees,
                mode,
                coassignees,
                watchers,
                checklists: cleanLists(lists),
                urgent,
                requires_review: review,
                result_required: resultRequired,
                deadline_days: n,
                deadline_time: time || null,
              },
            },
          });
          toast.success(template.id ? "Шаблон сохранён" : "Шаблон создан");
          onClose();
        } catch (err) {
          toast.error(taskErrorText(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{template.id ? "Шаблон" : "Новый шаблон"}</DialogTitle>
        <DialogDescription>
          Заготовка задачи: из неё ставят задачу и делают регулярные. Поля — как в форме новой
          задачи.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название шаблона" required error={errors.name}>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </FormField>
        {scopes.length > 1 && (
          <FormField label="Кому виден" tip={TIPS.scope} htmlFor={null}>
            <SegmentedControl
              aria-label="Кому виден шаблон"
              value={scope}
              onChange={setScope}
              options={scopes}
            />
          </FormField>
        )}
        {scope === "project" && (
          <FormField label="Проект">
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {managed.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <div className="space-y-4 border-t pt-4">
          <p className="text-xs font-medium text-muted-foreground uppercase">Новая задача</p>
          <FormField label="Что сделать" required error={errors.title}>
            <Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          </FormField>
          <FormField label="Описание" optional>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setDescDoc(null);
              }}
            />
          </FormField>
          <FormField
            label={assignees.length > 1 ? "Исполнители" : "Исполнитель"}
            hint={assignees.length ? undefined : "Не выбран — тот, кто ставит"}
            htmlFor={null}
          >
            <PeopleField value={assignees} onChange={setAssignees} addLabel="Выбрать" />
          </FormField>
          {assignees.length > 1 && (
            <FormField label="Как поставить" tip={TIPS.mode} htmlFor={null}>
              <SegmentedControl
                aria-label="Как поставить нескольким"
                fullWidth
                value={mode}
                onChange={setMode}
                options={[
                  { value: "shared", label: "Одна общая задача" },
                  { value: "separate", label: "Каждому своя" },
                ]}
              />
            </FormField>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Срок — через рабочих дней"
              hint="Пусто — без срока; 0 — в тот же день"
            >
              <Input
                type="number"
                min={0}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </FormField>
            <FormField label="Ко времени" hint="Не выбрано — к концу рабочего дня" htmlFor={null}>
              <div className="flex items-center gap-1">
                <TimeField
                  value={time}
                  onChange={setTime}
                  placeholder="Конец дня"
                  aria-label="Ко времени"
                  className="w-full"
                />
                {time && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Сбросить время"
                    title="Сбросить — к концу рабочего дня"
                    onClick={() => setTime("")}
                  >
                    <X />
                  </Button>
                )}
              </div>
            </FormField>
          </div>
          <FormField label="Соисполнители" htmlFor={null}>
            <PeopleField value={coassignees} onChange={setCoassignees} exclude={assignees} />
          </FormField>
          <FormField label="Наблюдатели" htmlFor={null}>
            <PeopleField
              value={watchers}
              onChange={setWatchers}
              exclude={[...assignees, ...coassignees]}
            />
          </FormField>
          <FormField label="Чек-листы" htmlFor={null}>
            <ChecklistsEditor lists={lists} onChange={setLists} />
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
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {template.id ? "Сохранить" : "Создать шаблон"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
