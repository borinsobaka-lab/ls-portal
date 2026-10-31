import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsInboxTemplatesPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  INBOX_KEY,
  inboxRpc,
  inboxTemplatesQuery,
  type InboxTemplate,
} from "@/lib/analytics/inbox/data";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/inbox/templates")({
  head: () => ({ meta: [{ title: "Шаблоны ответов — Диалоги VK — Lady Stretch" }] }),
  pendingComponent: AnalyticsInboxTemplatesPageSkeleton,
  component: AnalyticsInboxTemplatesPage,
});

const SECTIONS = [
  {
    visibility: "shared",
    title: "Общие шаблоны",
    description: "Доступны всем лид-менеджерам. Добавляет и редактирует администратор.",
    empty: ["Общих шаблонов пока нет.", "Создайте первый шаблон, чтобы быстро отвечать клиентам."],
    add: "Добавить общий шаблон",
  },
  {
    visibility: "personal",
    title: "Мои личные шаблоны",
    description: "Видны только вам. Каждый менеджер ведёт свои шаблоны.",
    empty: [
      "Личных шаблонов пока нет.",
      "Создайте свой первый шаблон для быстрых ответов клиентам.",
    ],
    add: "Добавить личный шаблон",
  },
] as const;

/**
 * «Диалоги VK» → «Шаблоны» — их /admin/vk-inbox/templates: общие (правит
 * администратор аналитики, видят все) и личные шаблоны ответов.
 */
function AnalyticsInboxTemplatesPage() {
  const { data, error } = useQuery(inboxTemplatesQuery);
  return (
    <AdminShell title={AN_TITLES.inboxTemplates}>
      <div className="max-w-4xl space-y-6">
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/inbox">
            <ArrowLeft />К диалогам
          </Link>
        </Button>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          SECTIONS.map((sec) => {
            const allowed = sec.visibility === "personal" || data.admin;
            const items = data.templates.filter((t) => t.visibility === sec.visibility);
            return (
              <section key={sec.visibility} className="space-y-3">
                <div>
                  <h2 className="text-lg font-semibold">{sec.title}</h2>
                  <p className="text-sm text-muted-foreground">{sec.description}</p>
                </div>
                {items.map((t) => (
                  <div key={t.id} className="rounded-lg border bg-background p-4">
                    {allowed ? (
                      <TemplateForm template={t} visibility={sec.visibility} />
                    ) : (
                      <>
                        <h3 className="font-semibold">{t.title}</h3>
                        <p className="mt-1 text-sm whitespace-pre-wrap">{t.body}</p>
                      </>
                    )}
                  </div>
                ))}
                {!items.length && (
                  <InfoNote variant="empty">
                    <b>{sec.empty[0]}</b> {sec.empty[1]}
                  </InfoNote>
                )}
                {allowed && (
                  <div className="rounded-lg border bg-background p-4">
                    <h3 className="mb-3 font-semibold">{sec.add}</h3>
                    <TemplateForm
                      key={`${sec.visibility}-new-${items.length}`}
                      visibility={sec.visibility}
                    />
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </AdminShell>
  );
}

function TemplateForm({
  template,
  visibility,
}: {
  template?: InboxTemplate;
  visibility: "shared" | "personal";
}) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [title, setTitle] = useState(template?.title ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await action();
      await qc.invalidateQueries({ queryKey: [...INBOX_KEY, "templates"] });
      toast.success("Шаблоны обновлены.");
      if (!template) {
        setTitle("");
        setBody("");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const fieldId = `tpl-${template?.id ?? `new-${visibility}`}`;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          inboxRpc("an_inbox_template_save", {
            p_id: template?.id ?? null,
            p_title: title,
            p_body: body,
            p_visibility: visibility,
          }),
        );
      }}
    >
      <FormField label="Название" required htmlFor={`${fieldId}-title`}>
        <Input
          id={`${fieldId}-title`}
          value={title}
          maxLength={100}
          placeholder="Например: Приветствие нового клиента"
          onChange={(e) => setTitle(e.target.value)}
        />
      </FormField>
      <FormField label="Текст ответа" required htmlFor={`${fieldId}-body`}>
        <Textarea
          id={`${fieldId}-body`}
          value={body}
          rows={4}
          maxLength={4096}
          placeholder="Введите текст шаблона..."
          onChange={(e) => setBody(e.target.value)}
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {template ? "Сохранить" : "Добавить шаблон"}
        </Button>
        {template && (
          <Button
            variant="outline"
            disabled={saving}
            onClick={async () => {
              if (!(await confirm({ title: "Удалить шаблон?", confirmLabel: "Удалить" }))) return;
              void run(() => inboxRpc("an_inbox_template_delete", { p_id: template.id }));
            }}
          >
            <Trash2 />
            Удалить
          </Button>
        )}
      </div>
      {confirmDialog}
    </form>
  );
}
