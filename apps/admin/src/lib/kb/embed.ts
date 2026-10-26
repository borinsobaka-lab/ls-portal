/**
 * Видео с внешних сервисов в статье (блок «embed», components/kb/kb-document.tsx):
 * из того, что вставил автор (ссылка или код <iframe>), — адрес плеера для
 * встраивания. Без React — тесты рядом.
 */

export type KbEmbedProvider = "rutube" | "kinescope" | "vk" | "iframe";

export const KB_EMBED_PROVIDERS: KbEmbedProvider[] = ["rutube", "kinescope", "vk", "iframe"];

export const KB_EMBED_LABEL: Record<KbEmbedProvider, string> = {
  rutube: "RuTube",
  kinescope: "Kinescope",
  vk: "VK Видео",
  iframe: "iframe",
};

/** Название блока — в меню «/» и окне ссылки. */
export const KB_EMBED_TITLE: Record<KbEmbedProvider, string> = {
  rutube: "Видео RuTube",
  kinescope: "Видео Kinescope",
  vk: "VK Видео",
  iframe: "Видео по коду iframe",
};

/** Что вставить в блок — показывается в окне ссылки. */
export const KB_EMBED_HINT: Record<KbEmbedProvider, { lines: string[]; example: string }> = {
  rutube: {
    lines: [
      "Ссылка на видео: из адресной строки или «Поделиться» → «Скопировать ссылку» под видео. Подойдёт и код из «Поделиться» → «Код для вставки».",
      "Закрытое видео («Доступ по ссылке») — тоже: ссылка вида rutube.ru/video/private/…/?p=… — ключ после p= сохранится.",
      "Видео не должно быть удалено или скрыто «Только для меня».",
    ],
    example: "https://rutube.ru/video/0123456789abcdef0123456789abcdef/",
  },
  kinescope: {
    lines: [
      "Ссылка на видео из Kinescope: видео → «Поделиться» → «Ссылка» или код для вставки (<iframe …>).",
      "Если у проекта Kinescope включены разрешённые домены — добавьте туда адрес портала, иначе плеер покажет ошибку.",
    ],
    example: "https://kinescope.io/XXXXXXXXXXXXXXXXXXXXXX",
  },
  vk: {
    lines: [
      "Надёжнее всего — код для вставки: под видео «Поделиться» → «Экспортировать» (или «Код для вставки») → скопировать <iframe …>.",
      "Подойдёт и ссылка на видео (vkvideo.ru или vk.com), но без кода для вставки часть видео (из закрытых сообществ, с ограничениями) не воспроизведётся.",
      "Видео должно быть открытым для всех.",
    ],
    example: "https://vkvideo.ru/video-123456789_456239017",
  },
  iframe: {
    lines: [
      'Код для вставки <iframe src="https://…"></iframe> или адрес плеера для встраивания с любого сервиса — Vimeo, Яндекс Диск, Google Диск и т. п.',
      "Нужен именно адрес для встраивания (обычно в «Поделиться» → «Код для вставки»): обычная страница сайта внутри статьи чаще всего не покажется.",
      "Ссылки RuTube, Kinescope и VK Видео распознаются сами.",
    ],
    example: '<iframe src="https://player.vimeo.com/video/…"></iframe>',
  },
};

export type KbEmbedResult = { provider: KbEmbedProvider; src: string } | { error: string };

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Ссылка из вставленного: из кода <iframe> — его src, иначе текст как есть. */
function extractUrl(raw: string): URL | null {
  let text = raw.trim();
  if (/<iframe/i.test(text)) {
    const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(text);
    if (!m) return null;
    text = decodeEntities(m[1].trim());
  }
  if (text.startsWith("//")) text = `https:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^(www|m)\./, "");

const RUTUBE_ID = /^[a-f0-9]{32}$/i;

/**
 * RuTube: rutube.ru/video/<id>/, /shorts/<id>/, закрытое /video/private/<id>/?p=<ключ>,
 * встраивание /play/embed/<id> — в плеер /play/embed/<id>/ (ключ и время — как были).
 */
function rutube(u: URL): string | null {
  if (host(u) !== "rutube.ru") return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const id = seg.find((x) => RUTUBE_ID.test(x));
  const kind = seg[0] === "play" ? seg[1] : seg[0];
  if (!id || !["video", "shorts", "embed"].includes(kind ?? "")) return null;
  const p = new URLSearchParams();
  const key = u.searchParams.get("p");
  if (key) p.set("p", key);
  const t = u.searchParams.get("t");
  if (t && /^\d+$/.test(t)) p.set("t", t);
  const q = p.toString();
  return `https://rutube.ru/play/embed/${id.toLowerCase()}/${q ? `?${q}` : ""}`;
}

function kinescope(u: URL): string | null {
  const h = host(u);
  if (h !== "kinescope.io" && !h.endsWith(".kinescope.io")) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const id = seg[0] === "embed" ? seg[1] : seg[seg.length - 1];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || id === "embed") return null;
  return `https://kinescope.io/embed/${id}${u.search}`;
}

const VK_HOSTS = ["vk.com", "vk.ru", "vkvideo.ru"];

function vk(u: URL): string | null {
  if (!VK_HOSTS.includes(host(u))) return null;
  if (u.pathname === "/video_ext.php") {
    const oid = u.searchParams.get("oid");
    const id = u.searchParams.get("id");
    if (!oid || !id || !/^-?\d+$/.test(oid) || !/^\d+$/.test(id)) return null;
    const p = new URLSearchParams({ oid, id });
    const hash = u.searchParams.get("hash");
    if (hash) p.set("hash", hash);
    p.set("hd", u.searchParams.get("hd") ?? "2");
    const t = u.searchParams.get("t");
    if (t) p.set("t", t);
    return `https://vkvideo.ru/video_ext.php?${p.toString()}`;
  }
  // video-123_456 в пути или в ?z=video-123_456/… (видео открыто поверх ленты).
  const where = `${u.pathname} ${u.searchParams.get("z") ?? ""}`;
  const m = /(?:video|clip)(-?\d+)_(\d+)/.exec(where);
  if (!m) return null;
  return `https://vkvideo.ru/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2`;
}

const PARSERS: [Exclude<KbEmbedProvider, "iframe">, (u: URL) => string | null][] = [
  ["rutube", rutube],
  ["kinescope", kinescope],
  ["vk", vk],
];

/**
 * Адрес плеера из вставленного автором. Ссылку известного сервиса узнаём
 * при любом выбранном блоке (вставили RuTube в «iframe» — встанет RuTube);
 * `iframe` — любой https-адрес, кроме самого портала (`ownOrigin`).
 */
export function parseKbEmbed(
  provider: KbEmbedProvider,
  raw: string,
  ownOrigin?: string,
): KbEmbedResult {
  if (!raw.trim()) return { error: "Вставьте ссылку или код для вставки." };
  const u = extractUrl(raw);
  if (!u) return { error: "Не похоже на ссылку или код <iframe>." };
  for (const [p, parse] of PARSERS) {
    const src = parse(u);
    if (src) return { provider: p, src };
  }
  if (provider !== "iframe") {
    return {
      error: `Не получилось найти видео ${KB_EMBED_LABEL[provider]} в этой ссылке. Пример: ${KB_EMBED_HINT[provider].example}`,
    };
  }
  if (u.protocol !== "https:") return { error: "Нужен адрес, начинающийся с https://" };
  if (ownOrigin && u.origin === ownOrigin) {
    return { error: "Страницу самого портала встроить нельзя." };
  }
  return { provider: "iframe", src: u.toString() };
}
