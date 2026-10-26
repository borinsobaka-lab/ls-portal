import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FilePlus, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { KbPageHeading } from "@/components/kb/kb-header";
import { useConfirm } from "@/components/confirm-dialog";
import { KbNodeTitleForm } from "@/components/kb/node-dialogs";
import { KbTemplateEditor } from "@/components/kb/template-dialogs";
import { useKbActions } from "@/components/kb/use-kb-actions";
import { KbTemplatesPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import { canEditKb } from "@/lib/kb/access";
import {
  KB_TEMPLATES_KEY,
  kbBasesQuery,
  kbErrorText,
  loadKbTemplateContent,
  useKbAuthors,
  useKbTemplates,
  useKbTree,
  type KbTemplate,
} from "@/lib/kb/data";
import { formatDate } from "@/lib/format";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

export const Route = createFileRoute("/_authenticated/kb/$baseId/templates")({
  head: () => ({ meta: [{ title: "Шаблоны — Lady Stretch" }] }),
  pendingComponent: KbTemplatesPageSkeleton,
  component: KbTemplatesPage,
});

/**
 * Шаблоны статей (№32, kb_templates) — общие для всех баз знаний (решение
 * владельца 2026-10-25), видят и правят редакторы любой базы и владельцы.
 * Появляются из статьи — «⋯» → «Сохранить как шаблон»; здесь — просмотр,
 * «Статья по шаблону» (в этой базе), правка шаблона целиком — название,
 * описание и текст (KbTemplateEditor), удаление.
 */
function KbTemplatesPage() {
  const { baseId } = Route.useParams();
  const access = useAdminAccess();
  const canEdit = canEditKb(access?.kbAdmin ? "manage" : access?.kb?.[baseId]);
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: bases } = useQuery(kbBasesQuery);
  const base = bases?.find((b) => b.id === baseId);
  const { data: templates, isLoading } = useKbTemplates(canEdit);
  const { data: nodes } = useKbTree(baseId);
  const { data: authors } = useKbAuthors(baseId);
  const actions = useKbActions(baseId);
  const [dialog, setDialog] = useState<{
    kind: "view" | "edit" | "create";
    template: KbTemplate;
  } | null>(null);
  // Есть несохранённые правки шаблона — закрыть окно только с подтверждением.
  const dirty = useRef(false);
  const open = (next: typeof dialog) => {
    dirty.current = false;
    setDialog(next);
  };
  const close = async () => {
    if (
      dialog?.kind === "edit" &&
      dirty.current &&
      !(await confirm({
        title: "Закрыть без сохранения?",
        description: "Правки шаблона пропадут.",
        confirmLabel: "Закрыть",
      }))
    )
      return;
    open(null);
  };

  const remove = async (t: KbTemplate) => {
    const ok = await confirm({
      title: `Удалить шаблон «${t.title}»?`,
      description: "Статьи, уже созданные по нему, останутся как есть.",
    });
    if (!ok) return;
    const { error } = await supabase.from("kb_templates").delete().eq("id", t.id);
    if (error) {
      toast.error(kbErrorText(error.message));
      return;
    }
    open(null);
    await qc.invalidateQueries({ queryKey: [KB_TEMPLATES_KEY] });
    toast.success("Шаблон удалён");
  };

  return (
    <AdminShell title={`Шаблоны${base ? ` · ${base.title}` : ""}`}>
      <div className="mx-auto max-w-4xl space-y-3">
        <KbPageHeading baseId={baseId} title="Шаблоны" />
        {!canEdit && access ? (
          <InfoNote variant="warning">Шаблоны видят редакторы баз знаний и владельцы.</InfoNote>
        ) : (
          <>
            <InfoNote>
              Шаблон — готовая структура статьи (регламент, чек-лист смены, скрипт). Шаблоны общие
              для всех баз знаний. Сохраните его из статьи: «⋯» → «Сохранить как шаблон», поправить
              — карандашом. Новую статью по шаблону — кнопкой «Статья» в меню и выбором шаблона, или
              здесь.
            </InfoNote>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Шаблон</TableHead>
                    <TableHead>Обновлён</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableSkeletonRows columns={3} rows={4} />
                  ) : !templates?.length ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                        Шаблонов пока нет.
                      </TableCell>
                    </TableRow>
                  ) : (
                    templates.map((t) => (
                      <TableRow
                        key={t.id}
                        className="cursor-pointer"
                        onClick={() => open({ kind: "view", template: t })}
                      >
                        <TableCell className="max-w-96">
                          <span className="block truncate font-medium">{t.title}</span>
                          {t.description && (
                            <span className="line-clamp-2 text-xs text-muted-foreground">
                              {t.description}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          <span className="block">{formatDate(t.updated_at)}</span>
                          <span className="text-xs text-muted-foreground">
                            {(t.updated_by && authors?.get(t.updated_by)) || ""}
                          </span>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Статья по шаблону"
                              title="Статья по шаблону"
                              onClick={() => open({ kind: "create", template: t })}
                            >
                              <FilePlus />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Редактировать шаблон"
                              title="Редактировать шаблон"
                              onClick={() => open({ kind: "edit", template: t })}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Удалить шаблон"
                              title="Удалить шаблон"
                              onClick={() => void remove(t)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && void close()}>
        <DialogContent
          className={
            dialog?.kind === "edit"
              ? "max-w-4xl"
              : dialog?.kind === "view"
                ? "max-w-3xl"
                : "max-w-lg"
          }
        >
          {dialog?.kind === "view" && (
            <TemplatePreview
              baseId={baseId}
              template={dialog.template}
              onCreate={() => open({ kind: "create", template: dialog.template })}
              onEdit={() => open({ kind: "edit", template: dialog.template })}
            />
          )}
          {dialog?.kind === "edit" && (
            <KbTemplateEditor
              key={dialog.template.id}
              baseId={baseId}
              template={dialog.template}
              onDirtyChange={(d) => {
                dirty.current = d;
              }}
              onDone={() => void close()}
            />
          )}
          {dialog?.kind === "create" && (
            <KbNodeTitleForm
              kind="article"
              node={null}
              place={{
                nodes: nodes ?? [],
                baseTitle: base?.title ?? "База",
                parentId: null,
                baseId,
                templateId: dialog.template.id,
              }}
              onSave={(title, description, parentId, icon, templateId, tags) =>
                actions.create("article", parentId, title, description, icon, templateId, tags)
              }
              onDone={() => open(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

function TemplatePreview({
  baseId,
  template,
  onCreate,
  onEdit,
}: {
  baseId: string;
  template: KbTemplate;
  onCreate: () => void;
  onEdit: () => void;
}) {
  const { data: content, isLoading } = useQuery({
    queryKey: [KB_TEMPLATES_KEY, "content", template.id],
    queryFn: () => loadKbTemplateContent(template.id),
    meta: { errorMessage: "Не удалось загрузить шаблон" },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Eye className="size-5 text-muted-foreground" />
          {template.title}
        </DialogTitle>
        {template.description && <DialogDescription>{template.description}</DialogDescription>}
      </DialogHeader>
      <DialogBody>
        {isLoading || !content ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Загружаем шаблон…
          </div>
        ) : (
          <div className="-mx-3">
            <Suspense fallback={null}>
              <KbDocument baseId={baseId} nodeId={template.id} initial={content} editable={false} />
            </Suspense>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onEdit}>
          <Pencil />
          Редактировать
        </Button>
        <Button onClick={onCreate}>
          <FilePlus />
          Статья по шаблону
        </Button>
      </DialogFooter>
    </>
  );
}
