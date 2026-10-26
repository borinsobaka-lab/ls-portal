import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { useAuth } from "@/hooks/use-auth";
import { isNotMemberError, markSignInRefused } from "@/lib/sign-in-refused";

// Студия текущего клиента (clients.studio_id).
//
// Зачем: расписание, новости и услуги должны показывать данные студии клиента,
// а не всех студий сразу — с открытием второй точки нефильтрованные запросы
// начали бы смешивать контент. Паттерн тот же, что уже используется в
// memberships.tsx (там студия берётся из загруженной карточки клиента).
//
// studioId === null при studioReady === true означает «гость или клиент без
// карточки» — в этом случае страницы оставляют запросы нефильтрованными,
// то есть поведение при одной студии не меняется.
//
// Кэш — React Query по пользователю (ключ с user.id: студия прежнего
// пользователя новому не достаётся), он же сохраняется между запусками и
// деплоями (src/lib/query-persist.ts, meta.persist = "stable"): при повторном
// открытии приложения студия известна сразу и контент грузится без ожидания
// этого запроса.

type State = { studioId: string | null; studioReady: boolean };

// Ошибки запросов пробрасываем, а не превращаем в null: разовый сбой сети
// не должен закэшироваться как «студии нет» (клиент видел бы расписание и
// новости всех студий). Ошибка не кэшируется и запрашивается снова.
async function fetchStudioId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("studio_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data?.studio_id) return data.studio_id;

  // Карточки по user_id нет — сервер привязывает свободную карточку с той же
  // почтой (её могли завести на портале позже учётной записи). Нет и такой —
  // человек не член клуба: выходим, экран входа покажет причину.
  const { data: ensured, error: ensureError } = await untypedDb.rpc("ensure_client_profile");
  if (isNotMemberError(ensureError)) {
    markSignInRefused();
    // Только эта вкладка: сотрудника без карточки клиента не выкидываем из
    // админки (учётная запись у них общая).
    await supabase.auth.signOut({ scope: "local" });
  }
  if (ensureError) throw ensureError;
  const row = Array.isArray(ensured) ? ensured[0] : ensured;
  return row?.studio_id ?? null;
}

export function useClientStudioId(): State {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const q = useQuery({
    queryKey: ["client-studio-id", userId],
    queryFn: () => fetchStudioId(userId!),
    enabled: !loading && !!userId,
    staleTime: 10 * 60_000,
    // Переживает деплой (src/lib/query-persist.ts): от студии зависят все
    // остальные запросы главной.
    meta: { persist: "stable" },
  });

  if (loading) return { studioId: null, studioReady: false };
  if (!userId) return { studioId: null, studioReady: true };
  if (q.data !== undefined) return { studioId: q.data, studioReady: true };
  // Не оставляем приложение в вечном скелетоне: без карточки клиента
  // страницы просто не фильтруют по студии — как для гостя.
  if (q.isError) return { studioId: null, studioReady: true };
  return { studioId: null, studioReady: false };
}
