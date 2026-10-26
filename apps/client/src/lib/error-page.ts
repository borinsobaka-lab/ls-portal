import { type Locale, LOCALE_COOKIE, parseLocale } from "@/i18n/locales";

/**
 * Тексты страницы 500 на трёх языках — прямо здесь, а не в словарях: страница
 * собирается синхронно, когда SSR уже упал, и подгружать словарь (чанк)
 * в этот момент ненадёжно.
 */
const TEXTS: Record<Locale, { title: string; body: string; retry: string; home: string }> = {
  en: {
    title: "This page didn't load",
    body: "Something went wrong on our end. You can try refreshing or head back home.",
    retry: "Try again",
    home: "Go home",
  },
  ka: {
    title: "გვერდი ვერ ჩაიტვირთა",
    body: "რაღაც შეცდომა მოხდა ჩვენს მხარეს. სცადეთ გვერდის განახლება ან დაბრუნდით მთავარზე.",
    retry: "ხელახლა ცდა",
    home: "მთავარზე",
  },
  ru: {
    title: "Страница не загрузилась",
    body: "Что-то пошло не так. Попробуйте обновить или вернуться на главную.",
    retry: "Попробовать снова",
    home: "На главную",
  },
};

/** Язык из cookie запроса (как у приложения); без запроса — по умолчанию. */
function requestLocale(request?: Request): Locale {
  const cookie = request?.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  let value: string | null = null;
  try {
    value = match ? decodeURIComponent(match[1]) : null;
  } catch {
    value = null;
  }
  return parseLocale(value);
}

/**
 * Серверная страница 500. Язык — из cookie запроса, если его передали
 * (renderErrorPage(request)); иначе — английский (язык по умолчанию).
 */
export function renderErrorPage(request?: Request): string {
  const locale = requestLocale(request);
  const text = TEXTS[locale];
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <title>${text.title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; border-color: #d1d5db; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${text.title}</h1>
      <p>${text.body}</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">${text.retry}</button>
        <a class="secondary" href="/">${text.home}</a>
      </div>
    </div>
  </body>
</html>`;
}
