import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminShell } from "@/components/admin-shell";
import { StudioBranding } from "@/components/studio-branding";
import { AppShellSkeleton, RoutePendingSkeleton } from "@/components/skeletons";
import { hasStaffRole } from "@/lib/roles";
import { studiosQuery } from "@/hooks/use-studios";
import { staffProfileQuery } from "@/hooks/use-staff-profile";
import { adminPermissionsQuery, useAdminAccess } from "@/hooks/use-admin-access";
import { kbBasesQuery, kbOwnGrantsQuery } from "@/lib/kb/data";
import { acadAccessQuery } from "@/lib/academy/data";
import { analyticsAccessQuery } from "@/lib/analytics/data";
import { accessMeQuery } from "@/lib/access/data";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { canOpenPath, firstAllowedUrl } from "@/lib/nav-sections";
import { usePreloadSections } from "@/hooks/use-preload-sections";

/**
 * Кто уже прошёл полную проверку в этой вкладке. beforeLoad выполняется на
 * КАЖДОМ переходе между разделами: раньше это были два запроса по сети
 * подряд (getUser в GoTrue и роль в user_roles) до того, как раздел вообще
 * начинал открываться. Теперь полная проверка — один раз на человека, дальше
 * хватает сессии из localStorage (getSession без сети, пока жив токен).
 * Отозванную роль это не пропустит к данным: границу держит RLS.
 */
let verifiedUserId: string | null = null;

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const sessionUser = sessionData.session?.user;
    if (!sessionUser) {
      verifiedUserId = null;
      // После входа — обратно сюда: ссылку на статью прислали тому, кто не вошёл.
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }

    // Меню, права и профиль нужны любой странице — грузим их сразу и
    // параллельно с проверкой, а не после неё по очереди.
    void queryClient.prefetchQuery(studiosQuery);
    void queryClient.prefetchQuery(adminPermissionsQuery);
    void queryClient.prefetchQuery(staffProfileQuery);
    void queryClient.prefetchQuery(kbBasesQuery);
    void queryClient.prefetchQuery(kbOwnGrantsQuery);
    void queryClient.prefetchQuery(acadAccessQuery);
    void queryClient.prefetchQuery(analyticsAccessQuery);
    void queryClient.prefetchQuery(accessMeQuery);

    if (verifiedUserId === sessionUser.id) return { user: sessionUser };

    // Одной авторизации мало: клиент мобильного приложения — тоже
    // авторизованный пользователь этого же проекта Supabase. В админку
    // пускаем только сотрудников клубов и людей портала с ролями
    // (is_portal_user: сотрудник УК может быть без клуба).
    // Сбой самой проверки роли — исключение: страница ошибки с «Повторить»,
    // без выхода из аккаунта. getUser сверяет сессию с сервером (локальная
    // могла быть отозвана), роль проверяется одновременно с ним.
    // Отозванная сессия важнее сбоя проверки роли: сначала ответ getUser.
    const staffCheck = hasStaffRole(supabase, sessionUser.id);
    staffCheck.catch(() => {});
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user || data.user.id !== sessionUser.id) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    // scope local — не трогаем сессии на других устройствах.
    if (!(await staffCheck)) {
      await supabase.auth.signOut({ scope: "local" });
      throw redirect({ to: "/auth" });
    }

    // Кэш — только в браузере: на сервере (если когда-нибудь включат SSR
    // этого роута) модуль общий для всех посетителей.
    if (typeof window !== "undefined") verifiedUserId = data.user.id;
    return { user: data.user };
  },
  // Пока проверяется вход (и при ssr: false — в HTML с сервера) — скелетон
  // всего каркаса, а не белый экран.
  pendingComponent: AppShellSkeleton,
  component: AuthenticatedLayout,
});

/**
 * Каркас админки живёт здесь, а не в AdminShell на каждой странице.
 *
 * Иначе боковое меню размонтируется и монтируется заново при каждом переходе:
 * его прокрутка отскакивала наверх, а сама панель на кадр перерисовывалась.
 * В layout-роуте она монтируется один раз, а меняется только содержимое
 * Outlet — AdminShell рисует шапку с заголовком и тело страницы.
 */
function AuthenticatedLayout() {
  usePreloadSections();
  return (
    // Меню всегда развёрнуто: кнопку сворачивания убрали, а сохранённое в
    // cookie «свёрнуто» иначе оставило бы меню свёрнутым без пути назад.
    // На мобильном шторка управляется отдельно (openMobile) и работает как раньше.
    <SidebarProvider open>
      <StudioBranding />
      {/* h-dvh, а не h-screen: в мобильном Safari 100vh выше видимой области
          (под адресной строкой), и низ страницы с пагинацией уезжал за экран. */}
      {/*
        С md фон каркаса — цвет меню, а рабочая область лежит поверх него
        скруглённой панелью с тонкой тёмной рамкой сверху, справа и снизу:
        рамка продолжает меню. Слева отступа нет — там само меню. До md меню
        в шторке, рамка только съела бы ширину телефона — панель во весь экран.
      */}
      <div className="flex h-dvh w-full overflow-hidden bg-canvas md:bg-sidebar md:py-1.5 md:pr-1.5">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas md:rounded-xl">
          <AccessGate />
        </div>
      </div>
    </SidebarProvider>
  );
}

/**
 * Разделы, закрытые сотруднику в «Доступах»: страница не открывается, а
 * уводит на первую доступную. Это интерфейс, не защита: данные студии
 * ограничивает RLS (роль в студии), разделы рейки — has_admin_section.
 */
function AccessGate() {
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const studioId = useActiveStudioId();
  const access = useAdminAccess();

  // Пока права грузятся — скелетон открываемой страницы (её pendingComponent),
  // чтобы закрытая страница не мелькнула, а раскладка не прыгала.
  if (!access) return <RoutePendingSkeleton />;
  if (canOpenPath(access, studioId, pathname)) return <Outlet />;

  const fallback = firstAllowedUrl(access, studioId);
  if (fallback && fallback !== pathname) return <Navigate to={fallback} replace />;
  return (
    <AdminShell title="Нет доступа">
      <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
        Нет доступных разделов. Попросите администратора выдать роль в «Пользователях и ролях».
      </div>
    </AdminShell>
  );
}
