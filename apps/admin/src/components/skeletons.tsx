import type { ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { PanelLeft, RefreshCw } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { RailVersion } from "@/components/rail-version";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MAIN_HEADER_GRID } from "@/lib/header-layout";
import {
  KB_ACTIONS_SLOT,
  KB_HEADER_GRID,
  KB_SEARCH_SLOT,
  KB_TABS_SLOT,
} from "@/lib/kb/header-layout";
import { cn } from "@/lib/utils";
import { CLUBS_HIDDEN } from "@/lib/launch";

/*
 * Скелетоны админки — состояние ПЕРВОЙ загрузки: вместо пустоты, нулей или
 * спиннера показываем болванку ИМЕННО ЭТОГО раздела — его шапку, фильтры,
 * колонки и блоки. Чужая болванка (таблица на месте карточек скриптов) хуже
 * пустоты: страница «перепрыгивает» из одной раскладки в другую.
 *
 * Полная инструкция — .interface-design/system.md, «Скелетоны». Коротко:
 *  - у каждой страницы свой скелетон в components/page-skeletons.tsx
 *    (шапка ShellSkeleton с настоящим заголовком + тело из блоков ниже) и
 *    `pendingComponent` в её роуте. Его же показывают AccessGate, каркас до
 *    входа и RequireFormat — через RoutePendingSkeleton;
 *  - данные внутри уже открытой страницы — TableSkeletonRows в настоящей
 *    таблице, тело-скелетон раздела (например, ScriptsListSkeleton) и т. п.
 *
 * Блоки:
 *   ShellSkeleton ........... шапка AdminShell с заголовком + <main>
 *   ToolbarSkeleton ......... плашка TableToolbar с теми же контролами
 *   TableCardSkeleton ....... таблица с настоящими заголовками колонок
 *   TableSkeletonRows ....... строки внутри настоящей таблицы
 *   CardSkeleton ............ простые карточки (лента истории и т. п.)
 *   MenuSkeleton / RailSkeleton — меню и рейка на тёмной панели
 */

/**
 * Строки-скелетоны для состояния загрузки таблицы: вместо одиночного спиннера
 * показываем «болванку» таблицы — высота списка не скачет, и видно, что грузится
 * именно таблица.
 *
 * Использование вместо спиннера:
 *   {loading ? <TableSkeletonRows columns={11} /> : ...}
 */
export function TableSkeletonRows({ columns, rows = 8 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r}>
          {Array.from({ length: columns }).map((_, c) => (
            <TableCell key={c} className="py-3">
              {/* Первая колонка шире — обычно это имя/название. */}
              <Skeleton className={c === 0 ? "h-4 w-40" : "h-4 w-16"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/**
 * Скелетон для карточных списков и форм (разделы без таблицы).
 */
export function CardSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mb-3 rounded-lg border bg-background p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * Болванка кнопки или контрола. Строка — класс ширины (w-40, w-48: селекты,
 * поля); объект — кнопка, ширину которой задаёт её настоящий текст
 * (невидимый внутри болванки), поэтому она совпадает с кнопкой до пикселя.
 */
export type ControlSkeleton = string | { label: string; icon?: boolean; className?: string };

export function ControlSkeletonView({ control }: { control: ControlSkeleton }) {
  if (typeof control === "string") return <Skeleton className={cn("h-10", control)} />;
  return (
    <Skeleton
      className={cn(
        // Болванка кнопки — пилюля, как Button; строка-класс выше — поле.
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium",
        control.className,
      )}
    >
      <span className="invisible inline-flex items-center gap-2 whitespace-nowrap">
        {control.icon !== false && <span className="size-4" />}
        {control.label}
      </span>
    </Skeleton>
  );
}

/**
 * Шапка страницы как в AdminShell: та же разметка и классы, настоящий
 * заголовок раздела; плавающие кнопки действий — болванки по их тексту.
 * Хуков нет — можно рисовать до загрузки чего угодно (каркас до входа).
 */
export function ShellSkeleton({
  title,
  actions = [],
  kb = false,
  network = false,
  children,
}: {
  title: string;
  /** Кнопки действий страницы — как в настоящих actions AdminShell. */
  actions?: ControlSkeleton[];
  /**
   * Шапка базы знаний: вкладки баз и поиск по базе, рабочая область белая;
   * "tool" — служебная страница базы на канве (isKbToolPath).
   */
  kb?: boolean | "tool";
  /** Раздел, общий для сети («Академия»): в шапке только заголовок. */
  network?: boolean;
  children: ReactNode;
}) {
  // Пока клубы скрыты (lib/launch.ts), у всех страниц шапка без поиска
  // клиента и выбора клуба — как у AdminShell.
  network ||= CLUBS_HIDDEN;
  return (
    <>
      {kb ? (
        <header
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 lg:h-16 lg:gap-3 lg:px-4 lg:py-0",
            KB_HEADER_GRID,
          )}
        >
          <span className="-ml-1 inline-flex size-10 shrink-0 items-center justify-center md:hidden">
            <PanelLeft className="size-4" />
          </span>
          <h1 className="sr-only">{title}</h1>
          {/* Вкладки баз, поиск и кнопки — те же колонки, что у AdminShell. */}
          <div className={cn("flex gap-1", KB_TABS_SLOT)}>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-32 rounded-full" />
            ))}
          </div>
          <Skeleton className={cn("h-10", KB_SEARCH_SLOT)} />
          <div
            className={cn(
              "flex items-center justify-end gap-2 lg:justify-between",
              KB_ACTIONS_SLOT,
            )}
          >
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <span className="inline-flex size-10 shrink-0 items-center justify-center">
              <RefreshCw className="h-5 w-5" />
            </span>
          </div>
        </header>
      ) : (
        <header
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 lg:h-16 lg:flex-nowrap lg:gap-3 lg:px-4 lg:py-0",
            !network && MAIN_HEADER_GRID,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 lg:basis-auto xl:col-start-1">
            {/* Кнопка меню на узком экране — как SidebarTrigger. */}
            <span className="-ml-1 inline-flex size-10 shrink-0 items-center justify-center md:hidden">
              <PanelLeft className="size-4" />
            </span>
            <h1 className="min-w-0 truncate text-xl font-semibold leading-tight lg:text-2xl">
              {title}
            </h1>
            <span className="inline-flex size-10 shrink-0 items-center justify-center">
              <RefreshCw className="h-5 w-5" />
            </span>
          </div>
          {!network && (
            <>
              {/* Поиск клиента и «Рабочий день» — как в AdminShell. */}
              <div className="contents xl:col-start-2 xl:flex xl:items-center xl:gap-2">
                <Skeleton className="order-last h-10 w-full lg:order-none lg:w-auto lg:min-w-56 lg:flex-[0_1_30rem] xl:min-w-0 xl:flex-1" />
                <Skeleton className="h-10 w-10 shrink-0 rounded-full sm:w-36 lg:max-xl:w-10" />
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2 lg:flex-1 lg:basis-0 xl:col-start-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full sm:w-20" />
                {/* Выбор клуба; «Выход» — в рейке (RailAccount), не в шапке. */}
                <div className="hidden items-center gap-2 lg:flex">
                  <Skeleton className="h-10 w-60 xl:w-52" />
                </div>
              </div>
            </>
          )}
        </header>
      )}
      <main
        className={cn(
          "admin-main flex-1 overflow-auto p-3 sm:p-4 lg:p-6",
          kb === true && "bg-background",
        )}
        aria-busy="true"
      >
        {children}
        {/* Плавающие действия — как FloatingActions: тот же контейнер,
            «пилюли» размера .fab-actions button. */}
        {actions.length > 0 && (
          <div className="fab-actions fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-end gap-3 sm:right-6 sm:bottom-6 lg:right-8 lg:bottom-8">
            {actions.map((a, i) => (
              <ControlSkeletonView
                key={i}
                control={
                  typeof a === "string"
                    ? cn("h-12 rounded-full", a)
                    : {
                        ...a,
                        className: cn("h-12 rounded-full px-5 text-[0.9375rem]", a.className),
                      }
                }
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

/**
 * Плашка фильтров (TableToolbar): те же классы, на телефоне те же правила
 * раскладки (styles.css, .table-toolbar). `search` — поле поиска,
 * `controls` — остальные контролы по порядку (см. ControlSkeleton).
 */
export function ToolbarSkeleton({
  search = true,
  controls = [],
  children,
}: {
  search?: boolean;
  controls?: ControlSkeleton[];
  children?: ReactNode;
}) {
  return (
    <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
      {search && <Skeleton className="toolbar-search h-10 w-full max-w-96" />}
      {controls.map((c, i) => (
        <ControlSkeletonView key={i} control={c} />
      ))}
      {children}
    </div>
  );
}

/** Подвал пагинации (DataPagination): «строк на странице», счётчик, стрелки. */
export function PaginationSkeleton() {
  const arrow = "size-10 shrink-0 rounded-full border bg-background";
  return (
    <div className="flex items-center justify-between gap-2 rounded-b-lg border-t bg-background px-2 py-2 sm:gap-3 sm:px-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="max-sm:hidden">Строк на странице</span>
        <Skeleton className="h-10 w-20" />
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <Skeleton className="h-4 w-20" />
        <div className="flex items-center gap-1">
          <span className={cn(arrow, "max-sm:hidden")} />
          <span className={arrow} />
          <Skeleton className="mx-1 h-4 w-8 sm:mx-2" />
          <span className={arrow} />
          <span className={cn(arrow, "max-sm:hidden")} />
        </div>
      </div>
    </div>
  );
}

/**
 * Таблица раздела целиком: обёртка, настоящие заголовки колонок (те же, что
 * у страницы, — по ним видно, что это за таблица, и на телефоне карточки
 * получают подписи) и строки-болванки. `title` — полоса над таблицей
 * («История операций»), `pagination` — подвал DataPagination.
 */
export type HeaderSkeleton = string | { label: string; className?: string };

export function TableCardSkeleton({
  headers,
  rows = 8,
  title,
  pagination = false,
}: {
  /** Заголовки колонок страницы; объект — с классом ширины колонки. */
  headers: HeaderSkeleton[];
  rows?: number;
  title?: string;
  pagination?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-background">
      {title && <div className="border-b px-4 py-2 text-lg font-semibold">{title}</div>}
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) =>
              typeof h === "string" ? (
                <TableHead key={i}>{h}</TableHead>
              ) : (
                <TableHead key={i} className={h.className}>
                  {h.label}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeletonRows columns={headers.length} rows={rows} />
        </TableBody>
      </Table>
      {pagination && <PaginationSkeleton />}
    </div>
  );
}

/**
 * Типовой раздел, о котором ничего не известно: фильтры и таблица. Только
 * запасной вариант (роут без своего скелетона) — у каждой страницы должен
 * быть свой, см. page-skeletons.tsx.
 */
export function PageBodySkeleton() {
  return (
    <div className="space-y-3">
      <ToolbarSkeleton controls={["w-40"]} />
      <div className="rounded-lg border bg-background">
        <Table>
          <TableBody>
            <TableSkeletonRows columns={6} />
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Запасная страница целиком — роут без своего pendingComponent. */
export function PageSkeleton() {
  return (
    <ShellSkeleton title="">
      <PageBodySkeleton />
    </ShellSkeleton>
  );
}

/**
 * Скелетон страницы, которая сейчас открывается: pendingComponent её роута
 * (последнего в цепочке). Нужен там, где страница уже известна, а её
 * компонент ещё нельзя показывать: AccessGate (права грузятся), каркас до
 * проверки входа, RequireFormat (формат клуба неизвестен).
 */
export function RoutePendingSkeleton() {
  const router = useRouter();
  const routeId = useRouterState({ select: (s) => s.matches[s.matches.length - 1]?.routeId });
  const route = routeId ? router.looseRoutesById[routeId] : undefined;
  const Pending = route?.options.pendingComponent;
  // Свой скелетон есть только у страниц; у layout-роута это сам каркас.
  if (!Pending || Pending === AppShellSkeleton || Pending === RoutePendingSkeleton)
    return <PageSkeleton />;
  return <Pending />;
}

/**
 * Пункты бокового меню на тёмной панели. Обычный Skeleton там не виден
 * (серый на тёмном), поэтому заливка — белая полупрозрачная, как подложка
 * активного пункта.
 */
export function MenuSkeleton({ items = 6 }: { items?: number }) {
  return (
    <div className="space-y-1 px-2 py-1" aria-busy="true" aria-label="Загрузка меню">
      <Skeleton className="mx-2 mb-2 mt-1 h-3 w-16 bg-white/10" />
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="size-5 shrink-0 rounded-full bg-white/10" />
          {/* Ширины фиксированные, не случайные: SSR и клиент рисуют одно и то же. */}
          <Skeleton className="h-4 bg-white/10" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Разделы рейки (иконка + подпись) на тёмном фоне — пока не пришли права. */
export function RailSkeleton({ items }: { items: number }) {
  return (
    <>
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex w-full flex-col items-center gap-1.5 py-2" aria-hidden="true">
          <Skeleton className="size-5 rounded-full bg-white/10" />
          <Skeleton className="h-2.5 w-10 bg-white/10" />
        </div>
      ))}
    </>
  );
}

/**
 * Весь каркас админки — до того, как известно, что пользователь вошёл и он
 * сотрудник (pendingComponent у `_authenticated`). Повторяет разметку
 * layout-роута: рейка + меню на тёмном фоне, справа скруглённая рабочая
 * область. Хуков с данными здесь нет и быть не должно: запросы до проверки
 * входа закэшировали бы пустые ответы.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas md:bg-sidebar md:py-1.5 md:pr-1.5">
      <div className="hidden w-[calc(var(--rail-width)+12rem)] shrink-0 md:flex">
        <div className="flex w-(--rail-width) shrink-0 flex-col border-r border-white/10 bg-rail px-1 py-4">
          <div className="my-auto flex w-full flex-col gap-1">
            <RailSkeleton items={5} />
          </div>
          <div className="flex w-full flex-col gap-1 border-t border-white/10 pt-2">
            {/* Аватарка сотрудника (RailAccount), «Доступы», «Клубы». */}
            <div className="flex w-full flex-col items-center gap-1 py-2">
              <Skeleton className="size-8 rounded-full bg-white/10" />
              <Skeleton className="h-2.5 w-10 bg-white/10" />
            </div>
            <RailSkeleton items={2} />
            <div className="flex justify-center">
              <RailVersion />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-3 py-4">
            <Skeleton className="h-9 w-32 bg-white/10" />
          </div>
          <MenuSkeleton items={8} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas md:rounded-xl">
        <RoutePendingSkeleton />
      </div>
    </div>
  );
}
