import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2 } from "lucide-react";

import { AdminShell, FloatingActions } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { SellerSelect } from "@/components/seller-select";
import { isAdminRole } from "@/lib/staff-directory";
import { SELLER_TIP, useStudioStaff } from "@/lib/studio-staff";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from "@/lib/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TableToolbar } from "@/components/table-toolbar";
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
import { toast } from "sonner";
import { celebrateSale } from "@/lib/confetti";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { ClientNameLink } from "@/components/client-name-link";
import { useCrmLinks } from "@/hooks/use-crm-links";
import { ClientCombobox } from "@/components/client-combobox";
import { TableSkeletonRows } from "@/components/skeletons";
import { clientName, formatMoneyPrecise, formatDate, todayISO } from "@/lib/format";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { CommentCell } from "@/components/comment-cell";
import { commentSaver } from "@/lib/comment-saver";
import { OtherSalesPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  item: "Справочник — на вкладке «Позиции». Неактивные позиции здесь не показываются.",
  unitPrice: "Подставляется из позиции. Можно изменить — например, для скидки.",
  payment: "Как платил клиент. В «Кассу» продажа сама не попадает.",
  seller: SELLER_TIP,
  catalogPrice: "Цена по умолчанию. При продаже её можно изменить.",
};

export const Route = createFileRoute("/_authenticated/other-sales")({
  head: () => ({ meta: [{ title: "Прочие продажи — Lady Stretch" }] }),
  pendingComponent: OtherSalesPageSkeleton,
  component: OtherSalesPage,
});

// ---------------------------------------------------------------------------
// Типы и справочники
// ---------------------------------------------------------------------------
type ItemKind = "service" | "product";

type SaleItem = {
  id: string;
  studio_id: string;
  kind: ItemKind;
  name: string;
  price: number;
  is_active: boolean;
  created_at: string;
};

type OtherSale = {
  id: string;
  studio_id: string;
  item_id: string | null;
  item_kind: ItemKind;
  item_name: string;
  client_id: string | null;
  admin_name: string | null;
  quantity: number;
  unit_price: number;
  total_amount: number;
  payment_method: PaymentMethod | null;
  comment: string | null;
  sold_at: string;
  created_at: string;
  clients: { first_name: string | null; last_name: string | null; full_name: string } | null;
};

const KIND_LABEL: Record<ItemKind, string> = { service: "Услуга", product: "Товар" };

/**
 * Колонки сортировки продаж (lib/table-sort.ts): ключ заголовка → колонки
 * other_sales; клиент — по встроенной карточке (to-one, PostgREST сортирует
 * родительские строки по её колонкам).
 */
const SALE_SORT_COLUMNS = {
  item: "item_name",
  kind: "item_kind",
  client: ["clients(last_name)", "clients(first_name)", "clients(full_name)"],
  quantity: "quantity",
  unitPrice: "unit_price",
  total: "total_amount",
  payment: "payment_method",
  soldAt: ["sold_at", "created_at"],
  seller: "admin_name",
  comment: "comment",
};

/** Сортировка каталога позиций — в браузере. */
const ITEM_SORT_GETTERS = {
  name: (i: SaleItem) => i.name,
  kind: (i: SaleItem) => KIND_LABEL[i.kind],
  price: (i: SaleItem) => Number(i.price),
  active: (i: SaleItem) => i.is_active,
};

/** Каталог позиций нужен обеим вкладкам — запрос у них общий через кэш. */
const saleItemsKey = (studioId: string) => ["sale_items", studioId];

function useSaleItems(studioId: string) {
  return useQuery({
    queryKey: saleItemsKey(studioId),
    queryFn: () =>
      unwrap<SaleItem[]>(
        supabase
          .from("sale_items")
          .select("*")
          .eq("studio_id", studioId)
          .order("kind", { ascending: true })
          .order("name", { ascending: true }),
      ),
    meta: { errorMessage: "Не удалось загрузить позиции" },
  });
}

/**
 * Цена из поля ввода («12,5» тоже). Пустое поле — null, а не 0: раньше
 * незаполненная цена молча сохранялась нулём.
 */
function parsePrice(raw: string) {
  const s = raw.trim().replace(",", ".");
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Страница
// ---------------------------------------------------------------------------
function OtherSalesPage() {
  const studioId = useActiveStudioId();

  return (
    <AdminShell title="Прочие продажи">
      <RequireStudio studioId={studioId}>
        <OtherSalesTabs studioId={studioId!} />
      </RequireStudio>
    </AdminShell>
  );
}

type TabValue = "sales" | "catalog";

/**
 * Плавающая кнопка «Добавить …» зависит от открытой вкладки, поэтому она и
 * окна создания живут здесь, а не в actions шапки AdminShell.
 */
function OtherSalesTabs({ studioId }: { studioId: string }) {
  const [tab, setTab] = useState<TabValue>("sales");
  const [saleOpen, setSaleOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogEditing, setCatalogEditing] = useState<SaleItem | null>(null);
  const { data: items = [] } = useSaleItems(studioId);

  const openCatalogDialog = (i: SaleItem | null) => {
    setCatalogEditing(i);
    setCatalogOpen(true);
  };

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="space-y-3">
      {/* Табы — на белой плашке фильтров, не прямо на канве. */}
      <TableToolbar>
        <div className="toolbar-full">
          <TabsList>
            <TabsTrigger value="sales">Продажи</TabsTrigger>
            <TabsTrigger value="catalog">Позиции</TabsTrigger>
          </TabsList>
        </div>
      </TableToolbar>
      <FloatingActions>
        {tab === "sales" ? (
          <Button onClick={() => setSaleOpen(true)} disabled={items.length === 0}>
            <Plus />
            Добавить продажу
          </Button>
        ) : (
          <Button onClick={() => openCatalogDialog(null)}>
            <Plus />
            Добавить позицию
          </Button>
        )}
      </FloatingActions>

      <TabsContent value="sales" className="space-y-3">
        <SalesTab studioId={studioId} open={saleOpen} onOpenChange={setSaleOpen} />
      </TabsContent>

      <TabsContent value="catalog" className="space-y-3">
        <CatalogTab
          studioId={studioId}
          open={catalogOpen}
          onOpenChange={setCatalogOpen}
          editing={catalogEditing}
          openDialog={openCatalogDialog}
        />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Вкладка «Продажи»
// ---------------------------------------------------------------------------
function SalesTab({
  studioId,
  open,
  onOpenChange,
}: {
  studioId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const { data: items = [], isLoading: itemsLoading } = useSaleItems(studioId);
  const sort = useTableSort();

  // Серверная пагинация: прежний limit(500) молча прятал старые продажи.
  // Порядок с уникальным хвостом (id) — иначе строки с одной датой и временем
  // на границе страниц дублируются или пропадают.
  const table = useServerTable<OtherSale>({
    queryKey: ["other_sales", studioId, sort.key],
    queryFn: ({ from, to }) =>
      orderBy(
        supabase
          .from("other_sales")
          .select("*, clients(first_name, last_name, full_name)", { count: "exact" })
          .eq("studio_id", studioId),
        sort.sort,
        SALE_SORT_COLUMNS,
        (q) =>
          q
            .order("sold_at", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id"),
      ).range(from, to),
    errorMessage: "Не удалось загрузить продажи",
  });
  const { rows, loading } = table;
  const reload = () => queryClient.invalidateQueries({ queryKey: ["other_sales"] });

  const handleDelete = async (s: OtherSale) => {
    if (
      !(await confirm({
        title: "Удалить продажу?",
        description: `Продажа «${s.item_name}» будет удалена.`,
      }))
    )
      return;
    const { error } = await supabase.from("other_sales").delete().eq("id", s.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Продажа удалена");
    reload();
  };

  const crmLinkOf = useCrmLinks(
    studioId,
    "id",
    rows.map((s) => s.client_id),
  );

  return (
    <>
      {/* Пока каталог грузится, он пуст — подсказку показываем только по факту. */}
      {!itemsLoading && items.length === 0 && (
        <InfoNote>
          Сначала добавьте позиции во вкладке «Позиции» — их можно будет продавать.
        </InfoNote>
      )}

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead tip={TIPS.item} {...sort.head("item")}>
                Позиция
              </TableHead>
              <TableHead {...sort.head("kind")}>Тип</TableHead>
              <TableHead {...sort.head("client")}>Клиент</TableHead>
              <TableHead className="text-right" {...sort.head("quantity")}>
                Кол-во
              </TableHead>
              <TableHead className="text-right" tip={TIPS.unitPrice} {...sort.head("unitPrice")}>
                Цена
              </TableHead>
              <TableHead className="text-right" {...sort.head("total")}>
                Сумма
              </TableHead>
              <TableHead tip={TIPS.payment} {...sort.head("payment")}>
                Оплата
              </TableHead>
              <TableHead {...sort.head("soldAt")}>Дата</TableHead>
              <TableHead tip={TIPS.seller} {...sort.head("seller")}>
                Администратор
              </TableHead>
              <TableHead {...sort.head("comment")}>Комментарий</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableSkeletonRows columns={10} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                  Пока нет продаж. Нажмите «Добавить продажу».
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => (
                <RowContextMenu
                  key={s.id}
                  actions={[
                    {
                      label: "Удалить",
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => handleDelete(s),
                    },
                  ]}
                >
                  <TableRow>
                    <TableCell className="font-medium">{s.item_name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{KIND_LABEL[s.item_kind]}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {s.client_id && s.clients ? (
                        <ClientNameLink clientId={s.client_id} crmLink={crmLinkOf(s.client_id)}>
                          {clientName(s.clients)}
                        </ClientNameLink>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyPrecise(Number(s.unit_price))}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoneyPrecise(Number(s.total_amount))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.payment_method ? PAYMENT_METHOD_LABEL[s.payment_method] : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDate(s.sold_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.admin_name ?? "—"}</TableCell>
                    <TableCell>
                      <CommentCell
                        text={s.comment}
                        onSave={commentSaver("other_sales", s.id)}
                        onSaved={reload}
                      />
                    </TableCell>
                  </TableRow>
                </RowContextMenu>
              ))
            )}
          </TableBody>
        </Table>
        <DataPagination {...table.pagination} />
      </div>

      <AddSaleDialog
        open={open}
        onOpenChange={onOpenChange}
        studioId={studioId}
        items={items}
        onSaved={reload}
      />
      {confirmDialog}
    </>
  );
}

type AddSaleDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string;
  items: SaleItem[];
  onSaved: () => void;
};

function AddSaleDialog(props: AddSaleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <AddSaleForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function AddSaleForm({ onOpenChange, studioId, items, onSaved }: AddSaleDialogProps) {
  const { ensure: ensureStaff } = useStaffProfile();
  const [form, setForm] = useState(() => ({
    itemId: "",
    clientId: "",
    quantity: "1",
    unitPrice: "",
    payment: "cash" as PaymentMethod,
    soldAt: todayISO(),
    comment: "",
    sellerId: "",
  }));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const [saving, setSaving] = useState(false);

  const selectedItem = items.find((i) => i.id === form.itemId) ?? null;
  const { data: staffRows = [], isLoading: staffLoading } = useStudioStaff(studioId);
  const admins = staffRows.filter((r) => isAdminRole(r.role));
  const seller = admins.find((r) => r.id === form.sellerId) ?? null;

  // Цену позиции подставляем при выборе, а не эффектом по itemId.
  const pickItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    setForm((f) => ({ ...f, itemId: id, unitPrice: item ? String(item.price) : f.unitPrice }));
  };

  // Без прижатия к 1: иначе «0» или «-3» молча продавались как одна штука,
  // а проверка количества ниже никогда не срабатывала.
  const qty = Math.floor(Number(form.quantity) || 0);
  const price = parsePrice(form.unitPrice);
  const total = Math.round(Math.max(0, qty) * (price ?? 0) * 100) / 100;

  const handleSave = async () => {
    if (saving) return;
    if (!selectedItem) {
      toast.error("Выберите позицию");
      return;
    }
    if (qty <= 0) {
      toast.error("Количество должно быть больше нуля");
      return;
    }
    if (price === null) {
      toast.error("Укажите цену");
      return;
    }
    if (price < 0) {
      toast.error("Цена не может быть отрицательной");
      return;
    }
    if (!form.soldAt) {
      toast.error("Укажите дату продажи");
      return;
    }
    if (!seller) {
      toast.error("Выберите администратора, который продал");
      return;
    }
    setSaving(true);
    try {
      const staff = await ensureStaff();
      const { error } = await supabase.from("other_sales").insert({
        studio_id: studioId,
        item_id: selectedItem.id,
        item_kind: selectedItem.kind,
        item_name: selectedItem.name,
        client_id: form.clientId || null,
        // admin_id — кто внёс, seller_id / admin_name — кто продал.
        admin_id: staff?.id ?? null,
        seller_id: seller.id,
        admin_name: seller.full_name,
        quantity: qty,
        unit_price: price,
        total_amount: total,
        payment_method: form.payment,
        sold_at: form.soldAt,
        comment: form.comment.trim() || null,
      });
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success("Продажа добавлена");
      celebrateSale();
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новая продажа</DialogTitle>
        <DialogDescription>
          Выберите позицию, количество и цену. Клиент — по желанию.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Позиция" tip={TIPS.item} required>
              <SearchableCombobox
                placeholder="Выбрать услугу или товар"
                searchPlaceholder="Поиск по названию"
                emptyText="Ничего не найдено"
                value={form.itemId}
                onChange={pickItem}
                options={items
                  .filter((i) => i.is_active)
                  .map((i) => ({
                    value: i.id,
                    label: i.name,
                    hint: `${KIND_LABEL[i.kind]} · ${formatMoneyPrecise(Number(i.price))}`,
                    searchText: `${i.name} ${KIND_LABEL[i.kind]}`,
                  }))}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Количество" required>
                <Input
                  type="number"
                  min={1}
                  step="1"
                  value={form.quantity}
                  onChange={(e) => set("quantity", e.target.value)}
                />
              </FormField>
              <FormField label="Цена за штуку, ₾" tip={TIPS.unitPrice} required>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.unitPrice}
                  onChange={(e) => set("unitPrice", e.target.value)}
                />
              </FormField>
            </div>

            <InfoNote className="flex items-center justify-between">
              <span>Итого</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {formatMoneyPrecise(total)}
              </span>
            </InfoNote>

            <FormField label="Клиент" optional>
              <ClientCombobox
                studioId={studioId}
                value={form.clientId}
                onChange={(id) => set("clientId", id)}
                placeholder="Без клиента"
                clearable
                creatable
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Оплата" tip={TIPS.payment} required>
                <Select
                  value={form.payment}
                  onValueChange={(v) => set("payment", v as PaymentMethod)}
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
              <FormField label="Дата" required>
                <Input
                  type="date"
                  value={form.soldAt}
                  onChange={(e) => set("soldAt", e.target.value)}
                />
              </FormField>
            </div>

            <FormField
              label="Администратор"
              tip={TIPS.seller}
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
                value={form.sellerId}
                onChange={(v) => set("sellerId", v)}
              />
            </FormField>

            <FormField label="Комментарий" optional>
              <Textarea
                note
                value={form.comment}
                onChange={(e) => set("comment", e.target.value)}
                placeholder="Заметка к продаже"
                rows={2}
              />
            </FormField>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Вкладка «Позиции» (каталог услуг/товаров)
// ---------------------------------------------------------------------------
function CatalogTab({
  studioId,
  open,
  onOpenChange,
  editing,
  openDialog,
}: {
  studioId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SaleItem | null;
  openDialog: (i: SaleItem | null) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const { data: items = [], isLoading: loading } = useSaleItems(studioId);
  const reload = () => queryClient.invalidateQueries({ queryKey: ["sale_items"] });

  const handleDelete = async (i: SaleItem) => {
    if (
      !(await confirm({
        title: "Удалить позицию?",
        description: `«${i.name}» пропадёт из каталога. Прошлые продажи сохранятся.`,
      }))
    )
      return;
    const { error } = await supabase.from("sale_items").delete().eq("id", i.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Позиция удалена");
    reload();
  };

  const toggleActive = async (i: SaleItem, next: boolean) => {
    const { error } = await supabase.from("sale_items").update({ is_active: next }).eq("id", i.id);
    if (error) {
      toast.error("Ошибка: " + error.message);
      return;
    }
    queryClient.setQueryData<SaleItem[]>(saleItemsKey(studioId), (prev) =>
      prev?.map((x) => (x.id === i.id ? { ...x, is_active: next } : x)),
    );
  };

  const sort = useTableSort(ITEM_SORT_GETTERS);
  const pg = usePagination(sort.apply(items), undefined, sort.key);

  return (
    <>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Название</TableHead>
              <TableHead {...sort.head("kind")}>Тип</TableHead>
              <TableHead className="text-right" tip={TIPS.catalogPrice} {...sort.head("price")}>
                Цена
              </TableHead>
              <TableHead className="w-[100px]" {...sort.head("active")}>
                Активна
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableSkeletonRows columns={4} />
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Пока нет позиций. Нажмите «Добавить позицию».
                </TableCell>
              </TableRow>
            ) : (
              pg.paged.map((i) => (
                <RowContextMenu
                  key={i.id}
                  actions={[
                    { label: "Редактировать", icon: Pencil, onSelect: () => openDialog(i) },
                    {
                      label: "Удалить",
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => handleDelete(i),
                    },
                  ]}
                >
                  <TableRow>
                    <TableCell className="font-medium">{i.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{KIND_LABEL[i.kind]}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyPrecise(Number(i.price))}
                    </TableCell>
                    <TableCell>
                      <Switch
                        aria-label={`Активна: ${i.name}`}
                        checked={i.is_active}
                        onCheckedChange={(v) => toggleActive(i, v)}
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

      <CatalogDialog
        open={open}
        onOpenChange={onOpenChange}
        studioId={studioId}
        item={editing}
        onSaved={reload}
      />
      {confirmDialog}
    </>
  );
}

type CatalogDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string;
  item: SaleItem | null;
  onSaved: () => void;
};

function CatalogDialog(props: CatalogDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <CatalogForm key={props.item?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function CatalogForm({ onOpenChange, studioId, item, onSaved }: CatalogDialogProps) {
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? "service");
  const [price, setPrice] = useState(item ? String(item.price) : "");
  const [isActive, setIsActive] = useState(item?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    if (!name.trim()) {
      toast.error("Укажите название");
      return;
    }
    const p = parsePrice(price);
    if (p === null || p < 0) {
      toast.error("Укажите цену");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        studio_id: studioId,
        kind,
        name: name.trim(),
        price: p,
        is_active: isActive,
      };
      const { error } = item
        ? await supabase.from("sale_items").update(payload).eq("id", item.id)
        : await supabase.from("sale_items").insert(payload);
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(item ? "Позиция обновлена" : "Позиция добавлена");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Редактировать позицию" : "Новая позиция"}</DialogTitle>
        <DialogDescription>Услуга или товар, доступные для продажи.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Тип" htmlFor={null} required>
              <SegmentedControl<ItemKind>
                fullWidth
                aria-label="Тип"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "service", label: "Услуга" },
                  { value: "product", label: "Товар" },
                ]}
              />
            </FormField>

            <FormField label="Название" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "product" ? "Вода 0.5 л" : "Персональная тренировка"}
              />
            </FormField>

            <FormField label="Цена, ₾" tip={TIPS.catalogPrice} required>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
              />
            </FormField>

            <SwitchRow
              title="Активна"
              hint="Неактивные позиции не показываются при продаже."
              checked={isActive}
              onCheckedChange={setIsActive}
            />
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
