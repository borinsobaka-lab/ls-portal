import type { ReactNode } from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";

/**
 * Шторка снизу — как у новостей, услуг и тренировок: выдвигается снизу,
 * закрывается свайпом вниз или касанием фона. Решение владельца 2026-10-15:
 * так же открываются «О приложении» и политика конфиденциальности в профиле
 * и «Фидбэк» на главной (раньше — переход на страницу или раскрытие строки).
 * Ручка, заголовок (необязательное описание под ним), прокручиваемое
 * содержимое и закреплённый низ (кнопка действия всегда на виду);
 * содержимое монтируется только в открытой шторке.
 */
export function BottomDrawer({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  className,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Заголовок только для экранного диктора — у содержимого свой (политика). */
  hideTitle?: boolean;
  description?: ReactNode;
  /** Размер шторки: по умолчанию — по содержимому, до 90% экрана. */
  className?: string;
  /** Закреплён под прокруткой: не уезжает вместе с содержимым. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none",
            className,
          )}
          aria-describedby={undefined}
        >
          <div className="mx-auto mb-1 mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          {hideTitle ? (
            <DrawerPrimitive.Title className="sr-only">{title}</DrawerPrimitive.Title>
          ) : (
            <div className="shrink-0 px-4 pb-2 pt-3">
              <DrawerPrimitive.Title className="text-2xl font-semibold leading-tight">
                {title}
              </DrawerPrimitive.Title>
              {description && (
                <div className="mt-1 text-sm text-muted-foreground">{description}</div>
              )}
            </div>
          )}
          <div
            className={cn(
              "min-h-0 grow overflow-y-auto overscroll-contain px-4 pt-3",
              footer ? "pb-4" : "pb-[calc(env(safe-area-inset-bottom)+24px)]",
            )}
          >
            {children}
          </div>
          {footer && (
            <div className="shrink-0 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
