import { supabase } from "@/integrations/supabase/client";
import { APP_BRAND, APP_FORMAT } from "@/lib/app-format";
import type { Translator } from "@/i18n";

/**
 * Иконка и подпись приложения для установки (PWA, «На экран „Домой“») и
 * фавикон. Задаются в админке: «Мобильное приложение» → «Настройки»
 * (app_install_settings — строка на формат клубов, то есть на приложение:
 * у app. и pack. свои; db/migrations/2026-10-11_zzzzzzzzzz_app_content_by_studio.sql).
 *
 * app_icon_path — папка в публичном бакете app-icons с готовыми PNG (их
 * нарезает админка, apps/admin/src/lib/app-icons.ts — имена файлов те же).
 * Без своей иконки — Base40 из public/.
 */
export type AppInstall = {
  name: string;
  icons: {
    icon192: string;
    icon512: string;
    maskable512: string;
    appleTouch: string;
    favicon32: string;
  };
  /** Своя иконка из админки (иначе — Base40 по умолчанию). */
  custom: boolean;
  /**
   * «Вход закрыт» (app_install_settings.sign_in_closed, решение владельца
   * 2026-10-14): приложение раздают до переноса базы клиентов — на экране
   * входа вместо почты текст, когда откроем вход (routes/auth.tsx).
   */
  signInClosed: boolean;
};

const DEFAULT_NAME = APP_BRAND;

/**
 * Цвет строки состояния телефона (время, заряд) в установленном приложении —
 * как фон шапки (HeaderBackdrop в components/page-shell.tsx), чтобы полоса
 * сверху не была чёрной. Meta theme-color и theme_color манифеста.
 */
export const APP_THEME_COLOR = "#2A2B2F";

const DEFAULT_ICONS: AppInstall["icons"] = {
  icon192: "/icon-192.png",
  icon512: "/icon-512.png",
  maskable512: "/icon-maskable-512.png",
  appleTouch: "/apple-touch-icon.png",
  favicon32: "/favicon-32.png",
};

const ICON_FILES: AppInstall["icons"] = {
  icon192: "icon-192.png",
  icon512: "icon-512.png",
  maskable512: "icon-maskable-512.png",
  appleTouch: "apple-touch-icon.png",
  favicon32: "favicon-32.png",
};

export const DEFAULT_APP_INSTALL: AppInstall = {
  name: DEFAULT_NAME,
  icons: DEFAULT_ICONS,
  custom: false,
  signInClosed: false,
};

function iconUrls(folder: string): AppInstall["icons"] {
  const bucket = supabase.storage.from("app-icons");
  const url = (file: string) => bucket.getPublicUrl(`${folder}/${file}`).data.publicUrl;
  return {
    icon192: url(ICON_FILES.icon192),
    icon512: url(ICON_FILES.icon512),
    maskable512: url(ICON_FILES.maskable512),
    appleTouch: url(ICON_FILES.appleTouch),
    favicon32: url(ICON_FILES.favicon32),
  };
}

// Читается на каждый серверный рендер (head корня) и манифестом: держим
// в памяти процесса. Устаревшее значение (старше минуты) отдаём сразу, а
// обновляем фоном: раньше раз в минуту очередная страница ждала ответа базы
// (до 2 секунд) перед тем, как начать отдаваться.
const TTL_MS = 60_000;
let cached: { value: AppInstall; at: number } | null = null;
let refreshing: Promise<AppInstall> | null = null;

async function loadAppInstall(): Promise<AppInstall> {
  try {
    // У каждого приложения (формата клубов) своя строка. «*», а не список
    // колонок: до миграции sign_in_closed запрос не падает (иначе пропала бы
    // и иконка).
    const { data, error } = await supabase
      .from("app_install_settings")
      .select("*")
      .eq("format", APP_FORMAT)
      .abortSignal(AbortSignal.timeout(2000))
      .maybeSingle();
    if (error) throw error;
    const value: AppInstall = {
      name: data?.app_name?.trim() || DEFAULT_NAME,
      icons: data?.app_icon_path ? iconUrls(data.app_icon_path) : DEFAULT_ICONS,
      custom: !!data?.app_icon_path,
      // Колонки нет в сгенерированных типах (db/migrations/2026-10-14_zz_…).
      signInClosed: (data as { sign_in_closed?: boolean } | null)?.sign_in_closed === true,
    };
    cached = { value, at: Date.now() };
    return value;
  } catch {
    // Ошибку не кэшируем: следующий запрос попробует снова.
    return cached?.value ?? DEFAULT_APP_INSTALL;
  }
}

/**
 * «Вход закрыт» прямо из базы — для экрана входа в браузере. Страница с
 * сервера может прийти с устаревшим флагом (минутный кэш выше, сохранённая
 * service worker'ом копия страницы), поэтому экран входа перепроверяет его
 * сам. Ошибка — исключение (React Query оставит прежнее значение).
 */
export async function fetchSignInClosed(): Promise<boolean> {
  const { data, error } = await supabase
    .from("app_install_settings")
    .select("*")
    .eq("format", APP_FORMAT)
    .maybeSingle();
  if (error) throw error;
  return (data as { sign_in_closed?: boolean } | null)?.sign_in_closed === true;
}

/**
 * Настройки установки. Никогда не бросает: при ошибке или медленной базе —
 * Base40 по умолчанию (иконка не должна ронять или задерживать страницу).
 */
export async function fetchAppInstall(): Promise<AppInstall> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (!refreshing) {
    refreshing = loadAppInstall().finally(() => {
      refreshing = null;
    });
  }
  // Есть прежнее значение — не ждём базу.
  return cached ? cached.value : refreshing;
}

/** Веб-манифест (/manifest.webmanifest) на языке клиента. */
export function buildManifest(app: AppInstall, t: Translator) {
  return {
    id: "/",
    name: app.name,
    short_name: app.name,
    description: t("Расписание, запись на тренировки и абонементы."),
    lang: t.locale,
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Только вертикально (решение владельца 2026-10-13). Android соблюдает;
    // iOS поле не читает — там заглушка RotateOverlay (__root.tsx).
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: APP_THEME_COLOR,
    icons: [
      { src: app.icons.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: app.icons.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: app.icons.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
