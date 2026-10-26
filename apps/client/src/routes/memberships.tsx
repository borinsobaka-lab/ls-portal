import { createFileRoute } from "@tanstack/react-router";
import { settlePackageMemberships } from "@/lib/packages-memberships";
import { APP_BRAND } from "@/lib/terms";
import { APP_FORMAT } from "@/lib/app-format";
import { PageShell } from "@/components/page-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { ShieldCheck, CheckCircle, CloseCircle } from "@solar-icons/react";
import { ChevronRight } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import confetti from "canvas-confetti";
import { supabase } from "@/integrations/supabase/client";
import { untypedDb } from "@/lib/untyped-db";
import { useAuth } from "@/hooks/use-auth";
import { mediaUrl } from "@/lib/media";
import { MembershipCardsSkeleton } from "@/components/content-skeletons";
import { PackagesMembershipsPage } from "@/formats/packages/memberships-page";
import { FormattedText } from "@/lib/formatted-text";
import {
  type ContentTranslations,
  type Translator,
  currentT,
  getTranslator,
  msg,
  useLocalize,
  useT,
} from "@/i18n";

export const Route = createFileRoute("/memberships")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: `${t("Абонементы")} — ${APP_BRAND}` },
        {
          name: "description",
          content: t("Абонементы и пакеты занятий {brand}.", { brand: APP_BRAND }),
        },
      ],
    };
  },
  // Пакетное приложение — свой экран без покупки (src/formats/packages/).
  component: APP_FORMAT === "packages" ? PackagesMembershipsPage : MembershipsPage,
});

type Membership = {
  id: string;
  name: string;
  description: string | null;
  benefits: string[] | null;
  visits_count: number | null;
  duration_days: number;
  price: number;
  installment_enabled: boolean | null;
  studio_id: string | null;
  cover_url: string | null;
  for_couple?: boolean | null;
  freeze_days_allowed?: number | null;
  translations?: ContentTranslations | null;
};

function formatPeriod(days: number, t: Translator): string {
  if (days === 30) return t("раз в месяц");
  if (days === 365 || days === 360) return t("раз в год");
  if (days > 0 && days % 30 === 0) {
    const months = days / 30;
    return t.plural(months, "раз в {n} месяц|раз в {n} месяца|раз в {n} месяцев");
  }
  return t.plural(days, "на {n} день|на {n} дня|на {n} дней");
}

/** Строки карточек: срок и заморозка (общие у тарифа и действующего абонемента). */
function durationLine(days: number, t: Translator) {
  return t.plural(days, "Срок действия {n} день|Срок действия {n} дня|Срок действия {n} дней");
}
function freezeLine(days: number, t: Translator) {
  return t.plural(days, "Заморозка до {n} дня|Заморозка до {n} дней|Заморозка до {n} дней");
}

const MEMBERSHIP_TABS = [
  { key: "unlimited", label: msg("Безлимитные") },
  { key: "packages", label: msg("Пакеты тренировок") },
  { key: "couples", label: msg("Для двоих") },
] as const;

type ActiveMembership = {
  id: string;
  ends_at: string | null;
  visits_left: number | null;
  auto_renew: boolean | null;
  // Только в пакетном приложении (db/migrations/2026-10-11_zz_packages_personal_balance.sql).
  balance_kind?: "group" | "personal" | null;
  personal_left?: number | null;
  memberships: {
    name: string;
    description: string | null;
    benefits: string[] | null;
    visits_count: number | null;
    duration_days: number | null;
    price: number | null;
    freeze_days_allowed?: number | null;
    translations?: ContentTranslations | null;
  } | null;
};

const COLORS = ["#0ea5e9", "#8b5cf6", "#f43f5e", "#10b981", "#f59e0b", "#ec4899"];
const db = untypedDb;

// Действующий абонемент клиента. Не maybeSingle() по статусу: при двух
// строках active/frozen (переход на новый тариф, заморозка) PostgREST
// возвращает ошибку, и страница целиком падала в «не удалось загрузить».
// В пакетном формате сначала досчитываем очередь: продление могло стать
// действующим (settlePackageMemberships).
// Статус active с прошедшим ends_at (expire_memberships ещё не прошёл) — не
// действующий: такие не показываем; замороженный — показываем всегда.
// В пакетном формате у клиента бывает два живых абонемента (пакет тренировок
// и пакет персональных, balance_kind) — на карточку берём групповой
// ('group' < 'personal' по алфавиту).
async function fetchActiveMembership(clientId: string) {
  await settlePackageMemberships();
  const isPackages = APP_FORMAT === "packages";
  let query = db
    .from("client_memberships")
    .select(
      `id, ends_at, visits_left, auto_renew, ${isPackages ? "balance_kind, personal_left, " : ""}memberships(name, description, benefits, visits_count, duration_days, price, freeze_days_allowed, translations)`,
    )
    .eq("client_id", clientId)
    .in("status", ["active", "frozen"])
    .or(`ends_at.is.null,ends_at.gte.${tbilisiDateISO()},status.eq.frozen`);
  if (isPackages) query = query.order("balance_kind", { ascending: true });
  return query.order("ends_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
}

/** Сегодняшняя дата YYYY-MM-DD по Тбилиси — как считает база (ends_at — date). */
function tbilisiDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** «12 октября 2026». Дату без времени (YYYY-MM-DD) читаем как местную:
 * new Date("YYYY-MM-DD") — полночь UTC, и западнее Гринвича выходил вчерашний день. */
function formatLongDate(value: string, t: Translator) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return t.date(d, { day: "numeric", month: "long", year: "numeric" });
}

/** Локальная дата YYYY-MM-DD (toISOString() дала бы UTC — в первые часы суток вчерашнюю). */
function localDateISO(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function MembershipsPage() {
  const t = useT();
  const loc = useLocalize();
  const { user, loading: authLoading } = useAuth();
  const [client, setClient] = useState<{ id: string; studio_id: string } | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [active, setActive] = useState<ActiveMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Membership | null>(null);
  const [activeTab, setActiveTab] = useState<"unlimited" | "packages" | "couples">("unlimited");
  const [purchasing, setPurchasing] = useState(false);
  const [lastPaidTotal, setLastPaidTotal] = useState<number | null>(null);
  const [activeOpen, setActiveOpen] = useState(false);
  const [confirmSwitchOpen, setConfirmSwitchOpen] = useState(false);
  const [cancellingRenew, setCancellingRenew] = useState(false);
  const [confirmManageOpen, setConfirmManageOpen] = useState(false);

  const unlimitedTopRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const unlimitedBottomRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const packagesTopRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const packagesBottomRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const couplesTopRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const couplesBottomRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const [unlimitedTopHeight, setUnlimitedTopHeight] = useState(0);
  const [unlimitedBottomHeight, setUnlimitedBottomHeight] = useState(0);
  const [packagesTopHeight, setPackagesTopHeight] = useState(0);
  const [packagesBottomHeight, setPackagesBottomHeight] = useState(0);
  const [couplesTopHeight, setCouplesTopHeight] = useState(0);
  const [couplesBottomHeight, setCouplesBottomHeight] = useState(0);

  const unlimitedMemberships = useMemo(
    () => memberships.filter((m) => m.visits_count === null && !m.for_couple),
    [memberships],
  );
  const packagesMemberships = useMemo(
    () => memberships.filter((m) => m.visits_count !== null && !m.for_couple),
    [memberships],
  );
  const couplesMemberships = useMemo(
    () => memberships.filter((m) => m.for_couple === true),
    [memberships],
  );

  function measureGroup(
    topRefs: React.MutableRefObject<Map<string, HTMLDivElement>>,
    bottomRefs: React.MutableRefObject<Map<string, HTMLDivElement>>,
    setTop: (h: number) => void,
    setBottom: (h: number) => void,
  ) {
    let maxTop = 0;
    topRefs.current.forEach((el) => {
      maxTop = Math.max(maxTop, el.getBoundingClientRect().height);
    });
    let maxBottom = 0;
    bottomRefs.current.forEach((el) => {
      maxBottom = Math.max(maxBottom, el.getBoundingClientRect().height);
    });
    setTop(maxTop);
    setBottom(maxBottom);
  }

  // Меряем группу активной вкладки: карточки неактивных вкладок не
  // отрисованы, и замер при загрузке давал им 0 — выравнивание высот работало
  // только на вкладке, открытой первой. Поэтому замер и при смене вкладки.
  useLayoutEffect(() => {
    if (activeTab === "unlimited" && unlimitedMemberships.length > 0) {
      measureGroup(
        unlimitedTopRefs,
        unlimitedBottomRefs,
        setUnlimitedTopHeight,
        setUnlimitedBottomHeight,
      );
    }
  }, [activeTab, unlimitedMemberships]);

  useLayoutEffect(() => {
    if (activeTab === "packages" && packagesMemberships.length > 0) {
      measureGroup(
        packagesTopRefs,
        packagesBottomRefs,
        setPackagesTopHeight,
        setPackagesBottomHeight,
      );
    }
  }, [activeTab, packagesMemberships]);

  useLayoutEffect(() => {
    if (activeTab === "couples" && couplesMemberships.length > 0) {
      measureGroup(couplesTopRefs, couplesBottomRefs, setCouplesTopHeight, setCouplesBottomHeight);
    }
  }, [activeTab, couplesMemberships]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // Текст ошибки — на языке на момент загрузки (эффект не зависит от языка).
      const t = currentT();
      setLoading(true);
      setError(null);
      try {
        const own = await db
          .from("clients")
          .select("id, studio_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (own.error) throw own.error;
        let c = own.data;

        // Нет карточки — не тупик: заводим её на сервере и продолжаем.
        // Раньше здесь показывалось «обратитесь к администратору», хотя
        // студия одна и привязать клиента можно автоматически.
        if (!c || !c.studio_id) {
          const { data: ensured } = await db.rpc("ensure_client_profile");
          const row = Array.isArray(ensured) ? ensured[0] : ensured;
          if (row?.studio_id) c = { id: row.id, studio_id: row.studio_id };
        }

        if (!c || !c.studio_id) {
          if (!cancelled) {
            setClient(null);
            setLoading(false);
            setError(t("Профиль клиента не привязан к студии. Обратитесь к администратору."));
          }
          return;
        }
        if (cancelled) return;
        setClient({ id: c.id, studio_id: c.studio_id });

        // profiles приложение больше не переписывает: этот upsert затирал имя,
        // исправленное администратором, и позволял подменить себе studio_id
        // (от него зависит RLS расписания и каталога). Синхронизацию студии
        // держит триггер на clients (db/client_app_fixes.sql).

        const membershipSelect =
          "id, name, description, benefits, visits_count, duration_days, price, installment_enabled, studio_id, cover_url, for_couple, freeze_days_allowed, translations";
        const [{ data: m, error: mErr }, { data: act, error: aErr }] = await Promise.all([
          db
            .from("memberships")
            .select(membershipSelect)
            .eq("studio_id", c.studio_id)
            .eq("is_active", true)
            .order("price", { ascending: true }),
          fetchActiveMembership(c.id),
        ]);
        if (mErr) throw mErr;
        if (aErr) throw aErr;

        let membershipRows = (m as Membership[]) ?? [];
        if (membershipRows.length === 0) {
          // Запасной вариант — только тарифы без студии (общие). Раньше здесь
          // выбирались активные тарифы ВСЕХ студий, и клиент студии без своих
          // тарифов видел и мог купить тариф чужой студии.
          const { data: fallbackMemberships, error: fallbackErr } = await db
            .from("memberships")
            .select(membershipSelect)
            .is("studio_id", null)
            .eq("is_active", true)
            .order("price", { ascending: true });
          if (fallbackErr) throw fallbackErr;
          membershipRows = (fallbackMemberships as Membership[]) ?? [];
        }

        if (cancelled) return;
        setMemberships(membershipRows);
        setActive((act as unknown as ActiveMembership | null) ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message ?? t("Не удалось загрузить абонементы"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const refreshActive = async () => {
    if (!client) return;
    const { data: act, error: actErr } = await fetchActiveMembership(client.id);
    // При ошибке не обнуляем абонемент: баннер «нет абонемента» был бы враньём.
    if (actErr) return;
    setActive((act as unknown as ActiveMembership | null) ?? null);
  };

  // Сумма к оплате приходит из чека: там применяется промокод. Без неё в
  // продажу писалась цена по каталогу, хотя клиенту показывали цену со скидкой.
  const handlePurchase = async (paid?: number) => {
    if (!selected || !client) return;
    const paidTotal = Math.max(0, paid ?? Number(selected.price ?? 0));
    setLastPaidTotal(paidTotal);
    // If user has active membership and is picking a different one → require confirmation first
    if (active && !confirmSwitchOpen) {
      setConfirmSwitchOpen(true);
      return;
    }
    setPurchasing(true);
    try {
      // В чеке показывали цену со скидкой, а в продажу писали полную —
      // касса расходилась с тем, что видел клиент.
      const listPrice = Number(selected.price ?? 0);
      const discount = Math.max(0, listPrice - paidTotal);
      const { error: insErr } = await db.from("sales").insert({
        studio_id: selected.studio_id ?? client.studio_id,
        client_id: client.id,
        membership_id: selected.id,
        sold_at: localDateISO(new Date()),
        total_amount: paidTotal,
        down_payment_amount: paidTotal,
        list_price: listPrice,
        discount_amount: discount,
        remaining_installments: 0,
        source: "mobile",
      });
      if (insErr) throw insErr;

      await refreshActive();

      // 🎉 Конфетти при успешной покупке
      const fire = (opts: confetti.Options) =>
        confetti({ particleCount: 80, spread: 70, startVelocity: 45, ...opts });
      fire({ origin: { x: 0.2, y: 0.7 }, angle: 60 });
      fire({ origin: { x: 0.8, y: 0.7 }, angle: 120 });
      setTimeout(() => fire({ origin: { x: 0.5, y: 0.6 }, spread: 100 }), 200);

      const name = loc(selected).name;
      toast.success(
        active
          ? t("Вы перешли на «{name}»", { name })
          : t("Абонемент «{name}» оформлен!", { name }),
      );
      setSelected(null);
      setConfirmSwitchOpen(false);
    } catch (e) {
      toast.error((e as Error)?.message ?? t("Не удалось оформить абонемент"));
    } finally {
      setPurchasing(false);
    }
  };

  /** true — автопродление отключено; при ошибке показывает тост и возвращает false. */
  const handleCancelAutorenew = async (): Promise<boolean> => {
    if (!active) return false;
    setCancellingRenew(true);
    try {
      const { error: rpcErr } = await db.rpc("cancel_membership_autorenew", {
        _client_membership_id: active.id,
        _source: "mobile",
        _reason: "self",
      });
      if (rpcErr) throw rpcErr;
      await refreshActive();
      toast.success(t("Автопродление отключено"));
      return true;
    } catch (e) {
      toast.error((e as Error)?.message ?? t("Не удалось отключить автопродление"));
      return false;
    } finally {
      setCancellingRenew(false);
    }
  };

  return (
    <PageShell
      scrollKey={activeTab}
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Абонементы")}</h1>
          <p className="text-sm text-white/70">{t("Выберите подходящий пакет занятий")}</p>
          {!loading &&
            user &&
            active &&
            (() => {
              const autoOn = active.auto_renew !== false;
              const accent = autoOn ? "#22C55E" : "#EF4444";
              return (
                <Card
                  onClick={() => setActiveOpen(true)}
                  className="mt-4 p-0 overflow-hidden cursor-pointer transition-colors hover:bg-card/90 active:bg-card/80 border-0"
                >
                  <div className="flex items-stretch">
                    <div className="flex-1 p-4 border border-border rounded-l-xl bg-background">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-14 w-14 rounded-xl flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${accent}26` }}
                        >
                          {autoOn ? (
                            <ShieldCheck className="h-8 w-8" style={{ color: accent }} />
                          ) : (
                            <CloseCircle
                              className="h-8 w-8"
                              style={{ color: accent }}
                              weight="BoldDuotone"
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-base font-semibold text-foreground truncate">
                            {loc(active.memberships)?.name ?? t("Абонемент")}
                          </div>
                          {active.ends_at && (
                            <div className="text-sm text-muted-foreground mt-0.5">
                              {t("Действует до {date}", {
                                date: formatLongDate(active.ends_at, t),
                              })}
                            </div>
                          )}
                          <div className="text-sm mt-0.5" style={{ color: accent }}>
                            {autoOn ? t("Автопродление включено") : t("Автопродление выключено")}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="w-6 flex items-center justify-center bg-muted">
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                </Card>
              );
            })()}
        </div>
      }
    >
      <div className="p-4 space-y-4 pb-24">
        {!user && !authLoading && (
          <Card className="p-4 text-sm text-muted-foreground">
            {t("Войдите в аккаунт, чтобы увидеть абонементы.")}
          </Card>
        )}

        {(loading || authLoading) && user && <MembershipCardsSkeleton />}

        {error && !loading && <Card className="p-4 text-sm text-destructive">{error}</Card>}

        {!loading && user && !error && memberships.length === 0 && !active && (
          <Card className="p-4 text-sm text-muted-foreground">
            {t("Пока нет доступных абонементов.")}
          </Card>
        )}

        {!loading && user && !error && memberships.length > 0 && (
          <div className="w-full">
            <div
              data-memberships-tabs
              className="-mx-4 px-4 flex gap-6 overflow-x-auto no-scrollbar mb-4"
            >
              {MEMBERSHIP_TABS.map((tab) => {
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => {
                      setActiveTab(tab.key);
                    }}
                    className={`shrink-0 relative pt-3 pb-1 text-base font-semibold transition-colors ${
                      active ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {t(tab.label)}
                    {active && (
                      <span className="absolute left-0 right-0 -bottom-px h-1 bg-primary rounded-full" />
                    )}
                  </button>
                );
              })}
            </div>

            {activeTab === "unlimited" && (
              <>
                {unlimitedMemberships.length > 0 ? (
                  <div className="-mx-4 px-4 scroll-pl-4 scroll-pr-4 flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-2">
                    {unlimitedMemberships.map((m, idx) => (
                      <MembershipCard
                        key={m.id}
                        membership={m}
                        color={COLORS[idx % COLORS.length]}
                        onSelect={() => setSelected({ ...m })}
                        topMinHeight={unlimitedTopHeight || undefined}
                        bottomMinHeight={unlimitedBottomHeight || undefined}
                        onTopRef={(el) => {
                          if (el) unlimitedTopRefs.current.set(m.id, el);
                          else unlimitedTopRefs.current.delete(m.id);
                        }}
                        onBottomRef={(el) => {
                          if (el) unlimitedBottomRefs.current.set(m.id, el);
                          else unlimitedBottomRefs.current.delete(m.id);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <Card className="p-4 text-sm text-muted-foreground">
                    {t("Пока нет доступных безлимитных абонементов.")}
                  </Card>
                )}
              </>
            )}

            {activeTab === "packages" && (
              <>
                {packagesMemberships.length > 0 ? (
                  <div className="-mx-4 px-4 scroll-pl-4 scroll-pr-4 flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-2">
                    {packagesMemberships.map((m, idx) => (
                      <MembershipCard
                        key={m.id}
                        membership={m}
                        color={COLORS[idx % COLORS.length]}
                        onSelect={() => setSelected({ ...m })}
                        topMinHeight={packagesTopHeight || undefined}
                        bottomMinHeight={packagesBottomHeight || undefined}
                        onTopRef={(el) => {
                          if (el) packagesTopRefs.current.set(m.id, el);
                          else packagesTopRefs.current.delete(m.id);
                        }}
                        onBottomRef={(el) => {
                          if (el) packagesBottomRefs.current.set(m.id, el);
                          else packagesBottomRefs.current.delete(m.id);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <Card className="p-4 text-sm text-muted-foreground">
                    {t("Пока нет доступных пакетов тренировок.")}
                  </Card>
                )}
              </>
            )}

            {activeTab === "couples" && (
              <>
                {couplesMemberships.length > 0 ? (
                  <div className="-mx-4 px-4 scroll-pl-4 scroll-pr-4 flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-2">
                    {couplesMemberships.map((m, idx) => (
                      <MembershipCard
                        key={m.id}
                        membership={m}
                        color={COLORS[idx % COLORS.length]}
                        onSelect={() => setSelected({ ...m })}
                        topMinHeight={couplesTopHeight || undefined}
                        bottomMinHeight={couplesBottomHeight || undefined}
                        onTopRef={(el) => {
                          if (el) couplesTopRefs.current.set(m.id, el);
                          else couplesTopRefs.current.delete(m.id);
                        }}
                        onBottomRef={(el) => {
                          if (el) couplesBottomRefs.current.set(m.id, el);
                          else couplesBottomRefs.current.delete(m.id);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <Card className="p-4 text-sm text-muted-foreground">
                    {t("Пока нет доступных абонементов для двоих.")}
                  </Card>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {selected && (
        <CheckoutSheet
          membership={selected}
          open={!!selected}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          onPurchase={handlePurchase}
          purchasing={purchasing}
          hasActive={!!active}
        />
      )}

      {active && (
        <ActiveMembershipDrawer
          active={active}
          open={activeOpen}
          onOpenChange={setActiveOpen}
          onManage={() => setConfirmManageOpen(true)}
        />
      )}

      <AlertDialog open={confirmSwitchOpen} onOpenChange={setConfirmSwitchOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Перейти на этот абонемент?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "У вас уже есть активный абонемент. При переходе текущий абонемент будет аннулирован, а вместо него подключится выбранный.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purchasing} className="font-bold">
              {t("Отмена")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={purchasing}
              className="font-bold"
              onClick={(e) => {
                e.preventDefault();
                handlePurchase(lastPaidTotal ?? undefined);
              }}
            >
              {purchasing ? t("Переходим…") : t("Перейти")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={confirmManageOpen} onOpenChange={setConfirmManageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Отключить автопродление?")}</DialogTitle>
            <DialogDescription>
              {t(
                "Абонемент останется активным до конца оплаченного периода, но не будет продлён автоматически.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={cancellingRenew}
              onClick={() => setConfirmManageOpen(false)}
            >
              {t("Закрыть")}
            </Button>
            <Button
              disabled={cancellingRenew}
              variant="destructive"
              onClick={() => {
                // Закрываем только при успехе: при ошибке клиент остаётся в
                // диалоге и может повторить.
                handleCancelAutorenew().then((ok) => {
                  if (!ok) return;
                  setConfirmManageOpen(false);
                  setActiveOpen(false);
                });
              }}
            >
              {cancellingRenew ? t("Отключаем…") : t("Отключить автопродление")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function MembershipCard({
  membership: rawMembership,
  color,
  onSelect,
  topMinHeight,
  bottomMinHeight,
  onTopRef,
  onBottomRef,
}: {
  membership: Membership;
  color: string;
  onSelect: () => void;
  topMinHeight?: number;
  bottomMinHeight?: number;
  onTopRef?: (el: HTMLDivElement | null) => void;
  onBottomRef?: (el: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const membership = useLocalize()(rawMembership);
  const cover = mediaUrl(membership.cover_url, "memberships-media");
  const features = [
    membership.visits_count === null
      ? t("Безлимит посещений")
      : t.plural(membership.visits_count, "{n} занятие|{n} занятия|{n} занятий"),
    durationLine(membership.duration_days, t),
    membership.freeze_days_allowed ? freezeLine(membership.freeze_days_allowed, t) : null,
    ...((membership.benefits ?? []).filter(Boolean) as string[]),
  ].filter(Boolean) as string[];

  return (
    <Card className="shrink-0 w-[85%] snap-start overflow-hidden rounded-xl p-0 flex flex-col">
      {/* Top: cover (image fills area; no overlay when image present) */}
      <div
        className="relative p-5 flex flex-col"
        style={
          cover
            ? {
                backgroundImage: `url(${cover})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        <div ref={onTopRef} style={{ minHeight: topMinHeight }}>
          <h3 className="text-xl font-semibold leading-tight">{membership.name}</h3>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-4xl font-black tracking-tight">
              {t.number(Number(membership.price))} ₾
            </span>
            <span className="text-sm text-muted-foreground">
              {formatPeriod(membership.duration_days, t)}
            </span>
          </div>
          {membership.description?.trim() && (
            <FormattedText
              text={membership.description}
              className="mt-3 text-sm text-muted-foreground"
              linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
            />
          )}
        </div>
        <Button onClick={onSelect} className="mt-5 w-full">
          {t("Выбрать")}
        </Button>
      </div>

      {/* Bottom: features */}
      <div
        ref={onBottomRef}
        className="p-5 border-t border-card-border"
        style={{ minHeight: bottomMinHeight }}
      >
        <div className="text-xs font-bold text-muted-foreground mb-3">{t("Преимущества")}</div>
        <div className="space-y-2">
          {features.map((f, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <CheckCircle
                className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5"
                weight="BoldDuotone"
              />
              <span>{f}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function CheckoutSheet({
  membership: rawMembership,
  open,
  onOpenChange,
  onPurchase,
  purchasing,
  hasActive,
}: {
  membership: Membership;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPurchase: (paid: number) => void;
  purchasing: boolean;
  hasActive: boolean;
}) {
  const t = useT();
  const membership = useLocalize()(rawMembership);
  const isSubscription = membership.visits_count === null;
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [promo, setPromo] = useState("");
  const [promoApplied, setPromoApplied] = useState<null | { code: string; discount: number }>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreeRecurring, setAgreeRecurring] = useState(!isSubscription);

  const digits = cardNumber.replace(/\D/g, "");
  const cardValid = digits.length >= 13 && digits.length <= 19;
  const expiryValid = /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry);
  const cvcValid = /^\d{3,4}$/.test(cvc);
  const holderValid = holder.trim().length >= 2;
  const canPay =
    cardValid &&
    expiryValid &&
    cvcValid &&
    holderValid &&
    agreeTerms &&
    agreeRecurring &&
    !purchasing;

  const formatCard = (v: string) =>
    v
      .replace(/\D/g, "")
      .slice(0, 19)
      .replace(/(\d{4})(?=\d)/g, "$1 ");
  const formatExpiry = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 4);
    if (d.length < 3) return d;
    return d.slice(0, 2) + "/" + d.slice(2);
  };

  const total = Math.max(0, Number(membership.price) - (promoApplied?.discount ?? 0));

  const applyPromo = () => {
    const code = promo.trim().toUpperCase();
    if (!code) return;
    // Mock: WELCOME10 → 10% off
    if (code === "WELCOME10") {
      setPromoApplied({ code, discount: Math.round(Number(membership.price) * 0.1) });
      toast.success(t("Промокод применён"));
    } else {
      setPromoApplied(null);
      toast.error(t("Промокод не найден"));
    }
  };

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <DrawerPrimitive.Title className="text-xl font-bold leading-tight">
              {t("Оформление")}
            </DrawerPrimitive.Title>

            {/* Summary */}
            <div className="mt-3 rounded-xl bg-muted p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{membership.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatPeriod(membership.duration_days, t)}
                  {isSubscription ? ` · ${t("подписка с автопродлением")}` : ""}
                </div>
              </div>
              <div className="text-lg font-black shrink-0">
                {t.number(Number(membership.price))} ₾
              </div>
            </div>

            {/* Card */}
            <div className="mt-4">
              <div className="text-xs font-bold text-muted-foreground mb-2">
                {t("Банковская карта")}
              </div>
              <Input
                inputMode="numeric"
                placeholder="0000 0000 0000 0000"
                value={cardNumber}
                onChange={(e) => setCardNumber(formatCard(e.target.value))}
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Input
                  inputMode="numeric"
                  placeholder={t("MM/ГГ")}
                  value={expiry}
                  onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                />
                <Input
                  inputMode="numeric"
                  placeholder="CVC"
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </div>
              <Input
                placeholder={t("Имя на карте")}
                value={holder}
                onChange={(e) => setHolder(e.target.value.toUpperCase())}
                className="mt-2"
              />
            </div>

            {/* Promo */}
            <div className="mt-4 flex gap-2">
              <Input
                placeholder={t("Промокод")}
                value={promo}
                onChange={(e) => setPromo(e.target.value)}
                className="flex-1"
              />
              <Button type="button" variant="outline" onClick={applyPromo} className="px-4">
                {t("Применить")}
              </Button>
            </div>
            {promoApplied && (
              <div className="mt-1 text-xs text-emerald-600">
                {t("Скидка −{sum} ₾", { sum: t.number(promoApplied.discount) })}
              </div>
            )}

            {/* Consents */}
            <label className="mt-4 flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={agreeTerms}
                onChange={(e) => setAgreeTerms(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>{t("Согласен с условиями оферты и политикой конфиденциальности")}</span>
            </label>
            {isSubscription && (
              <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreeRecurring}
                  onChange={(e) => setAgreeRecurring(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span>
                  {t(
                    "Согласен с регулярными списаниями каждые {n} дн. Отменить можно в любой момент.",
                    { n: membership.duration_days },
                  )}
                </span>
              </label>
            )}

            {/* Total + Pay */}
            <div className="mt-5 flex items-end justify-between">
              <div className="text-xs text-muted-foreground">{t("К оплате")}</div>
              <div className="text-2xl font-black tabular-nums">{t.number(total)} ₾</div>
            </div>

            <Button
              onClick={() => onPurchase(total)}
              disabled={!canPay}
              className="mt-3 w-full disabled:opacity-60"
            >
              {purchasing
                ? t("Оплачиваем…")
                : hasActive
                  ? t("Оплатить и перейти · {sum} ₾", { sum: t.number(total) })
                  : t("Оплатить · {sum} ₾", { sum: t.number(total) })}
            </Button>

            <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{t("Защищённый платёж")}</span>
            </div>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

function ActiveMembershipDrawer({
  active,
  open,
  onOpenChange,
  onManage,
}: {
  active: ActiveMembership;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: () => void;
}) {
  const t = useT();
  const m = useLocalize()(active.memberships);
  const autoOn = active.auto_renew !== false;
  // Пакет персональных: visits_count = 0, остаток — в personal_left (иначе «0 из 0»).
  const isPersonal = active.balance_kind === "personal";
  const features = [
    isPersonal
      ? t("Персональных тренировок осталось: {n}", { n: active.personal_left ?? 0 })
      : m?.visits_count == null
        ? t("Безлимит посещений")
        : t("Осталось {left} из {total} занятий", {
            left: active.visits_left ?? m.visits_count,
            total: m.visits_count,
          }),
    !isPersonal && (active.personal_left ?? 0) > 0
      ? t("Персональных тренировок: {n}", { n: active.personal_left ?? 0 })
      : null,
    m?.duration_days ? durationLine(m.duration_days, t) : null,
    m?.freeze_days_allowed ? freezeLine(m.freeze_days_allowed, t) : null,
    ...((m?.benefits ?? []).filter(Boolean) as string[]),
  ].filter(Boolean) as string[];

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DrawerPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col rounded-t-2xl border-t border-border bg-background outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <DrawerPrimitive.Title className="text-2xl font-bold leading-tight">
                  {m?.name ?? t("Ваш абонемент")}
                </DrawerPrimitive.Title>
                {m?.description?.trim() && (
                  <FormattedText
                    text={m.description}
                    className="text-sm text-muted-foreground mt-1"
                    linkClass="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
                  />
                )}
              </div>
              <div
                className="h-14 w-14 rounded-2xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: (autoOn ? "#22C55E" : "#EF4444") + "26" }}
              >
                {autoOn ? (
                  <ShieldCheck className="h-7 w-7" style={{ color: "#22C55E" }} />
                ) : (
                  <CloseCircle
                    className="h-7 w-7"
                    style={{ color: "#EF4444" }}
                    weight="BoldDuotone"
                  />
                )}
              </div>
            </div>

            <div className="mt-5 space-y-2">
              {features.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" weight="BoldDuotone" />
                  <span>{f}</span>
                </div>
              ))}
            </div>

            <div
              className="mt-5 flex items-center gap-2 rounded-xl p-3 text-sm"
              style={{ backgroundColor: (autoOn ? "#22C55E" : "#EF4444") + "14" }}
            >
              {autoOn ? (
                <ShieldCheck className="h-4 w-4 shrink-0" style={{ color: "#22C55E" }} />
              ) : (
                <CloseCircle
                  className="h-4 w-4 shrink-0"
                  style={{ color: "#EF4444" }}
                  weight="BoldDuotone"
                />
              )}
              <span style={{ color: autoOn ? "#15803D" : "#B91C1C" }}>
                {autoOn
                  ? active.ends_at
                    ? t("Автопродление включено. Следующее списание {date}", {
                        date: formatLongDate(active.ends_at, t),
                      })
                    : t("Автопродление включено")
                  : active.ends_at
                    ? t("Автопродление выключено. Абонемент закончится {date}", {
                        date: formatLongDate(active.ends_at, t),
                      })
                    : t("Автопродление выключено")}
              </span>
            </div>

            <div className="mt-6 flex justify-center">
              <button
                onClick={onManage}
                disabled={!autoOn}
                className={`text-sm font-normal transition-opacity ${
                  !autoOn
                    ? "text-foreground/40 pointer-events-none select-none"
                    : "text-foreground hover:opacity-80"
                }`}
              >
                {t("Управление")}
              </button>
            </div>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
