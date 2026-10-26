import { ReadBar } from "@/components/kb/analytics/parts";
import { useKbReaders } from "@/components/kb/analytics/queries";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
import { DialogBody, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KB_READ_STATE, formatAgo, formatDuration, type KbReadState } from "@/lib/kb/analytics";
import { formatDateTime } from "@/lib/format";

const ORDER: KbReadState[] = ["unread", "outdated", "current"];

/**
 * Окно «Кто прочитал» статьи — из аналитики («Статьи») и из самой статьи:
 * сначала кто не открывал (с ними и работать), потом читавшие прежнюю
 * версию, потом прочитавшие — когда, сколько времени, докуда дочитал.
 * Считаются сотрудники, кому база выдана в «Доступах», без владельцев и
 * авторов статьи.
 */
export function KbReadersDialogBody({ nodeId, title }: { nodeId: string; title: string }) {
  const { data, isLoading } = useKbReaders(nodeId);
  const rows = data ?? [];
  const count = (s: KbReadState) => rows.filter((r) => r.state === s).length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title || "Без названия"}</DialogTitle>
        <DialogDescription>
          Кто из сотрудников с доступом к базе прочитал статью. Владельцы и авторы статьи не
          считаются; «прежняя версия» — открывал до последней публикации.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Читателей нет: статью некому читать — базу никому не выдали в «Доступах» (владельцы и
            авторы статьи не считаются).
          </p>
        ) : (
          <div className="space-y-4">
            <ReadBar
              current={count("current")}
              outdated={count("outdated")}
              total={rows.length}
              legend
            />
            {ORDER.filter((s) => count(s) > 0).map((s) => (
              <section key={s}>
                <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: KB_READ_STATE[s].color }}
                  />
                  {KB_READ_STATE[s].short} · {count(s)}
                </h3>
                <ul className="divide-y rounded-md border">
                  {rows
                    .filter((r) => r.state === s)
                    .map((r) => (
                      <li key={r.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <PersonButton userId={r.user_id} className="shrink-0 rounded-full">
                          <StaffAvatar
                            value={r.avatar_url}
                            name={r.full_name ?? ""}
                            className="size-8 text-xs"
                          />
                        </PersonButton>
                        <span className="min-w-0 flex-1">
                          <PersonButton
                            userId={r.user_id}
                            className="block max-w-full truncate font-medium hover:underline"
                          >
                            {r.full_name || "Сотрудник"}
                          </PersonButton>
                          {s !== "unread" && (
                            <span className="block text-xs text-muted-foreground">
                              {formatDuration(r.seconds)} · прокрутил {r.max_scroll}%
                              {r.read_count > 1 && ` · открывал ${r.read_count} раз`}
                            </span>
                          )}
                        </span>
                        {s !== "unread" && (
                          <span
                            className="shrink-0 text-right text-xs text-muted-foreground"
                            title={r.last_read_at ? formatDateTime(r.last_read_at) : undefined}
                          >
                            {formatAgo(r.last_read_at)}
                            {r.completed_at && (
                              <span className="block text-emerald-700 dark:text-emerald-300">
                                дочитал
                              </span>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </DialogBody>
    </>
  );
}
