/**
 * Плавающий правый нижний угол рабочей области (AdminShell и болванка
 * ShellSkeleton): действия страницы (FloatingActions), под ними —
 * «Сообщить об ошибке» (components/bug-report.tsx, решение владельца
 * 2026-11-01). Запас снизу под угол — `.admin-main` в styles.css.
 */
export const FLOATING_STACK_CLASS =
  "pointer-events-none fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-3 sm:right-6 sm:bottom-6 lg:right-8 lg:bottom-8";

/**
 * Кнопка «Сообщить об ошибке»: с sm — пилюля с подписью, на телефоне —
 * круглая 48px. Цвет — меню (`--sidebar`): тёмная и в тёмной теме базы.
 */
export const BUG_BUTTON_CLASS =
  "inline-flex size-12 shrink-0 items-center justify-center gap-2 rounded-full bg-sidebar font-medium text-sidebar-foreground shadow-[0_10px_24px_-6px_rgb(0_0_0/0.28),0_2px_6px_-1px_rgb(0_0_0/0.12)] ring-1 ring-white/10 transition hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:h-10 sm:w-auto sm:px-4 sm:text-sm";
