import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";

/**
 * Кэш данных React Query в localStorage — чтобы приложение, выгруженное из
 * памяти телефона, при следующем открытии сразу показывало главную, расписание
 * и абонементы с прошлыми данными, а свежие подтягивало фоном (без скелетонов
 * и без ожидания сети).
 *
 * Кэш привязан к пользователю: чужие данные не восстанавливаются, при выходе
 * кэш стирается (use-auth.tsx). Номер сборки (__BUILD_ID__) сбрасывает кэш
 * после каждого деплоя: новый код может ждать другие поля в ответах.
 * Исключение — запросы с meta.persist = "stable" (студия клиента: простое
 * значение, форма которого не меняется): они переживают деплой, и первый
 * запуск новой версии не ждёт их перед загрузкой остального.
 */

const STORAGE_KEY = "base40.queryCache";
const STABLE_KEY = "base40.queryCacheStable";
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const WRITE_DELAY_MS = 1000;

type Persisted = {
  buildId: string;
  userId: string;
  savedAt: number;
  state: ReturnType<typeof dehydrate>;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function restoreKey(
  ls: Storage,
  key: string,
  queryClient: QueryClient,
  userId: string,
  checkBuild: boolean,
) {
  try {
    const raw = ls.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw) as Persisted;
    if (
      (checkBuild && saved.buildId !== __BUILD_ID__) ||
      saved.userId !== userId ||
      Date.now() - saved.savedAt > MAX_AGE_MS
    ) {
      ls.removeItem(key);
      return;
    }
    hydrate(queryClient, saved.state);
  } catch {
    try {
      ls.removeItem(key);
    } catch {
      // ничего
    }
  }
}

/** Восстановить кэш этого пользователя (если он есть и не устарел). */
export function restoreQueryCache(queryClient: QueryClient, userId: string) {
  const ls = storage();
  if (!ls) return;
  restoreKey(ls, STABLE_KEY, queryClient, userId, false);
  restoreKey(ls, STORAGE_KEY, queryClient, userId, true);
}

export function clearPersistedQueryCache() {
  try {
    storage()?.removeItem(STORAGE_KEY);
    storage()?.removeItem(STABLE_KEY);
  } catch {
    // нет доступа к хранилищу — нечего стирать
  }
}

/**
 * Сохранять кэш, пока пользователь вошёл. Запись — с задержкой после
 * изменений и сразу при уходе приложения в фон (телефон может выгрузить его
 * в любой момент). Возвращает отписку.
 */
export function persistQueryCache(queryClient: QueryClient, userId: string): () => void {
  const ls = storage();
  if (!ls) return () => {};
  let timer: number | null = null;

  const write = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    try {
      // Только успешные ответы и только то, что не помечено meta.persist = false.
      const save = (key: string, stable: boolean) => {
        const state = dehydrate(queryClient, {
          shouldDehydrateQuery: (q) =>
            q.state.status === "success" &&
            q.meta?.persist !== false &&
            (q.meta?.persist === "stable") === stable,
        });
        const value: Persisted = { buildId: __BUILD_ID__, userId, savedAt: Date.now(), state };
        ls.setItem(key, JSON.stringify(value));
      };
      save(STABLE_KEY, true);
      save(STORAGE_KEY, false);
    } catch {
      // Переполнено хранилище или приватный режим — работаем без кэша.
    }
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = window.setTimeout(write, WRITE_DELAY_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" || event.type === "removed") schedule();
  });
  const onHide = () => {
    if (document.visibilityState === "hidden") write();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", write);

  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", write);
    if (timer !== null) window.clearTimeout(timer);
  };
}
