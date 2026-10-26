/**
 * Вкладка «Приложение» в карточке клиента (решение владельца 2026-10-15):
 * устройства, уведомления и активность клиента в клиентском приложении.
 * Данные — RPC client_app_overview
 * (db/migrations/2026-10-15_zzzzz_client_app_activity.sql), их сообщает само
 * приложение (apps/client, lib/app-activity.ts). Здесь — типы, подписи и
 * подсказки без React: тест рядом (client-app.test.ts), вид —
 * components/client-app-tab.tsx.
 */
import { tbilisiDate } from "@/lib/booking-coverage";
import { formatDate } from "@/lib/format";
import { plural } from "@/lib/payroll";

export type PushPermission = "granted" | "denied" | "default" | "unsupported";

export type AppDevice = {
  device_id: string;
  app_format: "subscription" | "packages";
  platform: "ios" | "android" | "other" | null;
  os_name: string | null;
  os_version: string | null;
  device_model: string | null;
  browser: string | null;
  browser_version: string | null;
  app_version: string | null;
  standalone: boolean | null;
  push_permission: PushPermission | null;
  push_subscribed: boolean | null;
  locale: string | null;
  device_language: string | null;
  timezone: string | null;
  screen: string | null;
  dark_mode: boolean | null;
  user_agent: string | null;
  sessions_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type ClientAppOverview = {
  has_account: boolean;
  app_format: "subscription" | "packages";
  /** Учётная запись общая с админкой — «последний вход» может быть и в неё. */
  is_staff?: boolean;
  account?: {
    created_at: string | null;
    last_sign_in_at: string | null;
    privacy_accepted_at: string | null;
    privacy_version: string | null;
  } | null;
  /** Самая новая версия приложения у клиентов за 30 дней. */
  latest_app_version?: string | null;
  /** Новые первыми. */
  devices?: AppDevice[];
  activity?: {
    first_day: string | null;
    days: { day: string; sessions: number }[];
    screens_30d: Record<string, number>;
    memberships_last_day: string | null;
  };
  push?: {
    subscriptions: number;
    received_30d: number;
    read_30d: number;
    last_received_at: string | null;
    sent_30d: number;
    delivered_30d: number;
    clicked_30d: number;
  };
  actions?: {
    bookings_self_30d: number;
    bookings_staff_30d: number;
    purchases_app: number;
    last_purchase_app_at: string | null;
    trainer_reviews: number;
    requests: number;
    nps_last: { score: number; at: string } | null;
  };
};

export const PUSH_PERMISSION_LABEL: Record<PushPermission, string> = {
  granted: "Разрешены",
  denied: "Запрещены",
  default: "Не включал",
  unsupported: "Не поддерживаются",
};

export const LOCALE_LABEL: Record<string, string> = {
  en: "английский",
  ka: "грузинский",
  ru: "русский",
};

/** Раздел приложения (ключ — screenKey в apps/client, lib/device-info.ts). */
export function screenLabel(key: string, format: "subscription" | "packages"): string {
  switch (key) {
    case "home":
      return "Главная";
    case "schedule":
      return "Расписание";
    case "club":
      return format === "packages" ? "Студия" : "Клуб";
    case "memberships":
      return "Абонементы";
    case "news":
      return "Новости";
    case "notifications":
      return "Уведомления";
    case "profile":
      return "Профиль";
    case "feedback":
      return "Обратная связь";
    default:
      return key;
  }
}

/** Разделы за 30 дней — по убыванию просмотров. */
export function screensRanking(
  screens: Record<string, number>,
  format: "subscription" | "packages",
): { key: string; label: string; count: number }[] {
  return Object.entries(screens)
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, label: screenLabel(key, format), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"));
}

/** «1.10» новее «1.9»: сравнение по числам. Неразборчивое — 0 (не сравниваем). */
export function compareVersions(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)$/.exec(a.trim());
  const pb = /^(\d+)\.(\d+)$/.exec(b.trim());
  if (!pa || !pb) return 0;
  return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]);
}

export function isOutdated(version: string | null, latest: string | null | undefined): boolean {
  return !!version && !!latest && compareVersions(version, latest) < 0;
}

/** «2 ч назад», «вчера», «5 дней назад». */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return "только что";
  if (minutes < 60) return `${minutes} ${plural(minutes, ["минуту", "минуты", "минут"])} назад`;
  const hours = Math.floor(minutes / 60);
  const days = daysBetween(tbilisiDate(iso), tbilisiDate(now.toISOString()));
  if (days === 0) return `${hours} ${plural(hours, ["час", "часа", "часов"])} назад`;
  if (days === 1) return "вчера";
  return `${days} ${plural(days, ["день", "дня", "дней"])} назад`;
}

/** Дней между датами YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

/** Последние n дней по Тбилиси (сегодня — последний) и открытия в каждый. */
export function activityStrip(
  days: { day: string; sessions: number }[],
  now: Date = new Date(),
  n = 30,
): { day: string; sessions: number }[] {
  const today = tbilisiDate(now.toISOString());
  const byDay = new Map(days.map((d) => [d.day, d.sessions]));
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(today, i - (n - 1));
    return { day, sessions: byDay.get(day) ?? 0 };
  });
}

/** Активных дней за последние n дней. */
export function activeDays(strip: { sessions: number }[], n: number): number {
  return strip.slice(-n).filter((d) => d.sessions > 0).length;
}

export function lastSeenAt(devices: AppDevice[]): string | null {
  let best: string | null = null;
  for (const d of devices) if (!best || d.last_seen_at > best) best = d.last_seen_at;
  return best;
}

/** «iPhone 15 / 15 Pro», «Samsung SM-S918B», «Компьютер». */
export function deviceTitle(d: AppDevice): string {
  if (d.device_model) return d.device_model;
  if (d.platform === "android") return "Android-телефон";
  if (d.platform === "ios") return "iPhone";
  return d.os_name ? `Компьютер (${d.os_name})` : "Устройство";
}

/** «iOS 18.6 · Safari» / «Android 14 · Chrome 141». */
export function deviceSystem(d: AppDevice): string {
  const os = [d.os_name, d.os_version].filter(Boolean).join(" ");
  const browser = [d.browser, d.browser_version].filter(Boolean).join(" ");
  return [os, browser].filter(Boolean).join(" · ") || "—";
}

/** Уведомления на устройстве одной строкой. */
export function devicePush(d: AppDevice): string {
  if (!d.push_permission) return "—";
  const label = PUSH_PERMISSION_LABEL[d.push_permission];
  if (d.push_permission !== "granted") return label;
  return d.push_subscribed ? `${label}, подписка есть` : `${label}, подписки нет`;
}

export type AppInsight = { tone: "warning" | "info"; text: string };

/** Не заходил дольше — подсказка «давно не открывал». */
export const INACTIVE_DAYS = 14;

/**
 * На что обратить внимание администратору: уведомления, давно не заходил,
 * интерес к абонементам, устаревшая версия. По последнему устройству — им
 * клиент пользуется сейчас.
 */
export function appInsights(o: ClientAppOverview, now: Date = new Date()): AppInsight[] {
  if (!o.has_account) return [];
  const devices = o.devices ?? [];
  const out: AppInsight[] = [];
  const latest = devices[0];
  if (!latest) {
    out.push({
      tone: "info",
      text: "Приложение ещё не сообщало о себе: данные об устройстве и активности появятся, когда клиент откроет обновлённое приложение.",
    });
    return out;
  }

  switch (latest.push_permission) {
    case "denied":
      out.push({
        tone: "warning",
        text: "Уведомления запрещены в настройках телефона — пуши и напоминания о занятиях не приходят. Подскажите включить: в приложении «Профиль» → «Push-уведомления» покажет, как это сделать.",
      });
      break;
    case "default":
      out.push({
        tone: "warning",
        text: "Клиент ещё не включил уведомления — предложите нажать «Включите уведомления» на главной приложения.",
      });
      break;
    case "unsupported":
      out.push({
        tone: "warning",
        text: "Телефон не принимает уведомления: на iPhone нужна iOS 16.4 или новее и приложение, открытое с экрана «Домой».",
      });
      break;
    case "granted":
      if (!latest.push_subscribed && !o.push?.subscriptions) {
        out.push({
          tone: "warning",
          text: "Уведомления разрешены, но телефон не подписан — попросите закрыть приложение и открыть снова.",
        });
      }
      break;
  }

  const seen = lastSeenAt(devices);
  if (seen) {
    const idle = daysBetween(tbilisiDate(seen), tbilisiDate(now.toISOString()));
    if (idle >= INACTIVE_DAYS) {
      out.push({
        tone: "warning",
        text: `Не открывал приложение ${idle} ${plural(idle, ["день", "дня", "дней"])}.`,
      });
    }
  }

  const views = o.activity?.screens_30d.memberships ?? 0;
  if (views > 0) {
    const last = o.activity?.memberships_last_day;
    out.push({
      tone: "info",
      text:
        `Смотрел абонементы ${views} ${plural(views, ["раз", "раза", "раз"])} за 30 дней` +
        (last ? `, последний раз — ${formatDate(last)}.` : "."),
    });
  }

  if (isOutdated(latest.app_version, o.latest_app_version)) {
    out.push({
      tone: "warning",
      text: `Устаревшая версия приложения ${latest.app_version} (актуальная — ${o.latest_app_version}): попросите закрыть приложение и открыть снова.`,
    });
  }

  if (latest.standalone === false) {
    out.push({
      tone: "info",
      text: "Приложение открыто во вкладке браузера, а не с экрана «Домой» — на iPhone уведомления так не приходят.",
    });
  }

  return out;
}
