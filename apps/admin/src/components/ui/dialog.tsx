"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /**
     * «top» — с sm окно прибито к верху и растёт вниз, а не от центра: для
     * форм, которые меняют высоту на ходу (добавить вариант, сменить вид),
     * — поля под курсором не прыгают.
     */
    anchor?: "center" | "top";
  }
>(({ className, children, anchor = "center", ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // От sm — окно по центру. На телефоне — шторка снизу во всю ширину:
        // кнопки подвала под большим пальцем, а поля не зажаты отступами по
        // 16px с каждой стороны. max-w-* страниц (max-w-lg, max-w-2xl) на
        // телефоне снимает max-sm:max-w-none: twMerge оставляет оба класса
        // (разные варианты), а медиа-вариант в CSS идёт позже.
        "fixed z-50 flex flex-col overflow-hidden border bg-background shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "inset-x-0 bottom-0 max-h-[92dvh] w-full max-w-lg rounded-t-xl max-sm:max-w-none data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        "sm:inset-x-auto sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
        anchor === "top" && "sm:top-[7vh] sm:translate-y-0",
        className,
      )}
      {...props}
    >
      {children}
      {/* Крестик — полноценная кнопка 32px (раньше голая иконка 16px, в которую
          трудно попасть); стоит по центру строки заголовка шапки. */}
      <DialogPrimitive.Close className="absolute right-3 top-3 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Закрыть</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * Шапка диалога — закреплена: `shrink-0`, поэтому не уезжает при прокрутке
 * тела. Отступ и разделитель здесь, а не на DialogContent: контент прокручивается
 * между шапкой и подвалом, и полоса прокрутки не должна на них заезжать.
 */
const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // Текст всегда слева — по центру (как в shadcn на мобильных) он
      // отрывался от полей, которые выровнены влево.
      "flex shrink-0 flex-col space-y-1.5 border-b px-4 py-4 pr-12 text-left sm:px-6",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

/**
 * Тело диалога — единственная прокручиваемая часть. Всё, что между шапкой и
 * подвалом, кладём сюда; свой `max-h` и `overflow` на DialogContent вешать не
 * нужно (и нельзя — тогда поедут шапка с подвалом).
 */
const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6", className)} {...props} />
);
DialogBody.displayName = "DialogBody";

/**
 * Форма вокруг тела и подвала: Enter в поле = нажать главную кнопку (у неё
 * type="submit"). Сама форма — flex-колонка, иначе тело перестаёт
 * прокручиваться. Браузерную валидацию отключаем: проверки — тостами в
 * обработчике, как во всей админке.
 */
const DialogForm = ({
  onSubmit,
  className,
  ...props
}: Omit<React.FormHTMLAttributes<HTMLFormElement>, "onSubmit"> & { onSubmit: () => void }) => (
  <form
    noValidate
    className={cn("flex min-h-0 flex-1 flex-col", className)}
    onSubmit={(e) => {
      e.preventDefault();
      // React ведёт события по дереву компонентов, а не по DOM: submit формы
      // из вложенного окна (портал) иначе всплыл бы до формы внешнего окна и
      // отправил бы и её.
      e.stopPropagation();
      onSubmit();
    }}
    {...props}
  />
);
DialogForm.displayName = "DialogForm";

/**
 * Подвал с кнопками — тоже закреплён, всегда виден под прокруткой тела.
 * Порядок: слева при необходимости разрушающее действие («Удалить»), справа
 * «Отмена» (outline) и главная кнопка. На телефоне кнопки делят строку
 * поровну (раньше вставали столбиком и подвал занимал треть шторки); не
 * влезают — переносятся, главная остаётся последней.
 */
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 max-sm:[&>*]:flex-1 sm:px-6 sm:py-4",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogForm,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
