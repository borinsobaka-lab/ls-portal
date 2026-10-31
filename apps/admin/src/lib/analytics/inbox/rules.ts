/**
 * «Диалоги VK» — правила их vk_inbox.py без сети и базы (их разбор ID группы,
 * события Callback API, ответа groups.getById и users.get, проверка самого
 * раннего сообщения переписки). Python-приведения (int(), bool(), str())
 * повторены как у них: от них зависит, какое событие VK примется, а какое
 * получит «error».
 */

export const INBOX_BRANDS = ["Lady Stretch", "Lady Jump"] as const;
export type InboxBrand = (typeof INBOX_BRANDS)[number];

/** Их MAX_CALLBACK_BYTES: событие VK больше — «error». */
export const INBOX_MAX_CALLBACK_BYTES = 512_000;
export const VK_API_VERSION = "5.199";
/** Их users.get: до 500 ID за запрос, до 500 диалогов за проход. */
export const INBOX_PROFILES_BATCH = 500;
/** Их refresh_first_message_dates: до 100 диалогов, пауза 0,4 с между запросами. */
export const INBOX_FIRST_BATCH = 100;
export const INBOX_FIRST_PAUSE_MS = 400;
/** Их _history_group_retry: VK не ответил — сообщество ждёт час. */
export const INBOX_FIRST_GROUP_RETRY_MS = 60 * 60 * 1000;

export const INBOX_TEXT = {
  badId: "Укажите числовой ID группы VK или ссылку вида vk.ru/public123456.",
  idTooLarge: "ID группы VK слишком большой — проверьте group_id.",
  badShortName: "Укажите ID группы или ссылку VK, например vk.ru/ladystretch_penza.",
  needToken: "Вставьте токен сообщества, чтобы проверить ссылку VK.",
  resolveNetwork: "Не удалось проверить ссылку VK. Повторите позже или укажите числовой ID группы.",
  resolveVk: (m: string) => "VK не подтвердил группу: " + m,
  resolveNoGroup: "VK не вернул данные группы по указанной ссылке.",
  requiredFields: "Заполните название группы, город, строку подтверждения VK и токен сообщений.",
  secretLength: "Вставьте текущий секретный ключ Callback API из VK.",
  badEvent: "Некорректный формат события VK.",
  vkNetwork: "Не удалось отправить сообщение в VK. Повторите позже.",
  vkError: (m: string) => "VK не отправил сообщение: " + m,
  noHistory: "VK не вернул начало истории.",
  noFirst: "VK не вернул первое сообщение.",
  notConfirmed: "Не удалось подтвердить первое сообщение VK.",
  laterThanLocal: "Начало истории VK позже сохранённой переписки.",
  noLocal: "Нет сохранённых сообщений для сверки.",
};

/** Их InboxError: текст для человека. */
export class InboxError extends Error {}
class InboxIdTooLarge extends InboxError {}

type Dict = Record<string, unknown>;
export const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Python int(): число (дробь — к нулю), bool, строка из цифр; иначе — ошибка. */
export function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("int");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(v);
    if (!m) throw new TypeError("int");
    const n = Number(m[2].replace(/_/g, ""));
    return m[1] === "-" ? -n : n;
  }
  throw new TypeError("int");
}

/** Python bool(): пустые строки, списки, словари, 0 и None — ложь. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python str() для значений JSON. */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** dict.get(key, default) */
const get = (d: Dict, key: string, def: unknown) => (key in d ? d[key] : def);

/** Их normalize_vk_community_id: число, «public123» или «club123». */
export function normalizeVkCommunityId(value: string): number {
  let source = value.trim().replace(/^-+/, "");
  const m = /(?:public|club)(\d+)(?:$|[/?#])/i.exec(source);
  if (m) source = m[1];
  if (!/^\d{1,20}$/.test(source)) throw new InboxError(INBOX_TEXT.badId);
  const n = Number(source);
  // У них такой ID проходил и падал при записи в базу (bigint).
  if (!Number.isSafeInteger(n)) throw new InboxIdTooLarge(INBOX_TEXT.idTooLarge);
  return n;
}

/**
 * Их resolve_vk_community до запроса: числовой ID — сразу, иначе — короткий
 * адрес группы (vk.ru/ladystretch_penza) для groups.getById.
 */
export function vkCommunityRef(
  value: string,
  token: string,
): { id: number } | { shortName: string } {
  try {
    return { id: normalizeVkCommunityId(value) };
  } catch (e) {
    if (!(e instanceof InboxError) || e instanceof InboxIdTooLarge) throw e;
  }
  const raw = value.trim().replace(/\/+$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:vk\.ru|vk\.com)\/([A-Za-z0-9_.-]+)(?:[/?#].*)?$/i.exec(
    raw,
  );
  const shortName = m ? m[1] : raw;
  if (!/^[A-Za-z0-9_.-]{2,80}$/.test(shortName)) throw new InboxError(INBOX_TEXT.badShortName);
  if (!token.trim()) throw new InboxError(INBOX_TEXT.needToken);
  return { shortName };
}

/** Их разбор ответа groups.getById (v5.199 — {groups: […]}, раньше — список). */
export function vkGroupFromResponse(result: unknown): { id: number; name: string } {
  if (isDict(result) && pyTruthy(result.error)) {
    const err = result.error;
    const msg = isDict(err)
      ? pyStr(get(err, "error_msg", "неизвестная ошибка"))
      : "неизвестная ошибка";
    throw new InboxError(INBOX_TEXT.resolveVk(msg));
  }
  const data = isDict(result) ? result.response : undefined;
  let group: unknown;
  if (isDict(data) && Array.isArray(data.groups)) group = data.groups[0] ?? null;
  else group = Array.isArray(data) && data.length ? data[0] : data;
  try {
    if (!isDict(group) || !("id" in group)) throw new TypeError("group");
    return { id: pyInt(group.id), name: pyStr(get(group, "name", "")) };
  } catch {
    throw new InboxError(INBOX_TEXT.resolveNoGroup);
  }
}

/** Их правило: название из VK, если введённое отличается (без регистра). */
export function inboxDisplayName(entered: string, vkName: string): string {
  return vkName && entered.toLowerCase() !== vkName.toLowerCase() ? vkName : entered;
}

/** Сообщение события, разобранное как у их _store_message. */
export type InboxMessage = {
  peer_id: number;
  id: number;
  date: number;
  from_id: number | null;
  out: boolean;
  conversation_message_id: number | null;
  text: string;
  raw: Dict;
};

export type InboxCallback = {
  type: string;
  /** Секрет из события ('' — нет): сервер сравнивает его SHA-256. */
  secret: string;
  message: InboxMessage | null;
};

/**
 * Их handle_callback до базы: тип, секрет и сообщение (message_new /
 * message_reply / message_edit). Без peer_id или id сообщение пропускается
 * (ответ — 'ok'), непонятные date / from_id — ошибка, как у них.
 */
export function inboxCallbackParse(payload: unknown, nowSeconds: number): InboxCallback {
  if (!isDict(payload)) throw new InboxError(INBOX_TEXT.badEvent);
  const type = pyStr(get(payload, "type", ""));
  const secret = pyStr(get(payload, "secret", ""));
  let message: InboxMessage | null = null;
  if (type === "message_new" || type === "message_reply" || type === "message_edit") {
    const obj = payload.object;
    const raw = isDict(obj) ? get(obj, "message", obj) : null;
    if (isDict(raw)) message = inboxMessageParse(raw, nowSeconds);
  }
  return { type, secret, message };
}

function inboxMessageParse(m: Dict, nowSeconds: number): InboxMessage | null {
  let peer: number;
  let id: number;
  try {
    if (!("peer_id" in m) || !("id" in m)) return null;
    peer = pyInt(m.peer_id);
    id = pyInt(m.id);
  } catch {
    return null;
  }
  const bad = () => new InboxError(INBOX_TEXT.badEvent);
  let date: number;
  let from: number;
  let conv: number | null = null;
  try {
    date = pyInt(pyTruthy(m.date) ? m.date : Math.trunc(nowSeconds));
    from = pyInt(pyTruthy(m.from_id) ? m.from_id : 0);
    if (m.conversation_message_id !== undefined && m.conversation_message_id !== null)
      conv = pyInt(m.conversation_message_id);
  } catch {
    throw bad();
  }
  return {
    peer_id: peer,
    id,
    date,
    from_id: from || null,
    out: pyTruthy(m.out),
    conversation_message_id: conv,
    text: pyStr(get(m, "text", "")),
    raw: m,
  };
}

/** Их _vk_request: ответ VK или ошибка с их текстом. */
export function vkMethodResponse(payload: unknown): unknown {
  if (!isDict(payload) || pyTruthy(payload.error)) {
    const err = isDict(payload) ? payload.error : undefined;
    const msg = isDict(err)
      ? pyStr(get(err, "error_msg", "неизвестная ошибка"))
      : "неизвестная ошибка";
    throw new InboxError(INBOX_TEXT.vkError(msg));
  }
  return payload.response;
}

/** Их first_history_timestamp: самое раннее сообщение VK, не позже сохранённых. */
export function firstHistoryTimestamp(payload: unknown, peerId: number, oldestLocal: Date): Date {
  const isInt = (v: unknown) => typeof v === "boolean" || Number.isInteger(v);
  if (!isDict(payload) || !isInt(payload.count) || Number(payload.count) < 1)
    throw new InboxError(INBOX_TEXT.noHistory);
  const items = payload.items;
  if (!Array.isArray(items) || items.length !== 1 || !isDict(items[0]))
    throw new InboxError(INBOX_TEXT.noFirst);
  const item = items[0];
  const peer = typeof item.peer_id === "boolean" ? Number(item.peer_id) : item.peer_id;
  if (peer !== peerId || !isInt(item.date) || Number(item.date) <= 0 || pyTruthy(item.action))
    throw new InboxError(INBOX_TEXT.notConfirmed);
  const stamp = new Date(Number(item.date) * 1000);
  if (stamp > oldestLocal) throw new InboxError(INBOX_TEXT.laterThanLocal);
  return stamp;
}

export type InboxProfileCandidate = {
  id: number;
  customer_vk_id: number;
  community_id: number;
  has_name: boolean;
  has_avatar: boolean;
};

/**
 * Их refresh_missing_customer_profiles: ответ users.get → имена и аватарки
 * для диалогов пачки (только https-аватарки; только пустые поля).
 */
export function inboxProfileUpdates(
  response: unknown,
  batch: InboxProfileCandidate[],
): { id: number; name: string; avatar: string }[] {
  const users = isDict(response) ? get(response, "items", []) : response;
  if (!Array.isArray(users)) return [];
  const byId = new Map<number, Dict>();
  for (const u of users) {
    if (!isDict(u)) continue;
    const raw = pyStr(get(u, "id", ""));
    if (!/^\d+$/.test(raw)) continue;
    byId.set(Number(raw), u);
  }
  const out: { id: number; name: string; avatar: string }[] = [];
  for (const c of batch) {
    const p = byId.get(c.customer_vk_id);
    if (!p) continue;
    const name = [pyStr(get(p, "first_name", "")).trim(), pyStr(get(p, "last_name", "")).trim()]
      .filter(Boolean)
      .join(" ")
      .trim();
    let avatar = pyStr(get(p, "photo_100", "")).trim();
    if (!avatar.startsWith("https://")) avatar = "";
    if ((name && !c.has_name) || (avatar && !c.has_avatar)) out.push({ id: c.id, name, avatar });
  }
  return out;
}

/** Их save_callback_secret: секрет из VK — 16–256 знаков. */
export function inboxSecretValid(secret: string): boolean {
  const v = secret.trim();
  return v.length >= 16 && v.length <= 256;
}

/** Адрес Callback API подключения на портале. */
export const inboxCallbackUrl = (origin: string, id: number) =>
  `${origin.replace(/\/+$/, "")}/api/analytics/vk-callback/${id}`;

// --- Ответ из портала (их send_operator_message и загрузка фото) ---

/** Их MAX_INBOX_IMAGES / MAX_INBOX_IMAGE_BYTES; поле ответа в форме — 4000 знаков. */
export const INBOX_MAX_IMAGES = 4;
export const INBOX_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const INBOX_REPLY_MAX = 4000;
export const INBOX_VK_TEXT_MAX = 4096;

export const INBOX_SEND_TEXT = {
  images: "Можно отправить до 4 картинок общим размером до 8 МБ.",
  imageType: "Выберите картинки в формате JPG или PNG.",
  empty: "Введите текст сообщения или выберите картинку.",
  tooLong: "Сообщение VK не может быть длиннее 4096 символов.",
  formTooLarge: "Размер картинок не должен превышать 8 МБ.",
  fieldTooLong: "Слишком длинное поле формы.",
  badUploadUrl: "VK вернул недопустимый адрес загрузки. Сообщение не отправлено.",
  missingFile: "VK не нашёл файл в запросе (код 4606). Сообщение не отправлено.",
  uploadHttp: (status: number, code: number | null) =>
    `VK отклонил загрузку картинки (HTTP ${status}${code ? `, код VK ${code}` : ""}). Сообщение не отправлено.`,
  uploadNetwork:
    "Нет связи с сервером загрузки VK или истекло время ожидания. Сообщение не отправлено.",
  uploadTooLarge: "VK вернул слишком большой ответ загрузки. Сообщение не отправлено.",
  uploadNotJson:
    "Сервер загрузки VK вернул ответ вместо подтверждения картинки. Сообщение не отправлено.",
  uploadNotDict: "VK вернул некорректный ответ загрузки. Сообщение не отправлено.",
  uploadRejected: (code: number | null) =>
    `VK отклонил картинку${code ? ` (код VK ${code})` : ""}. Сообщение не отправлено.`,
  uploadFiles: "VK вернул неподдерживаемый формат загрузки фото. Сообщение не отправлено.",
  uploadNotConfirmed: "VK не подтвердил загрузку картинки. Сообщение не отправлено.",
  notSaved: "VK не сохранил картинку. Сообщение не отправлено.",
  photoIncomplete: "VK вернул неполные данные картинки.",
  badMessageId: "VK вернул некорректный идентификатор отправленного сообщения.",
  unconfirmed: "Не удалось подтвердить отправку. Проверьте историю диалога перед повтором.",
};

export type InboxImage = { name: string; data: Uint8Array; mime: string };

/** Их validate_reply_images: до 4 картинок, всего до 8 МБ, JPG или PNG по первым байтам. */
export function validateReplyImages(images: InboxImage[]): void {
  const total = images.reduce((s, i) => s + i.data.length, 0);
  if (images.length > INBOX_MAX_IMAGES || total > INBOX_MAX_IMAGE_BYTES)
    throw new InboxError(INBOX_SEND_TEXT.images);
  const starts = (d: Uint8Array, sig: number[]) => sig.every((b, i) => d[i] === b);
  for (const { data, mime } of images) {
    const ok =
      (mime === "image/png" && starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      (mime === "image/jpeg" && starts(data, [0xff, 0xd8, 0xff]));
    if (!ok) throw new InboxError(INBOX_SEND_TEXT.imageType);
  }
}

/** Их проверки текста до запросов VK: пусто без картинок, длиннее 4096. */
export function replyText(body: string, images: number): string {
  const text = body.trim();
  if (!text && !images) throw new InboxError(INBOX_SEND_TEXT.empty);
  if ([...text].length > INBOX_VK_TEXT_MAX) throw new InboxError(INBOX_SEND_TEXT.tooLong);
  return text;
}

const UPLOAD_DOMAINS = ["vk.com", "vk.ru", "vkuserphoto.ru", "userapi.com"];

/**
 * Их _validate_photo_upload_url: только https на 443 к серверам VK. `extra` —
 * адрес заглушки VK только для стенда.
 */
export function uploadUrlAllowed(url: string, extra?: string): boolean {
  if (extra && url.startsWith(extra.replace(/\/+$/, "") + "/")) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    (u.port === "" || u.port === "443") &&
    UPLOAD_DOMAINS.some((d) => host === d || host.endsWith("." + d))
  );
}

/** Их _upload_error_code: только число 1–99999 из error.error_code или error_code. */
export function uploadErrorCode(payload: unknown): number | null {
  if (!isDict(payload)) return null;
  const err = payload.error;
  const value = isDict(err) ? err.error_code : payload.error_code;
  try {
    const code = pyInt(value);
    return code > 0 && code < 100_000 ? code : null;
  } catch {
    return null;
  }
}

/** Их ответ сервера загрузки после HTTP 200: 4606 — повторить другим полем. */
export function uploadResult(
  raw: string | null,
): { ok: true; uploaded: Dict } | { ok: false; missing: boolean; error: string } {
  if (raw === null) return { ok: false, missing: false, error: INBOX_SEND_TEXT.uploadTooLarge };
  let uploaded: unknown;
  try {
    uploaded = JSON.parse(raw);
  } catch {
    return { ok: false, missing: false, error: INBOX_SEND_TEXT.uploadNotJson };
  }
  if (!isDict(uploaded)) return { ok: false, missing: false, error: INBOX_SEND_TEXT.uploadNotDict };
  const code = uploadErrorCode(uploaded);
  if (code === 4606) return { ok: false, missing: true, error: INBOX_SEND_TEXT.missingFile };
  if (code || pyTruthy(uploaded.error))
    return { ok: false, missing: false, error: INBOX_SEND_TEXT.uploadRejected(code) };
  return { ok: true, uploaded };
}

/** Их ответ сервера загрузки с ошибкой HTTP. */
export function uploadHttpError(status: number, body: string): { missing: boolean; error: string } {
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const code = uploadErrorCode(payload);
  if (code === 4606) return { missing: true, error: INBOX_SEND_TEXT.missingFile };
  return { missing: false, error: INBOX_SEND_TEXT.uploadHttp(status, code) };
}

/** Их проверка подтверждения загрузки: photo, server и hash. */
export function uploadedPhotoParams(uploaded: Dict): Record<string, string> {
  if (!["photo", "server", "hash"].every((k) => pyTruthy(uploaded[k]))) {
    throw new InboxError(
      isDict(uploaded.files) ? INBOX_SEND_TEXT.uploadFiles : INBOX_SEND_TEXT.uploadNotConfirmed,
    );
  }
  return {
    photo: pyStr(uploaded.photo),
    server: pyStr(uploaded.server),
    hash: pyStr(uploaded.hash),
  };
}

/** Их проверка photos.saveMessagesPhoto: первая картинка с owner_id и id. */
export function savedPhoto(saved: unknown): Dict {
  if (!Array.isArray(saved) || !saved.length || !isDict(saved[0]))
    throw new InboxError(INBOX_SEND_TEXT.notSaved);
  const photo = saved[0];
  try {
    if (!("owner_id" in photo) || !("id" in photo)) throw new TypeError();
    pyInt(photo.owner_id);
    pyInt(photo.id);
  } catch {
    throw new InboxError(INBOX_SEND_TEXT.photoIncomplete);
  }
  return photo;
}

/** Их вложение messages.send: photo<owner>_<id>[_<access_key>]. */
export const photoAttachment = (p: Dict) =>
  `photo${pyInt(p.owner_id)}_${pyInt(p.id)}` +
  (pyTruthy(p.access_key) ? "_" + pyStr(p.access_key) : "");

/** Их id отправленного сообщения — int(ответ messages.send). */
export function sentMessageId(response: unknown): number {
  try {
    if (response === null || response === undefined || isDict(response) || Array.isArray(response))
      throw new TypeError();
    return pyInt(response);
  } catch {
    throw new InboxError(INBOX_SEND_TEXT.badMessageId);
  }
}

// --- Очередь и переписка (их страница /admin/vk-inbox) ---

/** Имя клиента: введённое или «VK ID …». */
export const inboxCustomerName = (d: {
  customer_name: string | null;
  customer_vk_id: number | null;
  peer_id: number;
}) => (d.customer_name ?? "").trim() || `VK ID ${d.customer_vk_id || d.peer_id}`;

/** Их превью в очереди: без переносов, 86 знаков. */
export const inboxPreview = (body: string | null) =>
  [...(body || "Вложение или служебное сообщение").replace(/\n/g, " ")].slice(0, 86).join("");

const MSK_SHORT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Их format_inbox_timestamp: «дд.мм чч:мм» по Москве, пусто — «—». */
export function inboxTime(value: string | null | undefined): string {
  if (!value) return "—";
  const p = Object.fromEntries(
    MSK_SHORT.formatToParts(new Date(value)).map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** Их смайлики окна ответа (три раздела). */
export const INBOX_EMOJI: [string, string[]][] = [
  [
    "Лица",
    [
      "😀",
      "😃",
      "😄",
      "😁",
      "😊",
      "☺️",
      "🙂",
      "😉",
      "😍",
      "🥰",
      "😘",
      "😎",
      "🤩",
      "🥳",
      "😂",
      "🤣",
      "😅",
      "😇",
      "🤗",
      "🤔",
      "😌",
      "😴",
      "😔",
      "🥺",
      "😢",
      "😭",
      "😮",
      "😱",
      "😤",
      "🙃",
      "😋",
      "😏",
    ],
  ],
  [
    "Жесты",
    [
      "👋",
      "🤚",
      "✋",
      "👌",
      "✌️",
      "🤞",
      "👍",
      "👎",
      "👏",
      "🙌",
      "👐",
      "🤝",
      "🙏",
      "💪",
      "🤟",
      "🫶",
      "☝️",
      "👇",
      "👈",
      "👉",
      "✍️",
      "🤲",
      "💃",
      "🏃",
      "🧘",
      "🤸",
      "🏋️",
      "🤍",
    ],
  ],
  [
    "Сердца",
    [
      "💜",
      "❤️",
      "🩷",
      "💖",
      "💗",
      "💕",
      "💞",
      "💝",
      "💘",
      "🤍",
      "🧡",
      "💛",
      "💚",
      "💙",
      "🖤",
      "✨",
      "⭐",
      "🌟",
      "💫",
      "🔥",
      "🌸",
      "🌷",
      "🌹",
      "🌺",
      "🎉",
      "🎊",
      "🎁",
      "🎀",
      "☀️",
      "🌈",
      "✅",
      "💯",
    ],
  ],
];

/** Их вставка шаблона или смайлика в место курсора с проверкой длины поля. */
export function insertAt(
  value: string,
  start: number,
  end: number,
  insert: string,
  max = INBOX_REPLY_MAX,
): { value: string; caret: number } | null {
  if (value.length - (end - start) + insert.length > max) return null;
  return { value: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length };
}
