import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FileSpreadsheet, FileUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsReviewsUploadPageSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import {
  importReviews,
  invalidateReviews,
  rvRpc,
  rvUploadsQuery,
  type RvUpload,
} from "@/lib/analytics/reviews/data";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/reviews/upload")({
  head: () => ({ meta: [{ title: "Отзывы · загрузка — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsReviewsUploadPageSkeleton,
  component: AnalyticsReviewsUploadPage,
});

/**
 * «Аналитика» → «Отзывы» → «Загрузка выгрузки» (администратору аналитики) —
 * их reviews_upload_page: выгрузка оценок 1С (.xls, .xlsx) добавляется к
 * накопленной истории, совпадающие строки не дублируются; история загрузок.
 * Файл разбирается в браузере (lib/analytics/reviews/parse.ts).
 */
function AnalyticsReviewsUploadPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { confirm, confirmDialog } = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const { data: uploads, isPending } = useQuery(rvUploadsQuery);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async () => {
    if (!file) {
      toast.error("Выберите файл выгрузки.");
      return;
    }
    setError(null);
    setBusy("Читаю выгрузку…");
    try {
      const result = await importReviews(file, setBusy);
      await invalidateReviews(qc);
      const duplicates = result.duplicates
        ? ` Повторы не добавлены: ${formatNumber(result.duplicates)}.`
        : "";
      toast.success(`Добавлено оценок: ${formatNumber(result.rows)}.${duplicates}`);
      void navigate({ to: "/analytics/reviews" });
    } catch (e) {
      setError((e as Error).message);
      await invalidateReviews(qc);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (u: RvUpload) => {
    const ok = await confirm({
      title: `Удалить «${u.filename}»?`,
      description: "Удалить эту загрузку и её строки?",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    try {
      await rvRpc.deleteUpload(u.id);
      await invalidateReviews(qc);
      toast.success("Загрузка удалена.");
    } catch {
      toast.error("Не удалось удалить загрузку.");
    }
  };

  return (
    <AdminShell title={AN_TITLES.reviewsUpload}>
      <div className="max-w-3xl space-y-4">
        <InfoNote>
          Каждый файл добавляет новые оценки в накопленную историю. Уже загруженные совпадающие
          строки не дублируются.{" "}
          <Link
            to="/analytics/reviews"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Открыть статистику
          </Link>
        </InfoNote>

        <section className="space-y-3 rounded-lg border bg-background p-4">
          <div>
            <h2 className="font-semibold">Добавить выгрузку оценок</h2>
            <p className="text-sm text-muted-foreground">
              Поддерживаются исходные файлы 1С в формате .xls и .xlsx.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={input}
              type="file"
              accept=".xls,.xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) {
                  setFile(f);
                  setError(null);
                }
              }}
            />
            <Button variant="outline" disabled={!!busy} onClick={() => input.current?.click()}>
              <FileUp />
              {file ? "Другой файл" : "Файл выгрузки"}
            </Button>
            <Button onClick={() => void upload()} disabled={!!busy}>
              {busy && <Loader2 className="animate-spin" />}
              Добавить выгрузку
            </Button>
            {file && (
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                <FileSpreadsheet className="size-4 shrink-0 text-emerald-700" />
                <span className="truncate">{file.name}</span>
              </span>
            )}
          </div>
          {busy && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {busy}
            </p>
          )}
          {error && <InfoNote variant="warning">{error}</InfoNote>}
        </section>

        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-2 font-semibold">История загрузок</h2>
          {isPending ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !uploads?.length ? (
            <p className="text-sm text-muted-foreground">Выгрузок пока нет.</p>
          ) : (
            <ul className="divide-y">
              {uploads.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{u.filename}</div>
                    <div className="text-xs text-muted-foreground">
                      {u.period_from} — {u.period_to} · добавлено {formatNumber(u.row_count)} оценок
                      {u.imported_by ? ` · ${u.imported_by}` : ""} · {formatMsk(u.imported_at)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Удалить ${u.filename}`}
                    disabled={!!busy}
                    onClick={() => void remove(u)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {confirmDialog}
    </AdminShell>
  );
}
