import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogForm,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { TableSkeletonRows } from "@/components/skeletons";
import { formatDate, formatMoneyPrecise } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { PromocodesPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  code: "Код, который вы сообщаете клиенту. Сохраняется заглавными буквами.",
  discount: "Для процентов — число до 100, для лари — сумма скидки.",
  expires: "Последний день, когда код действует. Пусто — бессрочно.",
  usageLimit: "Сколько раз всего можно использовать код. Пусто — без ограничений.",
};

export const Route = createFileRoute("/_authenticated/promocodes")({
  head: () => ({ meta: [{ title: "Промокоды — Base40 Admin" }] }),
  pendingComponent: PromocodesPageSkeleton,
  component: PromoCodesPage,
});

type DiscountType = "amount" | "percent";

type PromoCode = {
  id: string;
  studio_id: string;
  name: string;
  code: string;
  expires_at: string | null;
  discount_type: DiscountType;
  discount_value: number;
  usage_limit: number | null;
  usage_count: number;
  description: string | null;
  is_active: boolean;
  created_at: string;
};

/** Сортировка колонок (lib/table-sort.ts). */
const SORT_GETTERS: SortGetters<PromoCode> = {
  name: (p) => p.name,
  code: (p) => p.code,
  discount: (p) => p.discount_value,
  expires: (p) => p.expires_at,
  usage: (p) => p.usage_count,
  description: (p) => p.description,
  active: (p) => p.is_active,
};

function formatDiscount(type: DiscountType, value: number) {
  if (type === "percent") return `${value}%`;
  // Валюта студии — лари (GEL), как во всех остальных разделах.
  return formatMoneyPrecise(value);
}

function PromoCodesPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PromoCode | null>(null);

  const queryKey = ["promo_codes", studioId];
  const { data: items = [], isLoading: loading } = useQuery({
    queryKey,
    queryFn: () =>
      unwrap<PromoCode[]>(
        supabase
          .from("promo_codes")
          .select("*")
          .eq("studio_id", studioId!)
          .order("created_at", { ascending: false }),
      ),
    enabled: !!studioId,
    meta: { errorMessage: "Не удалось загрузить промокоды" },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["promo_codes"] });

  const handleDelete = async (p: PromoCode) => {
    if (
      !(await confirm({
        title: "Удалить промокод?",
        description: `«${p.name}» перестанет действовать.`,
      }))
    )
      return;
    const { error } = await supabase.from("promo_codes").delete().eq("id", p.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Промокод удалён");
    reload();
  };

  const toggleActive = async (p: PromoCode, next: boolean) => {
    const { error } = await supabase
      .from("promo_codes")
      .update({ is_active: next, updated_at: new Date().toISOString() })
      .eq("id", p.id);
    if (error) {
      toast.error("Ошибка: " + error.message);
      return;
    }
    queryClient.setQueryData<PromoCode[]>(queryKey, (prev) =>
      prev?.map((x) => (x.id === p.id ? { ...x, is_active: next } : x)),
    );
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (p: PromoCode) => {
    setEditing(p);
    setOpen(true);
  };

  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(items), undefined, sort.key);

  return (
    <AdminShell
      title="Промокоды"
      actions={
        <Button onClick={openCreate} disabled={!studioId}>
          <Plus />
          Добавить промокод
        </Button>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead {...sort.head("name")}>Название</TableHead>
                  <TableHead tip={TIPS.code} {...sort.head("code")}>
                    Промокод
                  </TableHead>
                  <TableHead tip={TIPS.discount} {...sort.head("discount")}>
                    Скидка
                  </TableHead>
                  <TableHead tip={TIPS.expires} {...sort.head("expires")}>
                    Действует до
                  </TableHead>
                  <TableHead tip={TIPS.usageLimit} {...sort.head("usage")}>
                    Применений
                  </TableHead>
                  <TableHead {...sort.head("description")}>Описание</TableHead>
                  <TableHead className="w-[100px]" {...sort.head("active")}>
                    Активен
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={7} />
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Пока нет промокодов. Нажмите «Добавить промокод».
                    </TableCell>
                  </TableRow>
                ) : (
                  pg.paged.map((p) => (
                    <RowContextMenu
                      key={p.id}
                      actions={[
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(p) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(p),
                        },
                      ]}
                    >
                      <TableRow>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="font-mono uppercase">
                            {p.code}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDiscount(p.discount_type, p.discount_value)}
                        </TableCell>
                        <TableCell className="tabular-nums">{formatDate(p.expires_at)}</TableCell>
                        <TableCell>
                          <span className="tabular-nums">
                            {p.usage_count}
                            {p.usage_limit != null ? ` / ${p.usage_limit}` : " / ∞"}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[280px] truncate text-muted-foreground">
                          {p.description ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Switch
                            aria-label={`Активен: ${p.name}`}
                            checked={p.is_active}
                            onCheckedChange={(v) => toggleActive(p, v)}
                          />
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination {...pg} loading={loading} />
          </div>
        </RequireStudio>
      </div>

      <PromoCodeDialog
        open={open}
        onOpenChange={setOpen}
        studioId={studioId}
        item={editing}
        onSaved={reload}
      />
      {confirmDialog}
    </AdminShell>
  );
}

type DialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string | null;
  item: PromoCode | null;
  onSaved: () => void;
};

function PromoCodeDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <PromoCodeForm key={props.item?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function PromoCodeForm({ onOpenChange, studioId, item, onSaved }: DialogProps) {
  const [name, setName] = useState(item?.name ?? "");
  const [code, setCode] = useState(item?.code ?? "");
  const [expiresAt, setExpiresAt] = useState(item?.expires_at ?? "");
  const [discountType, setDiscountType] = useState<DiscountType>(item?.discount_type ?? "amount");
  const [discountValue, setDiscountValue] = useState(item ? String(item.discount_value) : "");
  const [usageLimit, setUsageLimit] = useState(
    item?.usage_limit != null ? String(item.usage_limit) : "",
  );
  const [description, setDescription] = useState(item?.description ?? "");
  const [isActive, setIsActive] = useState(item?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!studioId) return;
    if (!name.trim()) {
      toast.error("Укажите название");
      return;
    }
    const cleanCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(cleanCode)) {
      toast.error("Промокод: только латинские буквы и цифры");
      return;
    }
    const dv = Number(discountValue.replace(",", "."));
    if (!Number.isFinite(dv) || dv <= 0) {
      toast.error("Укажите размер скидки");
      return;
    }
    if (discountType === "percent" && dv > 100) {
      toast.error("Процент скидки не может быть больше 100");
      return;
    }
    let limit: number | null = null;
    if (usageLimit.trim() !== "") {
      const n = Number(usageLimit);
      if (!Number.isInteger(n) || n <= 0) {
        toast.error("Количество применений — целое число > 0");
        return;
      }
      limit = n;
    }

    setSaving(true);
    try {
      const payload = {
        studio_id: studioId,
        name: name.trim(),
        code: cleanCode,
        expires_at: expiresAt || null,
        discount_type: discountType,
        discount_value: dv,
        usage_limit: limit,
        description: description.trim() || null,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      };
      const { error } = item
        ? await supabase.from("promo_codes").update(payload).eq("id", item.id)
        : await supabase.from("promo_codes").insert(payload);
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(item ? "Промокод обновлён" : "Промокод добавлен");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Редактировать промокод" : "Новый промокод"}</DialogTitle>
        <DialogDescription>Промокод можно применить при покупке для скидки.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Название" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Летняя акция"
              />
            </FormField>

            <FormField
              label="Промокод"
              tip={TIPS.code}
              required
              hint="Только латинские буквы и цифры."
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="SUMMER25"
                className="font-mono uppercase"
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Тип скидки" htmlFor={null} required>
                <SegmentedControl<DiscountType>
                  fullWidth
                  aria-label="Тип скидки"
                  value={discountType}
                  onChange={setDiscountType}
                  options={[
                    { value: "amount", label: "₾", title: "В лари (₾)" },
                    { value: "percent", label: "%", title: "В процентах (%)" },
                  ]}
                />
              </FormField>
              <FormField label="Размер скидки" tip={TIPS.discount} required>
                <Input
                  inputMode="decimal"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "percent" ? "10" : "500"}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Срок действия" tip={TIPS.expires} optional>
                <Input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </FormField>
              <FormField label="Количество применений" tip={TIPS.usageLimit} optional>
                <Input
                  inputMode="numeric"
                  value={usageLimit}
                  onChange={(e) => setUsageLimit(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Без ограничений"
                />
              </FormField>
            </div>

            <FormField label="Описание" hint="Внутреннее, для сотрудников." optional>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Для чего создан промокод"
                rows={3}
              />
            </FormField>

            <SwitchRow
              title="Активен"
              hint="Неактивные промокоды нельзя применить."
              checked={isActive}
              onCheckedChange={setIsActive}
            />

            {item && (
              <InfoNote>
                Применений: <span className="font-medium text-foreground">{item.usage_count}</span>
                {item.usage_limit != null ? ` из ${item.usage_limit}` : " (без ограничений)"}
              </InfoNote>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
