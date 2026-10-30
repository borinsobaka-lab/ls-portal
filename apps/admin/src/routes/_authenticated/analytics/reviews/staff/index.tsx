import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsStaffLinksPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AN_TITLES } from "@/lib/analytics/labels";
import {
  invalidateReviews,
  rvRpc,
  rvStaffLinksQuery,
  type RvStaffLink,
} from "@/lib/analytics/reviews/data";
import { feedbackUrl, rvInitials, staffMatches } from "@/lib/analytics/reviews/view";

export const Route = createFileRoute("/_authenticated/analytics/reviews/staff/")({
  head: () => ({ meta: [{ title: "Отзывы · ссылки сотрудников — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsStaffLinksPageSkeleton,
  component: AnalyticsStaffLinksPage,
});

type LinkState = "active" | "paused" | "missing";
const STATE_LABELS: Record<"all" | LinkState, string> = {
  all: "Все сотрудники",
  active: "Активные",
  paused: "Приостановленные",
  missing: "Без ссылки",
};

const linkState = (l: RvStaffLink): LinkState =>
  l.link_id === null ? "missing" : l.is_active ? "active" : "paused";

/** Их цвета аватарок по порядку строк. */
const AVATAR_COLORS = ["#f8d9ed", "#e9d9ff", "#ffe4d5", "#d8eaff", "#f4d9ff", "#d7f4e7"];

/**
 * «Аналитика» → «Отзывы» → «Ссылки на отзывы сотрудников» (администратору
 * аналитики) — их staff_feedback_links_page: у каждого сотрудника (люди
 * портала, кроме партнёров) — постоянная ссылка на форму отзыва без входа;
 * «Создать ссылку», «Копировать», «Приостановить» / «Включить».
 */
function AnalyticsStaffLinksPage() {
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery(rvStaffLinksQuery);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"all" | LinkState>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const employees = data ?? [];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const rows = employees.filter(
    (e) =>
      (state === "all" || linkState(e) === state) &&
      staffMatches(`${e.full_name} ${e.position ?? ""}`, query),
  );
  const filterLabel = query.trim()
    ? `Найдено: ${rows.length} из ${employees.length}`
    : `${STATE_LABELS[state]} (${rows.length})`;

  const create = async (e: RvStaffLink) => {
    setBusy(e.user_id);
    try {
      const name = await rvRpc.createLink(e.user_id);
      await invalidateReviews(qc);
      toast.success(`Ссылка для сотрудника «${name}» создана.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (e: RvStaffLink) => {
    if (e.link_id === null) return;
    setBusy(e.user_id);
    try {
      await rvRpc.setLinkActive(e.link_id, !e.is_active);
      await invalidateReviews(qc);
      toast.success("Статус ссылки обновлён.");
    } catch {
      toast.error("Не удалось изменить ссылку.");
    } finally {
      setBusy(null);
    }
  };
  const copy = async (e: RvStaffLink, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      toast.error("Не удалось скопировать — выделите ссылку и скопируйте вручную.");
      return;
    }
    setCopied(e.user_id);
    setTimeout(() => setCopied((c) => (c === e.user_id ? null : c)), 1600);
  };

  return (
    <AdminShell title={AN_TITLES.staffLinks}>
      <div className="space-y-3">
        <InfoNote>
          Здесь всегда доступны постоянные ссылки сотрудников. Форма по ссылке открывается без
          входа: город, имя партнёра, две оценки от 1 до 5 и рекомендации.
        </InfoNote>
        <TableToolbar>
          <ToolbarSearch
            value={query}
            onChange={setQuery}
            placeholder="Поиск по сотруднику или должности…"
          />
          <Select value={state} onValueChange={(v) => setState(v as "all" | LinkState)}>
            <SelectTrigger className="w-56" aria-label="Ссылки">
              <SelectValue>{filterLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все сотрудники ({employees.length})</SelectItem>
              <SelectItem value="active">Активные</SelectItem>
              <SelectItem value="paused">Приостановленные</SelectItem>
              <SelectItem value="missing">Без ссылки</SelectItem>
            </SelectContent>
          </Select>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Сотрудник</TableHead>
                  <TableHead>Ссылка</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={3} rows={8} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {employees.length
                        ? "Сотрудники не найдены."
                        : "Действующих сотрудников пока нет."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((e) => {
                    const s = linkState(e);
                    const url = e.token ? feedbackUrl(origin, e.token) : "";
                    const color = AVATAR_COLORS[employees.indexOf(e) % AVATAR_COLORS.length];
                    return (
                      <TableRow key={e.user_id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <span
                              className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold text-[#5c2a75]"
                              style={{ background: color }}
                            >
                              {rvInitials(e.full_name, "С")}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{e.full_name}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {e.position || "Должность не указана"}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-64">
                          {s === "missing" ? (
                            <span className="text-sm text-muted-foreground">
                              Ссылка ещё не создана
                            </span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Input
                                readOnly
                                value={url}
                                aria-label={`Ссылка на отзыв для ${e.full_name}`}
                                onFocus={(ev) => ev.currentTarget.select()}
                                className="font-mono text-xs"
                              />
                              {s === "paused" && (
                                <StatusChip tone="neutral" size="sm">
                                  Приостановлена
                                </StatusChip>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {s === "missing" ? (
                              <Button
                                size="sm"
                                disabled={busy === e.user_id}
                                onClick={() => void create(e)}
                              >
                                {busy === e.user_id && <Loader2 className="animate-spin" />}
                                Создать ссылку
                              </Button>
                            ) : (
                              <>
                                <Button size="sm" onClick={() => void copy(e, url)}>
                                  <Copy />
                                  {copied === e.user_id ? "Скопировано" : "Копировать"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy === e.user_id}
                                  onClick={() => void toggle(e)}
                                >
                                  {busy === e.user_id && <Loader2 className="animate-spin" />}
                                  {e.is_active ? "Приостановить" : "Включить"}
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
