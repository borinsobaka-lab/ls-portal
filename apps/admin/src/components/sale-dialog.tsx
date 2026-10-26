import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { SellerSelect } from "@/components/seller-select";
import { StaffOption } from "@/components/employee-photo";
import { isAdminRole } from "@/lib/staff-directory";
import { SELLER_TIP, useStudioStaff } from "@/lib/studio-staff";
import { useStudios } from "@/hooks/use-studios";
import { useCatalogStudioIds } from "@/hooks/use-catalog-studios";
import { unwrap } from "@/lib/query";
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  PAYMENT_TYPE_LABEL,
  PAYMENT_TYPES,
  SALE_KIND_HINT,
  SALE_KIND_LABEL,
  SALE_TIPS,
  addMonthsISO,
  type MembershipKind,
  type PaymentMethod,
  type PaymentType,
  type SaleKind,
} from "@/lib/payments";
import { celebrateSale } from "@/lib/confetti";
import { clientName, formatDate, formatMoney, formatMoneyPrecise, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClientCombobox, type ClientOption } from "@/components/client-combobox";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { useConfirm } from "@/components/confirm-dialog";

// Диалог «Новая продажа» абонемента. Открывается из «Продаж» (подписочный
// клуб), «Абонементов» (пакетный) и из карточки клиента («Добавить продажу» —
// клиент уже подставлен).
//
// Рассрочка зависит от формата студии (STUDIO_FORMATS.md):
// - подписочный — у тарифа флаг installment_enabled, остаток на 2 или 3 мес.;
// - пакетный — у пакета max_payments («сколькими платежами можно оплатить»),
//   администратор выбирает число платежей от 1 до него; поля «Тип оплаты» нет.
// В обоих случаях первый платёж — в день продажи, остальные — ежемесячно.
//
// В пакетной студии у продажи есть тип (sales.sale_kind, плитки в «Абонементах»):
// новая продажа, пробное, допродажа, продление. «Пробное» предлагает только
// номенклатуры «Пробное посещение» и подставляет первую сама, остальные типы —
// пакеты тренировок и пакеты персональных. Подписочная студия тип не пишет.
//
// Ещё в пакетной студии — «Тренер» (sales.trainer_id + снимок имени
// trainer_name): кто был тренером при продаже, ему начисляется бонус. Продажи
// с тренером и рассрочкой видны в разделе «Абонементы». У «Оплаты пробного»
// тренера нет (решение владельца 2026-10-14): клиент ещё не был на тренировке.
//
// «Администратор» (оба формата) — выбирается из администраторов студии
// (lib/studio-staff.ts, components/seller-select.tsx): sales.seller_id + снимок admin_name;
// admin_id — тот, кто внёс продажу.
//
// «Клуб продажи» (пакетный формат, решение владельца 2026-10-20) —
// обязательный выбор из пакетных клубов сотрудника, по умолчанию — клуб, в
// котором открыта форма. По нему sales.studio_id: «Абонементы» общие для
// клубов сети, а касса, зарплаты и дашборд считаются по клубу продажи.
// Администраторы и тренеры в списках — этого клуба.
/** Значение «Без тренера»: у пунктов Radix Select пустой строки быть не может. */
const NO_TRAINER = "none";

type MembershipRow = {
  id: string;
  name: string;
  price: number;
  duration_days: number | null;
  visits_count: number | null;
  installment_enabled: boolean;
  /** Пакетный формат: сколькими платежами можно оплатить (1 — только сразу). */
  max_payments: number;
  /** Пакетный формат: пакет тренировок, персональных, разовое или пробное посещение. */
  kind: MembershipKind;
};

// Делим в тетри: доли — с округлением вниз, остаток — последнему платежу.
// Округление доли вверх при маленьком остатке давало последнему платежу минус
// (0,10 на 12 платежей: 11 × 0,01 = 0,11 → последний −0,01).
function splitAmount(total: number, parts: number) {
  const cents = Math.max(0, Math.round(total * 100));
  const part = Math.floor(cents / parts);
  const arr: number[] = Array(parts).fill(part / 100);
  arr[parts - 1] = (cents - part * (parts - 1)) / 100;
  return arr;
}

// ---------------------------------------------------------------------------
// Новая продажа
// ---------------------------------------------------------------------------

type SaleFields = {
  clientId: string;
  /** Имя выбранного клиента — для итоговой строки под формой. */
  clientLabel: string;
  membershipId: string;
  soldAt: string;
  amount: string;
  downPayment: string;
  /** Подписочный формат: на сколько месяцев разбить остаток. */
  remainingCount: 2 | 3;
  /** Пакетный формат: всего платежей, включая первый (1 — оплата сразу). */
  paymentsCount: number;
  paymentType: PaymentType;
  paymentMethod: PaymentMethod;
  promoCode: string;
  comment: string;
  /** Пакетный формат: тренер при продаже; NO_TRAINER — не было. */
  trainerId: string;
  /** Администратор, который продал (сотрудник справочника). */
  sellerId: string;
};

/** Суммы продажи по форме: итог, первый взнос, скидка от тарифа, график рассрочки. */
function saleTotals(form: SaleFields, membership: MembershipRow | null, isPackages: boolean) {
  const installment = isPackages
    ? form.paymentsCount > 1
    : (membership?.installment_enabled ?? false);
  const total = Number(form.amount) || 0;
  const down = installment ? Number(form.downPayment) || 0 : total;
  const remaining = !installment ? 0 : isPackages ? form.paymentsCount - 1 : form.remainingCount;
  const remainingTotal = Math.max(0, total - down);
  const listPrice = membership?.price != null ? Number(membership.price) : null;
  const discount = listPrice != null ? Math.max(0, listPrice - total) : 0;
  const schedule =
    !form.soldAt || remaining === 0 || remainingTotal <= 0
      ? []
      : [
          { date: form.soldAt, amount: down, isDownPayment: true },
          ...splitAmount(remainingTotal, remaining).map((amount, i) => ({
            date: addMonthsISO(form.soldAt, i + 1),
            amount,
            isDownPayment: false,
          })),
        ];
  return { installment, total, down, remaining, listPrice, discount, schedule };
}

/** Первая ошибка заполнения формы продажи (текст для тоста) или null. */
function saleFormError(form: SaleFields, t: ReturnType<typeof saleTotals>) {
  if (!form.clientId) return "Выберите клиента";
  if (!form.membershipId) return "Выберите абонемент";
  if (t.total <= 0) return "Укажите стоимость";
  if (!form.soldAt) return "Укажите дату продажи";
  if (t.installment) {
    if (t.down <= 0) return "Укажите первый взнос";
    if (t.down >= t.total) return "Первый взнос должен быть меньше общей суммы";
  }
  return null;
}

/** Действующий абонемент клиента (embed memberships — объект или массив). */
type CurrentMembership = {
  status: string;
  memberships:
    | { name: string; kind: string | null }
    | { name: string; kind: string | null }[]
    | null;
};

export type SaleDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string | null;
  onSaved: () => void;
  /** Клиент, подставленный заранее (продажа из карточки клиента); сменить можно. */
  initialClient?: ClientOption | null;
  /** Тип продажи (пакетная студия); по умолчанию — новая продажа. */
  kind?: SaleKind;
};

/** Подсказка поля «Клуб продажи». */
const SALE_STUDIO_TIP =
  "Клуб, где продан абонемент: продажа идёт в его кассу, зарплаты и дашборд. В «Абонементах» её видят все клубы сети. По умолчанию — клуб, открытый в шапке.";

export function SaleDialog(props: SaleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <SaleForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function SaleForm({
  onOpenChange,
  studioId,
  onSaved,
  initialClient,
  kind = "new",
}: SaleDialogProps) {
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const { ensure: ensureStaff } = useStaffProfile();
  const { data: studios } = useStudios();
  const isPackages = studios?.find((s) => s.id === studioId)?.format === "packages";
  const isTrial = isPackages && kind === "trial";
  const isRenewal = isPackages && kind === "renewal";
  // Клуб продажи — из пакетных клубов сотрудника (вносить продажу можно только
  // там, где он сотрудник); у подписочного — сам клуб формы.
  const [saleStudioId, setSaleStudioId] = useState(studioId);
  const saleStudios = isPackages ? (studios ?? []).filter((s) => s.format === "packages") : [];
  const [form, setForm] = useState<SaleFields>(() => ({
    clientId: initialClient?.id ?? "",
    clientLabel: initialClient ? clientName(initialClient) : "",
    membershipId: "",
    soldAt: todayISO(),
    amount: "",
    downPayment: "",
    remainingCount: 2,
    paymentsCount: 1,
    paymentType: "first",
    paymentMethod: "cash",
    promoCode: "",
    comment: "",
    trainerId: NO_TRAINER,
    sellerId: "",
  }));
  const set = <K extends keyof SaleFields>(key: K, value: SaleFields[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const [saving, setSaving] = useState(false);

  // У пакетных клубов номенклатура общая на все пакетные клубы.
  const catalogIds = useCatalogStudioIds(studioId);
  const { data: memberships = [], isFetched: membershipsFetched } = useQuery({
    queryKey: ["memberships", studioId, "options", catalogIds?.join(",")],
    queryFn: () =>
      unwrap<MembershipRow[]>(
        supabase
          .from("memberships")
          .select(
            "id, name, price, duration_days, visits_count, installment_enabled, max_payments, kind",
          )
          .in("studio_id", catalogIds!)
          .order("name"),
      ),
    enabled: !!studioId && !!catalogIds,
    meta: { errorMessage: "Не удалось загрузить абонементы" },
  });

  // Сотрудники клуба продажи: администраторы — кто продал, тренеры (пакетный
  // формат) — кто был с клиентом при продаже. Выбранный, которого нет в
  // другом клубе, сбрасывается сам: seller / trainer ищутся в новом списке.
  const { data: staffRows = [], isLoading: staffLoading } = useStudioStaff(saleStudioId);
  const trainers = staffRows.filter((r) => r.role === "trainer");
  // У пробного тренера нет — клиент ещё не был на тренировке.
  const trainer = isTrial ? null : (trainers.find((r) => r.id === form.trainerId) ?? null);
  const admins = staffRows.filter((r) => isAdminRole(r.role));
  const seller = admins.find((r) => r.id === form.sellerId) ?? null;

  // Пакетная студия: «Пробное» — только пробные посещения, остальное — пакеты
  // и разовое посещение (его продают только здесь, в приложении его нет).
  const options = isPackages
    ? memberships.filter((m) => (m.kind === "trial") === isTrial)
    : memberships;
  const membership = options.find((m) => m.id === form.membershipId) ?? null;
  const t = saleTotals(form, membership, isPackages);
  const maxPayments = isPackages ? Math.max(1, membership?.max_payments ?? 1) : 1;

  // Цена подставляется при выборе, а не эффектом по выбранному абонементу:
  // эффект срабатывал и на перезагрузку списка и затирал введённую скидку.
  const pickMembership = (id: string) => {
    const m = options.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      membershipId: id,
      amount: m ? String(m.price ?? 0) : "",
      downPayment: "",
      remainingCount: 2,
      paymentsCount: 1,
    }));
  };

  // «Пробное»: пробное посещение подставляется само, как только загрузится
  // список (один раз — выбранное администратором не перетирается).
  // Состояние правится прямо в рендере (так React советует подстраивать его
  // под пришедшие данные): условие выполняется один раз, дальше выбор занят.
  const firstTrialId = isTrial ? (options[0]?.id ?? "") : "";
  if (firstTrialId && !form.membershipId) pickMembership(firstTrialId);

  // Пакетный формат: при выборе числа платежей первый платёж предлагается
  // равной долей — график виден сразу, администратор правит сумму, внесённую
  // на месте, остаток пересчитывается на следующие платежи.
  const pickPaymentsCount = (n: number) => {
    setForm((f) => {
      const total = Number(f.amount) || 0;
      return {
        ...f,
        paymentsCount: n,
        downPayment: n > 1 && total > 0 ? String(splitAmount(total, n)[0]) : "",
      };
    });
  };

  const handleSave = async () => {
    if (saving) return;
    const invalid =
      (!saleStudioId ? "Выберите клуб продажи" : null) ??
      (!seller ? "Выберите администратора, который продал" : null) ??
      saleFormError(form, t) ??
      (isPackages && form.paymentsCount > maxPayments
        ? `Этот пакет можно оплатить не больше чем ${maxPayments} платежами`
        : null);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    // Блокируем сразу, до проверки текущего абонемента: пока шёл тот запрос,
    // кнопка оставалась активной, и двойной клик создавал две продажи.
    setSaving(true);
    try {
      // Новая продажа вытесняет действующий абонемент — и активный, и
      // замороженный (activate_membership_from_sale), поэтому предупреждаем о
      // любом из них. limit(1), а не maybeSingle: при двух строках maybeSingle
      // отдаёт ошибку, и предупреждение молча пропадало.
      // Пакетная студия: пакет персональных и пакет тренировок — разные
      // балансы, вытесняется только абонемент того же вида (balance_kind).
      let currentQuery = supabase
        .from("client_memberships")
        .select("id, status, memberships(name, kind)")
        .eq("client_id", form.clientId)
        .in("status", ["active", "frozen"]);
      if (isPackages)
        currentQuery = currentQuery.eq(
          "balance_kind",
          membership?.kind === "personal" ? "personal" : "group",
        );
      const { data: currentRows, error: currentErr } = await currentQuery.limit(1);
      if (currentErr) {
        toast.error("Не удалось проверить абонементы клиента: " + currentErr.message);
        return;
      }
      const current = (currentRows as CurrentMembership[] | null)?.[0];
      const currentInfo = Array.isArray(current?.memberships)
        ? current?.memberships[0]
        : current?.memberships;
      // Продление в пакетной студии ничего не заменяет — встаёт в очередь
      // после текущего (db/migrations/2026-10-11_zzz_packages_renewal_queue.sql);
      // так же — разовое посещение и пакет при разовом
      // (db/migrations/2026-10-15_zzzz_packages_review_fixes.sql).
      const queued =
        isPackages &&
        membership?.kind !== "personal" &&
        (membership?.kind === "single" || currentInfo?.kind === "single");
      if (current && !isRenewal && !queued) {
        const name = currentInfo?.name ?? "—";
        const kind = current.status === "frozen" ? "замороженный" : "активный";
        const ok = await confirm({
          title: `Заменить ${kind} абонемент?`,
          description: `У клиента уже есть ${kind} абонемент «${name}». Новая продажа заменит его.`,
          confirmLabel: "Заменить",
          destructive: false,
        });
        if (!ok) return;
      }

      const admin = await ensureStaff();
      const { data: sale, error } = await supabase
        .from("sales")
        .insert({
          studio_id: saleStudioId,
          client_id: form.clientId,
          membership_id: form.membershipId,
          // admin_id — кто внёс, seller_id / admin_name — кто продал.
          admin_id: admin?.id ?? null,
          seller_id: seller?.id ?? null,
          admin_name: seller?.full_name ?? null,
          sold_at: form.soldAt,
          total_amount: t.total,
          down_payment_amount: t.down,
          remaining_installments: t.remaining,
          source: "admin",
          // В пакетных студиях типа оплаты нет — колонка остаётся по умолчанию,
          // зато есть тип продажи.
          ...(isPackages
            ? {
                sale_kind: kind,
                trainer_id: trainer?.id ?? null,
                trainer_name: trainer?.full_name ?? null,
              }
            : { payment_type: form.paymentType }),
          payment_method: form.paymentMethod,
          list_price: t.listPrice,
          discount_amount: t.discount,
          promo_code: form.promoCode.trim() || null,
          comment: form.comment.trim() || null,
        })
        .select("id")
        .single();
      if (error || !sale) {
        toast.error("Ошибка сохранения: " + (error?.message ?? "база не вернула продажу"));
        return;
      }
      if (t.schedule.length > 0) {
        const rows = t.schedule.map((p) => ({
          sale_id: sale.id,
          due_date: p.date,
          amount: p.amount,
          paid: p.isDownPayment,
          // Первый платёж внесён в день продажи (а не в день оформления).
          paid_at: p.isDownPayment ? p.date : null,
          payment_method: p.isDownPayment ? form.paymentMethod : null,
        }));
        const { error: instErr } = await supabase.from("sale_installments").insert(rows);
        if (instErr) {
          // Без графика продажа с рассрочкой неполная — убираем её (выданный по
          // ней абонемент удаляет триггер, прежний возвращается:
          // db/migrations/2026-10-11_zzzzzz_sale_membership_delete.sql), форма
          // остаётся открытой, чтобы повторить.
          const { error: delErr } = await supabase.from("sales").delete().eq("id", sale.id);
          toast.error(
            delErr
              ? `Не записан график платежей (${instErr.message}), и продажу не удалось отменить (${delErr.message}) — удалите её в списке продаж и внесите заново`
              : "Продажа не сохранена: не записан график платежей — " + instErr.message,
          );
          if (delErr) {
            // Продажа осталась в базе — списки должны её показать.
            queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
            onSaved();
          }
          return;
        }
      }
      toast.success("Продажа создана");
      celebrateSale();
      // Продажа пакетной студии сразу появляется в «Абонементах» — откуда бы
      // её ни оформили (из «Абонементов» или из карточки клиента).
      queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isPackages ? SALE_KIND_LABEL[kind] : "Новая продажа"}</DialogTitle>
        <DialogDescription>
          {isPackages
            ? SALE_KIND_HINT[kind]
            : "Выберите клиента и абонемент. Стоимость подтянется автоматически."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Клиент" required>
              <ClientCombobox
                studioId={studioId}
                initialClient={initialClient}
                creatable
                value={form.clientId}
                onChange={(id, c) =>
                  setForm((f) => ({ ...f, clientId: id, clientLabel: c ? clientName(c) : "" }))
                }
              />
            </FormField>

            {isPackages && (
              <FormField label="Клуб продажи" tip={SALE_STUDIO_TIP} required>
                <Select value={saleStudioId ?? ""} onValueChange={setSaleStudioId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите клуб" />
                  </SelectTrigger>
                  <SelectContent>
                    {saleStudios.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Дата продажи" tip={SALE_TIPS.soldAt} required>
                <Input
                  type="date"
                  value={form.soldAt}
                  onChange={(e) => set("soldAt", e.target.value)}
                />
              </FormField>
              <FormField
                label="Администратор"
                tip={SELLER_TIP}
                required
                hint={
                  !staffLoading && admins.length === 0
                    ? "В этом клубе нет администраторов — отметьте клуб у сотрудника с ролью «Администратор» в «Сотрудниках»."
                    : undefined
                }
              >
                <SellerSelect
                  admins={admins}
                  loading={staffLoading}
                  value={seller ? form.sellerId : ""}
                  onChange={(v) => set("sellerId", v)}
                />
              </FormField>
            </div>

            <FormField
              label="Абонемент"
              tip={SALE_TIPS.membership}
              required
              hint={
                isPackages && membershipsFetched && options.length === 0
                  ? isTrial
                    ? "Нет пробных посещений. Добавьте в «Номенклатурах» номенклатуру с типом «Пробное посещение»."
                    : "Нет пакетов тренировок. Добавьте их в «Номенклатурах»."
                  : isPackages && membership?.kind === "personal"
                    ? // Пакет персональных не идёт в продажи администратора и тренера
                      // (payroll_lines, 2026-10-11_zzzzzz_personal_no_trainer_bonus.sql).
                      "С пакета персональных тренировок бонус администратору и тренеру не идёт."
                    : undefined
              }
            >
              <SearchableCombobox
                placeholder="Выбрать абонемент"
                searchPlaceholder="Поиск по названию"
                emptyText="Ничего не найдено"
                value={form.membershipId}
                onChange={pickMembership}
                options={options.map((m) => ({
                  value: m.id,
                  label: m.name,
                  hint:
                    isPackages && m.kind === "personal"
                      ? `Персональные · ${formatMoney(Number(m.price ?? 0))}`
                      : isPackages && m.kind === "single"
                        ? `Разовое · ${formatMoney(Number(m.price ?? 0))}`
                        : formatMoney(Number(m.price ?? 0)),
                  searchText: m.name,
                }))}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label="Стоимость, ₾"
                tip={SALE_TIPS.amount}
                required
                hint={
                  t.discount > 0 && t.listPrice != null
                    ? `Цена по тарифу ${formatMoney(t.listPrice)}, скидка ${formatMoney(t.discount)}.`
                    : undefined
                }
              >
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                />
              </FormField>
              <FormField
                label="Способ оплаты"
                tip="Как платил клиент. В «Кассу» продажа сама не попадает."
                required
              >
                <Select
                  value={form.paymentMethod}
                  onValueChange={(v) => set("paymentMethod", v as PaymentMethod)}
                >
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
            </div>

            {isPackages ? (
              maxPayments > 1 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="Платежей" tip={SALE_TIPS.paymentsCount} required>
                    <Select
                      value={String(form.paymentsCount)}
                      onValueChange={(v) => pickPaymentsCount(Number(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: maxPayments }, (_, i) => i + 1).map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n === 1 ? "1 — оплата сразу" : n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  {t.installment && (
                    <FormField label="Первый платёж, ₾" tip={SALE_TIPS.firstPayment} required>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={form.downPayment}
                        onChange={(e) => set("downPayment", e.target.value)}
                        placeholder="Сколько внесено сейчас"
                      />
                    </FormField>
                  )}
                  {t.schedule.length > 0 && (
                    <InfoNote className="sm:col-span-2">
                      <ul className="space-y-1">
                        {t.schedule.map((p, i) => (
                          <li key={i} className="flex items-center justify-between gap-3">
                            <span>
                              Платёж {i + 1} — {formatDate(p.date)}
                              {p.isDownPayment && " (сегодня, в клубе)"}
                            </span>
                            <span className="font-medium tabular-nums text-foreground">
                              {formatMoneyPrecise(p.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </InfoNote>
                  )}
                </div>
              )
            ) : t.installment ? (
              <div className="space-y-3">
                <div className="text-xs font-medium uppercase text-muted-foreground">Рассрочка</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="Первый взнос, ₾" tip={SALE_TIPS.downPayment} required>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.downPayment}
                      onChange={(e) => set("downPayment", e.target.value)}
                      placeholder="Сколько вносит сейчас"
                    />
                  </FormField>
                  <FormField
                    label="Ещё платежей"
                    tip={SALE_TIPS.installments}
                    htmlFor={null}
                    required
                  >
                    <SegmentedControl<"2" | "3">
                      fullWidth
                      aria-label="Ещё платежей"
                      value={form.remainingCount === 3 ? "3" : "2"}
                      onChange={(v) => set("remainingCount", v === "3" ? 3 : 2)}
                      options={[
                        { value: "2", label: "2 мес." },
                        { value: "3", label: "3 мес." },
                      ]}
                    />
                  </FormField>
                </div>

                {t.schedule.length > 0 && (
                  <InfoNote>
                    <ul className="space-y-1">
                      {t.schedule.map((p, i) => (
                        <li key={i} className="flex items-center justify-between gap-3">
                          <span>
                            {p.isDownPayment ? "Первый взнос" : `Платёж ${i + 1}`} —{" "}
                            {formatDate(p.date)}
                          </span>
                          <span className="font-medium tabular-nums text-foreground">
                            {formatMoneyPrecise(p.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </InfoNote>
                )}
              </div>
            ) : membership ? (
              <InfoNote>
                Рассрочка недоступна для этого абонемента. Оплата производится сразу.
              </InfoNote>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {isPackages && !isTrial && (
                <FormField label="Тренер" tip={SALE_TIPS.trainer} optional>
                  <Select
                    value={trainer ? form.trainerId : NO_TRAINER}
                    onValueChange={(v) => set("trainerId", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TRAINER}>Без тренера</SelectItem>
                      {trainers.map((r) => (
                        <SelectItem key={r.id} value={r.id} textValue={r.full_name}>
                          <StaffOption name={r.full_name} photo={r.photo_url} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}
              {!isPackages && (
                <FormField label="Тип оплаты" tip={SALE_TIPS.paymentType} required>
                  <Select
                    value={form.paymentType}
                    onValueChange={(v) => set("paymentType", v as PaymentType)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_TYPES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {PAYMENT_TYPE_LABEL[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}
              <FormField label="Промокод" tip={SALE_TIPS.promo} optional>
                <Input value={form.promoCode} onChange={(e) => set("promoCode", e.target.value)} />
              </FormField>
            </div>

            <FormField label="Комментарий" optional>
              <Textarea
                note
                rows={2}
                value={form.comment}
                onChange={(e) => set("comment", e.target.value)}
              />
            </FormField>

            {isRenewal && (
              <InfoNote>
                Продление не заменяет текущий абонемент клиента: посещения сначала списываются с
                текущего, пока он не истечёт или на нём не закончатся тренировки. Срок нового
                абонемента пойдёт с первого посещения по нему.
              </InfoNote>
            )}
            {isPackages && !isRenewal && membership?.kind === "single" && (
              <InfoNote>
                Разовое посещение не заменяет действующий абонемент клиента: встанет в очередь и
                спишется, когда текущий истечёт или на нём закончатся тренировки. Так же и пакет,
                проданный при неиспользованном разовом посещении.
              </InfoNote>
            )}

            {form.clientId && membership && (
              <InfoNote>
                Продажа абонемента «{membership.name}» клиенту {form.clientLabel}.
                {isPackages && !isRenewal && (
                  <>
                    {" "}
                    Абонемент будет ожидать посещения: срок действия начнётся с первой тренировки
                    клиента, а не с даты продажи.
                  </>
                )}
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
            Продать
          </Button>
        </DialogFooter>
      </DialogForm>
      {confirmDialog}
    </>
  );
}
