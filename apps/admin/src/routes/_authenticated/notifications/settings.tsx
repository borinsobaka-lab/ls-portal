import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Download, Loader2, Share, Smartphone, Trash2 } from "lucide-react";
import { addDays, format, set } from "date-fns";
import { ru } from "date-fns/locale";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { NotificationSettingsPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { promptInstall, useCanInstall } from "@/lib/notifications/install";
import { NOTIF_KINDS, pushEnabled, withPush } from "@/lib/notifications/kinds";
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
 * 38 брифа): пуши на этом устройстве и установка приложения, «Не
 * беспокоить» разово и по расписанию, какие события присылать пушем,
 * часовой пояс (по нему — тихие часы и сроки задач), свои устройства.
 * В ленту портала уведомления приходят всегда.
 */
export const Route = createFileRoute("/_authenticated/notifications/settings")({
  head: () => ({ meta: [{ title: `Настройки уведомлений — ${PORTAL_NAME}` }] }),
  pendingComponent: NotificationSettingsPageSkeleton,
  component: NotificationSettingsPage,
});

function NotificationSettingsPage() {
  const { data: settings, isLoading } = usePortalSettings();
  const save = useSavePortalSettings();

  const update = async (patch: Partial<PortalSettings>) => {
    try {
      await save(patch);
    } catch (e) {
      toast.error(`Не удалось сохранить: ${(e as Error).message}`);
    }
  };

  return (
    <AdminShell title="Настройки уведомлений">
      <div className="mx-auto max-w-3xl space-y-4">
        <ThisDeviceCard />
        <InstallCard />
        {isLoading || !settings ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Загружаем…
          </div>
        ) : (
          <>
            <DndCard settings={settings} update={update} />
            <KindsCard settings={settings} update={update} />
            <TimezoneCard settings={settings} update={update} />
          </>
        )}
        <DevicesCard />
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

// ---- Пуши на этом устройстве ------------------------------------------------

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
        toast.error("Пуши работают только в рабочей версии портала (не в разработке)");
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
      description="Пуш придёт, даже когда портал закрыт. Пока вы на портале, пуши не приходят — новое видно в «Уведомлениях» в меню слева."
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
          и новее). Установите его — ниже — и включите уведомления уже в нём.
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
      description="Портал можно установить на телефон и компьютер: свой значок, отдельное окно и уведомления, как у обычного приложения."
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

// ---- «Не беспокоить» и тихие часы -----------------------------------------

type Update = (patch: Partial<PortalSettings>) => Promise<void>;

function DndCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const active = dndActive(settings);
  const until = (d: Date) => void update({ dnd_until: d.toISOString() });
  const tomorrowMorning = set(addDays(new Date(), new Date().getHours() < 9 ? 0 : 1), {
    hours: 9,
    minutes: 0,
    seconds: 0,
    milliseconds: 0,
  });

  return (
    <Section
      title="Не беспокоить"
      description="Пуши не приходят, уведомления копятся в «Уведомлениях» на портале."
    >
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <StatusChip tone="info">
              <BellOff className="mr-1 size-3.5" />
              До {format(new Date(settings.dnd_until!), "d MMMM, HH:mm", { locale: ru })}
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
            <Button variant="outline" onClick={() => until(tomorrowMorning)}>
              До утра (9:00)
            </Button>
          </>
        )}
      </div>
      <SwitchRow
        title="Тихие часы каждый день"
        hint="В это время пуши не приходят. Время — по вашему часовому поясу."
        checked={settings.quiet_enabled}
        onCheckedChange={(v) => void update({ quiet_enabled: v })}
      />
      {settings.quiet_enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="С">
            <Input
              type="time"
              defaultValue={settings.quiet_from}
              onBlur={(e) =>
                e.target.value &&
                e.target.value !== settings.quiet_from &&
                void update({ quiet_from: e.target.value })
              }
            />
          </FormField>
          <FormField label="До">
            <Input
              type="time"
              defaultValue={settings.quiet_to}
              onBlur={(e) =>
                e.target.value &&
                e.target.value !== settings.quiet_to &&
                void update({ quiet_to: e.target.value })
              }
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

// ---- Какие пуши ---------------------------------------------------------------

function KindsCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const kinds = NOTIF_KINDS.filter((k) => !k.hidden);
  const groups = [...new Set(kinds.map((k) => k.group))];
  return (
    <Section
      title="Что присылать пушем"
      description="В «Уведомления» на портале приходит всё — здесь только пуши на телефон и компьютер."
    >
      {groups.map((group) => (
        <div key={group} className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{group}</h3>
          {kinds
            .filter((k) => k.group === group)
            .map((k) => (
              <SwitchRow
                key={k.key}
                title={k.label}
                hint={k.hint}
                checked={pushEnabled(settings.prefs, k.key)}
                onCheckedChange={(v) => void update({ prefs: withPush(settings.prefs, k.key, v) })}
              />
            ))}
        </div>
      ))}
    </Section>
  );
}

// ---- Часовой пояс ---------------------------------------------------------------

function TimezoneCard({ settings, update }: { settings: PortalSettings; update: Update }) {
  const browserTz =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const options = [...RU_TIMEZONES];
  for (const tz of [settings.timezone, browserTz]) {
    if (tz && !options.some((o) => o.value === tz)) options.push({ value: tz, label: tz });
  }
  return (
    <Section
      title="Часовой пояс"
      description="По нему считаются тихие часы, а дальше — сроки задач и «до конца дня»."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Пояс">
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
        <FormField label="Конец рабочего дня">
          <Input
            type="time"
            defaultValue={settings.workday_end}
            onBlur={(e) =>
              e.target.value &&
              e.target.value !== settings.workday_end &&
              void update({ workday_end: e.target.value })
            }
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
  const { data: devices = [], isLoading } = useQuery(pushDevicesQuery);
  const remove = async (id: string) => {
    try {
      await unwrap(supabase.rpc("portal_push_device_delete", { p_id: id }));
      await queryClient.invalidateQueries({ queryKey: pushDevicesQuery.queryKey });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Section
      title="Мои устройства"
      description="Куда приходят пуши. Уберите устройство, которым больше не пользуетесь."
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Пока ни одного — включите уведомления выше.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
              <Smartphone className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {deviceLabel(d.user_agent)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Добавлено {format(new Date(d.created_at), "d MMM yyyy", { locale: ru })}
                  {d.last_sent_at &&
                    ` · последний пуш ${format(new Date(d.last_sent_at), "d MMM, HH:mm", { locale: ru })}`}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Убрать устройство"
                title="Убрать устройство"
                onClick={() => void remove(d.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
