import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { formatMoney } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from "@/lib/payments";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Возврат по продаже абонемента (таблица refunds): из «Продаж» подписочного
// клуба и из «Абонементов» пакетного. Можно вернуть часть; сумма всех
// возвратов по продаже не больше суммы продажи, в пакетном — не больше
// внесённого (невнесённые платежи возврат снимает сам, а возврат — это
// отданные деньги: иначе «Фактическая выручка» и LTV дашборда уходят в
// минус). В подписочном клубе абонемент возврат не отменяет; в пакетном
// (2026-10-13) база переводит абонемент в «Возврат», снимает невнесённые
// платежи и удаляет неотмеченные записи клиента на занятия (триггер
// refunds_packages_apply).

/** Что нужно окну о продаже. */
export type RefundSale = {
  id: string;
  /** Пакетный клуб: возврат закрывает абонемент (см. выше). */
  packages?: boolean;
  studio_id: string;
  total_amount: number;
  /** Сколько внесено по продаже (пакетный клуб): больше вернуть нельзя. */
  paidAmount?: number;
  /** Название абонемента — в описании окна. */
  membershipName: string | null;
};

type RefundDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sale: RefundSale | null;
  onSaved: () => void;
};

export function RefundDialog({ open, onOpenChange, sale, onSaved }: RefundDialogProps) {
  // Продажу не сбрасываем при закрытии: форма остаётся на месте, пока окно
  // уезжает анимацией.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {sale && (
          <RefundForm key={sale.id} sale={sale} onOpenChange={onOpenChange} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RefundForm({
  sale,
  onOpenChange,
  onSaved,
}: Omit<RefundDialogProps, "open"> & { sale: RefundSale }) {
  const { ensure: ensureStaff } = useStaffProfile();
  const queryClient = useQueryClient();
  // Уже оформленные возвраты по продаже: сумма всех возвратов не должна
  // превышать сумму продажи. Пока сумма перечитывается (isFetching, а не
  // только первая загрузка), кнопка заблокирована — проверка шла бы по
  // устаревшему остатку.
  const { data: refunded, isFetching: loadingRefunded } = useQuery({
    queryKey: ["refunds", "by-sale", sale.id],
    queryFn: async () => {
      const rows = await unwrap<{ amount: number | string | null }[]>(
        supabase.from("refunds").select("amount").eq("sale_id", sale.id),
      );
      return rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    },
    meta: { errorMessage: "Не удалось загрузить прошлые возвраты" },
  });
  const limit = sale.paidAmount ?? Number(sale.total_amount ?? 0);
  const available = Math.max(0, limit - (refunded ?? 0));
  // По умолчанию — остаток к возврату; пока админ не ввёл своё значение.
  const [amountInput, setAmount] = useState<string | null>(null);
  const amount = amountInput ?? (refunded === undefined ? "" : String(available));
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    const raw = amount.replace(",", ".").trim();
    const amt = Number(raw);
    if (!raw || !Number.isFinite(amt) || amt <= 0) {
      toast.error("Укажите сумму возврата больше нуля");
      return;
    }
    if (refunded === undefined) {
      toast.error("Не удалось проверить прошлые возвраты — обновите страницу");
      return;
    }
    if (amt > available) {
      toast.error(
        refunded > 0
          ? `Сумма возврата больше остатка: по продаже уже возвращено ${formatMoney(refunded)}`
          : sale.paidAmount !== undefined
            ? `Сумма возврата больше внесённой по продаже: ${formatMoney(limit)}`
            : "Сумма возврата больше суммы продажи",
      );
      return;
    }
    setSaving(true);
    try {
      const staff = await ensureStaff();
      const { error } = await supabase.from("refunds").insert({
        studio_id: sale.studio_id,
        sale_id: sale.id,
        amount: amt,
        reason: reason.trim() || null,
        method,
        refunded_by: staff?.id ?? null,
        refunded_by_name: staff?.displayName || null,
      });
      if (error) {
        toast.error("Ошибка возврата: " + error.message);
        return;
      }
      toast.success("Возврат зафиксирован");
      // Остаток к возврату по продаже и суммы возвратов в таблицах.
      queryClient.invalidateQueries({ queryKey: ["refunds"] });
      if (sale.packages) {
        // Абонемент закрыт, записи клиента на занятия удалены.
        queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
        queryClient.invalidateQueries({ queryKey: ["schedule_entries"] });
        queryClient.invalidateQueries({ queryKey: ["schedule_bookings"] });
      }
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Возврат</DialogTitle>
        <DialogDescription>
          Возврат по продаже{sale.membershipName ? ` «${sale.membershipName}»` : ""}.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            {sale.packages && (
              <InfoNote variant="warning">
                Абонемент перейдёт в статус «Возврат», невнесённые платежи по графику снимутся, а
                записи клиента на тренировки без отметки посещения удалятся. Отменить это нельзя.
              </InfoNote>
            )}
            <FormField
              label="Сумма возврата, ₾"
              required
              tip={
                sale.packages
                  ? "Не больше внесённого по продаже, можно часть. Абонемент перейдёт в статус «Возврат», невнесённые платежи снимутся, записи клиента на занятия без отметки посещения удалятся."
                  : "Можно вернуть часть. Абонемент клиента возврат не отменяет — при необходимости измените его в карточке клиента."
              }
              hint={
                refunded
                  ? `Уже возвращено ${formatMoney(refunded)}, доступно ${formatMoney(available)}`
                  : sale.paidAmount !== undefined && sale.paidAmount < Number(sale.total_amount)
                    ? `Внесено по продаже ${formatMoney(limit)}`
                    : undefined
              }
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
            <FormField
              label="Способ"
              tip="Как вернули деньги. В «Кассу» возврат сам не попадает."
              required
            >
              <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Причина" optional>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || loadingRefunded}>
            {saving && <Loader2 className="animate-spin" />}
            Оформить возврат
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
