import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
import { ReadBar } from "@/components/kb/analytics/parts";
import { useKbPerson } from "@/components/kb/analytics/queries";
import { DialogBody, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  KB_READ_STATE,
  dayLabels,
  formatAgo,
  formatDuration,
  percentText,
  type KbPersonArticle,
  type KbPersonRow,
  type KbReadState,
} from "@/lib/kb/analytics";
import { formatDateTime } from "@/lib/format";

const ORDER: KbReadState[] = ["unread", "outdated", "current"];

/**
 * Карточка чтения сотрудника в аналитике базы: сводка, активность за 30
 * дней (столбики по дням — минуты чтения), статьи по состоянию — сначала
 * не открытые (с ними и работать), потом прежняя версия, потом
 * прочитанные — и последние поиски.
 */
export function KbPersonDialogBody({ baseId, person }: { baseId: string; person: KbPersonRow }) {
  const { data, isLoading } = useKbPerson(baseId, person.user_id);
  const articles = data?.articles ?? [];
  const daily = data?.daily ?? [];
  const maxSeconds = Math.max(...daily.map((d) => d.seconds), 1);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <PersonButton userId={person.user_id} className="shrink-0 rounded-full">
            <StaffAvatar
              value={person.avatar_url}
              name={person.full_name ?? ""}
              className="size-10 text-sm"
            />
          </PersonButton>
          <span className="min-w-0">
            <PersonButton
              userId={person.user_id}
              className="block max-w-full truncate hover:underline"
            >
              {person.full_name || "Сотрудник"}
            </PersonButton>
            <span className="block text-xs font-normal text-muted-foreground">
              {person.level === "edit" ? "Правка базы" : "Просмотр базы"}
            </span>
          </span>
        </DialogTitle>
        <DialogDescription>
          Вход в админку — {formatAgo(person.last_sign_in_at)}
          {person.first_read_at && `, читает базу с ${formatDateTime(person.first_read_at)}`}.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini
              label="Прочитано"
              value={percentText(person.read_current, person.required)}
              hint={`${person.read_current} из ${person.required}`}
            />
            <Mini label="Прежняя версия" value={String(person.read_outdated)} hint="статей" />
            <Mini
              label="Время чтения"
              value={formatDuration(person.seconds_total)}
              hint="за всё время"
            />
            <Mini
              label="Последнее чтение"
              value={formatAgo(person.last_read_at)}
              hint={person.last_node_title ?? undefined}
            />
          </div>

          <ReadBar
            current={person.read_current}
            outdated={person.read_outdated}
            total={person.required}
            legend
          />

          <section>
            <h3 className="mb-2 text-sm font-semibold">Активность за 30 дней</h3>
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div
                className="flex h-16 items-end gap-0.5"
                role="img"
                aria-label="Минуты чтения по дням"
              >
                {daily.map((d) => {
                  const l = dayLabels(d.day);
                  return (
                    <div
                      key={d.day}
                      title={`${l.label}: ${d.views ? `${d.views} откр., ` : ""}${formatDuration(d.seconds)}`}
                      className="min-w-0 flex-1 rounded-t-sm"
                      style={{
                        height: `${d.seconds || d.views ? Math.max((d.seconds / maxSeconds) * 100, 8) : 4}%`,
                        backgroundColor: d.seconds || d.views ? "var(--brand)" : "var(--muted)",
                      }}
                    />
                  );
                })}
              </div>
            )}
          </section>

          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            ORDER.map((s) => {
              const list = articles.filter((a) => a.state === s);
              if (!list.length) return null;
              return (
                <section key={s}>
                  <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: KB_READ_STATE[s].color }}
                    />
                    {KB_READ_STATE[s].short} · {list.length}
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {list.map((a) => (
                      <ArticleRow key={a.id} baseId={baseId} article={a} />
                    ))}
                  </ul>
                </section>
              );
            })
          )}

          {!!data?.searches.length && (
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">Последние поиски</h3>
              <ul className="space-y-1">
                {data.searches.map((q) => (
                  <li key={q.created_at} className="flex items-center gap-2 text-sm">
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">«{q.query}»</span>
                    <span
                      className={
                        q.results === 0
                          ? "shrink-0 text-xs text-amber-700 dark:text-amber-300"
                          : "shrink-0 text-xs text-muted-foreground"
                      }
                    >
                      {q.results === 0
                        ? "ничего не нашлось"
                        : q.clicked_node_id
                          ? "нашёл и открыл"
                          : `нашлось ${q.results}`}{" "}
                      · {formatAgo(q.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </DialogBody>
    </>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border px-3 py-2">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className="block truncate text-base font-semibold tabular-nums">{value}</span>
      {hint && (
        <span className="block truncate text-xs text-muted-foreground" title={hint}>
          {hint}
        </span>
      )}
    </div>
  );
}

function ArticleRow({ baseId, article: a }: { baseId: string; article: KbPersonArticle }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <Link
          to="/kb/$baseId/$nodeId"
          params={{ baseId, nodeId: a.id }}
          className="block truncate font-medium hover:underline"
        >
          {a.title || "Без названия"}
        </Link>
        {a.state !== "unread" && (
          <span className="block text-xs text-muted-foreground">
            {formatDuration(a.seconds)} · прокрутил {a.max_scroll}%
            {a.read_count > 1 && ` · открывал ${a.read_count} раз`}
            {!a.required && " · не в обязательных"}
          </span>
        )}
      </span>
      {a.state !== "unread" && (
        <span
          className="shrink-0 text-right text-xs text-muted-foreground"
          title={a.last_read_at ? formatDateTime(a.last_read_at) : undefined}
        >
          {formatAgo(a.last_read_at)}
          {a.completed_at && (
            <span className="block text-emerald-700 dark:text-emerald-300">дочитал</span>
          )}
        </span>
      )}
    </li>
  );
}
