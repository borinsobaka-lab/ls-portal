import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Слой данных админки — React Query.
 *
 * Соглашения:
 * - queryKey начинается с имени таблицы/вью, дальше studioId и параметры:
 *   ["promo_codes", studioId]. После записи — invalidateQueries({ queryKey:
 *   ["promo_codes"] }); кнопка «Обновить» в шапке инвалидирует всё.
 * - queryFn бросает исключение при ошибке Supabase — для этого unwrap().
 * - Текст ошибки загрузки задаётся в meta.errorMessage, тост показывает
 *   QueryCache ниже: «Не удалось загрузить промокоды: <текст ошибки>».
 */

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { errorMessage?: string };
    mutationMeta: { errorMessage?: string };
  }
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const prefix = query.meta?.errorMessage;
        if (prefix) toast.error(`${prefix}: ${error.message}`);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        const prefix = mutation.meta?.errorMessage;
        if (prefix) toast.error(`${prefix}: ${error.message}`);
      },
    }),
    defaultOptions: {
      queries: {
        retry: 1,
        // Данные студии меняют и другие сотрудники, и клиенты из приложения:
        // при открытии раздела показываем кэш и тут же перезапрашиваем.
        staleTime: 0,
        // Кэш раздела живёт полчаса (по умолчанию — 5 минут): вернувшись в
        // раздел, видим прежние строки сразу, а свежие подменяют их фоном —
        // вместо скелетона на каждом заходе. На сервере — без таймера:
        // QueryClient создаётся на каждый запрос, и таймер держал бы в памяти
        // кэш отрисованного запроса полчаса (Infinity — значение React Query
        // по умолчанию для сервера: кэш уходит вместе с запросом).
        gcTime: typeof window === "undefined" ? Infinity : 30 * 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

type SupabaseResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};

/** Результат запроса Supabase -> данные; ошибка -> исключение (для queryFn). */
export async function unwrap<T>(query: PromiseLike<SupabaseResult>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Как unwrap, но для списков с { count: "exact" }: строки и общее число. */
export async function unwrapPage<T>(
  query: PromiseLike<SupabaseResult>,
): Promise<{ rows: T[]; count: number }> {
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: (data ?? []) as T[], count: count ?? 0 };
}
