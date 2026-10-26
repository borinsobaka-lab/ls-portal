import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { readDocumentLocale } from "@/i18n";
import { APP_FORMAT } from "@/lib/app-format";
import { unregisterPushDevice } from "@/lib/push";
import {
  clearPersistedQueryCache,
  persistQueryCache,
  restoreQueryCache,
} from "@/lib/query-persist";

type AuthCtx = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /**
   * Отправляет код входа на почту (письмо отправляет хук писем портала по
   * SMTP). Регистрации в приложении нет: войти может только тот,
   * чья почта есть в карточке клиента на портале. При первом входе GoTrue
   * создаёт учётную запись, а триггер handle_new_user привязывает её к
   * карточке или отказывает, если карточки нет
   * (db/migrations/…_client_signin_only.sql).
   */
  requestOtp: (email: string) => Promise<{ error: string | null }>;
  /** Проверяет код из письма. Успех = сессия появляется через onAuthStateChange. */
  verifyOtp: (email: string, token: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

// supabase-js при каждом возврате вкладки в фокус (и при обновлении токена)
// перечитывает сессию из storage и шлёт SIGNED_IN с НОВЫМ объектом user. Все
// эффекты страниц зависят от `user`, поэтому без стабилизации каждое
// переключение приложений перезагружало расписание/абонементы со скелетоном,
// затирало несохранённую анкету онбординга и форму профиля. Сохраняем прежние
// объекты, пока по существу ничего не поменялось.
function sameSession(a: Session | null, b: Session | null) {
  return a?.access_token === b?.access_token && a?.user?.id === b?.user?.id;
}
function sameUser(a: User | null, b: User | null) {
  return a?.id === b?.id && a?.updated_at === b?.updated_at;
}

/**
 * Сессия, сохранённая supabase-js в localStorage, — без сети. getSession()
 * при истёкшем токене (приложение не открывали дольше часа) сначала
 * обновляет его запросом к серверу, и всё приложение ждало этот запрос под
 * спиннером. Пользователь из сохранённой сессии позволяет сразу показать
 * экран с данными из кэша; запросы к базе сами дождутся свежего токена, а
 * если сессия больше недействительна — придёт SIGNED_OUT и вход.
 */
function readStoredSession(): Session | null {
  try {
    const key = (supabase.auth as unknown as { storageKey?: string }).storageKey;
    const raw = key ? window.localStorage.getItem(key) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session | null;
    return parsed?.access_token && parsed.refresh_token && parsed.user?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Кэш данных (src/lib/query-persist.ts) — только текущего пользователя:
    // при смене пользователя или выходе прежние данные стираются, иначе
    // следующий вошедший на этом телефоне увидел бы чужие записи.
    let activeUserId: string | null = null;
    let stopPersisting: (() => void) | null = null;
    const switchUser = (userId: string | null) => {
      if (userId === activeUserId) return;
      stopPersisting?.();
      stopPersisting = null;
      if (activeUserId !== null) queryClient.clear();
      activeUserId = userId;
      if (userId) {
        restoreQueryCache(queryClient, userId);
        stopPersisting = persistQueryCache(queryClient, userId);
      } else {
        clearPersistedQueryCache();
      }
    };

    const apply = (s: Session | null) => {
      // Кэш — до обновления состояния: экраны монтируются уже с данными.
      switchUser(s?.user?.id ?? null);
      setSession((prev) => (sameSession(prev, s) ? prev : s));
      const nextUser = s?.user ?? null;
      setUser((prev) => (sameUser(prev, nextUser) ? prev : nextUser));
    };

    const stored = readStoredSession();
    if (stored) {
      apply(stored);
      setLoading(false);
    }
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => apply(s));
    supabase.auth.getSession().then(({ data }) => {
      apply(data.session);
      setLoading(false);
    });
    return () => {
      sub.subscription.unsubscribe();
      stopPersisting?.();
    };
  }, [queryClient]);

  const value: AuthCtx = {
    session,
    user,
    loading,
    requestOtp: async (email) => {
      // emailRedirectTo задаём явно, хотя вход идёт по коду: по хосту в нём
      // обработчик писем (admin: /api/auth-email) отличает клиентское
      // приложение от админки. Без этого Supabase подставит Site URL
      // (= админка), и клиенту уйдёт письмо админки. В ?lang= — язык,
      // выбранный сейчас: на нём придёт письмо с кодом (без него —
      // английский). Путь «/» обязателен: разрешённые адреса GoTrue —
      // `https://<хост>/**`, адрес без пути с ними не совпал бы.
      const locale = readDocumentLocale();
      const emailRedirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/?lang=${locale}` : undefined;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          // Учётную запись создаём при первом входе — но только для почты из
          // карточки клиента (проверяет триггер в базе, не фронтенд).
          shouldCreateUser: true,
          emailRedirectTo,
          // Формат приложения: если карточки с этой почтой есть в студиях
          // обоих форматов, триггер привяжет карточку студии этого формата.
          // Язык — и в метаданные новой учётной записи (у существующей
          // GoTrue их из запроса не обновляет).
          data: { app_format: APP_FORMAT, locale },
        },
      });
      return { error: error?.message ?? null };
    },
    verifyOtp: async (email, token) => {
      const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      return { error: error?.message ?? null };
    },
    signOut: async () => {
      // Пока сессия жива — телефон больше не получает пуши этого человека.
      await unregisterPushDevice();
      // scope local: учётная запись у сотрудника-клиента общая с админкой, а
      // глобальный выход (по умолчанию) отозвал бы и его сессии в админке.
      await supabase.auth.signOut({ scope: "local" });
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
