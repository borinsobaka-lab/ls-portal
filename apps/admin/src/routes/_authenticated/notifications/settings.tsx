import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Check, Download, Loader2, Mail, Share, Smartphone, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import {
  NotificationSettingsCardsSkeleton,
  NotificationSettingsPageSkeleton,
} from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeField } from "@/components/ui/date-field";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { PORTAL_NAME } from "@/lib/brand";
import { unwrap } from "@/lib/query";
import {
  dndActive,
  pushDevicesQuery,
  usePortalSettings,
  useSavePortalSettings,
  type PortalSettings,
} from "@/lib/notifications/data";
import { dndUntilText, untilMorning } from "@/lib/notifications/feed-logic";
import { promptInstall, useCanInstall } from "@/lib/notifications/install";
import {
  emailEnabled,
  emailKindsCount,
  NOTIF_KINDS,
  pushEnabled,
  withChannel,
  type NotifChannel,
} from "@/lib/notifications/kinds";
import {
  enablePush,
  hasPushSubscription,
  isInstalledApp,
  isIos,
  syncPushDevice,
  usePushPermission,
} from "@/lib/notifications/push-client";
import { deviceLabel, RU_TIMEZONES, timezoneLabel } from "@/lib/notifications/settings-logic";

/**
 * Настройки уведомлений (TASKS_CHATS_PLAN.md, «Уведомления», боли № 8, 15,
 * 38 брифа; упрощение — UI_REVIEW, 5.8): уведомления на этом устройстве,
 * «Отключить на время» и «Тихие часы» — отдельными карточками, что и куда
 * присылать («На устройство» / «На почту»; почта по умолчанию выключена),
 * время и рабочий день (пояс — для календаря, сроков задач и тихих часов),
 * свои устройства, в конце — установка приложения. В ленту портала
 * уведомления приходят всегда. Сохраняется сразу — «Сохранено» на 2 с.
 */
export const Route = createFileRoute("/_authenticated/notifications/settings")({
  head: () => ({ meta: [{ title: `Настройки уведомлений — ${PORTAL_NAME}` }] }),
  pendingComponent: NotificationSettingsPageSkeleton,
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  const { data: settings, isLoading } = usePortalSettings();
  const save = useSavePortalSettings();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const update = async (patch: Partial<PortalSettings>) => {
    try {
      await save(patch);
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Не удалось сохранить: ${(e as Error).message}`);
    }
  };

  return (
    <AdminShell title="Настройки уведомлений">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Автосохранение — с видимым ответом (UI_REVIEW, 5.8.7). */}
        <div
          aria-live="polite"
          className="pointer-events-none sticky top-0 z-30 flex h-0 justify-end"
        >
          {saved && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 shadow-sm">
              <Check className="size-4" /> Сохранено
            </span>
          )}
        </div>
        <ThisDeviceCard />
        {isLoading || !settings ? (
          <NotificationSettingsCardsSkeleton
            titles={["Отключить на время", "Тихие часы", "Что и куда присылать"]}
          />
        ) : (
          <>
            <DndCard settings={settings} update={update} />
            <QuietCard settings={settings} update={update} />
            <KindsCard settings={settings} update={update} />
            <TimezoneCard settings={settings} update={update} />
          </>
        )}
        <DevicesCard />
        <InstallCard />
      </div>
    </AdminShell>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

// ---- Уведомления на этом устройстве---------------------------------------------

function ThisDeviceCard() {
  const permission = usePushPermission();
  const { data: profile } = useStaffProfile();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const installed = typeof window !== "undefined" && isInstalledApp();
  const ios = typeof window !== "undefined" && isIos();

  useEffect(() => {
    void hasPushSubscription().then(setSubscribed);
  }, [permission]);

  const enable = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      const res = await enablePush(profile.id);
      if (res.permission === "denied") toast.error("Уведомления запрещены в браузере");
      else if (res.error === "no-worker")
        toast.error("Уведомления на устройство работают только в рабочей версии портала");
      else if (res.error) toast.error("Не удалось подписаться на уведомления. Попробуйте ещё раз");
      else if (res.subscribed) toast.success("Уведомления включены на этом устройстве");
      setSubscribed(res.subscribed);
      void queryClient.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      if (profile) await syncPushDevice(profile.id, true).catch(() => false);
      const devices = (await unwrap<number>(supabase.rpc("notif_test"))) ?? 0;
      if (devices === 0) toast.error("Нет устройств с включёнными уведомлениями");
      else toast.success("Отправили. Уведомление придёт через несколько секунд");
    } catch (e) {
      const message = (e as Error).message;
      toast.error(
        message.includes("rate_limit")
          ? "Подождите несколько секунд перед следующей проверкой"
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  let status: ReactNode;
  let action: ReactNode = null;
  if (permission === "unsupported" || permission === null) {
    status = (
      <StatusChip tone="neutral">
        {ios && !installed ? "Нужна установка" : "Не поддерживаются"}
      </StatusChip>
    );
  } else if (permission === "denied") {
    status = <StatusChip tone="negative">Запрещены</StatusChip>;
  } else if (permission === "granted" && subscribed) {
    status = <StatusChip tone="positive">Включены</StatusChip>;
    action = (
      <Button variant="outline" disabled={busy} onClick={() => void test()}>
        {busy && <Loader2 className="animate-spin" />} Прислать проверочное
      </Button>
    );
  } else {
    status = <StatusChip tone="warning">Выключены</StatusChip>;
    action = (
      <Button disabled={busy || !profile} onClick={() => void enable()}>
        {busy && <Loader2 className="animate-spin" />} Включить уведомления
      </Button>
    );
  }

  return (
    <Section
      title="Уведомления на этом устройстве"
      description="Уведомление придёт на телефон или компьютер, даже когда портал закрыт. Пока вы на портале, на устройство ничего не приходит — новое видно в «Уведомлениях» в меню слева."
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">Сейчас:</span>
        {status}
        <div className="ml-auto">{action}</div>
      </div>
      {permission === "denied" && (
        <InfoNote>
          Браузер запомнил запрет. Разрешите уведомления для этого сайта: значок замка слева от
          адреса → «Уведомления» → «Разрешить» (на телефоне — в настройках приложения), затем
          вернитесь сюда.
        </InfoNote>
      )}
      {ios && !installed && (
        <InfoNote>
          На iPhone и iPad уведомления приходят только в установленном приложении портала (iOS 16.4
          и новее). Установите его — в конце страницы — и включите уведомления уже в нём.
        </InfoNote>
      )}
    </Section>
  );
}

// ---- Установка приложения ---------------------------------------------------

function InstallCard() {
  const canInstall = useCanInstall();
  const [installed, setInstalled] = useState(false);
  const ios = typeof window !== "undefined" && isIos();
  useEffect(() => setInstalled(isInstalledApp()), []);

  return (
    <Section
      title="Приложение портала"
      description="Нужно для уведомлений на iPhone и iPad. На телефон и компьютер портал ставится как приложение: свой значок и отдельное окно."
    >
      {installed ? (
        <div className="flex items-center gap-2 text-sm">
          <StatusChip tone="positive">Установлено</StatusChip> Вы открыли портал как приложение.
        </div>
      ) : canInstall ? (
        <Button
          onClick={() =>
            void promptInstall().then((ok) => ok && toast.success("Приложение устанавливается"))
          }
        >
          <Download /> Установить приложение
        </Button>
      ) : ios ? (
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>
            Откройте портал в <b>Safari</b>.
          </li>
          <li>
            Нажмите <b>«Поделиться»</b> <Share className="inline size-4 align-text-bottom" /> (в iOS
            26 — сначала три точки).
          </li>
          <li>
            Выберите <b>«На экран „Домой“»</b> и нажмите <b>«Добавить»</b>.
          </li>
          <li>Откройте портал значком с экрана «Домой» и включите уведомления здесь.</li>
        </ol>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          <li>
            <b>Компьютер (Chrome, Edge, Яндекс Браузер):</b> значок установки справа в адресной
            строке или меню браузера → «Установить приложение».
          </li>
          <li>
            <b>Android (Chrome):</b> меню ⋮ → «Добавить на главный экран» или «Установить
            приложение».
          </li>
        </ul>
      )}
    </Section>
  );
}

// ---- «Отключить на время» и «Тихие часы» --------------------------------------

type Update = (patch: Partial<PortalSettings>) => Promise<void>;

function DndCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const active = dndActive(settings);
  const tz = settings.timezone;
  const until = (d: Date) => void update({ dnd_until: d.toISOString() });

  return (
    <Section
      title="Отключить на время"
      description="Разово: на устройство ничего не придёт, уведомления копятся в «Уведомлениях» на портале. То же — кнопкой «Не беспокоить» в ленте."
    >
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <StatusChip tone="info">
              <BellOff className="mr-1 size-3.5" />
              Не беспокоить {dndUntilText(settings.dnd_until!, tz)}
            </StatusChip>
            <Button variant="outline" onClick={() => void update({ dnd_until: null })}>
              Выключить
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => until(new Date(Date.now() + 3600_000))}>
              На час
            </Button>
            <Button variant="outline" onClick={() => until(new Date(Date.now() + 3 * 3600_000))}>
              На 3 часа
            </Button>
            <Button variant="outline" onClick={() => until(untilMorning(tz))}>
              До утра (9:00)
            </Button>
          </>
        )}
      </div>
    </Section>
  );
}

function QuietCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  return (
    <Section
      title="Тихие часы"
      description="Каждый день в одно и то же время на устройство ничего не приходит — например, с 21:00 до 9:00. Время — по вашему часовому поясу (ниже)."
    >
      <SwitchRow
        title="Включить тихие часы"
        checked={settings.quiet_enabled}
        onCheckedChange={(v) => void update({ quiet_enabled: v })}
      />
      {settings.quiet_enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="С" htmlFor={null}>
            <TimeField
              step={15}
              className="w-full"
              aria-label="Тихие часы с"
              common={["20:00", "21:00", "22:00", "23:00"]}
              value={settings.quiet_from}
              onChange={(v) => v !== settings.quiet_from && void update({ quiet_from: v })}
            />
          </FormField>
          <FormField label="До" htmlFor={null}>
            <TimeField
              step={15}
              className="w-full"
              aria-label="Тихие часы до"
              common={["07:00", "08:00", "09:00", "10:00"]}
              value={settings.quiet_to}
              onChange={(v) => v !== settings.quiet_to && void update({ quiet_to: v })}
            />
          </FormField>
          <SwitchRow
            className="sm:col-span-2"
            title="И все выходные"
            checked={settings.quiet_weekends}
            onCheckedChange={(v) => void update({ quiet_weekends: v })}
          />
        </div>
      )}
    </Section>
  );
}

// ---- Что и куда присылать ----------------------------------------------------

function KindsCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const kinds = NOTIF_KINDS.filter((k) => !k.hidden);
  const groups = [...new Set(kinds.map((k) => k.group))];
  const set = (key: string, channel: NotifChannel, on: boolean) =>
    void update({ prefs: withChannel(settings.prefs, key, channel, on) });
  const noEmail = !settings.email;
  return (
    <Section
      title="Что и куда присылать"
      description="В «Уведомления» на портале приходит всё. Здесь — что ещё присылать на устройство (телефон, компьютер) и на почту: можно одно, оба или ничего."
    >
      <EmailNote settings={settings} />
      {groups.map((group) => (
        <div key={group}>
          <div className="sticky top-0 z-10 flex items-end gap-3 border-b bg-card px-1 pt-2 pb-1.5">
            <h3 className="flex-1 text-sm font-semibold">{group}</h3>
            <span className="w-20 text-center text-xs text-muted-foreground">На устройство</span>
            <span className="w-20 text-center text-xs text-muted-foreground">На почту</span>
          </div>
          <div className="divide-y">
            {kinds
              .filter((k) => k.group === group)
              .map((k) => (
                <div key={k.key} className="flex items-center gap-3 px-1 py-2.5">
                  <span className="flex-1 space-y-0.5">
                    <span className="block text-sm">{k.label}</span>
                    {k.hint && (
                      <span className="block text-xs text-muted-foreground">{k.hint}</span>
                    )}
                  </span>
                  <span className="flex w-20 justify-center">
                    <Switch
                      aria-label={`${k.label}: на устройство`}
                      checked={pushEnabled(settings.prefs, k.key)}
                      onCheckedChange={(v) => set(k.key, "push", v)}
                    />
                  </span>
                  <span className="flex w-20 justify-center">
                    <Switch
                      aria-label={`${k.label}: на почту`}
                      checked={emailEnabled(settings.prefs, k.key)}
                      disabled={noEmail && !emailEnabled(settings.prefs, k.key)}
                      onCheckedChange={(v) => set(k.key, "email", v)}
                    />
                  </span>
                </div>
              ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

/** Куда уходят письма и проверочное письмо. */
function EmailNote({ settings }: { settings: PortalSettings }) {
  const [busy, setBusy] = useState(false);
  if (!settings.email) {
    return (
      <InfoNote>
        У вашей учётной записи нет почты — письма-уведомления отправлять некуда. Почту указывают в
        «Пользователях и ролях».
      </InfoNote>
    );
  }
  const test = async () => {
    setBusy(true);
    try {
      const to = await unwrap<string>(supabase.rpc("notif_test_email"));
      toast.success(`Отправили на ${to}. Письмо придёт в течение минуты`);
    } catch (e) {
      const message = (e as Error).message;
      toast.error(
        message.includes("rate_limit")
          ? "Проверочное письмо — не чаще раза в минуту"
          : message.includes("notif_no_email")
            ? "У вашей учётной записи нет почты"
            : message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/50 p-3 text-sm">
      <Mail className="size-4 text-muted-foreground" />
      <span className="flex-1">
        Письма уходят на <span className="font-medium">{settings.email}</span>
        {emailKindsCount(settings.prefs) === 0 && (
          <span className="text-muted-foreground"> — сейчас ни одно уведомление не выбрано</span>
        )}
        . «Отключить на время» и тихие часы письма не задерживают; пока вы на портале, писем нет.
      </span>
      <Button variant="outline" disabled={busy} onClick={() => void test()}>
        {busy && <Loader2 className="animate-spin" />} Прислать проверочное письмо
      </Button>
    </div>
  );
}

// ---- Время и рабочий день -------------------------------------------------------

function TimezoneCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const browserTz =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const options = [...RU_TIMEZONES];
  for (const tz of [settings.timezone, browserTz]) {
    if (tz && !options.some((o) => o.value === tz)) options.push({ value: tz, label: tz });
  }
  return (
    <Section
      title="Время и рабочий день"
      description="По этому поясу показывается время в календаре, сроки задач и тихие часы. Конец рабочего дня — срок «сегодня» у задач."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Часовой пояс">
          <Select value={settings.timezone} onValueChange={(v) => void update({ timezone: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Конец рабочего дня" htmlFor={null}>
          <TimeField
            step={15}
            className="w-full"
            aria-label="Конец рабочего дня"
            common={["17:00", "18:00", "19:00", "20:00"]}
            value={settings.workday_end}
            onChange={(v) => v !== settings.workday_end && void update({ workday_end: v })}
          />
        </FormField>
      </div>
      {browserTz && browserTz !== settings.timezone && (
        <InfoNote>
          На этом устройстве пояс — {timezoneLabel(browserTz)}.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void update({ timezone: browserTz })}
          >
            Поставить его
          </button>
        </InfoNote>
      )}
    </Section>
  );
}

// ---- Мои устройства ---------------------------------------------------------------

function DevicesCard() {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: devices = [], isLoading } = useQuery(pushDevicesQuery);
  const thisUa = typeof navigator !== "undefined" ? navigator.userAgent : null;
  const remove = async (id: string, label: string, current: boolean) => {
    const ok = await confirm({
      title: `Убрать «${label}»?`,
      description: current
        ? "Это устройство. Уведомления на него перестанут приходить, пока вы снова их не включите."
        : "Уведомления на это устройство перестанут приходить.",
      confirmLabel: "Убрать",
    });
    if (!ok) return;
    try {
      await unwrap(supabase.rpc("portal_push_device_delete", { p_id: id }));
      await queryClient.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
      toast.success("Устройство убрано");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Section
      title="Мои устройства"
      description="Куда приходят уведомления на устройство. Уберите то, которым больше не пользуетесь."
    >
      {isLoading ? (
        <div className="divide-y rounded-md border">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="size-4" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока ни одного — включите уведомления выше.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {devices.map((d) => {
            const label = deviceLabel(d.user_agent);
            const current = !!thisUa && d.user_agent === thisUa;
            return (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 truncate text-sm font-medium">
                    {label}
                    {current && (
                      <StatusChip tone="info" size="sm">
                        это устройство
                      </StatusChip>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Добавлено {format(new Date(d.created_at), "d MMM yyyy", { locale: ru })}
                    {d.last_sent_at &&
                      ` · последнее уведомление ${format(new Date(d.last_sent_at), "d MMM, HH:mm", { locale: ru })}`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Убрать устройство ${label}`}
                  title="Убрать устройство"
                  onClick={() => void remove(d.id, label, current)}
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {confirmDialog}
    </Section>
  );
}
