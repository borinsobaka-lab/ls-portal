import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  useNavigate,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Refresh, SolarProvider } from "@solar-icons/react";
import { BottomNav } from "@/components/bottom-nav";
import { HeaderBackdrop } from "@/components/page-shell";
import { resetPageScrollPosition } from "@/lib/page-scroll";

import appCss from "../styles.css?url";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useClientStudio, type Studio } from "@/hooks/use-studios";
import { useViewedStudioId } from "@/hooks/use-viewed-studio";
import { APP_FORMAT, FORMAT_APP_URL } from "@/lib/app-format";
import { APP_THEME_COLOR, DEFAULT_APP_INSTALL, fetchAppInstall } from "@/lib/app-install";
import { clientCardQuery } from "@/lib/client-card";
import { homeBookingsQuery } from "@/lib/home-queries";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { PRIVACY_POLICY_INFO } from "@/lib/legal";
import { DarkSplash } from "@/formats/packages/dark-frame";
import {
  aboutQuery,
  packCatalogQuery,
  packMyBookingsQuery,
  packMyMembershipsQuery,
  packScheduleQuery,
  startOfDay,
  studioStaffQuery,
} from "@/formats/packages/queries";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";
import { RotateOverlay } from "@/components/rotate-overlay";
import { InstallScreen } from "@/components/install-screen";
import { useInstalledDisplay } from "@/hooks/use-pwa-install";
import { usePushSync } from "@/hooks/use-push-sync";
import { useAppActivity } from "@/hooks/use-app-activity";
import { NpsSurveyHost } from "@/components/nps-survey";
import { buttonVariants } from "@/components/ui/button";
import { I18nProvider, getTranslator, loadDictionary, useLocalize, useT } from "@/i18n";
import { getRequestLocale } from "@/i18n/request-locale";

// Адрес API Supabase — для preconnect: соединение (DNS + TLS) с базой
// открывается параллельно с загрузкой JS, а не после неё.
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL as string).origin;
  } catch {
    return null;
  }
})();

/**
 * Старая вкладка после деплоя: файлы прежней сборки с сервера уже удалены, и
 * переход в ещё не загруженный раздел падал с «Страница не загрузилась».
 * Перезагружаем страницу (не чаще раза в минуту, чтобы не зациклиться: та же
 * ошибка бывает и от сбоя сети, а каждая перезагрузка — полный холодный запуск
 * с десятками запросов к базе; до 2026-10-16 — раз в 10 секунд).
 */
function isStaleChunkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    message,
  );
}
function reloadForStaleChunks(): boolean {
  try {
    const key = "base40.chunkReloadAt";
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function NotFoundComponent() {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">{t("Страница не найдена")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Запрошенная страница не существует или была перемещена.")}
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("На главную")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const t = useT();

  useEffect(() => {
    if (isStaleChunkError(error)) reloadForStaleChunks();
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("Страница не загрузилась")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Что-то пошло не так. Попробуйте обновить или вернуться на главную.")}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("Попробовать снова")}
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t("На главную")}
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Язык интерфейса (cookie) и его словарь — до рендера: сервер сразу рисует
  // страницу на нём. В браузере словарь уже в памяти (hydrate в router.tsx).
  beforeLoad: async () => {
    const locale = getRequestLocale();
    await loadDictionary(locale);
    return { locale };
  },
  // Иконка и подпись приложения из админки (src/lib/app-install.ts) — для
  // фавикона и установки на рабочий стол. Грузятся при серверном рендере;
  // переходы внутри приложения их не перезапрашивают.
  loader: () => fetchAppInstall(),
  staleTime: Infinity,
  head: ({ loaderData, match }) => {
    const app = loaderData ?? DEFAULT_APP_INSTALL;
    const t = getTranslator(match.context.locale);
    const description = t(
      "Клиентское приложение {brand} — расписание, бронирование и результаты тренировок.",
      { brand: APP_BRAND },
    );
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
        { title: APP_BRAND },
        { name: "description", content: description },
        { name: "theme-color", content: APP_THEME_COLOR },
        // Подпись под значком: Android берёт её из манифеста, iOS — отсюда.
        { name: "application-name", content: app.name },
        { name: "apple-mobile-web-app-title", content: app.name },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-status-bar-style", content: "default" },
        { property: "og:title", content: APP_BRAND },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
        { name: "twitter:title", content: APP_BRAND },
        { name: "twitter:description", content: description },
      ],
      links: [
        // Шрифт (Roboto) самохостится и подключён в styles.css. Обращений к
        // Google Fonts нет намеренно: «Google Sans» там публично не раздаётся,
        // так что прежние preconnect и stylesheet уходили впустую на каждой
        // загрузке — и утекали на сторонний домен.
        {
          rel: "stylesheet",
          href: appCss,
        },
        // Два preconnect: запросы к API идут в режиме CORS без cookie
        // (crossorigin), картинки из storage — без него; у браузера это
        // разные соединения.
        ...(SUPABASE_ORIGIN
          ? [
              { rel: "preconnect", href: SUPABASE_ORIGIN, crossOrigin: "anonymous" as const },
              { rel: "preconnect", href: SUPABASE_ORIGIN },
            ]
          : []),
        { rel: "icon", type: "image/png", sizes: "32x32", href: app.icons.favicon32 },
        // /favicon.ico (Base40) — только без своей иконки: иначе часть браузеров
        // предпочла бы его.
        ...(app.custom ? [] : [{ rel: "icon", href: "/favicon.ico", sizes: "any" }]),
        { rel: "apple-touch-icon", href: app.icons.appleTouch },
        { rel: "manifest", href: "/manifest.webmanifest" },
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  const { locale } = Route.useRouteContext();
  return (
    // Формат приложения — для фирменного цвета (styles.css, --brand).
    <html lang={locale} data-app-format={APP_FORMAT}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient, locale } = Route.useRouteContext();

  useEffect(() => {
    const onPreloadError = (event: Event) => {
      if (reloadForStaleChunks()) event.preventDefault();
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  // Service worker (public/sw.js): пуш-уведомления и файлы сборки из кэша
  // телефона — повторный запуск не ждёт загрузки JS и CSS. У обоих приложений
  // (с 2026-10-15: без него нет пушей).
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // без service worker приложение работает как раньше
    });
  }, []);

  return (
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SolarProvider value={{ weight: "BoldDuotone" }}>
            <InstallGate>
              <AppShell />
            </InstallGate>
            <Toaster />
            <RotateOverlay />
          </SolarProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function LoadingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Refresh className="h-6 w-6 text-muted-foreground animate-spin" weight="BoldDuotone" />
    </div>
  );
}

function useRouteScrollReset(scrollKey: string) {
  useLayoutEffect(() => {
    resetPageScrollPosition();
    const frameId = window.requestAnimationFrame(resetPageScrollPosition);
    const timeoutId = window.setTimeout(resetPageScrollPosition, 50);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [scrollKey]);
}

// Только click: pointerdown/touchstart срабатывают и в начале жеста прокрутки,
// так что палец, поставленный на ссылку («Перейти в профиль», «Забронировать»),
// чтобы пролистать страницу, сбрасывал прокрутку наверх. Click приходит лишь
// при настоящем нажатии и (capture на document) раньше навигации роутера.
function useInternalNavigationScrollReset() {
  useEffect(() => {
    const handleNavigationStart = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;

      const url = new URL(link.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;

      resetPageScrollPosition();
    };

    document.addEventListener("click", handleNavigationStart, true);
    return () => {
      document.removeEventListener("click", handleNavigationStart, true);
    };
  }, []);
}

/**
 * Клиент студии другого формата: у каждого формата своё приложение
 * (src/lib/app-format.ts), здесь его расписание и абонементы не работают.
 */
function OtherAppScreen({ studio }: { studio: Studio }) {
  const t = useT();
  const loc = useLocalize();
  const { signOut } = useAuth();
  const url = FORMAT_APP_URL[studio.format];
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold">{t("Ваша студия — в другом приложении")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Студия «{name}» работает в приложении {app}. Войдите там с той же почтой.", {
            name: loc(studio).name,
            app: url.replace(/^https?:\/\//, ""),
          })}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <a href={url} className={buttonVariants()}>
            {t("Открыть приложение студии")}
          </a>
          <button
            type="button"
            onClick={() => signOut()}
            className="h-12 text-sm text-muted-foreground"
          >
            {t("Выйти")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Анкета пройдена — помним на телефоне (по пользователю): раньше каждый
// запуск приложения ждал под спиннером запрос member_profiles, прежде чем
// показать главную. Пройденная анкета обратно не сбрасывается, но при выходе
// флаг стирается: анкету стирают вместе с карточкой клиента
// (db/migrations/2026-10-12_client_account_wipe.sql), и после новой карточки
// тот же user.id должен пройти её заново.
const ONBOARDED_KEY = "base40.onboarded";
function readOnboarded(userId: string) {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === userId;
  } catch {
    return false;
  }
}
function clearOnboarded() {
  try {
    window.localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    // приватный режим — флага и не было
  }
}
function markOnboarded(userId: string) {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, userId);
  } catch {
    // приватный режим — проверим анкету при следующем запуске
  }
}

/**
 * Пока клиент смотрит первый экран, фоном подгружаются код остальных разделов
 * и (в пакетном приложении) их данные: переход по нижнему меню открывает
 * экран сразу, без скелетона и ожидания сети. Данные главной (карточка,
 * записи) запрашиваются ещё раньше — сразу после входа, параллельно с
 * проверкой анкеты.
 */
function usePrefetchScreens(ready: boolean) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { studioId, studioReady } = useViewedStudioId();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    queryClient.prefetchQuery(clientCardQuery(userId));
    queryClient.prefetchQuery(homeBookingsQuery(userId));
  }, [userId, queryClient]);

  useEffect(() => {
    if (!ready || !userId || !studioReady) return;
    let timer: number | null = null;
    let idleId: number | null = null;
    const run = () => {
      for (const to of ["/", "/schedule", "/club", "/memberships", "/profile"] as const) {
        router.preloadRoute({ to }).catch(() => {});
      }
      if (!IS_PACKAGES) return;
      const today = startOfDay(new Date());
      queryClient.prefetchQuery(packScheduleQuery(studioId, today));
      queryClient.prefetchQuery(packMyBookingsQuery(userId, today));
      queryClient.prefetchQuery(packCatalogQuery());
      queryClient.prefetchQuery(packMyMembershipsQuery(userId));
      queryClient.prefetchQuery(aboutQuery());
      if (studioId) queryClient.prefetchQuery(studioStaffQuery(studioId));
    };
    // Сначала — запросы самого экрана (ждём, пока догрузятся, но не дольше
    // ~5 секунд), потом, когда браузер свободен, — остальное.
    let attempts = 0;
    const waitForScreen = () => {
      timer = null;
      if (queryClient.isFetching() > 0 && attempts++ < 20) {
        timer = window.setTimeout(waitForScreen, 250);
        return;
      }
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        run();
      }
    };
    timer = window.setTimeout(waitForScreen, 300);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (idleId !== null) window.cancelIdleCallback(idleId);
    };
  }, [ready, userId, studioId, studioReady, router, queryClient]);
}

/**
 * Страницы, которые открываются без входа и без установки: обратная связь
 * (ссылка и QR-код клуба из админки) и политика (только у Lady Stretch).
 */
const PUBLIC_ROUTES = new Set(["/feedback", ...(PRIVACY_POLICY_INFO ? ["/privacy"] : [])]);

/**
 * Заслон установки: в дев-сервере — только с ?install в адресе (проверить
 * экран инструкции), иначе разработка шла бы через установку.
 */
const INSTALL_GATE =
  import.meta.env.PROD ||
  (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("install"));

/**
 * Без установки на телефон приложение не открывается (решение владельца
 * 2026-10-15): во вкладке браузера вместо него — инструкция по установке
 * (components/install-screen.tsx). Открыто ли установленным — известно
 * только в браузере: сервер и гидратация рисуют приложение как раньше
 * (у пакетного это заставка), затем во вкладке — инструкция. Публичные
 * страницы (обратная связь, политика) открываются и в браузере.
 */
function InstallGate({ children }: { children: ReactNode }) {
  const installed = useInstalledDisplay();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (INSTALL_GATE && installed === false && !PUBLIC_ROUTES.has(pathname)) {
    return <InstallScreen />;
  }
  return children;
}

function AppShell() {
  const { session, user, loading } = useAuth();
  const studio = useClientStudio();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onAuthRoute = pathname === "/auth";
  const onOnboardingRoute = pathname === "/onboarding";
  // Открываются и без входа (обратная связь по QR-коду, политика — ссылка у входа).
  const onPublicRoute = PUBLIC_ROUTES.has(pathname);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  useRouteScrollReset(pathname);
  useInternalNavigationScrollReset();
  usePushSync();
  useAppActivity();

  useEffect(() => {
    if (loading) return;
    if (!session && !onAuthRoute && !onPublicRoute) navigate({ to: "/auth", replace: true });
    if (session && onAuthRoute) navigate({ to: "/", replace: true });
  }, [loading, session, onAuthRoute, onPublicRoute, navigate]);

  // Reset when user changes / signs out
  useEffect(() => {
    if (!user) setOnboardingChecked(false);
    if (!loading && !user) clearOnboarded();
  }, [user, loading]);

  // Onboarding gate: if logged in and member_profiles.onboarding_completed_at IS NULL → /onboarding
  useEffect(() => {
    if (loading || !user) return;
    if (onAuthRoute) return;
    // Публичную страницу (политику, обратную связь) открывают и до анкеты — проверка при уходе с неё.
    if (onOnboardingRoute || onPublicRoute || readOnboarded(user.id)) {
      setOnboardingChecked(true);
      return;
    }
    let cancelled = false;
    let retry = 0;
    const check = async (attempt: number) => {
      const { data, error } = await supabase
        .from("member_profiles")
        .select("onboarding_completed_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      // Ошибку запроса нельзя трактовать как «анкета не заполнена»: иначе
      // разовый сбой сети уводит уже прошедшего онбординг клиента в опросник,
      // а его завершение перезаписывает анкету пустыми ответами. И сразу
      // пускать на главную тоже нельзя — у нового клиента она мелькала перед
      // анкетой: сначала несколько повторов, и только без сети — главная.
      if (error) {
        if (attempt < 3) {
          retry = window.setTimeout(() => void check(attempt + 1), 800 * (attempt + 1));
        } else {
          setOnboardingChecked(true);
        }
        return;
      }
      if (!data || !data.onboarding_completed_at) {
        navigate({ to: "/onboarding", replace: true });
      } else {
        markOnboarded(user.id);
        setOnboardingChecked(true);
      }
    };
    void check(0);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [loading, user, onAuthRoute, onOnboardingRoute, onPublicRoute, navigate]);

  const onboardedCached = !!user && readOnboarded(user.id);
  usePrefetchScreens(
    !loading &&
      !!session &&
      !onAuthRoute &&
      !onOnboardingRoute &&
      (onboardingChecked || onboardedCached),
  );

  if (onAuthRoute) {
    // Пакетное: вместо белой пелены поверх тёмного экрана входа — заставка.
    if (IS_PACKAGES && loading) return <DarkSplash />;
    return (
      <div className="min-h-screen bg-background text-foreground flex justify-center">
        <div className="w-full max-w-md flex flex-col min-h-screen relative">
          <main className="flex-1 relative">
            <Outlet />
            {loading && <LoadingOverlay />}
          </main>
        </div>
      </div>
    );
  }

  // Студия известна и другого формата — дальше не пускаем (ни в анкету, ни в
  // разделы). Пока студия грузится или база без форматов — работаем как обычно.
  if (session && studio && studio.format !== APP_FORMAT) {
    return <OtherAppScreen studio={studio} />;
  }

  if (onOnboardingRoute) {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex justify-center">
        <div className="w-full max-w-md flex flex-col min-h-[100dvh] relative">
          <Outlet />
          {loading && <LoadingOverlay />}
        </div>
      </div>
    );
  }

  const showAppLoading = loading || (!!session && !onboardingChecked && !onboardedCached);

  // Публичная страница без входа: шапка с огоньками, без нижнего меню.
  if (onPublicRoute && !session) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-muted/60 text-foreground flex justify-center">
        <div className="w-full max-w-md flex h-full min-h-0 flex-col relative bg-muted/60 overflow-hidden">
          <HeaderBackdrop />
          <main key={pathname} className="flex-1 min-h-0 overflow-hidden relative">
            <Outlet />
          </main>
        </div>
      </div>
    );
  }

  // Пакетное приложение: пока вход и анкета не проверены — тёмная заставка
  // во весь экран, а не каркас главной (иначе новый клиент видел главную
  // перед онбордингом); без сессии — тоже она, пока не откроется вход.
  if (IS_PACKAGES && (showAppLoading || !session)) {
    return <DarkSplash />;
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-muted/60 text-foreground flex justify-center">
      <div className="w-full max-w-md flex h-full min-h-0 flex-col relative bg-muted/60 overflow-hidden">
        {/* Шапка с огоньками — одна на все разделы (не пересоздаётся при переходе). */}
        <HeaderBackdrop />
        <main key={pathname} className="flex-1 min-h-0 overflow-hidden relative">
          {!showAppLoading && <Outlet />}
          {showAppLoading && <LoadingOverlay />}
        </main>

        {!showAppLoading && <BottomNav />}
        {/* NPS-опрос модальным окном — на главной, когда база его назначила. */}
        {!showAppLoading && session && <NpsSurveyHost />}
      </div>
    </div>
  );
}
