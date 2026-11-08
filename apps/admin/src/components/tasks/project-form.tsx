/**
 * Проект (TASKS_CHATS_PLAN.md, 4.10): название, вид, цвет, закрытый или
 * открытый, правило срока и «Требует проверки» для новых задач, состав из
 * подразделения оргструктуры. Новый проект — окном (`NewProjectDialog`),
 * настройки — во вкладке проекта (`ProjectSettingsForm`).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PeopleField } from "@/components/tasks/task-bits";
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
import { Textarea } from "@/components/ui/textarea";
import { companyStructureQuery, unitChildren } from "@/lib/company";
import { invalidateTasks, taskErrorText, taskRpc } from "@/lib/tasks/data";
import { DEADLINE_RULE_LABEL, PROJECT_COLORS, PROJECT_KIND_LABEL } from "@/lib/tasks/logic";
import type { DeadlineRule, Project, ProjectKind } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const NONE = "none";

const TIPS = {
  visibility:
    "Закрытый — проект и его задачи видят только участники. Открытый — виден всем в каталоге, вступить может любой.",
  unit: "Все из подразделения (и ниже) становятся участниками сами — и новые сотрудники тоже.",
  rule: "Как исполнитель может переносить срок задачи проекта. Постановщик меняет срок всегда.",
  review: "Новые задачи проекта сразу с «Требует проверки» — постановщик примет работу или вернёт.",
};

type Values = {
  title: string;
  description: string;
  kind: ProjectKind;
  color: string;
  visibility: "closed" | "open";
  deadline_rule: DeadlineRule;
  requires_review: boolean;
  unit_id: string;
  unit_scope: "all" | "heads";
  with_subunits: boolean;
  members: string[];
};

const fromProject = (p?: Project): Values => ({
  title: p?.title ?? "",
  description: p?.description ?? "",
  kind: p?.kind ?? "project",
  color: p?.color ?? PROJECT_COLORS[0],
  visibility: p?.visibility ?? "closed",
  deadline_rule: p?.deadline_rule ?? "reason",
  requires_review: p?.requires_review ?? false,
  unit_id: p?.unit_id ?? NONE,
  unit_scope: p?.unit_scope ?? "all",
  with_subunits: p?.with_subunits ?? true,
  members: [],
});

const toPayload = (v: Values) => ({
  title: v.title.trim(),
  description: v.description.trim(),
  kind: v.kind,
  color: v.color,
  visibility: v.visibility,
  deadline_rule: v.deadline_rule,
  requires_review: v.requires_review,
  unit_id: v.unit_id === NONE ? null : v.unit_id,
  unit_scope: v.unit_scope,
  with_subunits: v.with_subunits,
  members: v.members,
});

function ProjectFields({
  v,
  set,
  isNew,
  titleError,
}: {
  v: Values;
  set: (p: Partial<Values>) => void;
  isNew: boolean;
  titleError: string | null;
}) {
  const { data: units = [] } = useQuery(companyStructureQuery);
  const unitList = useMemo(() => {
    const children = unitChildren(units);
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const u of children.get(parent) ?? []) {
        out.push({ id: u.id, name: u.name, depth });
        walk(u.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [units]);

  return (
    <div className="space-y-4">
      <FormField label="Название" required error={titleError}>
        <Input
          autoFocus={isNew}
          maxLength={120}
          value={v.title}
          placeholder="Например: Отдел развития, Казань, Открытие клуба"
          onChange={(e) => set({ title: e.target.value })}
        />
      </FormField>
      <FormField label="Вид" htmlFor={null}>
        <SegmentedControl
          aria-label="Вид проекта"
          value={v.kind}
          onChange={(kind) => set({ kind })}
          options={(Object.keys(PROJECT_KIND_LABEL) as ProjectKind[]).map((k) => ({
            value: k,
            label: PROJECT_KIND_LABEL[k],
          }))}
        />
      </FormField>
      <FormField label="Цвет" htmlFor={null}>
        <div className="flex flex-wrap gap-2">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Цвет ${c}`}
              aria-pressed={v.color === c}
              onClick={() => set({ color: c })}
              className="flex size-8 items-center justify-center rounded-full ring-offset-2 aria-pressed:ring-2 aria-pressed:ring-foreground/60"
              style={{ background: c }}
            >
              {v.color === c && <Check className="size-4 text-white" />}
            </button>
          ))}
        </div>
      </FormField>
      <FormField label="Описание" optional>
        <Textarea
          rows={2}
          value={v.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormField>
      <FormField label="Кто видит" tip={TIPS.visibility} htmlFor={null}>
        <SegmentedControl
          aria-label="Кто видит проект"
          value={v.visibility}
          onChange={(visibility) => set({ visibility })}
          options={[
            { value: "closed", label: "Только участники" },
            { value: "open", label: "Все — открытый" },
          ]}
        />
      </FormField>
      <FormField label="Участники из подразделения" tip={TIPS.unit}>
        <Select value={v.unit_id} onValueChange={(unit_id) => set({ unit_id })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Не привязывать — участники вручную</SelectItem>
            {unitList.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                <span style={{ paddingLeft: `${u.depth * 12}px` }}>{u.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {v.unit_id !== NONE && (
        <div className="space-y-3 rounded-lg border p-3">
          <SegmentedControl
            aria-label="Кто из подразделения"
            fullWidth
            value={v.unit_scope}
            onChange={(unit_scope) => set({ unit_scope })}
            options={[
              { value: "all", label: "Все сотрудники" },
              { value: "heads", label: "Руководители и заместители" },
            ]}
          />
          <SwitchRow
            title="И подразделения ниже"
            checked={v.with_subunits}
            onCheckedChange={(with_subunits) => set({ with_subunits })}
          />
        </div>
      )}
      {isNew && (
        <FormField label="Участники" hint="Вы — владелец проекта" htmlFor={null}>
          <PeopleField value={v.members} onChange={(members) => set({ members })} />
        </FormField>
      )}
      <FormField label="Перенос срока" tip={TIPS.rule}>
        <Select
          value={v.deadline_rule}
          onValueChange={(r) => set({ deadline_rule: r as DeadlineRule })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(DEADLINE_RULE_LABEL) as DeadlineRule[]).map((r) => (
              <SelectItem key={r} value={r}>
                {DEADLINE_RULE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <SwitchRow
        title="Новые задачи — «Требует проверки»"
        tip={TIPS.review}
        checked={v.requires_review}
        onCheckedChange={(requires_review) => set({ requires_review })}
      />
    </div>
  );
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-xl">
        {open && <NewProjectForm onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [v, setV] = useState<Values>(() => fromProject());
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!v.title.trim()) {
          setTitleError("Назовите проект");
          return;
        }
        setSaving(true);
        try {
          const id = await taskRpc<string>("task_project_save", { p_id: null, p: toPayload(v) });
          void invalidateTasks(qc);
          void qc.invalidateQueries({ queryKey: ["chat_list"] });
          toast.success("Проект создан — у него уже есть чат в «Чатах» → «Проекты»");
          onClose();
          void navigate({ to: "/tasks/projects/$projectId", params: { projectId: id } });
        } catch (e) {
          toast.error(taskErrorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Новый проект</DialogTitle>
        <DialogDescription>Отдел, город или проект: свои задачи, канбан и чат.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <ProjectFields
          v={v}
          set={(p) => {
            setV((x) => ({ ...x, ...p }));
            if (p.title !== undefined) setTitleError(null);
          }}
          isNew
          titleError={titleError}
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Создать проект
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

export function ProjectSettingsForm({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>(() => fromProject(project));
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form
      noValidate
      className={cn("max-w-xl space-y-4 rounded-lg border bg-background p-4 sm:p-6")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.title.trim()) {
          setTitleError("Назовите проект");
          return;
        }
        setSaving(true);
        try {
          await taskRpc("task_project_save", { p_id: project.id, p: toPayload(v) });
          void invalidateTasks(qc);
          toast.success("Сохранено");
        } catch (err) {
          toast.error(taskErrorText(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <ProjectFields
        v={v}
        set={(p) => {
          setV((x) => ({ ...x, ...p }));
          if (p.title !== undefined) setTitleError(null);
        }}
        isNew={false}
        titleError={titleError}
      />
      <Button type="submit" disabled={saving}>
        {saving && <Loader2 className="size-4 animate-spin" />}
        Сохранить
      </Button>
    </form>
  );
}
