import type React from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { FieldHint } from "@/components/ui/field-hint";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton } from "@/components/skeletons";
import {
  LOCALE_LABEL,
  PUSH_PERMISSION_LABEL,
  activeDays,
  activityStrip,
  appInsights,
  devicePush,
  deviceSystem,
  deviceTitle,
  isOutdated,
  lastSeenAt,
  screensRanking,
  timeAgo,
  type AppDevice,
  type ClientAppOverview,
  type PushPermission,
} from "@/lib/client-app";
import { formatDate, formatDateTime } from "@/lib/format";
import { plural } from "@/lib/payroll";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";

/** Подсказки «?» у блоков вкладки. */
const TIPS = {
  activity:
    "Открытие — запуск приложения или возвращение в него после 30 минут перерыва. День — по Тбилиси.",
  push: "Получено — уведомления в ленте приложения (приходят и с выключенными пушами), прочитано — открыл в ленте. Доставлено и открыто из пуша — по телефонам с включёнными уведомлениями.",
  devices:
    "Модель iPhone приложение не сообщает — она угадана по размеру экрана, поэтому перечислены модели одного размера.",
  screens: "Сколько раз клиент открывал раздел за 30 дней.",
  actions:
    "Кто записал, база знает с 15.10.2026: более ранние записи в счёт не идут. Покупки, оценки и заявки — за всё время.",
} as const;

/**
 * Вкладка «Приложение» карточки клиента (решение владельца 2026-10-15): вход,
 * активность, уведомления, устройства, разделы и действия клиента в
 * клиентском приложении. Данные — одна RPC client_app_overview, только
 * приложение формата клуба карточки; логика и подписи — lib/client-app.ts.
 */
export function ClientAppTab({ clientId, hasUser }: { clientId: string; hasUser: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["client_app_overview", clientId],
    queryFn: () =>
      unwrap<ClientAppOverview>(supabase.rpc("client_app_overview", { p_client_id: clientId })),
    enabled: hasUser,
    meta: { errorMessage: "Не удалось загрузить данные приложения" },
  });

  if (!hasUser || (data && !data.has_account)) {
    return (
      <InfoNote variant="empty">
        Клиент ещё не входил в мобильное приложение — данные появятся после первого входа.
      </InfoNote>
    );
  }
  if (isLoading || !data) return <ClientAppTabSkeleton />;

  const format = data.app_format;
  const devices = data.devices ?? [];
  const seen = lastSeenAt(devices);
  const strip = activityStrip(data.activity?.days ?? []);
  const sessions30 = strip.reduce((sum, d) => sum + d.sessions, 0);
  const screens = screensRanking(data.activity?.screens_30d ?? {}, format);
  const insights = appInsights(data);
  const push = data.push;
  const actions = data.actions;
  const latest = devices[0];

  return (
    <div className="space-y-4">
      <InfoNote className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span>
          {seen ? (
            <>
              Последний раз в приложении:{" "}
              <span className="font-medium text-foreground">{formatDateTime(seen)}</span> ·{" "}
              {timeAgo(seen)}
            </>
          ) : (
            "Приложение ещё не сообщало о себе"
          )}
        </span>
        {latest?.app_version && <span>версия {latest.app_version}</span>}
      </InfoNote>

      {insights.length > 0 && (
        <ul className="space-y-2">
          {insights.map((tip) => (
            <li key={tip.text}>
              <InfoNote
                variant={
                  tip.tone === "warning" ? "warning" : tip.tone === "info" ? "info" : "muted"
                }
              >
                {tip.text}
              </InfoNote>
            </li>
          ))}
        </ul>
      )}

      <Block title="Вход и активность" tip={TIPS.activity}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-2">
          <Value label="Первый вход" value={formatDate(data.account?.created_at)} />
          <Value
            label={
              data.is_staff ? "Последний вход по коду (и в админку)" : "Последний вход по коду"
            }
            value={formatDateTime(data.account?.last_sign_in_at)}
          />
          <Value label="Открытий за 30 дней" value={devices.length ? String(sessions30) : "—"} />
          <Value
            label="Активных дней"
            value={
              devices.length ? `${activeDays(strip, 7)} из 7 · ${activeDays(strip, 30)} из 30` : "—"
            }
          />
          {format === "packages" && (
            <Value
              label="Согласие с политикой"
              value={formatDate(data.account?.privacy_accepted_at)}
            />
          )}
          <Value
            label="Язык приложения"
            value={latest?.locale ? (LOCALE_LABEL[latest.locale] ?? latest.locale) : "—"}
          />
        </div>
        {devices.length > 0 && <ActivityStrip strip={strip} />}
      </Block>

      <Block title="Уведомления" tip={TIPS.push}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-2">
          <Value
            label="Разрешение на телефоне"
            value={<PermissionBadge permission={latest?.push_permission ?? null} />}
          />
          <Value label="Подписанных телефонов" value={push ? String(push.subscriptions) : "—"} />
          <Value
            label="Получено за 30 дней"
            value={push ? `${push.received_30d} · прочитано ${push.read_30d}` : "—"}
          />
          <Value
            label="Пуши за 30 дней"
            value={
              push
                ? `доставлено ${push.delivered_30d} из ${push.sent_30d} · открыто ${push.clicked_30d}`
                : "—"
            }
          />
          <Value label="Последнее уведомление" value={formatDateTime(push?.last_received_at)} />
        </div>
      </Block>

      {devices.length > 0 && (
        <Block
          title={devices.length > 1 ? `Устройства (${devices.length})` : "Устройство"}
          tip={TIPS.devices}
        >
          <ul className="divide-y">
            {devices.map((d) => (
              <DeviceRow key={d.device_id} device={d} latestVersion={data.latest_app_version} />
            ))}
          </ul>
        </Block>
      )}

      {screens.length > 0 && (
        <Block title="Разделы за 30 дней" tip={TIPS.screens}>
          <ScreensChart screens={screens} />
        </Block>
      )}

      {actions && (
        <Block title="Действия в приложении" tip={TIPS.actions}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 py-2">
            <Value
              label="Записи за 30 дней"
              value={`сам — ${actions.bookings_self_30d} · администратор — ${actions.bookings_staff_30d}`}
            />
            <Value
              label="Покупки в приложении"
              value={
                actions.purchases_app
                  ? `${actions.purchases_app} · последняя ${formatDate(actions.last_purchase_app_at)}`
                  : "нет"
              }
            />
            <Value label="Оценки тренерам" value={String(actions.trainer_reviews)} />
            {format === "packages" && (
              <Value label="Заявки администратору" value={String(actions.requests)} />
            )}
            <Value
              label="Последний NPS"
              value={
                actions.nps_last
                  ? `${actions.nps_last.score} из 10 · ${formatDate(actions.nps_last.at)}`
                  : "—"
              }
            />
          </div>
        </Block>
      )}
    </div>
  );
}

/** Блок вкладки: подпись (с «?») и содержимое — как разделы «Анкеты». */
function Block({
  title,
  tip,
  children,
}: {
  title: string;
  tip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
        {title}
        {tip && <FieldHint>{tip}</FieldHint>}
      </div>
      {children}
    </div>
  );
}

function Value({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

const PERMISSION_TONE: Record<PushPermission, StatusTone> = {
  granted: "positive",
  denied: "negative",
  default: "warning",
  unsupported: "neutral",
};

function PermissionBadge({ permission }: { permission: PushPermission | null }) {
  if (!permission) return <>—</>;
  return (
    <StatusChip tone={PERMISSION_TONE[permission]}>{PUSH_PERMISSION_LABEL[permission]}</StatusChip>
  );
}

/** 30 дней активности: день — квадрат, ярче — больше открытий. */
function ActivityStrip({ strip }: { strip: { day: string; sessions: number }[] }) {
  // Полоса передаёт смысл только цветом — для скринридера то же числом.
  const activeDays = strip.filter((d) => d.sessions > 0).length;
  const totalSessions = strip.reduce((sum, d) => sum + d.sessions, 0);
  const summary = activeDays
    ? `Открывал приложение ${activeDays} ${plural(activeDays, ["день", "дня", "дней"])} из ${strip.length}, всего ${totalSessions} ${plural(totalSessions, ["открытие", "открытия", "открытий"])}`
    : `Не открывал приложение ${strip.length} ${plural(strip.length, ["день", "дня", "дней"])}`;
  return (
    <div className="mt-1 border-t pt-3">
      <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{formatDate(strip[0]?.day)}</span>
        <span>сегодня</span>
      </div>
      <div
        role="img"
        aria-label={summary}
        className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-0.5"
      >
        {strip.map((d) => (
          <div
            key={d.day}
            title={`${formatDate(d.day)}: ${
              d.sessions
                ? `${d.sessions} ${plural(d.sessions, ["открытие", "открытия", "открытий"])}`
                : "не открывал"
            }`}
            className={cn(
              "h-4 rounded-sm",
              d.sessions === 0
                ? "bg-muted"
                : d.sessions === 1
                  ? "bg-blue-300"
                  : d.sessions <= 3
                    ? "bg-blue-500"
                    : "bg-blue-700",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function ScreensChart({ screens }: { screens: { key: string; label: string; count: number }[] }) {
  const max = screens[0]?.count ?? 1;
  return (
    <ul className="space-y-1.5 py-2">
      {screens.map((s) => (
        <li key={s.key} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="truncate">{s.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-blue-500"
              style={{ width: `${Math.max(4, Math.round((s.count / max) * 100))}%` }}
            />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">{s.count}</span>
        </li>
      ))}
    </ul>
  );
}

function DeviceRow({
  device: d,
  latestVersion,
}: {
  device: AppDevice;
  latestVersion: string | null | undefined;
}) {
  const outdated = isOutdated(d.app_version, latestVersion);
  const extra = [
    d.screen && `экран ${d.screen}`,
    d.dark_mode != null && (d.dark_mode ? "тёмная тема" : "светлая тема"),
    d.device_language && `язык устройства ${d.device_language}`,
    d.timezone,
  ].filter(Boolean);
  return (
    <li className="space-y-0.5 py-2 text-sm">
      <div className="font-medium">{deviceTitle(d)}</div>
      <div className="text-muted-foreground">
        {deviceSystem(d)}
        {d.app_version && (
          <>
            {" · "}
            <span className={cn(outdated && "font-medium text-amber-700")}>
              приложение {d.app_version}
              {outdated && " (устарело)"}
            </span>
          </>
        )}
      </div>
      <div className="text-muted-foreground">
        {d.standalone === false ? "Вкладка браузера" : "Установлено на экран «Домой»"}
        {" · уведомления: "}
        {devicePush(d).toLowerCase()}
      </div>
      {extra.length > 0 && <div className="text-xs text-muted-foreground">{extra.join(" · ")}</div>}
      <div className="text-xs text-muted-foreground">
        Первый запуск {formatDate(d.first_seen_at)} · последний {formatDateTime(d.last_seen_at)} ·{" "}
        {d.sessions_count} {plural(d.sessions_count, ["открытие", "открытия", "открытий"])}
      </div>
    </li>
  );
}

/** Болванка вкладки: строка «последний раз» и блоки той же раскладки. */
function ClientAppTabSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-full rounded-md" />
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border bg-background p-3">
          <Skeleton className="h-3 w-32" />
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="space-y-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <CardSkeleton rows={1} />
    </div>
  );
}
