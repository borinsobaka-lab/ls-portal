import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Receipt } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { SELLER_TIP } from "@/lib/studio-staff";
import { RequireStudio } from "@/components/require-studio";
import { RequireFormat } from "@/components/require-format";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { supabase } from "@/integrations/supabase/client";
import {
  PAYMENT_TYPE_LABEL,
  SALE_TIPS,
  saleDeleteDescription,
  saleSourceLabel,
  type PaymentType,
} from "@/lib/payments";
import { Button } from "@/components/ui/button";
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
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { ClientNameLink } from "@/components/client-name-link";
import { useCrmLinks } from "@/hooks/use-crm-links";
import { SaleDialog } from "@/components/sale-dialog";
import { RefundDialog, type RefundSale } from "@/components/refund-dialog";
import { CommentCell } from "@/components/comment-cell";
import { commentSaver } from "@/lib/comment-saver";
import { TableSkeletonRows } from "@/components/skeletons";
import { clientName, formatMoney, formatDate, formatPhone } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { StatusChip } from "@/components/ui/status-chip";
import { MembershipStatusBadge, AutoRenewBadge } from "@/components/membership-status-badge";
import { effectiveStatus, isLiveStatus } from "@/lib/membership-status";
import { SalesPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?» колонок — те же, что у полей формы продажи. */
const TIPS = { ...SALE_TIPS, admin: SELLER_TIP };

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => ({ meta: [{ title: "Продажи — Lady Stretch" }] }),
  pendingComponent: SalesPageSkeleton,
  component: SalesRoute,
});

// Только подписочные клубы: в пакетных продажа, возврат и удаление — в
// «Абонементах» (решение владельца 2026-10-13, STUDIO_FORMATS.md).
function SalesRoute() {
  return (
    <RequireFormat
      format="subscription"
      title="Продажи"
      other={{ packages: "/client-memberships" }}
    >
      <SalesPage />
    </RequireFormat>
  );
}

// Колонки вью sales_list. search_text не запрашиваем — он нужен только для
// фильтра на сервере. Связанные объекты (clients / memberships /
// client_memberships) вью отдаёт в той же форме, что раньше вложенный select.
const SALE_COLUMNS =
  "id, studio_id, client_id, membership_id, admin_id, admin_name, sold_at, total_amount, " +
  "down_payment_amount, remaining_installments, source, payment_type, promo_code, comment, " +
  "created_at, clients, memberships, client_memberships";

/**
 * Колонки сортировки (lib/table-sort.ts): ключ заголовка → колонки вью.
 * Клиент и абонемент — поля json-колонок вью (PostgREST сортирует по
 * `col->>key`). Статус — массив абонементов продажи, не сортируется.
 */
const SORT_COLUMNS = {
  client: ["clients->>last_name", "clients->>first_name", "clients->>full_name"],
  contacts: "clients->>phone",
  soldAt: ["sold_at", "created_at"],
  source: "source",
  membership: "memberships->>name",
  paymentType: "payment_type",
  promo: "promo_code",
  amount: "total_amount",
  downPayment: "down_payment_amount",
  installments: "remaining_installments",
  admin: "admin_name",
  comment: "comment",
};

type Sale = {
  id: string;
  studio_id: string;
  client_id: string;
  membership_id: string;
  admin_id: string | null;
  admin_name: string | null;
  sold_at: string;
  total_amount: number;
  down_payment_amount: number;
  remaining_installments: number;
  source: "admin" | "mobile";
  payment_type: PaymentType | null;
  promo_code: string | null;
  comment: string | null;
  created_at: string;
  clients: {
    id: string;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  memberships: { id: string; name: string } | null;
  client_memberships:
    | {
        id: string;
        status: string;
        auto_renew: boolean | null;
        ends_at: string | null;
        cancelled_at: string | null;
      }[]
    | null;
};

function SourceBadge({ source }: { source: Sale["source"] | null }) {
  return (
    <StatusChip tone={source === "mobile" ? "info" : "neutral"}>
      {saleSourceLabel(source)}
    </StatusChip>
  );
}

function SalesPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  const columns = 13;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [saleOpen, setSaleOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSale, setRefundSale] = useState<RefundSale | null>(null);
  const sort = useTableSort();

  const term = useDebouncedValue(search).trim();
  const table = useServerTable<Sale>({
    queryKey: ["sales_list", studioId, term, sort.key],
    queryFn: ({ from, to }) => {
      let q = supabase
        .from("sales_list")
        .select(SALE_COLUMNS, { count: "exact" })
        .eq("studio_id", studioId!);
      if (term) q = q.ilike("search_text", `%${term}%`);
      // sold_at — дата, у многих продаж одна: без уникального хвоста строки
      // на границе страниц дублируются или пропадают.
      return orderBy(q, sort.sort, SORT_COLUMNS, (o) =>
        o
          .order("sold_at", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id"),
      ).range(from, to);
    },
    enabled: !!studioId,
    errorMessage: "Не удалось загрузить продажи",
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["sales_list"] });
  const crmLinkOf = useCrmLinks(
    studioId,
    "id",
    table.rows.map((s) => s.client_id),
  );

  const handleDelete = async (s: Sale) => {
    if (
      !(await confirm({
        title: "Удалить продажу?",
        description: saleDeleteDescription(
          s.clients ? clientName(s.clients) : null,
          s.memberships?.name ?? null,
        ),
      }))
    )
      return;
    const { error } = await supabase.from("sales").delete().eq("id", s.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success(s.client_memberships?.length ? "Продажа и абонемент удалены" : "Продажа удалена");
    // Вместе с продажей удалился абонемент клиента (триггер в базе).
    for (const key of [
      "sales_list",
      "client_packages_list",
      "client_memberships",
      "clients_with_status",
    ])
      queryClient.invalidateQueries({ queryKey: [key] });
  };

  const openRefund = (s: Sale) => {
    setRefundSale({
      id: s.id,
      studio_id: s.studio_id,
      total_amount: Number(s.total_amount),
      membershipName: s.memberships?.name ?? null,
    });
    setRefundOpen(true);
  };

  return (
    <AdminShell
      title="Продажи"
      actions={
        <Button onClick={() => setSaleOpen(true)} disabled={!studioId}>
          <Plus />
          Новая продажа
        </Button>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Поиск по клиенту или абонементу"
            />
          </TableToolbar>

          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]" {...sort.head("client")}>
                    Клиент
                  </TableHead>
                  <TableHead {...sort.head("contacts")}>Контакты</TableHead>
                  <TableHead tip={TIPS.soldAt} {...sort.head("soldAt")}>
                    Дата
                  </TableHead>
                  <TableHead {...sort.head("source")}>Источник</TableHead>
                  <TableHead tip={TIPS.membership} {...sort.head("membership")}>
                    Абонемент
                  </TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead tip={TIPS.paymentType} {...sort.head("paymentType")}>
                    Тип оплаты
                  </TableHead>
                  <TableHead tip={TIPS.promo} {...sort.head("promo")}>
                    Промо-код
                  </TableHead>
                  <TableHead className="text-right" tip={TIPS.amount} {...sort.head("amount")}>
                    Сумма
                  </TableHead>
                  <TableHead
                    className="text-right"
                    tip={TIPS.downPayment}
                    {...sort.head("downPayment")}
                  >
                    Первый взнос
                  </TableHead>
                  <TableHead tip={TIPS.installments} {...sort.head("installments")}>
                    Рассрочка
                  </TableHead>
                  <TableHead tip={TIPS.admin} {...sort.head("admin")}>
                    Администратор
                  </TableHead>
                  <TableHead {...sort.head("comment")}>Комментарий</TableHead>
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
                      {term ? "Ничего не найдено." : "Продаж пока нет. Нажмите «Новая продажа»."}
                    </TableCell>
                  </TableRow>
                ) : (
                  table.rows.map((s) => {
                    const cm = s.client_memberships?.[0] ?? null;
                    return (
                      <RowContextMenu
                        key={s.id}
                        actions={[
                          {
                            label: "Оформить возврат",
                            icon: Receipt,
                            onSelect: () => openRefund(s),
                          },
                          {
                            label: "Удалить",
                            icon: Trash2,
                            destructive: true,
                            onSelect: () => handleDelete(s),
                          },
                        ]}
                      >
                        <TableRow>
                          <TableCell className="font-medium">
                            {s.clients ? (
                              <ClientNameLink
                                clientId={s.client_id}
                                crmLink={crmLinkOf(s.client_id)}
                              >
                                {clientName(s.clients)}
                              </ClientNameLink>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            <div>{formatPhone(s.clients?.phone) || "—"}</div>
                            <div className="text-xs">{s.clients?.email ?? "—"}</div>
                          </TableCell>
                          <TableCell className="tabular-nums">{formatDate(s.sold_at)}</TableCell>
                          <TableCell>
                            <SourceBadge source={s.source} />
                          </TableCell>
                          <TableCell>{s.memberships?.name ?? "—"}</TableCell>
                          <TableCell>
                            {cm ? (
                              <div className="flex flex-col gap-1">
                                <MembershipStatusBadge m={cm} />
                                {isLiveStatus(effectiveStatus(cm)) && (
                                  <AutoRenewBadge on={cm.auto_renew} />
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {PAYMENT_TYPE_LABEL[s.payment_type ?? "other"]}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {s.promo_code ?? "—"}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatMoney(Number(s.total_amount))}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {s.remaining_installments > 0
                              ? formatMoney(Number(s.down_payment_amount))
                              : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {s.remaining_installments > 0 ? `1 + ${s.remaining_installments}` : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {s.admin_name ?? "—"}
                          </TableCell>
                          <TableCell>
                            <CommentCell
                              text={s.comment}
                              onSave={commentSaver("sales", s.id)}
                              onSaved={reload}
                            />
                          </TableCell>
                        </TableRow>
                      </RowContextMenu>
                    );
                  })
                )}
              </TableBody>
            </Table>

            <DataPagination {...table.pagination} />
          </div>
        </RequireStudio>
      </div>

      <SaleDialog open={saleOpen} onOpenChange={setSaleOpen} studioId={studioId} onSaved={reload} />
      <RefundDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        sale={refundSale}
        onSaved={reload}
      />
      {confirmDialog}
    </AdminShell>
  );
}
