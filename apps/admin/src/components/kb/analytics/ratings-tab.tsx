import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Frown, Meh, Smile } from "lucide-react";

import { DataPagination, usePagination } from "@/components/data-pagination";
import { PersonChip } from "@/components/people/person-card";
import { Delta, EmptyBlock, KpiTile } from "@/components/kb/analytics/parts";
import { useKbRatings } from "@/components/kb/analytics/queries";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
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
import { formatAgo, percentText, type KbPeriod } from "@/lib/kb/analytics";
import { KB_SCORES, kbScore, type KbRatingCounts } from "@/lib/kb/ratings";
import { formatDateTime, formatNumber } from "@/lib/format";

const SCORE_ICON = { 1: Frown, 2: Meh, 3: Smile } as const;

const TIPS = {
  count:
    "Сколько раз оценили статьи базы за период. Оценка — своя на каждую версию статьи: поменял оценку той же версии — она одна.",
  good: "Доля оценок «Помогла» (зелёный смайлик).",
  bad: "Доля оценок «Не помогла» (красный смайлик) — к этим статьям стоит вернуться.",
  people: "Сколько разных сотрудников оценивали статьи за период.",
  outdated: "Оценка прежней версии статьи — после неё статью опубликовали заново.",
};

/**
 * «Оценки» аналитики (решение владельца 2026-10-25): сколько и как оценили
 * статьи базы (три смайлика в конце статьи), по статьям и кто как оценил —
 * по хронологии. Статья из адреса (`?node=`, ссылка «Кто и как оценил» под
 * статьёй) — сразу фильтром.
 */
export function KbRatingsTab({
  baseId,
  period,
  nodeId,
  onNode,
}: {
  baseId: string;
  period: KbPeriod;
  nodeId: string | null;
  onNode: (id: string | null) => void;
}) {
  const { data: r, isLoading, error } = useKbRatings(baseId, period);
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const log = (r?.log ?? []).filter(
    (l) =>
      (!nodeId || l.node_id === nodeId) &&
      (!term ||
        (l.full_name ?? "").toLowerCase().includes(term) ||
        l.title.toLowerCase().includes(term)),
  );
  const pg = usePagination(log, undefined, `${nodeId}|${term}|${period}`);

  if (error && !r) return <InfoNote variant="warning">{error.message}</InfoNote>;
  const loading = isLoading || !r;
  const c = r?.current;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <KpiTile
          label="Оценок"
          tip={TIPS.count}
          loading={loading}
          value={c ? formatNumber(c.count) : ""}
          delta={r && <Delta current={r.current.count} previous={r.previous.count} />}
        />
        <KpiTile
          label="Помогла"
          tip={TIPS.good}
          loading={loading}
          value={c ? percentText(c.good, c.count) : ""}
          hint={c ? `${formatNumber(c.good)} раз` : undefined}
        />
        <KpiTile
          label="Не помогла"
          tip={TIPS.bad}
          loading={loading}
          value={c ? percentText(c.bad, c.count) : ""}
          hint={c ? `${formatNumber(c.bad)} раз` : undefined}
        />
        <KpiTile
          label="Оценивали"
          tip={TIPS.people}
          loading={loading}
          value={c ? formatNumber(c.people) : ""}
          hint="сотрудников"
          delta={r && <Delta current={r.current.people} previous={r.previous.people} />}
        />
      </div>
      {c && c.count > 0 && (
        <div className="rounded-lg border bg-background px-4 py-3">
          <ScoreBar counts={c} legend />
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">По статьям</h3>
        {r && r.articles.length === 0 ? (
          <EmptyBlock>За период статьи не оценивали.</EmptyBlock>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Статья</TableHead>
                  <TableHead>Оценок</TableHead>
                  <TableHead>Как оценили</TableHead>
                  <TableHead>Последняя</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={4} rows={4} />
                ) : (
                  r.articles.map((a) => (
                    <TableRow
                      key={a.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-selected={a.id === nodeId}
                      data-state={a.id === nodeId ? "selected" : undefined}
                      onClick={() => onNode(a.id === nodeId ? null : a.id)}
                      onKeyDown={(e) => e.key === "Enter" && onNode(a.id === nodeId ? null : a.id)}
                    >
                      <TableCell className="max-w-80">
                        <Link
                          to="/kb/$baseId/$nodeId"
                          params={{ baseId, nodeId: a.id }}
                          onClick={(e) => e.stopPropagation()}
                          className="block truncate font-medium hover:underline"
                        >
                          {a.title || "Без названия"}
                        </Link>
                        {!a.feedback_enabled && (
                          <span className="text-xs text-muted-foreground">Оценка выключена</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{a.count}</TableCell>
                      <TableCell className="min-w-56">
                        <ScoreBar counts={a} />
                      </TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground"
                        title={formatDateTime(a.last_at)}
                      >
                        {formatAgo(a.last_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Кто и как оценил</h3>
        <TableToolbar>
          <ToolbarSearch value={q} onChange={setQ} placeholder="Сотрудник или статья" />
          <Select value={nodeId ?? "all"} onValueChange={(v) => onNode(v === "all" ? null : v)}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Все статьи" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статьи</SelectItem>
              {nodeId && !r?.articles.some((a) => a.id === nodeId) && (
                <SelectItem value={nodeId}>Выбранная статья</SelectItem>
              )}
              {(r?.articles ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title || "Без названия"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarReset
            active={!!q || !!nodeId}
            onReset={() => {
              setQ("");
              onNode(null);
            }}
          />
        </TableToolbar>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Когда</TableHead>
                <TableHead>Сотрудник</TableHead>
                <TableHead>Статья</TableHead>
                <TableHead>Оценка</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={4} rows={5} />
              ) : pg.paged.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {r.log.length === 0 ? "За период оценок нет" : "Ничего не нашлось"}
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((l) => {
                  const s = kbScore(l.score);
                  const Icon = SCORE_ICON[s.score];
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(l.rated_at)}
                      </TableCell>
                      <TableCell>
                        <PersonChip
                          userId={l.user_id}
                          name={l.full_name || "Сотрудник"}
                          avatar={l.avatar_url}
                        />
                      </TableCell>
                      <TableCell className="max-w-72">
                        <Link
                          to="/kb/$baseId/$nodeId"
                          params={{ baseId, nodeId: l.node_id }}
                          className="block truncate hover:underline"
                        >
                          {l.title || "Без названия"}
                        </Link>
                        {l.outdated && (
                          <span className="text-xs text-muted-foreground" title={TIPS.outdated}>
                            прежняя версия
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusChip tone={s.tone} size="sm">
                          <Icon />
                          {s.label}
                        </StatusChip>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {r && <DataPagination {...pg} />}
        </div>
        {r && r.log.length >= 1000 && (
          <p className="text-xs text-muted-foreground">
            Показаны последние 1000 оценок периода — для более ранних выберите период короче.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Полоса оценок: «помогла / так себе / не помогла» с просветами; `legend` —
 * подписи с числами и долями. У каждого цвета — подпись и смайлик.
 */
function ScoreBar({ counts, legend }: { counts: KbRatingCounts; legend?: boolean }) {
  const parts = [...KB_SCORES].reverse().map((s) => ({ ...s, value: counts[s.key] }));
  return (
    <div>
      <div
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}
      >
        {counts.count === 0 ? (
          <div className="h-full w-full rounded-full bg-muted" />
        ) : (
          parts
            .filter((p) => p.value > 0)
            .map((p) => (
              <div
                key={p.key}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(p.value / counts.count) * 100}%`,
                  backgroundColor: p.color,
                }}
              />
            ))
        )}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => {
          const Icon = SCORE_ICON[p.score];
          return (
            <li key={p.key} className="inline-flex items-center gap-1" title={p.label}>
              <Icon className="size-3.5" style={{ color: p.color }} />
              {legend && p.label}
              <span className="font-medium text-foreground tabular-nums">{p.value}</span>
              {legend && counts.count > 0 && (
                <span className="tabular-nums">· {percentText(p.value, counts.count)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
