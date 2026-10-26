import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
} from "@/components/ui/squircle-avatar";
import {
  AltArrowRight,
  Bell,
  ChatSquare,
  Phone,
  Star,
  ClipboardText,
  Ghost,
} from "@solar-icons/react";
import giftIcon from "@/assets/gift.png";
import inviteGiftButton from "@/assets/invite-gift-button.webp";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { mediaUrl } from "@/lib/media";
import { clientCardQuery } from "@/lib/client-card";
import { homeBookingsQuery, type MyBooking } from "@/lib/home-queries";
import { PageShell } from "@/components/page-shell";
import { useClubSettings } from "@/hooks/use-club-settings";
import { useFormatStudios, useViewedStudioId } from "@/hooks/use-viewed-studio";
import { useNotifications } from "@/lib/notifications";
import { PushBanner } from "@/components/push-prompt";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { isDiagnostic, packEntryToDrawerData, type PackEntry } from "@/formats/packages/entries";
import { PackWorkoutCard } from "@/formats/packages/workout-card";
import { StudioSwitcher } from "@/formats/packages/studio-switcher";

import { ContentDrawer } from "@/components/content-drawer";
import { StatsSection } from "@/components/stats-section";
import { WorkoutDrawer, type WorkoutDrawerData } from "@/components/workout-drawer";
import { RescheduleOfferDialog } from "@/components/reschedule-offer-dialog";
import { VisitHistoryButton, VisitHistoryDrawer } from "@/components/visit-history-drawer";
import { FeedbackDrawer } from "@/components/feedback-form";
import { entryToDrawerData, workoutTypeMeta } from "@/lib/workout-types";
import { toast } from "sonner";
import { CarouselSkeleton } from "@/components/content-skeletons";
import { fireQueuedHomeConfetti } from "@/lib/confetti";
import {
  getTranslator,
  useLocalize,
  useT,
  type ContentTranslations,
  type Translator,
} from "@/i18n";

export const Route = createFileRoute("/")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Главное — {brand}", { brand: APP_BRAND }) },
        {
          name: "description",
          content: t("Главная страница {brand}: новости, акции и быстрый доступ к профилю.", {
            brand: APP_BRAND,
          }),
        },
      ],
    };
  },
  component: HomePage,
});

/** Кнопка быстрого действия в шапке главной («Написать», «Позвонить», «Фидбэк»). */
const QUICK_ACTION_CLASS =
  "flex flex-1 flex-col items-center gap-1 rounded-xl px-2 py-1 active:scale-[0.97] transition";

/** «Понедельник, 12 октября» — день недели с заглавной, на языке клиента. */
function dayHeading(d: Date, t: Translator) {
  const weekday = t.date(d, { weekday: "long" });
  const date = t.date(d, { day: "2-digit", month: "long" });
  return `${t.capitalize(weekday)}, ${date}`;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function firstNameOnly(value: string | null | undefined) {
  return value?.trim().split(/\s+/)[0] || "";
}

type News = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  position: number;
  translations?: ContentTranslations | null;
};

type Service = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  button_text: string | null;
  button_url: string | null;
  position: number;
  translations?: ContentTranslations | null;
};

function HomePage() {
  const { user } = useAuth();
  const t = useT();
  const loc = useLocalize();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [openNewsId, setOpenNewsId] = useState<string | null>(null);
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<WorkoutDrawerData | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Кнопки «Написать/Позвонить/Фидбэк» — смотримой студии; срок отмены записи
  // — своей.
  const clubSettings = useClubSettings();
  const homeSettings = useClubSettings("home");
  const { unread } = useNotifications();
  // Новости и услуги — смотримой студии (переключатель пакетного приложения;
  // в подписочном — всегда своя).
  const { studioId, studioReady, homeStudioId } = useViewedStudioId();
  // Пакетное: абонемент действует во всех студиях сети — у записи в другую
  // студию на карточке её название.
  const { data: formatStudios = [] } = useFormatStudios();
  const guestStudioName = (id: string) =>
    homeStudioId && id !== homeStudioId
      ? (loc(formatStudios.find((s) => s.id === id))?.name ?? null)
      : null;
  const userId = user?.id ?? null;

  // Салют после входа по коду или после анкеты (флаг ставят они).
  useEffect(() => {
    fireQueuedHomeConfetti();
  }, []);

  // Данные главной — в кэше React Query (сохраняется и между запусками,
  // src/lib/query-persist.ts): при возврате на главную и при повторном
  // открытии приложения всё видно сразу, свежее подтягивается фоном.
  // Ошибки — отдельно от «пусто», но уже показанные данные при сбое
  // обновления не стираются.
  const bookingsQuery = useQuery(homeBookingsQuery(userId));
  const bookingsError = !bookingsQuery.data && bookingsQuery.isError;
  // Прошедшие отсекаем при показе: данные из кэша могут быть вчерашними.
  const myBookings = useMemo(() => {
    if (!userId) return [];
    if (!bookingsQuery.data) return null;
    const now = Date.now();
    return bookingsQuery.data
      .filter((r) => r.entry && new Date(r.entry.starts_at).getTime() >= now)
      .sort(
        (a, b) => new Date(a.entry!.starts_at).getTime() - new Date(b.entry!.starts_at).getTime(),
      );
  }, [userId, bookingsQuery.data]);

  const groupedBookings = useMemo(() => {
    if (!myBookings) return null;
    const groups = new Map<number, MyBooking[]>();
    for (const b of myBookings) {
      if (!b.entry) continue;
      const key = startOfDay(new Date(b.entry.starts_at)).getTime();
      const arr = groups.get(key) ?? [];
      arr.push(b);
      groups.set(key, arr);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, items]) => ({ ts, items }));
  }, [myBookings]);

  async function cancelBooking(entryId: string) {
    if (pendingId) return;
    setPendingId(entryId);
    const { data, error } = await untypedDb.rpc("cancel_schedule_booking", {
      p_entry_id: entryId,
      // Причину не спрашиваем (2026-10-21); p_reason — явно, как раньше:
      // вызов остаётся на той же перегрузке функции в базе.
      p_reason: null,
    });
    setPendingId(null);
    if (error) {
      toast.error(t("Не удалось отменить запись: {error}", { error: error.message }));
      return;
    }
    const res = data as { ok: boolean; reason?: string } | null;
    if (res?.ok) {
      // Диагностику назначает студия — другое время в расписании не выбрать.
      const entry = myBookings?.find((b) => b.entry_id === entryId)?.entry;
      const diagnostic = IS_PACKAGES && !!entry && isDiagnostic(entry as unknown as PackEntry);
      queryClient.setQueryData<MyBooking[]>(["home-bookings", userId], (prev) =>
        prev?.filter((b) => b.entry_id !== entryId),
      );
      // Расписание (места и отметка «Вы записаны») — обновится при переходе.
      queryClient.invalidateQueries({ queryKey: ["pack-schedule"] });
      queryClient.invalidateQueries({ queryKey: ["pack-my-bookings"] });
      setOpenEntry(null);
      if (diagnostic) toast.success(t("Диагностика отменена"));
      else setRescheduleOpen(true);
    } else if (res?.reason) {
      toast.error(t("Не удалось отменить запись: {error}", { error: res.reason }));
    }
  }

  // Имя и аватар — та же карточка клиента, что у «Профиля» (общий кэш).
  const { data: client } = useQuery(clientCardQuery(userId));
  const fullName =
    client?.first_name?.trim() ||
    firstNameOnly(client?.full_name) ||
    firstNameOnly(user?.user_metadata?.first_name as string | undefined) ||
    firstNameOnly(user?.user_metadata?.full_name as string | undefined) ||
    t("Участник");
  const avatarUrl = client?.photo_url ?? null;

  // Новости — тех студий, что выбраны у новости в админке (studio_ids);
  // клиент без карточки (студия неизвестна) видит все.
  const newsQuery = useQuery({
    queryKey: ["news", studioId],
    queryFn: async (): Promise<News[]> => {
      let q = supabase.from("news").select("id,title,description,image_url,position,translations");
      if (studioId) q = q.contains("studio_ids", [studioId]);
      const { data, error } = await q
        .order("position", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as News[] | null) ?? [];
    },
    enabled: studioReady,
    // Контент из админки меняется редко — не перезапрашивать при каждом
    // возвращении на главную.
    staleTime: 10 * 60_000,
  });
  const news = newsQuery.data ?? null;
  const newsError = newsQuery.isError;

  // Услуги — по студиям, как и новости.
  const servicesQuery = useQuery({
    queryKey: ["services", studioId],
    queryFn: async (): Promise<Service[]> => {
      let q = untypedDb
        .from("services")
        .select("id,title,description,image_url,button_text,button_url,position,translations");
      if (studioId) q = q.contains("studio_ids", [studioId]);
      const { data, error } = await q
        .order("position", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as Service[] | null) ?? [];
    },
    enabled: studioReady,
    staleTime: 10 * 60_000,
  });
  const services = servicesQuery.data ?? null;
  const servicesError = servicesQuery.isError;

  // Подписки Realtime на правки новостей и услуг убраны (2026-10-16, запуск):
  // постоянное соединение с каждого телефона и проверка доступа на каждое
  // событие для каждого подписчика — тяжело для одного сервера, а правки
  // контента и так приходят при следующем открытии главной (staleTime).

  return (
    <PageShell
      header={
        <div className="pt-2 pb-4">
          {/* Header */}
          <div className="px-4 flex items-center justify-between">
            <Link
              to="/profile"
              className="flex items-center gap-3 min-w-0 flex-1 -ml-1 rounded-xl px-1 py-1 active:bg-accent/50 transition-colors"
            >
              <SquircleAvatar size={44}>
                {avatarUrl && <SquircleAvatarImage src={avatarUrl} alt={fullName} />}
                <SquircleAvatarFallback className="bg-muted text-foreground text-sm font-semibold">
                  {initials(fullName)}
                </SquircleAvatarFallback>
              </SquircleAvatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="font-semibold truncate">{fullName}</span>
                  <AltArrowRight className="h-4 w-4 text-white/70 shrink-0" weight="BoldDuotone" />
                </div>
              </div>
            </Link>

            <div className="flex items-center gap-2 shrink-0">
              {IS_PACKAGES ? (
                // Пакетное (решение владельца 2026-10-12): круглая кнопка —
                // стеклянный подарок, ведёт в «Пригласи подругу».
                <Link
                  to="/invite"
                  aria-label={t("Пригласи подругу")}
                  className="h-10 w-10 shrink-0 overflow-hidden rounded-full ring-1 ring-white/20 shadow-lg shadow-primary/40 active:scale-95 transition-transform"
                >
                  <img src={inviteGiftButton} alt="" className="h-full w-full object-cover" />
                </Link>
              ) : (
                <button
                  type="button"
                  aria-label={t("Подарки")}
                  className="h-10 w-10 rounded-full flex items-center justify-center bg-gradient-to-r from-rose-500 via-orange-400 to-amber-300 active:opacity-90 transition-opacity shadow-md"
                >
                  <img src={giftIcon} alt={t("Подарки")} className="h-5 w-5 object-contain" />
                </button>
              )}
              <Link
                to="/notifications"
                aria-label={
                  unread > 0 ? t("Уведомления: непрочитанных {n}", { n: unread }) : t("Уведомления")
                }
                className="relative h-10 w-10 rounded-full flex items-center justify-center bg-white/10 active:bg-white/20 transition-colors"
              >
                <Bell className="h-5 w-5 text-white" />
                {unread > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold leading-none text-white ring-2 ring-[#2A2B2F] tabular-nums">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Link>
            </div>
          </div>

          {/* News */}
          <section className="mt-3">
            {news === null && newsError ? (
              <div className="mx-4 h-44 rounded-2xl border border-dashed border-border flex items-center justify-center text-center px-4 text-sm text-destructive bg-background/40">
                {t("Не удалось загрузить новости. Обновите страницу.")}
              </div>
            ) : news === null ? (
              <CarouselSkeleton cards={3} className="h-44 w-32" />
            ) : news.length === 0 ? (
              <div className="mx-4 h-44 rounded-2xl border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground gap-2 bg-background/40">
                <ClipboardText className="h-6 w-6" weight="BoldDuotone" />
                <span className="text-sm">{t("Пока нет новостей")}</span>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto px-4 snap-x snap-mandatory no-scrollbar scroll-pl-4 scroll-pr-4">
                {news.map((item) => {
                  const n = loc(item);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setOpenNewsId(n.id)}
                      className="relative shrink-0 snap-start w-32 h-44 rounded-2xl overflow-hidden text-left active:scale-[0.98] transition-transform"
                    >
                      {(() => {
                        const url = mediaUrl(n.image_url);
                        return url ? (
                          <img
                            src={url}
                            alt={n.title}
                            className="absolute inset-0 h-full w-full object-cover"
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-gradient-to-br from-primary/80 to-primary" />
                        );
                      })()}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

                      <div className="absolute inset-0 flex flex-col justify-end p-2.5">
                        <div className="text-white text-xs font-semibold leading-tight">
                          {n.title}
                        </div>
                        {n.description && (
                          <div className="text-white/80 text-[11px] leading-tight mt-0.5">
                            {n.description}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Быстрые действия. «Фидбэк» — своя форма обратной связи в шторке
              снизу (components/feedback-form.tsx, решение владельца
              2026-10-15), есть всегда;
              «Написать» и «Позвонить» — ссылки студии, без ссылки кнопки нет. */}
          {/* Пакетное: под кнопками — выбранная студия с переключателем. */}
          <section className="px-4 my-3">
            <div className="rounded-2xl bg-white/10 p-1.5">
              <div className="flex items-stretch justify-between gap-2">
                {[
                  { icon: ChatSquare, label: t("Написать"), href: clubSettings.write_url },
                  { icon: Phone, label: t("Позвонить"), href: clubSettings.call_url },
                ]
                  .filter((item) => !!item.href)
                  .map((item) => (
                    <a
                      key={item.label}
                      href={item.href!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={QUICK_ACTION_CLASS}
                    >
                      <item.icon className="h-5 w-5 text-white" />
                      <span className="text-[11px] font-semibold text-white/80">{item.label}</span>
                    </a>
                  ))}
                <button
                  type="button"
                  onClick={() => setFeedbackOpen(true)}
                  className={QUICK_ACTION_CLASS}
                >
                  <Star className="h-5 w-5 text-white" />
                  <span className="text-[11px] font-semibold text-white/80">{t("Фидбэк")}</span>
                </button>
              </div>
            </div>
          </section>

          {IS_PACKAGES && (
            <section className="px-4 my-3">
              <StudioSwitcher />
            </section>
          )}
        </div>
      }
    >
      <div className="pt-6 pb-8">
        <div className="bg-muted">
          {/* Тренировки */}
          <section className="bg-background rounded-b-[14px] pb-5">
            {/* Пока клиент не ответил на запрос уведомлений — плашка «Включите
                уведомления» (решение владельца 2026-10-15). */}
            <PushBanner className="px-4 mb-4" />
            <h2 className="px-4 text-2xl font-semibold mb-3">{t("Тренировки")}</h2>
            {bookingsError ? (
              <Card className="mx-4 p-4 text-sm text-destructive">
                {t("Не удалось загрузить ваши записи. Обновите страницу.")}
              </Card>
            ) : myBookings === null ? (
              <CarouselSkeleton cards={2} className="h-24 w-56" />
            ) : myBookings.length === 0 ? (
              <div className="mx-4 rounded-2xl border border-border bg-card p-5 flex flex-col items-center text-center gap-3">
                <Ghost className="h-14 w-14 text-muted-foreground ghost-nudge" />
                <div className="text-sm text-muted-foreground">
                  {t("У вас нет запланированных тренировок")}
                </div>
                <Button asChild>
                  <Link to="/schedule">{IS_PACKAGES ? t("Записаться") : t("Забронировать")}</Link>
                </Button>
              </div>
            ) : (
              <div className="px-4 space-y-5">
                {groupedBookings!.map((group) => {
                  const d = new Date(group.ts);
                  return (
                    <div key={group.ts} className="space-y-2">
                      <div className="text-xs font-semibold text-muted-foreground">
                        {dayHeading(d, t)}
                      </div>
                      {group.items.map((b) => {
                        const e = b.entry!;
                        if (IS_PACKAGES) {
                          const pe = e as unknown as PackEntry;
                          return (
                            <PackWorkoutCard
                              key={b.entry_id}
                              entry={pe}
                              isBooked
                              studioName={guestStudioName(pe.studio_id)}
                              onOpen={() => setOpenEntry(packEntryToDrawerData(pe, t))}
                            />
                          );
                        }
                        const meta = workoutTypeMeta(e.workout?.type);
                        const timeLabel = t.time(e.starts_at);
                        const workout = loc(e.workout);
                        const trainerNames = (e.trainers ?? [])
                          .map((tr) => loc(tr.trainer)?.full_name)
                          .filter((n): n is string => !!n);
                        return (
                          <button
                            key={b.entry_id}
                            type="button"
                            onClick={() => setOpenEntry(entryToDrawerData(e, t))}
                            className="w-full text-left active:opacity-80 transition-opacity"
                          >
                            <Card className="relative p-3 pl-4 flex items-center gap-3 w-full overflow-hidden rounded-lg bg-primary text-primary-foreground border-primary">
                              <span
                                className={`absolute left-0 top-0 bottom-0 w-1.5 ${meta.stripe}`}
                              />
                              <div className="flex flex-col items-center justify-center w-12 shrink-0">
                                <div className="text-base font-black tabular-nums leading-tight text-center">
                                  {timeLabel}
                                </div>
                              </div>
                              <div className="flex-1 min-w-0 ml-1">
                                <div className="font-medium break-words leading-snug">
                                  {workout?.name ?? t("Занятие")}
                                </div>
                                {trainerNames.length > 0 && (
                                  <div className="text-xs mt-0.5 truncate text-primary-foreground/70">
                                    {trainerNames.join(", ")}
                                  </div>
                                )}
                              </div>
                            </Card>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
            {/* История посещений — под запланированными, шторка по нажатию. */}
            {userId && <VisitHistoryButton onOpen={() => setHistoryOpen(true)} />}
          </section>

          <div className="h-3 bg-muted" />

          {/* Статистика */}
          <StatsSection />

          <div className="h-3 bg-muted" />

          {/* Услуги */}
          <section className="bg-background rounded-t-[14px] pt-5 pb-0">
            <h2 className="px-4 text-2xl font-semibold">{t("Услуги")}</h2>
            <p className="px-4 text-sm text-muted-foreground mb-3">
              {IS_PACKAGES
                ? t("Дополнительные возможности для клиентов студии")
                : t("Дополнительные возможности для участников клуба")}
            </p>
            {services === null && servicesError ? (
              <div className="mx-4 h-32 rounded-2xl border border-dashed border-border flex items-center justify-center text-center px-4 text-sm text-destructive">
                {t("Не удалось загрузить услуги. Обновите страницу.")}
              </div>
            ) : services === null ? (
              <CarouselSkeleton cards={3} className="h-32 w-56" />
            ) : services.length === 0 ? (
              <div className="mx-4 h-32 rounded-2xl border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground gap-2">
                <ClipboardText className="h-6 w-6" weight="BoldDuotone" />
                <span className="text-sm">{t("Пока нет услуг")}</span>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory no-scrollbar scroll-pl-4 scroll-pr-4">
                <div className="w-1 shrink-0 snap-none" aria-hidden="true" />
                {services.map((item) => {
                  const s = loc(item);
                  const url = mediaUrl(s.image_url, "services-media");
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setOpenServiceId(s.id)}
                      className="relative shrink-0 snap-start w-56 h-32 rounded-2xl overflow-hidden text-left bg-muted active:scale-[0.98] transition-transform"
                    >
                      {url ? (
                        <img
                          src={url}
                          alt={s.title}
                          className="absolute inset-0 h-full w-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-br from-primary/80 to-primary" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                      <div className="absolute inset-0 flex flex-col justify-end p-3">
                        <div className="text-white text-sm font-semibold leading-tight">
                          {s.title}
                        </div>
                        {s.description && (
                          <div className="text-white/80 text-[11px] leading-tight mt-0.5 line-clamp-1">
                            {s.description}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
                <div className="w-1 shrink-0 snap-none" aria-hidden="true" />
              </div>
            )}
          </section>
        </div>
      </div>

      <ContentDrawer
        kind="news"
        itemId={openNewsId}
        onOpenChange={(o) => {
          if (!o) setOpenNewsId(null);
        }}
      />

      <ContentDrawer
        kind="service"
        itemId={openServiceId}
        onOpenChange={(o) => {
          if (!o) setOpenServiceId(null);
        }}
      />

      <VisitHistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} />

      <FeedbackDrawer open={feedbackOpen} onOpenChange={setFeedbackOpen} />

      <WorkoutDrawer
        data={openEntry}
        open={openEntry !== null}
        onOpenChange={(o) => {
          if (!o) setOpenEntry(null);
        }}
        isBooked={true}
        isPending={openEntry ? pendingId === openEntry.id : false}
        cancelMinutes={homeSettings.cancel_booking_minutes}
        onBook={() => {
          if (openEntry) cancelBooking(openEntry.id);
        }}
      />

      <RescheduleOfferDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        onPick={() => navigate({ to: "/schedule" })}
      />
    </PageShell>
  );
}
