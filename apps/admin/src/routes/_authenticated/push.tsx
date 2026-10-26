import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2, Send, Copy } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { CLUB_STATUS_LABEL, type ClubStatus } from "@/lib/client-status";
import { formatDateTime, toDateTimeLocalValue } from "@/lib/format";
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { PushPageSkeleton } from "@/components/page-skeletons";
import { AppStudiosField, StudioNamesCell } from "@/components/app-studios-field";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import type { ContentTranslations } from "@/lib/content-i18n";
import { splitStudioIds, useDefaultStudioIds, useMyStudioIds } from "@/hooks/use-app-studios";
import { getPushServiceStatus, kickPushQueue } from "@/lib/push.functions";

/**
 * Пуш-уведомления клиентам в мобильное приложение (решение владельца
 * 2026-10-15: настоящая рассылка). Форма сохраняет уведомление
 * запланированным (сейчас или на дату) — отправляет сервер админки
 * (lib/push/push-worker.server.ts), статус и счётчики ведёт он же; схема —
 * db/migrations/2026-10-15_push_delivery.sql. Пуш приходит клиенту на языке
 * приложения на его телефоне; кто не включил уведомления — увидит его в
 * разделе «Уведомления» приложения.
 */

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  title: "Жирная первая строка. Держите коротким — длинный обрежется на экране блокировки.",
  segments:
    "ЧК — есть действующий абонемент, БЧК — был, но закончился, ПЧК — ещё ни разу не покупал.",
  studios: "Клиентам каких клубов уйдёт уведомление.",
  recipients:
    "Клиентов в выборке, у которых есть приложение, и сколько у них телефонов с включёнными уведомлениями. Уведомление попадает всем в раздел «Уведомления» приложения, пуш — на эти телефоны.",
  sent: "На сколько телефонов пуш принят службой доставки (Apple, Google). «Не дошло» — телефон отклонил: приложение удалено или уведомления выключены.",
  delivered: "Сколько телефонов показали пуш (подтверждение от приложения).",
  read: "Сколько клиентов открыли уведомление: нажали на пуш или открыли в разделе «Уведомления».",
  actionUrl:
    "Раздел приложения — /schedule (расписание), /memberships (абонементы), /club (студия) — или ссылка https://…. По нажатию на пуш клиент попадёт туда, в разделе «Уведомления» — кнопка «Перейти».",
};

export const Route = createFileRoute("/_authenticated/push")({
  head: () => ({ meta: [{ title: "Пуш-уведомления — Base40 Admin" }] }),
  pendingComponent: PushPageSkeleton,
  component: PushPage,
});

type Segment = ClubStatus | "all";
type PushStatus = "draft" | "scheduled" | "sending" | "sent";

type PushNotification = {
  id: string;
  /** Клубы, клиентам которых уходит уведомление. */
  studio_ids: string[];
  title: string;
  message: string | null;
  action_url: string | null;
  /** Переводы для приложения: {en|ka: {title, message}}. */
  translations: ContentTranslations;
  segments: Segment[];
  scheduled_at: string | null;
  sent_at: string | null;
  status: PushStatus;
  /** Клиентов в выборке с приложением. */
  recipients_count: number;
  /** Их телефонов с включёнными уведомлениями. */
  devices_count: number;
  /** Телефонов, чья служба доставки приняла пуш. */
  sent_count: number;
  /** Не принято службой доставки. */
  failed_count: number;
  delivered_count: number;
  read_count: number;
  created_at: string;
};

const STATUS_LABEL: Record<PushStatus, string> = {
  draft: "Черновик",
  scheduled: "Запланировано",
  sending: "Отправляется",
  sent: "Отправлено",
};

const STATUS_TONE: Record<PushStatus, StatusTone> = {
  draft: "neutral",
  scheduled: "info",
  sending: "info",
  sent: "positive",
};

const SEND_MODES = [
  { value: "now" as const, label: "Отправить сейчас" },
  { value: "schedule" as const, label: "Запланировать" },
];

/** Ушло ли уведомление в рассылку (тогда его не правят, а копируют). */
const isSent = (p: PushNotification) => p.status === "sending" || p.status === "sent";

/** Рассылка идёт или вот-вот начнётся — список обновляется сам. */
function isInFlight(p: PushNotification) {
  if (p.status === "sending") return true;
  return (
    p.status === "scheduled" &&
    !!p.scheduled_at &&
    new Date(p.scheduled_at).getTime() <= Date.now() + 30_000
  );
}

/** Число колонки статистики — только у отправленных, как в StatCell. */
const sentStat = (p: PushNotification, value: number) => (isSent(p) ? value : null);

/** Сортировка колонок (lib/table-sort.ts); статус — по ходу рассылки. */
const SORT_GETTERS: SortGetters<PushNotification> = {
  title: (p) => p.title,
  segments: (p) =>
    !p.segments?.length || p.segments.includes("all")
      ? "Все"
      : p.segments.map((s) => CLUB_STATUS_LABEL[s as ClubStatus]).join(", "),
  when: (p) => (isSent(p) ? p.sent_at : p.status === "scheduled" ? p.scheduled_at : null),
  status: (p) => Object.keys(STATUS_LABEL).indexOf(p.status),
  recipients: (p) => sentStat(p, p.recipients_count),
  sent: (p) => sentStat(p, p.sent_count),
  delivered: (p) => sentStat(p, p.delivered_count),
  read: (p) => sentStat(p, p.read_count),
};

function renderSegments(segments: Segment[]) {
  if (!segments || segments.length === 0 || segments.includes("all")) {
    return <Badge variant="secondary">Все</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {segments.map((s) => (
        <Badge key={s} variant="outline">
          {CLUB_STATUS_LABEL[s as ClubStatus]}
        </Badge>
      ))}
    </div>
  );
}

/** Число со второй строкой-пояснением (только у отправленных). */
function StatCell({ p, value, note }: { p: PushNotification; value: number; note?: string }) {
  if (!isSent(p)) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="tabular-nums">
      {value}
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

function PushPage() {
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PushNotification | null>(null);
  const [template, setTemplate] = useState<PushNotification | null>(null);

  const serviceStatus = useServerFn(getPushServiceStatus);
  const { data: service } = useQuery({
    queryKey: ["push-service-status"],
    queryFn: () => serviceStatus(),
    staleTime: 5 * 60_000,
  });

  // Уведомления, где есть хоть один мой клуб (чужие RLS и не отдаст).
  const myStudioIds = useMyStudioIds();
  const { data: items = [], isPending: loading } = useQuery({
    queryKey: ["push_notifications", "by-studios", myStudioIds?.join(",") ?? ""],
    queryFn: () =>
      unwrap<PushNotification[]>(
        supabase
          .from("push_notifications")
          .select("*")
          // Триггерные (по событиям) — в разделе «Триггеры».
          .is("trigger_key", null)
          .overlaps("studio_ids", myStudioIds ?? [])
          .order("created_at", { ascending: false }),
      ),
    enabled: !!myStudioIds,
    // Пока идёт рассылка — счётчики и статус обновляются на глазах.
    refetchInterval: (query) => (query.state.data?.some(isInFlight) ? 4000 : false),
    meta: { errorMessage: "Не удалось загрузить уведомления" },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["push_notifications"] });

  const handleDelete = async (p: PushNotification) => {
    // Удалить можно только из своих клубов целиком (RLS молча не удалит).
    if (splitStudioIds(p.studio_ids, myStudioIds).locked.length > 0) {
      toast.error("Удалить нельзя: уведомление и для клубов, к которым у вас нет доступа", {
        description: "Уберите из него свои клубы в «Редактировать» — у вас оно пропадёт.",
      });
      return;
    }
    if (
      !(await confirm({
        title: "Удалить уведомление?",
        description: isSent(p)
          ? `«${p.title}» пропадёт и из раздела «Уведомления» в приложении клиентов. Пуши, которые уже пришли на телефоны, останутся.`
          : `«${p.title}» будет удалено без возможности восстановления.`,
      }))
    )
      return;
    const { error } = await supabase.from("push_notifications").delete().eq("id", p.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Уведомление удалено");
    reload();
  };

  const openEdit = (p: PushNotification | null) => {
    setEditing(p);
    setTemplate(null);
    setOpen(true);
  };

  const openCopy = (p: PushNotification) => {
    setEditing(null);
    setTemplate(p);
    setOpen(true);
  };

  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(items), undefined, sort.key);

  return (
    <AdminShell
      title="Пуш-уведомления"
      actions={
        <Button onClick={() => openEdit(null)}>
          <Plus />
          Добавить уведомление
        </Button>
      }
    >
      <div className="space-y-3">
        {service && !service.ready ? (
          <InfoNote variant="warning">
            Рассылка не настроена на сервере: не задан сервис-ключ Supabase
            (APP_SUPABASE_SERVICE_KEY). Уведомления сохраняются, но не отправляются.
          </InfoNote>
        ) : null}
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead tip={TIPS.title} {...sort.head("title")}>
                  Заголовок
                </TableHead>
                <TableHead className="w-[180px]" tip={TIPS.studios}>
                  Клубы
                </TableHead>
                <TableHead tip={TIPS.segments} {...sort.head("segments")}>
                  Сегмент
                </TableHead>
                <TableHead {...sort.head("when")}>Отправка</TableHead>
                <TableHead {...sort.head("status")}>Статус</TableHead>
                <TableHead tip={TIPS.recipients} {...sort.head("recipients")}>
                  Получатели
                </TableHead>
                <TableHead tip={TIPS.sent} {...sort.head("sent")}>
                  Отправлено
                </TableHead>
                <TableHead tip={TIPS.delivered} {...sort.head("delivered")}>
                  Доставлено
                </TableHead>
                <TableHead tip={TIPS.read} {...sort.head("read")}>
                  Прочитано
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={9} />
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    Пока нет уведомлений. Нажмите «Добавить уведомление».
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((p) => (
                  <RowContextMenu
                    key={p.id}
                    actions={[
                      isSent(p)
                        ? { label: "Создать копию", icon: Copy, onSelect: () => openCopy(p) }
                        : { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(p) },
                      {
                        label: "Удалить",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => handleDelete(p),
                      },
                    ]}
                  >
                    <TableRow>
                      <TableCell className="font-medium max-w-[280px]">
                        <div className="truncate">{p.title}</div>
                        {p.message ? (
                          <div className="truncate text-xs text-muted-foreground">{p.message}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StudioNamesCell ids={p.studio_ids} />
                      </TableCell>
                      <TableCell>{renderSegments(p.segments)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        {isSent(p)
                          ? formatDateTime(p.sent_at)
                          : p.status === "scheduled"
                            ? formatDateTime(p.scheduled_at)
                            : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusChip tone={STATUS_TONE[p.status]}>
                          {p.status === "sending" ? <Loader2 className="animate-spin" /> : null}
                          {STATUS_LABEL[p.status]}
                        </StatusChip>
                      </TableCell>
                      <TableCell>
                        <StatCell
                          p={p}
                          value={p.recipients_count}
                          note={`телефонов: ${p.devices_count}`}
                        />
                      </TableCell>
                      <TableCell>
                        <StatCell
                          p={p}
                          value={p.sent_count}
                          note={p.failed_count > 0 ? `не дошло: ${p.failed_count}` : undefined}
                        />
                      </TableCell>
                      <TableCell>
                        <StatCell p={p} value={p.delivered_count} />
                      </TableCell>
                      <TableCell>
                        <StatCell p={p} value={p.read_count} />
                      </TableCell>
                    </TableRow>
                  </RowContextMenu>
                ))
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={loading} />
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
          <PushForm
            key={editing?.id ?? (template ? `copy-${template.id}` : "new")}
            onOpenChange={setOpen}
            item={editing}
            template={template}
            onSaved={reload}
          />
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

const ALL_SEGMENTS: ClubStatus[] = ["chk", "bchk", "pchk"];

type AudienceStats = { clients: number; app_users: number; push_users: number };

/**
 * Охват: сколько клиентов в выборке, у скольких приложение и включены
 * уведомления. Считается по своим клубам (RPC push_audience_stats).
 */
function useAudience(studioIds: string[], segments: Segment[]) {
  return useQuery({
    queryKey: ["push-audience", studioIds.join(","), segments.join(",")],
    queryFn: async () => {
      const rows = await unwrap<AudienceStats[]>(
        supabase.rpc("push_audience_stats", { p_studio_ids: studioIds, p_segments: segments }),
      );
      return rows[0] ?? { clients: 0, app_users: 0, push_users: 0 };
    },
    enabled: studioIds.length > 0 && segments.length > 0,
    staleTime: 30_000,
    meta: { errorMessage: "Не удалось посчитать получателей" },
  });
}

function AudienceNote({ stats, loading }: { stats?: AudienceStats; loading: boolean }) {
  if (loading || !stats) {
    return <InfoNote>Считаем получателей…</InfoNote>;
  }
  return (
    <InfoNote>
      В выборке клиентов: <b className="text-foreground">{stats.clients}</b>, в приложении —{" "}
      <b className="text-foreground">{stats.app_users}</b>, уведомления включены у{" "}
      <b className="text-foreground">{stats.push_users}</b>. Пуш придёт на их телефоны, остальные в
      приложении увидят уведомление в разделе «Уведомления».
    </InfoNote>
  );
}

function PushForm({
  onOpenChange,
  item,
  template,
  onSaved,
}: {
  onOpenChange: (v: boolean) => void;
  /** Редактируемое (черновик или запланированное). */
  item: PushNotification | null;
  /** «Создать копию» отправленного: новое уведомление с его текстом. */
  template: PushNotification | null;
  onSaved: () => void;
}) {
  const source = item ?? template;
  const initialSegments = source?.segments ?? ["all"];
  const defaultStudioIds = useDefaultStudioIds();
  const split = splitStudioIds(source?.studio_ids ?? [], useMyStudioIds());
  // У копии — только свои клубы: чужие в новое уведомление не выбрать.
  const locked = item ? split.locked : [];
  const [studioIds, setStudioIds] = useState(source ? split.mine : defaultStudioIds);
  // Запланированное открываем в режиме планирования.
  const scheduled = item?.status === "scheduled" && item.scheduled_at ? item.scheduled_at : null;
  const { confirm, confirmDialog } = useConfirm();
  const kick = useServerFn(kickPushQueue);

  const [title, setTitle] = useState(source?.title ?? "");
  const [message, setMessage] = useState(source?.message ?? "");
  const [actionUrl, setActionUrl] = useState(source?.action_url ?? "");
  const tr = useContentTranslations(source?.translations);
  const [allSelected, setAllSelected] = useState(initialSegments.includes("all"));
  const [segments, setSegments] = useState<ClubStatus[]>(() =>
    initialSegments.includes("all")
      ? []
      : initialSegments.filter((s): s is ClubStatus => s !== "all"),
  );
  const [sendMode, setSendMode] = useState<"now" | "schedule">(scheduled ? "schedule" : "now");
  const [scheduledAt, setScheduledAt] = useState(
    scheduled ? toDateTimeLocalValue(new Date(scheduled)) : "",
  );
  const [saving, setSaving] = useState(false);

  const audienceSegments: Segment[] = allSelected ? ["all"] : segments;
  const audience = useAudience(studioIds, audienceSegments);

  const toggleSegment = (s: ClubStatus, checked: boolean) => {
    setSegments((prev) =>
      checked ? Array.from(new Set([...prev, s])) : prev.filter((x) => x !== s),
    );
  };

  const handleSave = async () => {
    if (!title.trim()) {
      tr.setLang("ru");
      toast.error("Укажите заголовок");
      return;
    }
    if (studioIds.length === 0 && locked.length === 0) {
      toast.error("Выберите хотя бы один клуб");
      return;
    }
    if (!allSelected && segments.length === 0) {
      toast.error("Выберите хотя бы один сегмент");
      return;
    }
    if (sendMode === "schedule" && !scheduledAt) {
      toast.error("Укажите дату и время отправки");
      return;
    }
    const sendNow = sendMode === "now";
    const when = sendNow ? new Date() : new Date(scheduledAt);
    if (!sendNow && when.getTime() < Date.now() - 60_000) {
      toast.error("Время отправки уже прошло", {
        description: "Выберите время в будущем или «Отправить сейчас».",
      });
      return;
    }
    // Пуш не отозвать — перед отправкой сейчас переспрашиваем.
    if (sendNow) {
      const reach = audience.data
        ? ` Пуш получат ${audience.data.push_users} из ${audience.data.app_users} клиентов в приложении.`
        : "";
      const ok = await confirm({
        title: "Отправить уведомление сейчас?",
        description: `«${title.trim()}» уйдёт клиентам выбранных клубов.${reach} Отменить отправку будет нельзя.`,
        confirmLabel: "Отправить",
        destructive: false,
      });
      if (!ok) return;
    }

    // Отправляет сервер: здесь — запланированное (сейчас или на дату).
    const payload = {
      title: title.trim(),
      message: message.trim() || null,
      translations: tr.cleaned(),
      segments: audienceSegments,
      studio_ids: [...studioIds, ...locked],
      action_url: actionUrl.trim() || null,
      // «Сейчас» — время ставит база (now()): часы компьютера могут спешить,
      // и рассылка ждала бы их «сейчас».
      scheduled_at: sendNow ? null : when.toISOString(),
      status: "scheduled" as const,
      updated_at: new Date().toISOString(),
    };

    setSaving(true);
    try {
      const { error } = item
        ? await supabase.from("push_notifications").update(payload).eq("id", item.id)
        : await supabase.from("push_notifications").insert(payload);
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      if (sendNow) {
        // Не ждать очередного прохода рассылки; не вышло — уйдёт в течение 15 секунд.
        kick().catch(() => {});
      }
      toast.success(sendNow ? "Уведомление отправляется" : "Уведомление запланировано");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {item
            ? "Редактировать уведомление"
            : template
              ? "Копия уведомления"
              : "Новое пуш-уведомление"}
        </DialogTitle>
        <DialogDescription>
          Уведомление будет отправлено клиентам выбранных клубов в мобильное приложение — на языке
          приложения на телефоне клиента.
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <FormField
              label={<ContentLangLabel lang={tr.lang}>Заголовок</ContentLangLabel>}
              tip={TIPS.title}
              required={tr.lang === "ru"}
            >
              <Input
                {...tr.input("title", title, setTitle, "Например: Скидка 20% на абонементы")}
                maxLength={150}
              />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Сообщение</ContentLangLabel>}
              tip="На экране блокировки видно 2–3 строки — главное пишите в начале. В разделе «Уведомления» приложения текст виден целиком."
              optional
            >
              <Textarea
                {...tr.input("message", message, setMessage, "Текст пуш-уведомления")}
                rows={4}
                maxLength={1000}
              />
            </FormField>

            <FormField label="Ссылка перехода" optional tip={TIPS.actionUrl}>
              <Input
                value={actionUrl}
                onChange={(e) => setActionUrl(e.target.value)}
                placeholder="/schedule или https://…"
                maxLength={1000}
              />
            </FormField>

            <AppStudiosField
              value={studioIds}
              onChange={setStudioIds}
              locked={locked}
              tip={TIPS.studios}
            />

            <FormField label="Статус клиентов" tip={TIPS.segments} htmlFor={null} required>
              <div className="space-y-2 rounded-md border p-3">
                <CheckboxOption checked={allSelected} onCheckedChange={setAllSelected}>
                  Все клиенты
                </CheckboxOption>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {ALL_SEGMENTS.map((s) => (
                    <CheckboxOption
                      key={s}
                      checked={!allSelected && segments.includes(s)}
                      disabled={allSelected}
                      onCheckedChange={(v) => toggleSegment(s, v)}
                    >
                      {CLUB_STATUS_LABEL[s]}
                    </CheckboxOption>
                  ))}
                </div>
              </div>
            </FormField>

            {studioIds.length > 0 && audienceSegments.length > 0 ? (
              <AudienceNote stats={audience.data} loading={audience.isPending} />
            ) : null}

            <FormField label="Время отправки" htmlFor={null} required>
              <SegmentedControl
                aria-label="Время отправки"
                fullWidth
                value={sendMode}
                onChange={setSendMode}
                options={SEND_MODES}
              />
            </FormField>

            {sendMode === "schedule" && (
              <FormField
                label="Дата и время отправки"
                required
                hint="По времени вашего компьютера. Уйдёт в течение 15 секунд после наступления."
              >
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </FormField>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Send />}
            {sendMode === "now" ? "Отправить" : "Запланировать"}
          </Button>
        </DialogFooter>
      </DialogForm>
      {confirmDialog}
    </>
  );
}
