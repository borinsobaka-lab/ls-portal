import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, Check, ExternalLink, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { PORTAL_NAME } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { RowContextMenu } from "@/components/row-context-menu";
import { useConfirm } from "@/components/confirm-dialog";
import { BugReportsPageSkeleton } from "@/components/page-skeletons";

/**
 * «Управление» → «Сообщения об ошибках» (решение владельца 2026-11-01):
 * что сотрудники прислали кнопкой «Сообщить об ошибке» (components/bug-report.tsx).
 * Только суперадминистратору (право portal.admin; проверяет и база — RPC
 * portal_bug_reports_*). Новые — первыми; «Исправлено» убирает из счётчика
 * у пункта меню.
 */
export const Route = createFileRoute("/_authenticated/bug-reports")({
  head: () => ({ meta: [{ title: `Сообщения об ошибках — ${PORTAL_NAME}` }] }),
  pendingComponent: BugReportsPageSkeleton,
  component: BugReportsPage,
});

type Status = "open" | "resolved" | "all";

type BugReport = {
  id: string;
  user_id: string | null;
  author_name: string | null;
  author_email: string | null;
  page_path: string;
  page_title: string | null;
  message: string;
  app_version: string | null;
  user_agent: string | null;
  viewport: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
};

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "open", label: "Новые" },
  { value: "resolved", label: "Исправленные" },
  { value: "all", label: "Все" },
];

const when = (iso: string) => format(new Date(iso), "dd.MM.yy HH:mm", { locale: ru });

/** Заголовок вкладки без хвоста «— Портал»: короче в таблице. */
const pageLabel = (r: BugReport) =>
  r.page_title?.replace(/\s+[—-]\s+[^—-]+$/, "").trim() || r.page_path;

function BugReportsPage() {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [status, setStatus] = useState<Status>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryKey = ["portal_bug_reports", status];
  const { data, isPending } = useQuery({
    queryKey,
    queryFn: () =>
      unwrap<BugReport[]>(
        supabase.rpc("portal_bug_reports_list", { p_status: status === "all" ? null : status }),
      ),
    meta: { errorMessage: "Не удалось загрузить сообщения об ошибках" },
  });
  const rows = data ?? [];
  const pg = usePagination(rows, undefined, status);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const columns = 5;

  const reload = () => queryClient.invalidateQueries({ queryKey: ["portal_bug_reports"] });

  const resolve = async (r: BugReport, resolved: boolean) => {
    const { error } = await supabase.rpc("portal_bug_report_resolve", {
      p_id: r.id,
      p_resolved: resolved,
    });
    if (error) {
      toast.error("Не удалось сохранить: " + error.message);
      return false;
    }
    toast.success(resolved ? "Отмечено как исправленное" : "Возвращено в работу");
    await reload();
    return true;
  };

  const remove = async (r: BugReport) => {
    if (
      !(await confirm({
        title: "Удалить сообщение?",
        description: "Это действие нельзя отменить.",
      }))
    )
      return;
    const { error } = await supabase.rpc("portal_bug_report_delete", { p_id: r.id });
    if (error) {
      toast.error(error.message);
      return;
    }
    setSelectedId(null);
    toast.success("Удалено");
    await reload();
  };

  return (
    <AdminShell title="Сообщения об ошибках">
      <div className="space-y-3">
        <TableToolbar>
          <SegmentedControl<Status>
            aria-label="Статус"
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
          />
        </TableToolbar>

        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead>Страница</TableHead>
                <TableHead>Сообщение</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableSkeletonRows columns={columns} />
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    <Bug className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                    {status === "open" ? "Новых сообщений нет." : "Сообщений нет."}
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((r) => (
                  <RowContextMenu
                    key={r.id}
                    actions={[
                      r.resolved_at
                        ? {
                            label: "Вернуть в работу",
                            icon: RotateCcw,
                            onSelect: () => void resolve(r, false),
                          }
                        : {
                            label: "Исправлено",
                            icon: Check,
                            onSelect: () => void resolve(r, true),
                          },
                      {
                        label: "Удалить",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => void remove(r),
                      },
                    ]}
                  >
                    <TableRow onClick={() => setSelectedId(r.id)} className="cursor-pointer">
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {when(r.created_at)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {r.author_name || r.author_email || "—"}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate" title={r.page_path}>
                        {pageLabel(r)}
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate">{r.message}</TableCell>
                      <TableCell>
                        {r.resolved_at ? (
                          <StatusChip tone="positive">Исправлено</StatusChip>
                        ) : (
                          <StatusChip tone="warning">Новое</StatusChip>
                        )}
                      </TableCell>
                    </TableRow>
                  </RowContextMenu>
                ))
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={isPending} />
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelectedId(null)}>
        <DialogContent className="sm:max-w-lg">
          {selected && (
            <BugReportDetails
              key={selected.id}
              report={selected}
              onResolve={async (resolved) => {
                if (await resolve(selected, resolved)) setSelectedId(null);
              }}
              onDelete={() => void remove(selected)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

function BugReportDetails({
  report: r,
  onResolve,
  onDelete,
  onClose,
}: {
  report: BugReport;
  onResolve: (resolved: boolean) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    try {
      await onResolve(!r.resolved_at);
    } finally {
      setSaving(false);
    }
  };
  // Путь своей админки: открыть ту же страницу (без перехода на чужой адрес).
  const ownPath = r.page_path.startsWith("/") && !r.page_path.startsWith("//");

  return (
    <>
      <DialogHeader>
        <DialogTitle>Сообщение об ошибке</DialogTitle>
        <DialogDescription>
          {r.author_name || r.author_email || "Сотрудник"} · {when(r.created_at)}
          {r.author_name && r.author_email && ` · ${r.author_email}`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4">
          <p className="whitespace-pre-wrap break-words text-sm">{r.message}</p>
          <InfoNote>
            <span className="block font-medium text-foreground">{pageLabel(r)}</span>
            {ownPath ? (
              <Link
                to={r.page_path}
                onClick={onClose}
                className="inline-flex items-center gap-1 break-all underline underline-offset-2"
              >
                {r.page_path}
                <ExternalLink className="size-3.5 shrink-0" />
              </Link>
            ) : (
              <span className="block break-all">{r.page_path}</span>
            )}
          </InfoNote>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <dt>Версия портала</dt>
            <dd>{r.app_version || "—"}</dd>
            <dt>Размер окна</dt>
            <dd>{r.viewport || "—"}</dd>
            <dt>Браузер</dt>
            <dd className="break-words">{r.user_agent || "—"}</dd>
            {r.resolved_at && (
              <>
                <dt>Исправлено</dt>
                <dd>
                  {when(r.resolved_at)}
                  {r.resolved_by_name && ` · ${r.resolved_by_name}`}
                </dd>
              </>
            )}
          </dl>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDelete} disabled={saving}>
          <Trash2 />
          Удалить
        </Button>
        <Button onClick={() => void toggle()} disabled={saving}>
          {saving ? (
            <Loader2 className="animate-spin" />
          ) : r.resolved_at ? (
            <RotateCcw />
          ) : (
            <Check />
          )}
          {r.resolved_at ? "Вернуть в работу" : "Исправлено"}
        </Button>
      </DialogFooter>
    </>
  );
}
