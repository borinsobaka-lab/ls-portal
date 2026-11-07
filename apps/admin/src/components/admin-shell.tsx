import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Cat, RefreshCw, Sun, X } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StudioSwitcher } from "@/components/studio-switcher";
import { Button } from "@/components/ui/button";
import { HeaderClientSearch } from "@/components/header-client-search";
import { BugReportButton } from "@/components/bug-report";
import { useNotifUnread } from "@/lib/notifications/data";
import { FLOATING_STACK_CLASS } from "@/lib/floating-layout";
import { KbBaseTabs, KbHeaderSearch } from "@/components/kb/kb-header";
import { WorkdayButton } from "@/components/workday/workday-button";
import { KB_ACTIONS_SLOT, KB_HEADER_ROW, KB_SEARCH_SLOT } from "@/lib/kb/header-layout";
import { MAIN_HEADER_GRID, MAIN_HEADER_STUDIO } from "@/lib/header-layout";
import { useKbDarkTheme } from "@/lib/kb/theme";
import { isKbToolPath, kbBaseIdOf, railSectionKey } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";
import { CLUBS_HIDDEN } from "@/lib/launch";
import { AnalyticsPresence } from "@/components/analytics/presence";
import { presenceDashboard } from "@/lib/analytics/core";

// Kate (AI SDK, markdown) — отдельным чанком: в общем каркасе он прибавлял к
// первой загрузке любой страницы ~80 kB, а открывают его редко. Наведение на
// кнопку начинает загрузку заранее.
const loadKateChat = () => import("@/components/kate-chat");
const KateChat = lazy(() => loadKateChat().then((m) => ({ default: m.KateChat })));

/**
 * Действия страницы («Продажа», «Добавить тренировку»…) — крупные кнопки,
 * плавающие в правом нижнем углу рабочей области. AdminShell ставит сюда
 * свой проп `actions`; раздел, где действие зависит от таба («Прочие
 * продажи»), рендерит FloatingActions сам — где угодно внутри страницы.
 * Размер и тень кнопок — `.fab-actions` в styles.css: на месте кнопкам
 * размер не задаём, там же запас снизу у main.
 * Рендерить один раз: внутри бывают диалоги со своим состоянием.
 */
export function FloatingActions({ children }: { children: ReactNode }) {
  // Ширина кнопок — в --fab-width у рабочей области: по ней пагинация
  // отодвигает свои стрелки левее кнопок (styles.css, .data-pagination).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest<HTMLElement>(".admin-main");
    if (!el || !main) return;
    const observer = new ResizeObserver(() =>
      main.style.setProperty("--fab-width", `${el.offsetWidth}px`),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      main.style.removeProperty("--fab-width");
    };
  }, []);
  return (
    <div
      ref={ref}
      className="fab-actions pointer-events-auto flex flex-wrap items-center justify-end gap-3"
    >
      {children}
    </div>
  );
}

/**
 * Кнопка меню на узком экране (меню и рейка — в шторке). Есть непрочитанные
 * уведомления — красная точка: раздел «Уведомления» в рейке, а рейку на
 * телефоне без шторки не видно.
 */
function MenuTrigger() {
  const unread = useNotifUnread();
  return (
    <span className="relative -ml-1 inline-flex shrink-0 md:hidden">
      <SidebarTrigger className="size-10" />
      {unread > 0 && (
        <span
          aria-label={`Непрочитанных уведомлений: ${unread}`}
          className="pointer-events-none absolute top-1.5 right-1.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
        />
      )}
    </span>
  );
}

export function AdminShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [kateOpen, setKateOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // База знаний — своя шапка (решение владельца 2026-10-25): вкладки баз и
  // поиск по базе вместо заголовка и поиска клиента, без Kate и выбора
  // клуба (базы общие для сети); главная базы, папки и статьи — на белом,
  // служебные страницы («Аналитика», «Шаблоны», «Корзина») — на канве.
  const kb = railSectionKey(pathname) === "kb";
  // «Академия» общая для сети, «Аналитика» — над клубами (клубы выбираются
  // фильтрами отчёта): только заголовок, без поиска клиента, Kate и выбора
  // клуба.
  // Пока клубы скрыты (lib/launch.ts), так же и «Управление»: поиск клиента,
  // «Рабочий день», Kate и выбор клуба — только для разделов клубов.
  const network =
    ["academy", "analytics"].includes(railSectionKey(pathname)) || (CLUBS_HIDDEN && !kb);
  const kbBaseId = kb ? kbBaseIdOf(pathname) : null;
  // «Посещаемость» «Аналитики»: страницы раздела шлют пульс (их /presence).
  const presence = presenceDashboard(pathname);
  // Тёмная тема базы знаний: класс на <html> вешает StudioBranding.
  const [kbDarkTheme, toggleKbTheme] = useKbDarkTheme();

  // «Обновить»: иконка крутится, пока перезагружаются лоадеры роута и
  // активные запросы, но не короче MIN_SPIN_MS — иначе быстрый ответ мигал бы
  // незаметно и казалось, что ничего не произошло.
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    const MIN_SPIN_MS = 700;
    try {
      await Promise.all([
        router.invalidate(),
        queryClient.invalidateQueries(),
        new Promise((r) => setTimeout(r, MIN_SPIN_MS)),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // В шапке базы знаний — в кружке, как кнопка темы (outline).
  const refreshButton = (variant: "ghost" | "outline" = "ghost") => (
    <Button
      variant={variant}
      size="icon"
      aria-label={refreshing ? "Обновляется…" : "Обновить"}
      title="Обновить"
      aria-busy={refreshing}
      className="shrink-0 disabled:opacity-100"
      disabled={refreshing}
      onClick={() => void refresh()}
    >
      <RefreshCw
        className={cn(variant === "ghost" ? "h-5 w-5" : "size-4", refreshing && "animate-spin")}
      />
    </Button>
  );

  return (
    <>
      {presence && <AnalyticsPresence dashboard={presence} />}
      {kb ? (
        // Раскладка — lib/kb/header-layout.ts: первая строка — поиск ровно по
        // центру, тема и «Обновить» у края; вторая — базы знаний (если их
        // больше одной). Заголовок страницы — для скринридера: название
        // статьи и так крупно над текстом.
        <header className="shrink-0 border-b bg-background text-foreground">
          <div className={KB_HEADER_ROW}>
            <MenuTrigger />
            <h1 className="sr-only">{title}</h1>
            {kbBaseId && (
              <KbHeaderSearch key={kbBaseId} baseId={kbBaseId} className={KB_SEARCH_SLOT} />
            )}
            <div className={KB_ACTIONS_SLOT}>
              {/* Значок темы — всегда солнце (решение владельца 2026-11-01:
                  месяц из набора иконок не узнавали); включена ли тёмная —
                  aria-pressed и подсказка. */}
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-pressed={kbDarkTheme}
                aria-label={kbDarkTheme ? "Светлая тема" : "Тёмная тема"}
                title={kbDarkTheme ? "Светлая тема" : "Тёмная тема"}
                onClick={toggleKbTheme}
              >
                <Sun />
              </Button>
              {refreshButton("outline")}
            </div>
          </div>
          <KbBaseTabs />
        </header>
      ) : (
        <>
          {/*
        Шапка сплошная белая: она не перекрывает прокручиваемый контент (main —
        соседний блок), поэтому полупрозрачность только подмешивала подложку и
        размывала границу между шапкой и рабочей областью.

        С lg — три части: слева заголовок и «Обновить», по центру поиск
        клиента и «Рабочий день», справа Kate и выбор клуба. С xl — сетка
        (MAIN_HEADER_GRID): крайние колонки равны и не меньше правой части,
        заголовок обрезается, поэтому поиск стоит на одном месте на всех
        страницах, какой бы длины ни был заголовок (решение владельца
        2026-10-26: поиск «скакал» при переходе между разделами). С lg до xl
        места на равные колонки нет — заголовок берёт ширину по тексту.
        Узкий экран (до lg): первая строка — меню, заголовок, «Обновить»,
        «Рабочий день», Kate; поиск — второй строкой на всю ширину, а выбор
        клуба — в низ бокового меню (AppSidebar).
        Действия страницы в шапку больше не ставим — они плавают в правом
        нижнем углу (FloatingActions).
      */}
          <header
            className={cn(
              "flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 lg:h-16 lg:flex-nowrap lg:gap-3 lg:px-4 lg:py-0",
              !network && MAIN_HEADER_GRID,
            )}
          >
            {/* До xl заголовок берёт ширину по тексту и сжимается вместе с
            поиском (поиск — до min-w-56); с xl — левая колонка сетки, длинный
            обрезается. Не shrink-[0.1]: когда поиск упирается в минимум, браузер
            отдаёт заголовку лишь 0,1 нехватки — шапка вылезала за край. */}
            <div className="flex min-w-0 flex-1 items-center gap-2 lg:basis-auto xl:col-start-1">
              {/*
            На узком экране боковое меню уходит в шторку и кнопка сворачивания
            внутри него недоступна — открыть меню больше нечем.
          */}
              <MenuTrigger />
              {/*
            Заголовок раздела: font-semibold — тот же вес, что у заголовков
            диалогов и карточек, и он же прописан в дизайн-системе как вес
            ведущего элемента. Трекинг не задаём руками: он зашит в токен
            --text-2xl--letter-spacing. leading-tight обязателен — заголовок под
            truncate, а у «Промокодов» и «Пуш-уведомлений» есть выносные
            элементы (р, у), их бы срезало. На телефоне ступенью меньше (xl):
            в 2xl «Отмены автопродления» не помещались рядом с кнопками.
          */}
              {/* Длинное название (база знаний, клуб) обрезается — целиком в подсказке. */}
              <h1
                title={title}
                className="min-w-0 truncate text-xl font-semibold leading-tight lg:text-2xl"
              >
                {title}
              </h1>
              {refreshButton()}
            </div>

            {!network && (
              // Поиск и «Рабочий день» — средняя колонка с xl; до xl обёртка
              // не мешает (contents): поиск — своей строкой или по центру.
              <div className="contents xl:col-start-2 xl:flex xl:items-center xl:gap-2">
                <HeaderClientSearch className="order-last w-full lg:order-none lg:w-auto lg:min-w-56 lg:flex-[0_1_30rem] xl:min-w-0 xl:flex-1" />
                <WorkdayButton />
              </div>
            )}

            <div
              className={cn(
                "flex shrink-0 items-center justify-end gap-2 lg:flex-1 lg:basis-0 xl:col-start-3",
                network && "hidden",
              )}
            >
              <button
                type="button"
                onClick={() => setKateOpen(true)}
                onPointerEnter={() => void loadKateChat()}
                onFocus={() => void loadKateChat()}
                aria-label="Kate — AI ассистент"
                className="ai-gradient group relative inline-flex h-10 shrink-0 items-center gap-2 overflow-hidden rounded-full px-4 text-sm font-medium text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-sm:w-10 max-sm:justify-center max-sm:px-0"
              >
                <Cat className="h-4 w-4" />
                <span className="max-sm:hidden">Kate</span>
              </button>
              {/* «Выход» — в рейке слева, под аватаркой сотрудника (RailAccount). */}
              <div className="hidden items-center gap-2 lg:flex">
                <StudioSwitcher triggerClassName={MAIN_HEADER_STUDIO} />
              </div>
            </div>
          </header>
        </>
      )}
      {/*
        На телефоне поля рабочей области уже: p-6 съедал 48px из 390.
        admin-main: пока на странице есть плавающие действия, снизу добавляется
        запас (styles.css) — последняя строка таблицы и пагинация
        прокручиваются из-под кнопок.
      */}
      <main
        className={cn(
          "admin-main flex-1 overflow-auto p-3 sm:p-4 lg:p-6",
          kb && !isKbToolPath(pathname) && "bg-background text-foreground",
        )}
      >
        {children}
        {/* Правый нижний угол: действия страницы, под ними — «Сообщить об
            ошибке» (во всех разделах, решение владельца 2026-11-01). */}
        <div className={FLOATING_STACK_CLASS}>
          {actions && <FloatingActions>{actions}</FloatingActions>}
          <BugReportButton />
        </div>
      </main>

      <DialogPrimitive.Root open={kateOpen} onOpenChange={setKateOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          {/* На телефоне чат — во весь экран: в окне 80vh клавиатура съедала ленту. */}
          <DialogPrimitive.Content className="fixed inset-0 z-50 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 md:inset-auto md:left-1/2 md:top-1/2 md:w-[calc(100vw-2rem)] md:max-w-3xl lg:max-w-5xl md:-translate-x-1/2 md:-translate-y-1/2 md:data-[state=closed]:zoom-out-95 md:data-[state=open]:zoom-in-95">
            <DialogPrimitive.Title className="sr-only">Kate — AI ассистент</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Спросите Kate о клиентах, тренерах, расписании или абонементах.
            </DialogPrimitive.Description>
            <Suspense
              fallback={
                <div className="mx-auto h-dvh w-full max-w-3xl lg:max-w-5xl rounded-lg border bg-background max-md:rounded-none max-md:border-0 md:h-[min(80vh,720px)]" />
              }
            >
              <KateChat heightClass="h-dvh md:h-[min(80vh,720px)]" fullscreenOnMobile />
            </Suspense>
            {/* Во весь экран подложки не видно — закрыть окно иначе нечем. */}
            <DialogPrimitive.Close className="absolute right-2 top-2 z-20 inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden">
              <X className="h-5 w-5" />
              <span className="sr-only">Закрыть</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
