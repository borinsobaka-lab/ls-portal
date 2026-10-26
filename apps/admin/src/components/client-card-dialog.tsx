import type React from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { AmoCrmLinkIcon } from "@/components/amocrm-icon";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CardSkeleton, TableSkeletonRows } from "@/components/skeletons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditActiveMembershipDialog } from "@/components/edit-active-membership-dialog";
import { SaleDialog } from "@/components/sale-dialog";
import { SaleKindPickerDialog } from "@/components/sale-kind-picker";
import { ClientDialog, type SavedClient } from "@/components/client-form-dialog";
import { ClientAppTab } from "@/components/client-app-tab";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useStudioFormat, useWorkStudioId } from "@/hooks/use-catalog-studios";
import { useStudios } from "@/hooks/use-studios";
import { useTableSort } from "@/hooks/use-table-sort";
import { ClubStatusBadge } from "@/components/club-status-badge";
import { BookingStatusBadge } from "@/components/booking-status-badge";
import { MembershipStatusBadge, AutoRenewBadge } from "@/components/membership-status-badge";
import { effectiveStatus, isLiveStatus } from "@/lib/membership-status";
import { computeClubStatus } from "@/lib/client-status";
import { GOAL_LABELS, REFERRAL_LABELS } from "@/lib/client-profile";
import { BOOKING_STATUS_LABEL, type BookingStatus } from "@/lib/bookings";
import {
  clientName,
  formatDate,
  formatDateTime,
  formatMoney,
  genderLabel,
  initials,
  todayISO,
} from "@/lib/format";
import { saleSourceLabel, type SaleKind } from "@/lib/payments";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";

type MemberProfile = {
  user_id: string;
  primary_goal: string | null;
  goal_other: string | null;
  goal_motivation: string | null;
  target_timeframe: string | null;
  desired_frequency: number | null;
  experience_level: string | null;
  current_weekly_activity: number | null;
  tried_group_hiit: boolean | null;
  health_flags: string[] | null;
  health_notes: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  birth_year: number | null;
  birth_date: string | null;
  gender: string | null;
  preferred_times: string[] | null;
  referral_source: string | null;
  onboarding_completed_at: string | null;
  updated_at: string | null;
};

const EXPERIENCE_LABELS: Record<string, string> = {
  beginner: "Новичок / большой перерыв",
  occasional: "Время от времени",
  regular: "Регулярно, 2–3 раза в неделю",
  advanced: "Опытный, интенсивно",
};
const TIMEFRAME_LABELS: Record<string, string> = {
  no_rush: "Без спешки",
  few_months: "1–3 месяца",
  event_date: "К конкретной дате",
};
const ACTIVITY_LABELS: Record<number, string> = {
  0: "Почти не двигаюсь",
  1: "1 раз в неделю",
  3: "2–3 раза в неделю",
  5: "4+ раз в неделю",
};
const HEALTH_LABELS: Record<string, string> = {
  back_joints: "Спина / суставы",
  cardio_pressure: "Сердце / давление",
  recent_injury: "Недавняя травма или операция",
  pregnancy: "Беременность",
  chronic: "Хроническое заболевание",
  none: "Ничего из перечисленного",
};
const TIME_LABELS: Record<string, string> = {
  morning: "Утро",
  day: "День",
  evening: "Вечер",
};
const PROFILE_GENDER: Record<string, string> = {
  female: "Женский",
  male: "Мужской",
  other: "Другое",
};

/** Поля клиента, которые нужны карточке (строка clients или clients_with_status). */
export type ClientLike = {
  id: string;
  /**
   * Клуб карточки (где её завели); нет — активный клуб (карточку открыли из
   * его списков). У пакетных клубов база клиентов общая: с клиентом работают
   * в активном клубе, где бы карточку ни завели.
   */
  studio_id?: string | null;
  user_id?: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  phone2?: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  notes: string | null;
  registration_date: string | null;
  last_visit_date: string | null;
  crm_link: string | null;
  photo_url: string | null;
};

type SaleRow = {
  id: string;
  /** Клуб продажи: у клиента общей базы — любой пакетный клуб. */
  studio_id: string;
  studio: { name: string | null } | null;
  sold_at: string;
  total_amount: number;
  down_payment_amount: number;
  remaining_installments: number;
  source: "admin" | "mobile" | null;
  admin_name: string | null;
  comment: string | null;
  memberships: MembershipRef | MembershipRef[] | null;
  client_memberships:
    | {
        id: string;
        status: string;
        auto_renew: boolean | null;
        ends_at: string | null;
        cancelled_at: string | null;
        /** Пакетный клуб: без посещений — «Ожидает посещения», как в блоке абонемента. */
        started_at: string | null;
        starts_on_first_visit: boolean | null;
      }[]
    | null;
};

type MembershipRef = {
  name: string;
  freeze_days_allowed?: number | null;
  /** Пакетные клубы: trial — пробный (не делает клиента ЧК). */
  kind?: string | null;
};

type MembershipRow = {
  id: string;
  status: string;
  source: "admin" | "mobile";
  /** null — продление пакетной студии, по которому ещё не было посещений. */
  started_at: string | null;
  ends_at: string | null;
  visits_left: number | null;
  /** Пакетный клуб: остаток персональных (у пакета тренировок — подарочные). */
  personal_left: number | null;
  /** Пакетный клуб: остаток диагностик тела. */
  diagnostics_left?: number | null;
  auto_renew: boolean | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  freeze_days_used: number | null;
  frozen_until: string | null;
  /** Пакетный клуб: срок с первого посещения (без посещений — «Ожидает посещения»). */
  starts_on_first_visit: boolean | null;
  memberships: MembershipRef | MembershipRef[] | null;
};

function membershipName(m: MembershipRow["memberships"] | SaleRow["memberships"]) {
  if (!m) return "—";
  if (Array.isArray(m)) return m[0]?.name ?? "—";
  return m.name;
}

function membershipKind(m: MembershipRow["memberships"] | SaleRow["memberships"]) {
  return (Array.isArray(m) ? m[0] : m)?.kind ?? null;
}

function membershipFreezeAllowed(m: MembershipRow["memberships"]): number {
  if (!m) return 0;
  const ref = Array.isArray(m) ? m[0] : m;
  return ref?.freeze_days_allowed ?? 0;
}

const SALE_COLUMNS =
  "id, studio_id, studio:studios(name), sold_at, total_amount, down_payment_amount, remaining_installments, source, admin_name, comment, memberships(name, kind), client_memberships(id, status, auto_renew, ends_at, cancelled_at, started_at, starts_on_first_visit)";

const MEMBERSHIP_COLUMNS =
  "id, status, source, started_at, ends_at, visits_left, personal_left, diagnostics_left, auto_renew, cancelled_at, cancel_reason, freeze_days_used, frozen_until, starts_on_first_visit, memberships(name, freeze_days_allowed, kind)";

/**
 * Карточка клиента — одна и та же, откуда бы её ни открыли (раздел
 * «Клиенты», имя клиента в любой таблице, поиск в шапке; решение владельца
 * 2026-10-14): с правкой клиента, продажей и абонементом. Правка открывается
 * поверх карточки, после сохранения карточка показывает новые данные.
 */
export function ClientCardDialog({
  open,
  onOpenChange,
  client,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  client: ClientLike | null;
}) {
  if (!client) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {/*
          Содержимое монтируется при каждом открытии, а запросы привязаны к
          клиенту ключом: запоздавший ответ по прошлому клиенту в карточку
          нового не попадёт.
        */}
        <ClientCard key={client.id} client={client} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ClientCard({ client: initial, onClose }: { client: ClientLike; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedKind, setPickedKind] = useState<SaleKind>("new");
  const [clientEditOpen, setClientEditOpen] = useState(false);
  // Сохранённая правка клиента — поверх переданной строки, без перезапроса.
  const [saved, setSaved] = useState<SavedClient | null>(null);
  // Комментарий, сохранённый в блоке над вкладками (правке клиента — свежий).
  const [savedNotes, setSavedNotes] = useState<{ notes: string | null } | null>(null);
  const client: ClientLike = { ...initial, ...saved, ...savedNotes };
  // Клуб, где работают с клиентом: продажа — в нём. У общей базы клиентов
  // (пакетные клубы, 2026-10-17) это активный клуб, где бы карточку ни
  // завели; клиент подписочного клуба из поиска «в другом клубе» — его клуб.
  const activeStudioId = useActiveStudioId();
  const cardStudioId = client.studio_id ?? activeStudioId;
  const studioId = useWorkStudioId(cardStudioId);
  const { data: studios } = useStudios();
  const studio = studios?.find((s) => s.id === studioId) ?? null;
  // Формат — по клубу карточки: он может быть пакетным клубом, где у
  // сотрудника нет роли (useStudios его не знает).
  const isPackages = (useStudioFormat(cardStudioId) ?? studio?.format) === "packages";
  const otherStudio = !!studio && studio.id !== activeStudioId;
  const userId = client.user_id ?? null;

  const salesKey = ["sales", "by-client", client.id];
  const { data: sales = [], isLoading: loadingSales } = useQuery({
    queryKey: salesKey,
    queryFn: () =>
      unwrap<SaleRow[]>(
        supabase
          .from("sales")
          .select(SALE_COLUMNS)
          .eq("client_id", client.id)
          .order("sold_at", { ascending: false }),
      ),
    meta: { errorMessage: "Не удалось загрузить продажи клиента" },
  });

  const membershipsKey = ["client_memberships", "by-client", client.id];
  const { data: memberships = [], isLoading: loadingActive } = useQuery({
    queryKey: membershipsKey,
    queryFn: () =>
      unwrap<MembershipRow[]>(
        supabase
          .from("client_memberships")
          .select(MEMBERSHIP_COLUMNS)
          .eq("client_id", client.id)
          .order("started_at", { ascending: false }),
      ),
    meta: { errorMessage: "Не удалось загрузить абонементы клиента" },
  });

  const { data: profile = null, isLoading: loadingProfile } = useQuery({
    queryKey: ["member_profiles", userId],
    queryFn: () =>
      unwrap<MemberProfile | null>(
        supabase.from("member_profiles").select("*").eq("user_id", userId!).maybeSingle(),
      ),
    enabled: !!userId,
    meta: { errorMessage: "Не удалось загрузить анкету клиента" },
  });

  // Правка абонемента меняет и его статус в истории продаж (эмбед в sales),
  // и статус клиента в «Клиентах», и строку в «Абонементах» пакетной студии.
  const reloadMemberships = () => {
    queryClient.invalidateQueries({ queryKey: membershipsKey });
    queryClient.invalidateQueries({ queryKey: salesKey });
    queryClient.invalidateQueries({ queryKey: ["clients_with_status"] });
    queryClient.invalidateQueries({ queryKey: ["client_packages_list"] });
  };

  // Продажа из карточки меняет и историю, и абонемент, и статус клиента в списках.
  const onSaleSaved = () => {
    for (const key of ["sales", "sales_list", "client_memberships", "clients_with_status"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // Имя и контакты клиента видны в списках всех разделов.
  const onClientSaved = (row: SavedClient) => {
    setSaved(row);
    setSavedNotes(null);
    for (const key of [
      "clients",
      "clients_with_status",
      "sales_list",
      "client_packages_list",
      "bookings_log_full",
      "client-crm-link",
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // Комментарий виден в «Клиентах», в окне занятия и в шапке поиска; правка
  // клиента («Редактировать») берёт уже сохранённый текст.
  const onNotesSaved = (notes: string | null) => {
    setSavedNotes({ notes });
    for (const key of ["clients", "clients_with_status", "schedule_bookings"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // Пакетный клуб: сначала тот же выбор типа продажи, что в «Абонементах»
  // («Новая», «Оплата пробного», «Допродажа», «Продление» — решение
  // владельца 2026-10-19), потом форма продажи этого типа. У подписочного
  // типов нет — форма сразу.
  const startSale = () => {
    if (isPackages) setPickerOpen(true);
    else {
      setPickedKind("new");
      setSaleOpen(true);
    }
  };
  const pickSaleKind = (k: SaleKind) => {
    setPickerOpen(false);
    setPickedKind(k);
    setSaleOpen(true);
  };

  // Локальная дата, как в computeClubStatus/effectiveStatus: UTC-дата
  // первые часы суток (Тбилиси, UTC+4) — ещё вчерашняя, и истёкший
  // вчера абонемент показывался бы активным.
  const today = todayISO();
  // Замороженный абонемент тоже показываем как текущий.
  const active =
    memberships.find(
      (r) => r.status === "frozen" || (r.status === "active" && (!r.ends_at || r.ends_at >= today)),
    ) ?? null;
  const clubStatus = computeClubStatus(
    memberships.map((r) => ({
      client_id: client.id,
      status: r.status,
      ends_at: r.ends_at,
      kind: membershipKind(r.memberships),
    })),
  );

  const name = clientName(client);
  const photo = client.photo_url || "";

  const contacts = [client.phone, client.phone2, client.email].filter(Boolean).join(" · ");

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-4 text-left">
          <Avatar className="h-14 w-14 shrink-0">
            {photo && <AvatarImage src={photo} alt={name} />}
            <AvatarFallback className="text-lg">{initials(name, "?")}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{name}</DialogTitle>
              <ClubStatusBadge status={clubStatus} withFull />
              {client.crm_link && <AmoCrmLinkIcon href={client.crm_link} />}
            </div>
            <DialogDescription>
              {contacts || "Контактов нет"}
              {otherStudio && ` · клиент клуба «${studio.name}»`}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogBody>
        {/* Комментарий — над вкладками: виден, откуда бы карточку ни открыли
            и какая вкладка ни выбрана, и дописывается на месте (решение
            владельца 2026-10-19). */}
        <ClientNotes clientId={client.id} initial={client.notes} onSaved={onNotesSaved} />
        <Tabs defaultValue="card" className="w-full">
          {/* На телефоне четыре вкладки не помещаются в строку — прокручиваются. */}
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="card">Карточка</TabsTrigger>
            <TabsTrigger value="visits">Посещения</TabsTrigger>
            <TabsTrigger value="profile">Анкета</TabsTrigger>
            <TabsTrigger value="app">Приложение</TabsTrigger>
          </TabsList>

          <TabsContent value="card" className="mt-4 space-y-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border p-3">
              <Field label="Пол" value={genderLabel(client.gender)} />
              <Field label="Дата рождения" value={formatDate(client.birthday)} />
              <Field label="Регистрация" value={formatDate(client.registration_date)} />
              <Field label="Последний визит" value={formatDate(client.last_visit_date)} />
            </div>

            <div>
              <div className="mb-2 flex min-h-9 items-center justify-between">
                <SectionLabel>Активный абонемент</SectionLabel>
                {active && (
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil />
                    Редактировать
                  </Button>
                )}
              </div>
              {loadingActive ? (
                <Skeleton className="h-24 w-full rounded-lg" />
              ) : !active ? (
                <InfoNote variant="empty">Нет активного абонемента.</InfoNote>
              ) : (
                <div className="rounded-lg border bg-background p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{membershipName(active.memberships)}</div>
                    <StatusChip tone="neutral">{saleSourceLabel(active.source)}</StatusChip>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {active.started_at ? (
                      <>
                        {formatDate(active.started_at)} →{" "}
                        {active.ends_at ? formatDate(active.ends_at) : "бессрочно"}
                      </>
                    ) : (
                      "срок — с первого посещения"
                    )}
                    {" · "}
                    {isPackages
                      ? // Два баланса пакетного клуба — групповые и персональные.
                        `групповых: ${active.visits_left ?? "безлимит"} · персональных: ${active.personal_left ?? 0}` +
                        (active.diagnostics_left ? ` · диагностик: ${active.diagnostics_left}` : "")
                      : active.visits_left == null
                        ? "посещения: безлимит"
                        : `осталось посещений: ${active.visits_left}`}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <MembershipStatusBadge m={active} />
                    <AutoRenewBadge on={active.auto_renew} />
                  </div>
                  {/* Цвет статуса несут бейджи выше; здесь только подробности. */}
                  {active.status === "frozen" && active.frozen_until && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Заморожен до {formatDate(active.frozen_until)}
                    </div>
                  )}
                  {active.cancelled_at && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Отменён: {formatDate(active.cancelled_at)}
                      {active.cancel_reason ? ` · ${active.cancel_reason}` : ""}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex min-h-9 items-center justify-between">
                <SectionLabel>История продаж</SectionLabel>
                {/* Новая продажа сразу с этим клиентом — без перехода в «Продажи». */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startSale}
                  disabled={!studioId || loadingSales}
                >
                  <Plus />
                  Добавить продажу
                </Button>
              </div>
              {loadingSales ? (
                <CardSkeleton rows={2} />
              ) : sales.length === 0 ? (
                <InfoNote variant="empty">Продаж пока нет.</InfoNote>
              ) : (
                <ul className="divide-y rounded-lg border bg-background">
                  {sales.map((s) => {
                    const cm = s.client_memberships?.[0] ?? null;
                    return (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-medium truncate">
                              {membershipName(s.memberships)}
                            </div>
                            {cm && <MembershipStatusBadge m={cm} />}
                            {cm && isLiveStatus(effectiveStatus(cm)) && (
                              <AutoRenewBadge on={cm.auto_renew} />
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDate(s.sold_at)}
                            {/* Продажа другого клуба сети — правит её только тот клуб. */}
                            {s.studio_id !== studioId && ` · клуб «${s.studio?.name ?? "—"}»`}
                            {" · "}
                            {saleSourceLabel(s.source)}
                            {s.admin_name ? ` · ${s.admin_name}` : ""}
                            {s.remaining_installments > 0
                              ? ` · рассрочка 1 + ${s.remaining_installments}, первый взнос ${formatMoney(Number(s.down_payment_amount))}`
                              : ""}
                          </div>
                        </div>
                        <div className="shrink-0 font-medium tabular-nums">
                          {formatMoney(Number(s.total_amount))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </TabsContent>

          <TabsContent value="visits" className="mt-4">
            <VisitsTab clientId={client.id} userId={userId} studioId={studioId} />
          </TabsContent>

          <TabsContent value="profile" className="mt-4">
            <ProfileTab
              profile={profile}
              loading={loadingProfile}
              hasUser={!!userId}
              isPackages={isPackages}
            />
          </TabsContent>

          {/* Устройства, уведомления и активность в мобильном приложении. */}
          <TabsContent value="app" className="mt-4">
            <ClientAppTab clientId={client.id} hasUser={!!userId} />
          </TabsContent>
        </Tabs>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Закрыть
        </Button>
        <Button onClick={() => setClientEditOpen(true)} disabled={!studioId}>
          <Pencil />
          Редактировать
        </Button>
      </DialogFooter>

      <EditActiveMembershipDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        membership={
          active
            ? {
                id: active.id,
                ends_at: active.ends_at,
                visits_left: active.visits_left,
                personal_left: active.personal_left,
                diagnostics_left: active.diagnostics_left,
                status: active.status,
                freeze_days_used: active.freeze_days_used,
                frozen_until: active.frozen_until,
                freeze_days_allowed: membershipFreezeAllowed(active.memberships),
              }
            : null
        }
        isPackages={isPackages}
        onSaved={reloadMemberships}
      />
      <SaleKindPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={pickSaleKind}
        clientName={name}
      />
      <SaleDialog
        open={saleOpen}
        onOpenChange={setSaleOpen}
        studioId={studioId}
        initialClient={client}
        kind={pickedKind}
        onSaved={onSaleSaved}
      />
      <ClientDialog
        open={clientEditOpen}
        onOpenChange={setClientEditOpen}
        studioId={studioId}
        client={client}
        onSaved={onClientSaved}
      />
    </>
  );
}

/**
 * Комментарий о клиенте (clients.notes) прямо в карточке: поле «бумажки»,
 * «Сохранить» появляется, когда текст изменили (Ctrl/⌘+Enter — тоже). Текст
 * берётся из базы: строка, из которой открыли карточку, могла устареть.
 */
function ClientNotes({
  clientId,
  initial,
  onSaved,
}: {
  clientId: string;
  initial: string | null;
  onSaved: (notes: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const key = ["clients", "notes", clientId];
  const { data: stored = initial, isPlaceholderData } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const row = await unwrap<{ notes: string | null } | null>(
        supabase.from("clients").select("notes").eq("id", clientId).maybeSingle(),
      );
      return row?.notes ?? null;
    },
    placeholderData: initial,
    meta: { errorMessage: "Не удалось загрузить комментарий клиента" },
  });
  // null — поле не трогали, показываем сохранённый текст.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = draft ?? stored ?? "";
  const dirty = draft != null && draft.trim() !== (stored ?? "").trim();

  const save = async () => {
    if (!dirty || saving) return;
    const notes = text.trim() || null;
    setSaving(true);
    try {
      const { error } = await supabase.from("clients").update({ notes }).eq("id", clientId);
      if (error) {
        toast.error("Не удалось сохранить комментарий: " + error.message);
        return;
      }
      queryClient.setQueryData(key, notes);
      setDraft(null);
      toast.success("Комментарий сохранён");
      onSaved(notes);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <SectionLabel>Комментарий</SectionLabel>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
              Отмена
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Сохранить
            </Button>
          </div>
        )}
      </div>
      <Textarea
        note
        rows={2}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        // Пока свежий текст не пришёл, правка затёрлась бы им — ждём.
        disabled={isPlaceholderData}
        placeholder="Комментарий о клиенте — видно всем сотрудникам клуба"
        aria-label="Комментарий о клиенте"
        className="field-sizing-content max-h-48 min-h-16"
      />
    </div>
  );
}

/** Подпись раздела внутри карточки. */
function SectionLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("text-xs font-medium uppercase text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** Значение только для чтения: подпись мелким серым, значение обычным текстом. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{value ?? "—"}</div>
    </div>
  );
}

// В пакетных студиях своя анкета: без мотивации, срока, группового формата,
// роста и пола, с датой рождения вместо года (apps/client, formats/packages).
function ProfileTab({
  profile,
  loading,
  hasUser,
  isPackages,
}: {
  profile: MemberProfile | null;
  loading: boolean;
  hasUser: boolean;
  isPackages: boolean;
}) {
  if (!hasUser) {
    return (
      <InfoNote variant="empty">
        Клиент ещё не зарегистрирован в мобильном приложении — анкета появится после регистрации и
        прохождения онбординга.
      </InfoNote>
    );
  }
  if (loading) return <CardSkeleton rows={3} />;
  if (!profile) {
    return <InfoNote variant="empty">Клиент пока не прошёл онбординг.</InfoNote>;
  }

  const goalLabel = profile.primary_goal
    ? (GOAL_LABELS[profile.primary_goal] ?? profile.primary_goal)
    : null;
  const goal = goalLabel && profile.goal_other ? `${goalLabel}: ${profile.goal_other}` : goalLabel;
  const exp = profile.experience_level
    ? (EXPERIENCE_LABELS[profile.experience_level] ?? profile.experience_level)
    : null;
  const tf = profile.target_timeframe
    ? (TIMEFRAME_LABELS[profile.target_timeframe] ?? profile.target_timeframe)
    : null;
  const act =
    profile.current_weekly_activity != null
      ? (ACTIVITY_LABELS[profile.current_weekly_activity] ??
        String(profile.current_weekly_activity))
      : null;
  const hiit =
    profile.tried_group_hiit == null
      ? null
      : profile.tried_group_hiit
        ? "Да, формат знаком"
        : "Нет, будет впервые";
  const flags = (profile.health_flags ?? []).map((f) => HEALTH_LABELS[f] ?? f).join(", ") || null;
  const times = (profile.preferred_times ?? []).map((t) => TIME_LABELS[t] ?? t).join(", ") || null;
  const gender = profile.gender ? (PROFILE_GENDER[profile.gender] ?? profile.gender) : null;
  const ref = profile.referral_source
    ? (REFERRAL_LABELS[profile.referral_source] ?? profile.referral_source)
    : null;
  const freq = profile.desired_frequency
    ? profile.desired_frequency >= 4
      ? "4+ раз в неделю"
      : `${profile.desired_frequency} раз в неделю`
    : null;

  return (
    <div className="space-y-4">
      <InfoNote className="flex items-center justify-between gap-3">
        <span>
          {profile.onboarding_completed_at
            ? `Онбординг пройден ${formatDate(profile.onboarding_completed_at)}`
            : "Онбординг не завершён — данные неполные"}
        </span>
        {profile.updated_at && <span>обновлено {formatDate(profile.updated_at)}</span>}
      </InfoNote>

      <Section title="Цели и мотивация">
        <ProfileRow label="Главная цель" value={goal} />
        {!isPackages && (
          <>
            <ProfileRow label="Что подтолкнуло" value={profile.goal_motivation} />
            <ProfileRow label="Срок" value={tf} />
          </>
        )}
        <ProfileRow label="Желаемая частота" value={freq} />
      </Section>

      <Section title="Опыт и нагрузка">
        <ProfileRow label="Опыт тренировок" value={exp} />
        <ProfileRow label="Текущая активность" value={act} />
        {!isPackages && <ProfileRow label="Групповой формат (HIIT)" value={hiit} />}
        <ProfileRow label="Здоровье" value={flags} />
        <ProfileRow label="Комментарий по здоровью" value={profile.health_notes} />
      </Section>

      <Section title="Базовые параметры">
        <div className="grid grid-cols-2 gap-x-6">
          {!isPackages && (
            <ProfileRow label="Рост" value={profile.height_cm ? `${profile.height_cm} см` : null} />
          )}
          <ProfileRow label="Вес" value={profile.weight_kg ? `${profile.weight_kg} кг` : null} />
          {profile.birth_date ? (
            <ProfileRow label="Дата рождения" value={formatDate(profile.birth_date)} />
          ) : (
            <ProfileRow label="Год рождения" value={profile.birth_year} />
          )}
          {!isPackages && <ProfileRow label="Пол" value={gender} />}
        </div>
      </Section>

      <Section title="Логистика и маркетинг">
        <ProfileRow label="Удобное время" value={times} />
        <ProfileRow label="Откуда узнал(а)" value={ref} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <SectionLabel className="mb-1">{title}</SectionLabel>
      <div className="divide-y">{children}</div>
    </div>
  );
}

type VisitRow = {
  id: string;
  studio_id: string;
  studio: { name: string | null } | null;
  workout_name: string | null;
  starts_at: string;
  status: BookingStatus;
  cancelled_at: string | null;
};

/**
 * Записи клиента: по карточке (client_id — и записи администратора клиента без
 * приложения) и по учётной записи (старые строки журнала без client_id).
 * Пакетные студии: посещения во всех клубах сети (база клиентов общая) —
 * с колонкой «Клуб», если есть записи не в активном клубе.
 */
function VisitsTab({
  clientId,
  userId,
  studioId,
}: {
  clientId: string;
  userId: string | null;
  studioId: string | null;
}) {
  const { data: rows = [], isLoading: loading } = useQuery({
    queryKey: ["bookings_log", "by-client", clientId, userId],
    queryFn: () =>
      unwrap<VisitRow[]>(
        supabase
          .from("bookings_log")
          .select(
            "id, studio_id, studio:studios(name), workout_name, starts_at, status, cancelled_at",
          )
          .or(userId ? `client_id.eq.${clientId},user_id.eq.${userId}` : `client_id.eq.${clientId}`)
          .order("starts_at", { ascending: false })
          .limit(500),
      ),
    meta: { errorMessage: "Не удалось загрузить посещения клиента" },
  });
  const showStudio = rows.some((r) => r.studio_id !== studioId);
  const sort = useTableSort<VisitRow>({
    workout: (r) => r.workout_name ?? "Персональное занятие",
    studio: (r) => r.studio?.name,
    startsAt: (r) => r.starts_at,
    status: (r) => BOOKING_STATUS_LABEL[r.status] ?? r.status,
    cancelledAt: (r) => r.cancelled_at,
  });

  if (!loading && rows.length === 0) {
    return <InfoNote variant="empty">Посещений пока нет.</InfoNote>;
  }

  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead {...sort.head("workout")}>Тренировка</TableHead>
            {showStudio && <TableHead {...sort.head("studio")}>Клуб</TableHead>}
            <TableHead {...sort.head("startsAt")}>Дата и время</TableHead>
            <TableHead {...sort.head("status")}>Статус</TableHead>
            <TableHead {...sort.head("cancelledAt")}>Отменена</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={showStudio ? 5 : 4} rows={5} />
          ) : (
            sort.apply(rows).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.workout_name ?? "Персональное занятие"}</TableCell>
                {showStudio && (
                  <TableCell className="whitespace-nowrap">{r.studio?.name ?? "—"}</TableCell>
                )}
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDateTime(r.starts_at)}
                </TableCell>
                <TableCell>
                  <BookingStatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(r.cancelled_at)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
