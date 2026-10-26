import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, TrendingDown, TrendingUp, Wallet } from "lucide-react";

import { CommentCell } from "@/components/comment-cell";
import { commentSaver } from "@/lib/comment-saver";
import { StaffOption } from "@/components/employee-photo";
import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import type { Studio } from "@/hooks/use-studios";
import { StudioFilter, StudioLabel, StudioSelect } from "@/components/studio-label";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { STAFF_ROLES } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { DataPagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { formatDateTime, formatMoneyPrecise, toDateTimeLocalValue } from "@/lib/format";
import { CashPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  category: "Статья для отчёта. Продажи из «Продаж» и «Прочих продаж» сюда сами не попадают.",
  amount: "Всегда положительная — приход это или расход, задаёт «Тип».",
  operator: "Сотрудник, ответственный за операцию. По умолчанию — вы.",
  occurredAt: "Когда деньги фактически прошли. Можно указать задним числом.",
  studio: "Касса какого клуба: у каждого клуба свой баланс.",
  comment: "Обязателен. Пишите так, чтобы через месяц было понятно, за что деньги.",
};

export const Route = createFileRoute("/_authenticated/cash")({
  head: () => ({ meta: [{ title: "Касса — Lady Stretch" }] }),
  pendingComponent: CashPageSkeleton,
  component: CashPage,
});

type CashKind = "income" | "expense";

type CashOp = {
  id: string;
  studio_id: string;
  user_id: string | null;
  kind: CashKind;
  category: string;
  amount: number;
  comment: string;
  occurred_at: string;
  created_at: string;
};

type Operator = {
  id: string;
  full_name: string | null;
  email: string | null;
  /** Аватарка учётной записи (profiles.avatar_url) — в списке «Кто проводит». */
  avatar_url: string | null;
};

const CATEGORIES: Record<CashKind, { value: string; label: string }[]> = {
  income: [
    { value: "membership", label: "Продажа абонемента" },
    { value: "single_visit", label: "Разовое посещение" },
    { value: "merch", label: "Продажа товара" },
    { value: "other_income", label: "Прочий доход" },
  ],
  expense: [
    { value: "salary", label: "Зарплата" },
    { value: "rent", label: "Аренда" },
    { value: "supplies", label: "Расходники / закупка" },
    { value: "utilities", label: "Коммунальные / связь" },
    { value: "marketing", label: "Маркетинг" },
    { value: "other_expense", label: "Прочий расход" },
  ],
};

/**
 * Колонки сортировки (lib/table-sort.ts). «Сотрудник» и «Клуб» не
 * сортируются: в операции только id, имя подставляется в браузере.
 */
const SORT_COLUMNS = {
  occurredAt: "occurred_at",
  kind: "kind",
  category: "category",
  amount: "amount",
  comment: "comment",
};

const ALL_CATEGORIES = [...CATEGORIES.income, ...CATEGORIES.expense];

/** Тип операции кассы: приход — positive, расход — negative. */
function CashKindBadge({ kind }: { kind: CashKind }) {
  return kind === "income" ? (
    <StatusChip tone="positive">
      <TrendingUp /> Приход
    </StatusChip>
  ) : (
    <StatusChip tone="negative">
      <TrendingDown /> Расход
    </StatusChip>
  );
}

function categoryLabel(v: string) {
  return ALL_CATEGORIES.find((c) => c.value === v)?.label ?? v;
}

function operatorLabel(o: Operator) {
  return o.full_name || o.email || o.id.slice(0, 8);
}

function CashPage() {
  const studioId = useActiveStudioId();
  // Кассы всех клубов сотрудника на одной странице: клуб операции выбирается
  // в форме, баланс — плиткой на клуб, история — общая с колонкой «Клуб»
  // (решение владельца 2026-10-19: не переключать клуб в шапке).
  const studios = useSectionStudios("cash");
  const idsKey = studioIdsKey(studios);
  const ids = idsKey ? idsKey.split(",") : [];
  const multi = ids.length > 1;
  const studioOf = (id: string) => studios?.find((s) => s.id === id) ?? null;
  const queryClient = useQueryClient();
  // Форма после сохранения монтируется заново — так все поля возвращаются
  // к начальным значениям (приход, сейчас, текущий сотрудник) без ручного сброса.
  const [formKey, setFormKey] = useState(0);
  // Клуб формы переживает сохранение: операции обычно вносят пачкой в один клуб.
  const [pickedStudio, setPickedStudio] = useState("");
  const formStudio =
    (ids.includes(pickedStudio) && pickedStudio) ||
    (studioId && ids.includes(studioId) ? studioId : ids[0]) ||
    "";
  const [studioFilter, setStudioFilter] = useState("all");
  const historyIds = studioFilter === "all" ? idsKey : studioFilter;
  const sort = useTableSort();

  const table = useServerTable<CashOp>({
    queryKey: ["cash_operations", historyIds, sort.key],
    queryFn: ({ from, to }) =>
      orderBy(
        supabase
          .from("cash_operations")
          .select("*", { count: "exact" })
          .in("studio_id", historyIds.split(",")),
        sort.sort,
        SORT_COLUMNS,
        (q) => q.order("occurred_at", { ascending: false }).order("id"),
      ).range(from, to),
    enabled: !!historyIds,
    errorMessage: "Не удалось загрузить операции",
  });

  // Итоги считает БД по всем операциям каждого клуба, а не по текущей
  // странице, — поэтому это отдельный запрос, который не повторяется при
  // листании таблицы.
  const { data: totalsRows, isLoading: totalsQueryLoading } = useQuery({
    queryKey: ["cash_totals", idsKey],
    queryFn: () =>
      unwrap<{ studio_id: string; income: number | null; expense: number | null }[]>(
        supabase.from("cash_totals").select("studio_id, income, expense").in("studio_id", ids),
      ),
    enabled: ids.length > 0,
    meta: { errorMessage: "Не удалось загрузить итоги кассы" },
  });
  const totalsLoading = studios === null || totalsQueryLoading;
  const balanceOf = (id: string) => {
    const row = totalsRows?.find((r) => r.studio_id === id);
    return Number(row?.income ?? 0) - Number(row?.expense ?? 0);
  };

  // Сотрудники клубов: выбор «кто проводит» (только клуба формы) и подпись
  // операций в истории.
  const { data: staff } = useQuery({
    queryKey: ["user_roles", idsKey, "operators"],
    queryFn: async () => {
      const roles = await unwrap<{ user_id: string; studio_id: string }[]>(
        supabase
          .from("user_roles")
          .select("user_id, studio_id")
          .in("studio_id", ids)
          .in("role", STAFF_ROLES),
      );
      const userIds = Array.from(new Set(roles.map((r) => r.user_id)));
      if (userIds.length === 0) return { roles, profiles: [] };
      const profiles = await unwrap<Operator[]>(
        supabase.from("profiles").select("id, full_name, email, avatar_url").in("id", userIds),
      );
      return { roles, profiles };
    },
    enabled: ids.length > 0,
    meta: { errorMessage: "Не удалось загрузить сотрудников" },
  });
  const allOperators = staff?.profiles ?? [];
  const formOperators = allOperators.filter((o) =>
    staff?.roles.some((r) => r.user_id === o.id && r.studio_id === formStudio),
  );

  const operatorName = (id: string | null) => {
    if (!id) return "—";
    const op = allOperators.find((o) => o.id === id);
    return op ? operatorLabel(op) : id.slice(0, 8);
  };
  const columns = multi ? 7 : 6;

  const onSaved = () => {
    setFormKey((k) => k + 1);
    queryClient.invalidateQueries({ queryKey: ["cash_operations"] });
    queryClient.invalidateQueries({ queryKey: ["cash_totals"] });
  };

  return (
    <AdminShell title="Касса">
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          {/* Баланс каждого клуба (2026-10-19; был один — клуба из шапки);
              приход и расход «за всё время» владелец убрал (2026-10-11). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {studios === null ? (
              <CashBalanceSkeleton />
            ) : (
              studios.map((s) => (
                <StatTile
                  key={s.id}
                  icon={<Wallet />}
                  label={`Баланс · ${s.name}`}
                  // Пока баланс не пришёл — болванка, а не «0,00», который легко принять за правду.
                  loading={totalsLoading}
                  value={formatMoneyPrecise(balanceOf(s.id))}
                />
              ))
            )}
          </div>

          <CashOperationForm
            key={formKey}
            studioId={formStudio}
            studios={studios ?? []}
            onStudioChange={setPickedStudio}
            operators={formOperators}
            onSaved={onSaved}
          />

          {/* History */}
          <div className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <span className="text-lg font-semibold">История операций</span>
              {multi && studios && (
                <StudioFilter studios={studios} value={studioFilter} onChange={setStudioFilter} />
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead tip={TIPS.occurredAt} {...sort.head("occurredAt")}>
                    Дата
                  </TableHead>
                  {multi && <TableHead>Клуб</TableHead>}
                  <TableHead {...sort.head("kind")}>Тип</TableHead>
                  <TableHead tip={TIPS.category} {...sort.head("category")}>
                    Категория
                  </TableHead>
                  <TableHead className="text-right" tip={TIPS.amount} {...sort.head("amount")}>
                    Сумма
                  </TableHead>
                  <TableHead tip={TIPS.operator}>Сотрудник</TableHead>
                  <TableHead tip={TIPS.comment} {...sort.head("comment")}>
                    Комментарий
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.loading ? (
                  <TableSkeletonRows columns={columns} />
                ) : table.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Пока нет операций.
                    </TableCell>
                  </TableRow>
                ) : (
                  table.rows.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatDateTime(o.occurred_at)}
                      </TableCell>
                      {multi && (
                        <TableCell>
                          <StudioLabel studio={studioOf(o.studio_id)} />
                        </TableCell>
                      )}
                      <TableCell>
                        <CashKindBadge kind={o.kind} />
                      </TableCell>
                      <TableCell className="text-sm">{categoryLabel(o.category)}</TableCell>
                      <TableCell
                        className={
                          "whitespace-nowrap text-right font-medium tabular-nums " +
                          (o.kind === "income" ? "text-emerald-700" : "text-rose-600")
                        }
                      >
                        {o.kind === "income" ? "+" : "−"}
                        {formatMoneyPrecise(Number(o.amount))}
                      </TableCell>
                      <TableCell className="text-sm">{operatorName(o.user_id)}</TableCell>
                      <TableCell>
                        <CommentCell
                          text={o.comment}
                          onSave={commentSaver("cash_operations", o.id)}
                          onSaved={() =>
                            queryClient.invalidateQueries({ queryKey: ["cash_operations"] })
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination {...table.pagination} />
          </div>
        </RequireStudio>
      </div>
    </AdminShell>
  );
}

/** Плитка баланса, пока клубы раздела грузятся. */
function CashBalanceSkeleton() {
  return <StatTile icon={<Wallet />} label="Баланс" loading />;
}

function CashOperationForm({
  studioId,
  studios,
  onStudioChange,
  operators,
  onSaved,
}: {
  /** Клуб операции; меняет его поле «Клуб» (первое в форме). */
  studioId: string;
  studios: Studio[];
  onStudioChange: (id: string) => void;
  /** Сотрудники клуба операции. */
  operators: Operator[];
  onSaved: () => void;
}) {
  const { data: me, ensure: ensureMe } = useStaffProfile();
  const [kind, setKind] = useState<CashKind>("income");
  const [category, setCategory] = useState(CATEGORIES.income[0].value);
  const [amount, setAmount] = useState("");
  // Пусто — значит «текущий сотрудник»: профиль может загрузиться позже формы.
  const [operatorId, setOperatorId] = useState("");
  const [comment, setComment] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocalValue());
  const [saving, setSaving] = useState(false);

  const selectedOperatorId = operatorId || me?.id || "";

  const changeKind = (next: CashKind) => {
    setKind(next);
    // Категории прихода и расхода не пересекаются — выбранная от другого вида
    // в новом списке не найдётся.
    setCategory(CATEGORIES[next][0].value);
  };

  const changeStudio = (next: string) => {
    onStudioChange(next);
    // Выбранный вручную сотрудник может не работать в другом клубе.
    setOperatorId("");
  };

  const handleSave = async () => {
    if (!studioId) {
      toast.error("Выберите клуб");
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      toast.error("Укажите сумму больше нуля");
      return;
    }
    if (!comment.trim()) {
      toast.error("Комментарий обязателен");
      return;
    }
    // Пустое поле даты даёт Invalid Date, а toISOString() на нём бросает исключение.
    const occurred = new Date(occurredAt);
    if (!occurredAt || Number.isNaN(occurred.getTime())) {
      toast.error("Укажите дату и время операции");
      return;
    }
    setSaving(true);
    try {
      // Оператор не выбран вручную — текущий сотрудник (дожидаемся профиля,
      // если «Сохранить» нажали раньше, чем он загрузился).
      const operator = operatorId || (await ensureMe())?.id || null;
      const { error } = await supabase.from("cash_operations").insert({
        studio_id: studioId,
        user_id: operator,
        kind,
        category,
        amount: amt,
        comment: comment.trim(),
        occurred_at: occurred.toISOString(),
      });
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success("Операция сохранена");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      className="rounded-lg border bg-background p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving) void handleSave();
      }}
    >
      <h2 className="mb-3 text-lg font-semibold">Новая операция</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <FormField label="Клуб" tip={TIPS.studio} required className="sm:col-span-2">
          <StudioSelect studios={studios} value={studioId} onChange={changeStudio} />
        </FormField>
        <FormField label="Тип" htmlFor={null} required>
          <SegmentedControl<CashKind>
            fullWidth
            aria-label="Тип"
            value={kind}
            onChange={changeKind}
            options={[
              { value: "income", label: "Приход" },
              { value: "expense", label: "Расход" },
            ]}
          />
        </FormField>
        <FormField label="Категория" tip={TIPS.category} required>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES[kind].map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Сумма, ₾" tip={TIPS.amount} required>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
          />
        </FormField>
        <FormField label="Кто проводит" tip={TIPS.operator} required>
          <Select value={selectedOperatorId} onValueChange={setOperatorId}>
            <SelectTrigger>
              <SelectValue placeholder="Сотрудник" />
            </SelectTrigger>
            <SelectContent>
              {operators.map((o) => (
                <SelectItem key={o.id} value={o.id} textValue={operatorLabel(o)}>
                  <StaffOption name={operatorLabel(o)} avatar={o.avatar_url}>
                    {operatorLabel(o)}
                    {me?.id === o.id ? " (вы)" : ""}
                  </StaffOption>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Дата и время" tip={TIPS.occurredAt} required className="sm:col-span-2">
          <Input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </FormField>
        <FormField
          label="Комментарий"
          tip={TIPS.comment}
          required
          className="sm:col-span-2 lg:col-span-4"
        >
          <Textarea
            note
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="За что / от кого / основание"
          />
        </FormField>
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Plus />}
          Сохранить
        </Button>
      </div>
    </form>
  );
}
