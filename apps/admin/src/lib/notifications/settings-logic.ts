/**
 * Чистая логика настроек уведомлений: часовые пояса России и подпись
 * устройства по user agent. Тесты — notifications.test.ts.
 */

/** Пояса России — от Калининграда до Камчатки (+ Тбилиси: портал начинался там). */
export const RU_TIMEZONES: { value: string; label: string }[] = [
  { value: "Europe/Kaliningrad", label: "Калининград (МСК−1)" },
  { value: "Europe/Moscow", label: "Москва (МСК)" },
  { value: "Europe/Samara", label: "Самара (МСК+1)" },
  { value: "Asia/Yekaterinburg", label: "Екатеринбург (МСК+2)" },
  { value: "Asia/Omsk", label: "Омск (МСК+3)" },
  { value: "Asia/Novosibirsk", label: "Новосибирск (МСК+4)" },
  { value: "Asia/Krasnoyarsk", label: "Красноярск (МСК+4)" },
  { value: "Asia/Irkutsk", label: "Иркутск (МСК+5)" },
  { value: "Asia/Yakutsk", label: "Якутск (МСК+6)" },
  { value: "Asia/Vladivostok", label: "Владивосток (МСК+7)" },
  { value: "Asia/Magadan", label: "Магадан (МСК+8)" },
  { value: "Asia/Kamchatka", label: "Камчатка (МСК+9)" },
  { value: "Asia/Tbilisi", label: "Тбилиси" },
];

export function timezoneLabel(tz: string): string {
  return RU_TIMEZONES.find((t) => t.value === tz)?.label ?? tz;
}

/** «Chrome · Windows», «Safari · iPhone» — для списка устройств. */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  if (!s) return "Устройство";
  const os = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Windows/.test(s)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(s)
            ? "Mac"
            : /Linux/.test(s)
              ? "Linux"
              : null;
  const browser = /YaBrowser/.test(s)
    ? "Яндекс Браузер"
    : /Edg\//.test(s)
      ? "Edge"
      : /OPR\//.test(s)
        ? "Opera"
        : /Firefox\//.test(s)
          ? "Firefox"
          : /Chrome\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : null;
  return [browser, os].filter(Boolean).join(" · ") || "Устройство";
}
