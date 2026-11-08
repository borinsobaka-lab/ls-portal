/**
 * «Шаблоны» (TASKS_CHATS_PLAN.md, 4.9): личные, проекта (ведут владелец и
 * модераторы), общие («Администратор задач»). В шаблоне — поля новой
 * задачи и срок «через N рабочих дней». «Поставить» — форма новой задачи с
 * полями шаблона, «Сделать регулярной» — расписание. Сохранить карточку
 * задачи шаблоном — «⋯» в карточке.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { ChecklistsEditor } from "@/components/tasks/checklists-editor";
import { RecurrenceDialog } from "@/components/tasks/recurring-page";
import { PeopleField, ProjectTag } from "@/components/tasks/task-bits";
import { NewTaskDialog } from "@/components/tasks/task-form";
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
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { documentLines } from "@/lib/kb/document";
import { projectsQuery, taskAction, taskErrorText, templatesQuery } from "@/lib/tasks/data";
import { cleanLists, plural, type DraftList } from "@/lib/tasks/logic";
import type { TaskTemplate, TemplateTask } from "@/lib/tasks/types";

const SCOPE_LABEL: Record<TaskTemplate["scope"], string> = {
  personal: "Личный",
  project: "Проекта",
  shared: "Общий",
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
          <Plus className="size-4" /> Новый шаблон
        </Button>
      }
    >
      <div className="space-y-3">
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : data.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-background px-4 py-10 text-center text-sm text-muted-foreground">
            Шаблон — заготовка задачи: название, люди, чек-листы, срок «через N рабочих дней». Из
            него ставят задачу в два клика и делают регулярные задачи.
          </p>
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
                  Поставить
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRepeat(tp)}>
                  <Repeat className="size-4" /> Регулярно
                </Button>
                {tp.can_edit && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Изменить «${tp.name}»`}
                      onClick={() => setEditing(tp)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Удалить «${tp.name}»`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Удалить шаблон «${tp.name}»?`,
                          description:
                            "Регулярные задачи по нему тоже удалятся. Поставленные задачи останутся.",
                          confirmLabel: "Удалить",
                        });
                        if (ok)
                          void taskAction(qc, "task_template_delete", { p_id: tp.id }).catch((e) =>
                            toast.error(taskErrorText(e)),
                          );
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
                {!tp.can_edit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Копия «${tp.name}» себе`}
                    title="Сделать личную копию"
                    onClick={() =>
                      setEditing({
                        ...tp,
                        id: undefined,
                        scope: "personal",
                        project_id: null,
                        name: `${tp.name} (копия)`,
                      })
                    }
                  >
                    <Copy className="size-4" />
                  </Button>
                )}
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
  const [errors, setErrors] = useState<{ name?: string; title?: string }>({});
  const [saving, setSaving] = useState(false);

  const scopes: { value: TaskTemplate["scope"]; label: string }[] = [
    { value: "personal", label: "Личный" },
    ...(managed.length ? [{ value: "project" as const, label: "Проекта" }] : []),
    ...(isAdmin ? [{ value: "shared" as const, label: "Общий" }] : []),
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
                deadline_days: n,
                deadline_time: time || null,
              },
            },
          });
          toast.success("Шаблон сохранён");
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
          Заготовка задачи: из неё ставят задачу и делают регулярные.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название шаблона" required error={errors.name}>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </FormField>
        {scopes.length > 1 && (
          <FormField label="Кому виден" htmlFor={null}>
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
        <FormField label="Название задачи" required error={errors.title}>
          <Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField
          label="Исполнитель"
          hint={assignees.length ? undefined : "Не выбран — тот, кто ставит"}
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
              { value: "separate", label: "Отдельная каждому" },
            ]}
          />
        )}
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
        <FormField label="Чек-листы" htmlFor={null}>
          <ChecklistsEditor lists={lists} onChange={setLists} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Срок — через рабочих дней" hint="Пусто — без срока; 0 — в тот же день">
            <Input
              type="number"
              min={0}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </FormField>
          <FormField label="Ко времени" hint="Пусто — к концу рабочего дня">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </FormField>
        </div>
        <SwitchRow title="Срочно" checked={urgent} onCheckedChange={setUrgent} />
        <SwitchRow title="Требует проверки" checked={review} onCheckedChange={setReview} />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Сохранить шаблон
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
