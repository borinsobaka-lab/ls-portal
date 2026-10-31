/**
 * «Контент» — правила их content.py и страниц /admin/content без сети и базы:
 * часовые пояса групп, проверки картинок формы, постоянный random_id поста,
 * тип файла при загрузке в VK, подписи статусов, локальное время публикации.
 */
export const CONTENT_BRANDS = ["Lady Stretch", "Lady Jump"] as const;

/** Их TIMEZONES и TIMEZONE_LABELS. */
export const CONTENT_TIMEZONES: [string, string][] = [
  ["Europe/Kaliningrad", "UTC+2 · МСК−1 · Калининград"],
  ["Europe/Moscow", "UTC+3 · МСК · Москва"],
  ["Europe/Samara", "UTC+4 · МСК+1 · Самара"],
  ["Asia/Yekaterinburg", "UTC+5 · МСК+2 · Екатеринбург"],
  ["Asia/Omsk", "UTC+6 · МСК+3 · Омск"],
  ["Asia/Novosibirsk", "UTC+7 · МСК+4 · Новосибирск"],
  ["Asia/Barnaul", "UTC+7 · МСК+4 · Барнаул"],
  ["Asia/Krasnoyarsk", "UTC+7 · МСК+4 · Красноярск"],
  ["Asia/Irkutsk", "UTC+8 · МСК+5 · Иркутск"],
  ["Asia/Yakutsk", "UTC+9 · МСК+6 · Якутск"],
  ["Asia/Vladivostok", "UTC+10 · МСК+7 · Владивосток"],
  ["Asia/Kamchatka", "UTC+12 · МСК+9 · Камчатка"],
];
export const contentZoneLabel = (zone: string) =>
  CONTENT_TIMEZONES.find(([z]) => z === zone)?.[1] ?? zone;

export const CONTENT_TEXT = {
  apiDown: (detail: string) => "VK API недоступен: " + detail,
  apiError: (method: string, msg: unknown, code: unknown) =>
    `VK API ${method}: ${msg ?? "неизвестная ошибка"} (код ${code ?? "—"}).`,
  apiIncomplete: "VK API вернул неполный ответ.",
  uploadFailed: (detail: string) => "Не удалось загрузить изображение в VK: " + detail,
  photoNotSaved: "VK не подтвердил сохранение изображения.",
  mediaTokenMissing:
    "Для поста с картинками добавьте в настройках токен пользователя VK для загрузки изображений.",
  mediaTokenBroken:
    "Не удалось расшифровать токен пользователя VK для картинок. Сохраните его заново.",
  mediaTokenEmpty: "Вставьте токен пользователя VK для загрузки картинок.",
  chooseGroup: "Выберите тестовую группу.",
};

/** Их MAX_CONTENT_IMAGES / MAX_CONTENT_MEDIA_BYTES. */
export const CONTENT_MAX_IMAGES = 10;
export const CONTENT_MAX_BYTES = 24 * 1024 * 1024;
const ALLOWED: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};

/** Их content_multipart_values: проверки картинок формы (до загрузки). */
export function contentImagesProblem(
  files: { name: string; size: number; type: string }[],
): string | null {
  if (files.length > CONTENT_MAX_IMAGES)
    return `К одному посту можно прикрепить не больше ${CONTENT_MAX_IMAGES} изображений.`;
  if (files.reduce((s, f) => s + f.size, 0) > CONTENT_MAX_BYTES)
    return "Общий размер изображений не должен превышать 24 МБ.";
  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    const suffix = dot > 0 ? f.name.slice(dot).toLowerCase() : "";
    if (!ALLOWED[f.type]?.includes(suffix))
      return "Можно прикрепить только изображения JPG, PNG, WEBP или GIF.";
    if (!f.size) return "Одно из изображений оказалось пустым.";
  }
  return null;
}

/** Их mimetypes.guess_type(имя) или тип файла. */
export function contentUploadType(filename: string, mime: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jpe: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return (filename.includes(".") && known[ext]) || mime || "application/octet-stream";
}

export const contentPostUrl = (groupId: string, postId: string) =>
  `https://vk.com/wall-${groupId}_${postId}`;

/** Их _render_body. */
export const contentRenderBody = (body: string, trial: string, schedule: string) =>
  body.replaceAll("{ссылка_на_пробное}", trial).replaceAll("{ссылка_на_расписание}", schedule);

/** Их status_labels. */
export const CONTENT_STATUS: Record<string, string> = {
  pending: "Ожидает",
  published: "Опубликован",
  error: "Ошибка",
  partial: "Частично",
};

/** Их время публикации в группе: «дд.мм чч:мм» в её часовом поясе. */
export function contentLocalTime(iso: string | null, zone: string): string {
  if (!iso) return "—";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: zone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}
