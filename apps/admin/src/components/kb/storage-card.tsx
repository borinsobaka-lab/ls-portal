import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { FieldHint } from "@/components/ui/field-hint";
import { supabase } from "@/integrations/supabase/client";
import { plural } from "@/lib/kb/analytics";
import { formatFileSize } from "@/lib/kb/files";
import { unwrap } from "@/lib/query";

type Usage = {
  bases: {
    id: string;
    title: string;
    files: number;
    bytes: number;
    articles: number;
    revisions: number;
  }[];
  templates: { files: number; bytes: number };
  /** Файлы «Академии» — уроки, обложки, ответы учеников (с 2026-10-25). */
  academy?: { files: number; bytes: number; courses: number };
  files_total: number;
  bytes_total: number;
  db_bytes: number;
};

/** Когда файлов больше — пора выносить их с диска сервера в отдельное хранилище. */
const FILES_WARN_BYTES = 20 * 1024 ** 3;

const TIP =
  "Файлы статей и шаблонов лежат на диске того же сервера, что и база данных и приложение клиентов. Картинки сжимаются при загрузке, файлы, на которые больше ничего не ссылается, сервер удаляет раз в сутки (с запасом в неделю). Когда файлов станет больше 20 ГБ, их стоит вынести в отдельное хранилище.";

/**
 * «Место» в «Управление» → «Знания» (владельцу; RPC kb_storage_usage):
 * сколько занимают файлы каждой базы и шаблонов и таблицы базы знаний в
 * базе данных — чтобы вовремя заметить рост (видео, курсы).
 */
export function KbStorageCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["kb_storage_usage"],
    queryFn: () => unwrap<Usage>(supabase.rpc("kb_storage_usage")),
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось посчитать место" },
  });
  const bytes = (n: number) => (n > 0 ? formatFileSize(Number(n)) : "0 Б");

  return (
    <section className="rounded-lg border bg-background p-4">
      <h2 className="mb-3 flex items-center gap-1 text-sm font-semibold">
        Место
        <FieldHint>{TIP}</FieldHint>
      </h2>
      {isLoading || !data ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <div>
              <span className="block text-xs text-muted-foreground">Файлы</span>
              <span className="text-lg font-semibold tabular-nums">{bytes(data.bytes_total)}</span>
              <span className="ml-1.5 text-xs text-muted-foreground">
                {plural(data.files_total, ["файл", "файла", "файлов"])}
              </span>
            </div>
            <div>
              <span className="block text-xs text-muted-foreground">В базе данных</span>
              <span className="text-lg font-semibold tabular-nums">{bytes(data.db_bytes)}</span>
              <span className="ml-1.5 text-xs text-muted-foreground">
                тексты, версии, учёт чтения
              </span>
            </div>
          </div>
          {data.bytes_total > FILES_WARN_BYTES && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Файлов больше 20 ГБ — пора выносить их с диска сервера в отдельное хранилище.
            </p>
          )}
          <ul className="mt-3 divide-y border-t text-sm">
            {data.bases.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium">{b.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {plural(b.articles, ["статья", "статьи", "статей"])} ·{" "}
                  {plural(b.revisions, ["версия", "версии", "версий"])}
                </span>
                <span className="w-32 shrink-0 text-right tabular-nums">
                  {bytes(b.bytes)}
                  <span className="block text-xs text-muted-foreground">
                    {plural(b.files, ["файл", "файла", "файлов"])}
                  </span>
                </span>
              </li>
            ))}
            {data.academy && (
              <li className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium">Академия</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {plural(data.academy.courses, ["курс", "курса", "курсов"])}
                </span>
                <span className="w-32 shrink-0 text-right tabular-nums">
                  {bytes(data.academy.bytes)}
                  <span className="block text-xs text-muted-foreground">
                    {plural(data.academy.files, ["файл", "файла", "файлов"])}
                  </span>
                </span>
              </li>
            )}
            <li className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate font-medium">Шаблоны</span>
              <span className="w-32 shrink-0 text-right tabular-nums">
                {bytes(data.templates.bytes)}
                <span className="block text-xs text-muted-foreground">
                  {plural(data.templates.files, ["файл", "файла", "файлов"])}
                </span>
              </span>
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
