import { useCallback, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConfirmOptions = {
  /** Заголовок: коротко и по делу — «Удалить клиента?». */
  title: string;
  /** Что именно произойдёт и с чем. Здесь уместно имя записи. */
  description?: string;
  /** Надпись на подтверждающей кнопке. По умолчанию — «Удалить». */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Разрушающее действие красит кнопку в destructive. По умолчанию да. */
  destructive?: boolean;
  /**
   * Только сообщение, выбора нет («Переоформить нельзя…»): одна кнопка —
   * confirmLabel («Понятно»), промис всё равно отдаёт true / false.
   */
  hideCancel?: boolean;
};

/**
 * Подтверждение действия в дизайне админки вместо системного `confirm()`.
 *
 * Возвращает промис — вызов остаётся такой же линейный, как был:
 *   if (!(await confirm({ title: "Удалить клиента?" }))) return;
 *
 * Диалог нужно отрисовать в дереве страницы: `{confirmDialog}`.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const destructive = options?.destructive ?? true;

  const confirmDialog = (
    <AlertDialog
      open={!!options}
      onOpenChange={(open) => {
        // Закрытие по Esc/клику вне окна — это отказ.
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description && (
            <AlertDialogDescription>{options.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!options?.hideCancel && (
            <AlertDialogCancel onClick={() => settle(false)}>
              {options?.cancelLabel ?? "Отмена"}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            onClick={() => settle(true)}
            className={cn(destructive && buttonVariants({ variant: "destructive" }))}
          >
            {options?.confirmLabel ?? "Удалить"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, confirmDialog };
}
