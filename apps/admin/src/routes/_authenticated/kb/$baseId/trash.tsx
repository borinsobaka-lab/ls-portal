import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { KbPageHeading } from "@/components/kb/kb-header";
import { useConfirm } from "@/components/confirm-dialog";
import { DocumentText, Folder } from "@/components/nav-icons";
import { KbTrashPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
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
import { invalidateKb, kbBasesQuery, kbErrorText, useKbAuthors } from "@/lib/kb/data";
import { formatDate, formatDateTime } from "@/lib/format";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/kb/$baseId/trash")({
  head: () => ({ meta: [{ title: "Корзина — Base40 Admin" }] }),
  pendingComponent: KbTrashPageSkeleton,
  component: KbTrashPage,
});

type TrashRow = {
  id: string;
  root_id: string;
  kind: "folder" | "article";
  title: string;
  articles_count: number;
  deleted_by: string | null;
  deleted_at: string;
  purge_after: string;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Корзина базы (№12, kb_trash; редакторам): удалённые папки и статьи со
 * всем вложенным 30 дней. «Вернуть» — на прежнее место (папки нет — на
 * верхний уровень) с версиями, черновиками и отметками о прочтении;
 * потом или «Удалить навсегда» — с файлами (их стирает сервер админки).
 */
function KbTrashPage() {
  const { baseId } = Route.useParams();
  const access = useAdminAccess();
  const canEdit = canEditKb(access?.kbAdmin ? "manage" : access?.kb?.[baseId]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const { data: bases } = useQuery(kbBasesQuery);
  const base = bases?.find((b) => b.id === baseId);
  const { data: authors } = useKbAuthors(baseId);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["kb_trash", baseId],
    queryFn: () =>
      unwrap<TrashRow[]>(
        supabase
          .from("kb_trash")
          .select("id, root_id, kind, title, articles_count, deleted_by, deleted_at, purge_after")
          .eq("base_id", baseId)
          .order("deleted_at", { ascending: false }),
      ),
    enabled: canEdit,
    meta: { errorMessage: "Не удалось загрузить корзину" },
  });

  const restore = async (row: TrashRow) => {
    setBusy(row.id);
    try {
      const { error } = await supabase.rpc("kb_trash_restore", { p_id: row.id });
      if (error) {
        toast.error(kbErrorText(error.message));
        return;
      }
      await Promise.all([
        invalidateKb(qc, baseId),
        qc.invalidateQueries({ queryKey: ["kb_trash", baseId] }),
      ]);
      toast.success(row.kind === "folder" ? "Папка возвращена" : "Статья возвращена");
      await navigate({ to: "/kb/$baseId/$nodeId", params: { baseId, nodeId: row.root_id } });
    } finally {
      setBusy(null);
    }
  };

  const purge = async (row: TrashRow) => {
    const ok = await confirm({
      title: `Удалить «${row.title || "Без названия"}» навсегда?`,
      description:
        row.kind === "folder"
          ? "Папка со всем, что в ней, версии, отметки о прочтении и файлы удалятся без возможности вернуть."
          : "Статья, её версии, отметки о прочтении и файлы удалятся без возможности вернуть.",
      confirmLabel: "Удалить навсегда",
    });
    if (!ok) return;
    setBusy(row.id);
    try {
      const { error } = await supabase.rpc("kb_trash_delete", { p_id: row.id });
      if (error) {
        toast.error(kbErrorText(error.message));
        return;
      }
      await qc.invalidateQueries({ queryKey: ["kb_trash", baseId] });
      toast.success("Удалено навсегда");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell title={`Корзина${base ? ` · ${base.title}` : ""}`}>
      <div className="mx-auto max-w-4xl space-y-3">
        <KbPageHeading baseId={baseId} title="Корзина" />
        {!canEdit && access ? (
          <InfoNote variant="warning">Корзину видят редакторы базы и владельцы.</InfoNote>
        ) : (
          <>
            <InfoNote>
              Удалённые папки и статьи лежат здесь 30 дней — их можно вернуть на прежнее место со
              всеми версиями. Потом они удаляются навсегда вместе с файлами.
            </InfoNote>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Что удалено</TableHead>
                    <TableHead>Удалил</TableHead>
                    <TableHead>Удалится навсегда</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableSkeletonRows columns={4} rows={4} />
                  ) : !rows?.length ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        Корзина пуста.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => {
                      const days = Math.max(
                        0,
                        Math.ceil((new Date(r.purge_after).getTime() - Date.now()) / DAY),
                      );
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="max-w-80">
                            <span className="flex min-w-0 items-center gap-2 font-medium">
                              {r.kind === "folder" ? (
                                <Folder className="size-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <DocumentText className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate">{r.title || "Без названия"}</span>
                            </span>
                            {r.kind === "folder" && (
                              <span className="text-xs text-muted-foreground">
                                Папка, статей внутри: {r.articles_count}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="block">
                              {(r.deleted_by && authors?.get(r.deleted_by)) || "—"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDateTime(r.deleted_at)}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="block">{formatDate(r.purge_after)}</span>
                            <span className="text-xs text-muted-foreground">
                              {days === 0 ? "сегодня" : `через ${days} дн.`}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === r.id}
                                onClick={() => void restore(r)}
                              >
                                {busy === r.id ? <Loader2 className="animate-spin" /> : <Undo2 />}
                                Вернуть
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={busy === r.id}
                                aria-label="Удалить навсегда"
                                title="Удалить навсегда"
                                onClick={() => void purge(r)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
      {confirmDialog}
    </AdminShell>
  );
}
