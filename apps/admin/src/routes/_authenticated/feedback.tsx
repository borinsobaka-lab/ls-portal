import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, MessageSquare, Loader2, QrCode, Copy, Download } from "lucide-react";
import { endOfDay, format, startOfDay } from "date-fns";
import { ru } from "date-fns/locale";
import { toast } from "sonner";
import QRCode from "qrcode";

import { AdminShell } from "@/components/admin-shell";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useActiveStudio, type Studio } from "@/hooks/use-studios";
import { studioIdsKey, useSectionStudios } from "@/hooks/use-section-studios";
import { StudioFilter, StudioLabel, StudioSelect } from "@/components/studio-label";
import { STUDIO_FORMAT_APP_URL } from "@/lib/studio-formats";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { useTableSort } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";
import { StatTile } from "@/components/ui/stat-tile";
import { noteBoxClass } from "@/components/comment-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/ui/status-chip";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogForm,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { RowContextMenu } from "@/components/row-context-menu";
import { useConfirm } from "@/components/confirm-dialog";
import { FeedbackPageSkeleton, FeedbackStatsSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  contact: "Телефон, почта или ник — чтобы потом связаться с клиентом.",
};

export const Route = createFileRoute("/_authenticated/feedback")({
  head: () => ({ meta: [{ title: "Обратная связь — Base40 Admin" }] }),
  pendingComponent: FeedbackPageSkeleton,
  component: FeedbackPage,
});

type Feedback = {
  id: string;
  studio_id: string | null;
  topic: string;
  message: string;
  mood: string | null;
  client_name: string | null;
  client_contact: string | null;
  status: "pending" | "resolved";
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_comment: string | null;
  created_at: string;
  /** Откуда пришло (db/migrations/2026-10-15_zz_feedback_in_app.sql); старые — null. */
  source: "app" | "link" | "portal" | null;
};

const SOURCES: Record<string, string> = {
  app: "Мобильное приложение",
  link: "Ссылка или QR-код",
  portal: "Добавлено в портале",
};

// Подписи без эмодзи: эмодзи вместо иконок скринридер читал названием
// («грустное лицо»), а в списке и сортировке они мешали тексту.
const TOPICS: Record<string, string> = {
  training: "Тренировка",
  staff: "Сотрудник",
  cleanliness: "Чистота",
  app: "Приложение",
  idea: "Идея",
  thanks: "Спасибо",
  other: "Другое",
};

const MOOD_OPTIONS = [
  { value: "negative", emoji: "😞", label: "Плохо" },
  { value: "neutral", emoji: "😐", label: "Нормально" },
  { value: "positive", emoji: "😊", label: "Хорошо" },
];

/** Настроение в строке — смайлик с подписью для скринридера и подсказкой. */
function MoodMark({ mood }: { mood: string }) {
  const m = MOOD_OPTIONS.find((o) => o.value === mood);
  if (!m) return <>{mood}</>;
  return (
    <span role="img" aria-label={m.label} title={m.label}>
      {m.emoji}
    </span>
  );
}

/** Оценка для сортировки: от «Плохо» к «Хорошо». */
const MOOD_RANK: Record<string, number> = Object.fromEntries(
  MOOD_OPTIONS.map((m, i) => [m.value, i]),
);

/**
 * Сортировка по колонкам (lib/table-sort.ts) — в браузере, после фильтров.
 * Без сортировки — как прежде: не отработанные сверху, новые первыми.
 */
const SORT_GETTERS = {
  createdAt: (i: Feedback) => i.created_at,
  topic: (i: Feedback) => TOPICS[i.topic] || i.topic,
  message: (i: Feedback) => i.message,
  mood: (i: Feedback) => (i.mood ? MOOD_RANK[i.mood] : null),
  name: (i: Feedback) => i.client_name,
  contact: (i: Feedback) => i.client_contact,
  status: (i: Feedback) => (i.status === "pending" ? 0 : 1),
  resolvedBy: (i: Feedback) => i.resolved_by_name,
};

function moodSelectItems() {
  return MOOD_OPTIONS.map((m) => (
    <SelectItem key={m.value} value={m.value}>
      <span aria-hidden>{m.emoji}</span> {m.label}
    </SelectItem>
  ));
}

function FeedbackPage() {
  const studioId = useActiveStudioId();
  // Обращения всех клубов сотрудника сразу, клуб — колонкой (решение
  // владельца 2026-10-19: не переключать клуб в шапке, чтобы увидеть отзыв).
  const studios = useSectionStudios("feedback");
  const idsKey = studioIdsKey(studios);
  const multi = (studios?.length ?? 0) > 1;
  const studioOf = (id: string | null) => studios?.find((s) => s.id === id) ?? null;
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [studioFilter, setStudioFilter] = useState("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [moodFilter, setMoodFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [linksOpen, setLinksOpen] = useState(false);

  const queryKey = ["feedback", idsKey];
  const { data: items = [], isLoading: queryLoading } = useQuery({
    queryKey,
    queryFn: () => {
      let q = supabase.from("feedback").select("*");
      // Отзывы клубов раздела + строки без привязки (созданные до миграции
      // db/feedback_nps_studio.sql при нескольких студиях) — чтобы ни один
      // отзыв не пропал из виду.
      if (idsKey) q = q.or(`studio_id.in.(${idsKey}),studio_id.is.null`);
      return unwrap<Feedback[]>(
        q.order("status", { ascending: true }).order("created_at", { ascending: false }),
      );
    },
    enabled: studios !== null,
    meta: { errorMessage: "Не удалось загрузить обращения" },
  });
  const loading = studios === null || queryLoading;
  const reload = () => queryClient.invalidateQueries({ queryKey: ["feedback"] });

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (studioFilter !== "all" && i.studio_id !== studioFilter) return false;
      if (topicFilter !== "all" && i.topic !== topicFilter) return false;
      if (statusFilter !== "all" && i.status !== statusFilter) return false;
      if (moodFilter !== "all") {
        if (moodFilter === "none" && i.mood) return false;
        if (moodFilter !== "none" && i.mood !== moodFilter) return false;
      }
      const created = new Date(i.created_at);
      if (dateRange?.from && created < startOfDay(dateRange.from)) return false;
      if (dateRange?.to && created > endOfDay(dateRange.to)) return false;
      return true;
    });
  }, [items, studioFilter, topicFilter, statusFilter, moodFilter, dateRange]);

  const sort = useTableSort({
    ...SORT_GETTERS,
    studio: (i: Feedback) => studioOf(i.studio_id)?.name,
  });
  const pg = usePagination(sort.apply(filtered), undefined, sort.key);

  const selected = items.find((i) => i.id === selectedId) || null;

  const now = new Date();
  const thisMonth = items.filter((i) => {
    const d = new Date(i.created_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const resolvedThisMonth = thisMonth.filter((i) => i.status === "resolved").length;

  const handleDelete = async (item: Feedback) => {
    if (
      !(await confirm({
        title: "Удалить обращение?",
        description: "Это действие нельзя отменить.",
      }))
    )
      return;
    const { error } = await supabase.from("feedback").delete().eq("id", item.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    queryClient.setQueryData<Feedback[]>(queryKey, (prev) => prev?.filter((i) => i.id !== item.id));
    toast.success("Удалено");
  };

  const hasFilters =
    studioFilter !== "all" ||
    topicFilter !== "all" ||
    statusFilter !== "all" ||
    moodFilter !== "all" ||
    !!dateRange;
  const columns = multi ? 9 : 8;

  return (
    <AdminShell
      title="Обратная связь"
      actions={
        <>
          <Button variant="outline" onClick={() => setLinksOpen(true)}>
            <QrCode /> Ссылка и QR-код
          </Button>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus /> Добавить
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
              <NewFeedbackForm
                studioId={studioId}
                studios={studios ?? []}
                onClose={() => setAddOpen(false)}
                onSaved={reload}
              />
            </DialogContent>
          </Dialog>
        </>
      }
    >
      <div className="space-y-3">
        {/* Пока отзывы грузятся — болванки значений, а не нули. */}
        {loading ? (
          <FeedbackStatsSkeleton />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label="В этом месяце" value={thisMonth.length} />
            <StatTile
              label="Не отработано"
              value={pendingCount}
              tone={pendingCount > 0 ? "negative" : "default"}
            />
            <StatTile label="Отработано в этом месяце" value={resolvedThisMonth} />
          </div>
        )}

        <TableToolbar>
          {multi && studios && (
            <StudioFilter studios={studios} value={studioFilter} onChange={setStudioFilter} />
          )}
          <Select value={topicFilter} onValueChange={setTopicFilter}>
            <SelectTrigger aria-label="Тема" className="w-48">
              <SelectValue placeholder="Все темы" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все темы</SelectItem>
              {Object.entries(TOPICS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="Статус" className="w-40">
              <SelectValue placeholder="Все статусы" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              <SelectItem value="pending">Не отработано</SelectItem>
              <SelectItem value="resolved">Отработано</SelectItem>
            </SelectContent>
          </Select>
          <Select value={moodFilter} onValueChange={setMoodFilter}>
            <SelectTrigger aria-label="Настроение" className="w-40">
              <SelectValue placeholder="Все оценки" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все оценки</SelectItem>
              {moodSelectItems()}
              <SelectItem value="none">Без оценки</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeFilter
            placeholder="Дата"
            title="Дата обращения"
            value={dateRange}
            onChange={setDateRange}
            className="w-48"
          />
          <ToolbarReset
            active={hasFilters}
            onReset={() => {
              setStudioFilter("all");
              setTopicFilter("all");
              setStatusFilter("all");
              setMoodFilter("all");
              setDateRange(undefined);
            }}
          />
        </TableToolbar>

        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead {...sort.head("createdAt")}>Дата</TableHead>
                <TableHead {...sort.head("topic")}>Тема</TableHead>
                <TableHead {...sort.head("message")}>Сообщение</TableHead>
                <TableHead className="w-[80px] text-center" {...sort.head("mood")}>
                  Оценка
                </TableHead>
                <TableHead {...sort.head("name")}>Имя</TableHead>
                {multi && <TableHead {...sort.head("studio")}>Клуб</TableHead>}
                <TableHead tip={TIPS.contact} {...sort.head("contact")}>
                  Контакт
                </TableHead>
                <TableHead {...sort.head("status")}>Статус</TableHead>
                <TableHead {...sort.head("resolvedBy")}>Отработал</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={columns} />
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                    Обращений нет.
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((i) => (
                  <RowContextMenu
                    key={i.id}
                    actions={[
                      {
                        label: "Открыть обращение",
                        icon: MessageSquare,
                        onSelect: () => setSelectedId(i.id),
                      },
                      {
                        label: "Удалить",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => handleDelete(i),
                      },
                    ]}
                  >
                    <TableRow onClick={() => setSelectedId(i.id)} className="cursor-pointer">
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {format(new Date(i.created_at), "dd.MM.yy HH:mm", { locale: ru })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {TOPICS[i.topic] || i.topic}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate">{i.message}</TableCell>
                      <TableCell className="text-center text-lg">
                        {i.mood ? <MoodMark mood={i.mood} /> : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {i.client_name || "—"}
                      </TableCell>
                      {multi && (
                        <TableCell>
                          <StudioLabel studio={studioOf(i.studio_id)} />
                        </TableCell>
                      )}
                      <TableCell className="max-w-[140px] truncate whitespace-nowrap text-muted-foreground">
                        {i.client_contact || "—"}
                      </TableCell>
                      <TableCell>
                        {i.status === "pending" ? (
                          <StatusChip tone="warning">Не отработано</StatusChip>
                        ) : (
                          <StatusChip tone="positive">Отработано</StatusChip>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {i.resolved_by_name ? (
                          <>
                            {i.resolved_by_name}
                            {i.resolved_at && (
                              <div>
                                {format(new Date(i.resolved_at), "dd.MM.yy", { locale: ru })}
                              </div>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
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

      {/* Обращение — окно, как карточки во всей админке (решение владельца
          2026-10-15; раньше — боковая панель). */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelectedId(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <FeedbackDetails
              key={selected.id}
              item={selected}
              studio={multi ? studioOf(selected.studio_id) : null}
              onClose={() => setSelectedId(null)}
              onDone={() => {
                setSelectedId(null);
                reload();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={linksOpen} onOpenChange={setLinksOpen}>
        <DialogContent className="max-w-lg">{linksOpen && <FeedbackLinks />}</DialogContent>
      </Dialog>

      {confirmDialog}
    </AdminShell>
  );
}

function NewFeedbackForm({
  studioId,
  studios,
  onClose,
  onSaved,
}: {
  studioId: string | null;
  /** Клубы раздела: при нескольких — поле «Клуб», по умолчанию клуб из шапки. */
  studios: Studio[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [studio, setStudio] = useState(
    () => studios.find((s) => s.id === studioId)?.id ?? studios[0]?.id ?? studioId ?? "",
  );
  const [topic, setTopic] = useState("other");
  const [message, setMessage] = useState("");
  const [mood, setMood] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientContact, setClientContact] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!message.trim()) {
      toast.error("Введите сообщение");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("feedback").insert({
        studio_id: studio || null,
        topic,
        message: message.trim(),
        mood: mood || null,
        client_name: clientName.trim() || null,
        client_contact: clientContact.trim() || null,
        source: "portal",
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Обращение добавлено");
      onClose();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новое обращение</DialogTitle>
        <DialogDescription>Заполните данные обращения клиента.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={submit}>
        <DialogBody>
          <div className="space-y-4">
            {studios.length > 1 && (
              <FormField label="Клуб" required>
                <StudioSelect studios={studios} value={studio} onChange={setStudio} />
              </FormField>
            )}
            <FormField label="Тема" required>
              <Select value={topic} onValueChange={setTopic}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TOPICS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Сообщение" required>
              <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
            </FormField>
            <FormField label="Оценка">
              <Select value={mood || "none"} onValueChange={(v) => setMood(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Без оценки</SelectItem>
                  {moodSelectItems()}
                </SelectContent>
              </Select>
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Имя" optional>
                <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
              </FormField>
              <FormField label="Контакт" tip={TIPS.contact} optional>
                <Input value={clientContact} onChange={(e) => setClientContact(e.target.value)} />
              </FormField>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
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

/** Окно обращения: отметить отработанным / вернуть в работу. */
function FeedbackDetails({
  item,
  studio,
  onClose,
  onDone,
}: {
  item: Feedback;
  /** Клуб обращения — когда в разделе несколько клубов. */
  studio: Studio | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { ensure: ensureMe } = useStaffProfile();
  const [resolutionComment, setResolutionComment] = useState(item.resolution_comment || "");
  const [busy, setBusy] = useState(false);

  const update = async (patch: Partial<Feedback>, successMessage: string) => {
    setBusy(true);
    try {
      const { error } = await supabase.from("feedback").update(patch).eq("id", item.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(successMessage);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    const me = await ensureMe();
    return update(
      {
        status: "resolved",
        resolved_by: me?.id ?? null,
        resolved_by_name: me?.displayName || null,
        resolved_at: new Date().toISOString(),
        resolution_comment: resolutionComment.trim() || null,
      },
      "Обращение отработано",
    );
  };

  const handleReopen = () =>
    update(
      {
        status: "pending",
        resolved_by: null,
        resolved_by_name: null,
        resolved_at: null,
        resolution_comment: null,
      },
      "Возвращено в работу",
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{TOPICS[item.topic] || item.topic}</DialogTitle>
        <DialogDescription>
          {format(new Date(item.created_at), "d MMMM yyyy, HH:mm", { locale: ru })}
          {item.source && ` · ${SOURCES[item.source]}`}
          {studio && ` · ${studio.name}`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <ReadOnlyValue label="Сообщение">
          <span className="whitespace-pre-wrap">{item.message}</span>
        </ReadOnlyValue>
        {item.mood && (
          <ReadOnlyValue label="Оценка">
            <span>
              <span className="text-lg">
                <MoodMark mood={item.mood} />
              </span>{" "}
              {MOOD_OPTIONS.find((o) => o.value === item.mood)?.label}
            </span>
          </ReadOnlyValue>
        )}
        {(item.client_name || item.client_contact) && (
          <ReadOnlyValue label="Клиент">
            {item.client_name || "—"}
            {item.client_contact ? ` · ${item.client_contact}` : ""}
          </ReadOnlyValue>
        )}
        {item.status === "pending" ? (
          <FormField
            label="Комментарий обработки"
            tip="Что сделано. Сохранится с вашим именем при отметке «Отработано»."
            optional
          >
            <Textarea
              note
              value={resolutionComment}
              onChange={(e) => setResolutionComment(e.target.value)}
              placeholder="Что сделано?"
              rows={4}
            />
          </FormField>
        ) : (
          <InfoNote className="space-y-1">
            <p className="font-medium">Обработано</p>
            <p className="text-sm text-foreground">
              {item.resolved_by_name || "—"}
              {item.resolved_at &&
                ` · ${format(new Date(item.resolved_at), "d MMM yyyy", { locale: ru })}`}
            </p>
            {item.resolution_comment && (
              <p className={cn(noteBoxClass, "whitespace-pre-wrap text-sm")}>
                {item.resolution_comment}
              </p>
            )}
          </InfoNote>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Закрыть
        </Button>
        {item.status === "pending" ? (
          <Button onClick={handleResolve} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Отметить отработанным
          </Button>
        ) : (
          <Button onClick={handleReopen} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Вернуть в работу
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * Ссылка на форму обратной связи клиентского приложения (routes/feedback.tsx
 * в apps/client) и её QR-код — для стойки и стен клуба. Форма открывается без
 * входа и без установки приложения; клуб в ссылке подставляется сам, по общей
 * ссылке клиент выбирает клуб сам. QR-код рисуется в браузере (без внешних
 * сервисов), PNG 600×600.
 */
function FeedbackLinks() {
  const studio = useActiveStudio();
  if (!studio) {
    return (
      <DialogHeader>
        <DialogTitle>Ссылка и QR-код</DialogTitle>
        <DialogDescription>
          Выберите клуб: справа в шапке, на телефоне — внизу меню.
        </DialogDescription>
      </DialogHeader>
    );
  }
  const base = `${STUDIO_FORMAT_APP_URL[studio.format]}/feedback`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Ссылка и QR-код</DialogTitle>
        <DialogDescription>
          Форма обратной связи открывается по ссылке без входа в приложение. Обращения попадают
          сюда, в «Обратную связь».
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4">
          <FeedbackLinkRow
            title={`Клуб «${studio.name}»`}
            hint="Клуб подставляется сам — для QR-кода в клубе."
            url={`${base}?studio=${studio.id}`}
            fileName={`feedback-qr-${studio.name}`}
          />
          <FeedbackLinkRow
            title="Общая ссылка"
            hint="Клиент сам выбирает клуб."
            url={base}
            fileName="feedback-qr"
          />
        </div>
      </DialogBody>
    </>
  );
}

function FeedbackLinkRow({
  title,
  hint,
  url,
  fileName,
}: {
  title: string;
  hint: string;
  url: string;
  fileName: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 600, margin: 2 }).then(
      (data) => !cancelled && setQr(data),
      () => !cancelled && setQr(null),
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast.success("Ссылка скопирована"),
      () => toast.error("Не удалось скопировать"),
    );

  return (
    <div className="flex gap-4 rounded-lg border p-3">
      <div className="h-24 w-24 shrink-0 rounded-md bg-muted">
        {qr && <img src={qr} alt="" className="h-full w-full rounded-md" />}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={url}>
          {url}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy /> Скопировать ссылку
          </Button>
          <Button size="sm" variant="outline" disabled={!qr} asChild={!!qr}>
            {qr ? (
              <a href={qr} download={`${fileName}.png`}>
                <Download /> Скачать QR-код
              </a>
            ) : (
              <span>
                <Download /> Скачать QR-код
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Значение только для чтения: подпись мелким серым, значение обычным текстом. */
function ReadOnlyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
