import { createFileRoute } from "@tanstack/react-router";

import { buildManifest, fetchAppInstall } from "@/lib/app-install";
import { getTranslator, loadDictionary } from "@/i18n";
import { getRequestLocale } from "@/i18n/request-locale";

// Веб-манифест для установки приложения (PWA): подпись под значком и иконки
// из админки («Мобильное приложение» → «Настройки»), см. src/lib/app-install.ts.
// Собирается на лету: статичный public/manifest.webmanifest не знал бы
// настроек. Кэш короткий — Android сам перепроверяет манифест установленного
// приложения и подхватывает новую иконку и подпись. Описание — на языке из
// cookie, поэтому кэш только у браузера (private) и с учётом cookie.
export const Route = createFileRoute("/manifest.webmanifest")({
  server: {
    handlers: {
      GET: async () => {
        const locale = getRequestLocale();
        await loadDictionary(locale);
        const manifest = buildManifest(await fetchAppInstall(), getTranslator(locale));
        return new Response(JSON.stringify(manifest), {
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "private, max-age=300",
            vary: "cookie",
          },
        });
      },
    },
  },
});
