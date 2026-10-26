import { MessageCirclePlus, Repeat, ShoppingBag, Ticket } from "lucide-react";

import { cn } from "@/lib/utils";
import { ChoiceCard } from "@/components/ui/choice-card";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SALE_KIND_DESCRIPTION,
  SALE_KIND_DOT,
  SALE_KIND_LABEL,
  SALE_KINDS,
  type SaleKind,
} from "@/lib/payments";

/** Цветной кружок типа продажи пакетного клуба. */
export function SaleKindDot({ kind }: { kind: SaleKind }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2.5 shrink-0 rounded-full", SALE_KIND_DOT[kind])}
    />
  );
}

/** Иконка типа продажи на плитке выбора. */
const SALE_KIND_ICON: Record<SaleKind, typeof ShoppingBag> = {
  new: ShoppingBag,
  trial: Ticket,
  upsell: MessageCirclePlus,
  renewal: Repeat,
};

/**
 * Выбор типа продажи (пакетный клуб, «Абонементы») — плитки с иконкой типа
 * на плашке цвета типа (как кружок в колонке «Тип продажи»: новая и пробное —
 * зелёный, допродажа — синий, продление — фиолетовый; решение владельца
 * 2026-10-14); дальше форма продажи. Одно и то же окно везде, где продают
 * абонемент: «Абонементы» и карточка клиента (решение владельца 2026-10-19).
 */
export function SaleKindPickerDialog({
  open,
  onOpenChange,
  onPick,
  clientName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (kind: SaleKind) => void;
  /** Продажа из карточки клиента — его имя в пояснении. */
  clientName?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Какая продажа?</DialogTitle>
          <DialogDescription>
            {clientName ? `Выберите тип продажи — ${clientName}.` : "Выберите тип продажи."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SALE_KINDS.map((k) => {
              const Icon = SALE_KIND_ICON[k];
              return (
                <ChoiceCard
                  key={k}
                  onClick={() => onPick(k)}
                  media={
                    <span
                      className={cn(
                        "flex size-11 shrink-0 items-center justify-center rounded-lg text-white",
                        SALE_KIND_DOT[k],
                      )}
                    >
                      <Icon className="size-6" />
                    </span>
                  }
                  title={SALE_KIND_LABEL[k]}
                  description={SALE_KIND_DESCRIPTION[k]}
                />
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
