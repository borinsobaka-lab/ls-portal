/**
 * Текст сообщения чата: документ редактора (ProseMirror JSON) → чистый
 * текст для поиска и превью, проверка ссылок, системные сообщения, подписи.
 * Без React и без запросов — тесты в content.test.ts.
 */
import { STATUS_LABEL } from "@/lib/tasks/logic";
import type { TaskStatus } from "@/lib/tasks/types";
import { callSystemText } from "./call-logic";
import type {
  ChatDoc,
  ChatMessage,
  ChatNode,
  ChatNotify,
  ChatPreview,
  ChatRow,
  ChatSource,
  ChatSystem,
} from "./types";

/** Узлы и отметки, которые показывает чат (остальное из вставки — как текст). */
export const BLOCK_NODES = new Set([
  "doc",
  "paragraph",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "hardBreak",
  "text",
  "mention",
]);
export const MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link"]);

/** Чистый текст документа: абзацы и пункты — с новой строки, упоминания — «@Имя». */
export function docText(doc: ChatNode | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  const walk = (node: ChatNode, prefix = "") => {
    switch (node.type) {
      case "text":
        out.push(node.text ?? "");
        return;
      case "mention":
        out.push(`@${String(node.attrs?.label ?? "")}`);
        return;
      case "hardBreak":
        out.push("\n");
        return;
      case "paragraph":
        out.push(prefix);
        node.content?.forEach((c) => walk(c));
        out.push("\n");
        return;
      case "bulletList":
      case "orderedList":
        node.content?.forEach((item, i) =>
          item.content?.forEach((c, j) =>
            walk(c, j === 0 ? (node.type === "bulletList" ? "• " : `${i + 1}. `) : "   "),
          ),
        );
        return;
      case "blockquote":
        node.content?.forEach((c) => walk(c, "> "));
        return;
      default:
        node.content?.forEach((c) => walk(c, prefix));
    }
  };
  walk(doc);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Документ из обычного текста (пересланное без документа, старые данные). */
export function textDoc(text: string): ChatDoc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

/** Упомянутые: id из узлов mention (uuid или «all»). */
export function docMentions(doc: ChatNode | null | undefined): string[] {
  const ids = new Set<string>();
  const walk = (node: ChatNode) => {
    if (node.type === "mention" && typeof node.attrs?.id === "string") ids.add(node.attrs.id);
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return [...ids];
}

/** Безопасная ссылка: http(s), mailto, tel и пути портала; иначе null. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}

/** Ссылки в обычном тексте — для подсветки в превью и вкладки «Ссылки». */
export const URL_RE = /https?:\/\/[^\s<>"«»]+/g;

/** Имя чата: группа — название, личный — собеседник, «Избранное». */
export function chatTitle(
  chat: Pick<ChatRow, "kind" | "title" | "peer_id">,
  name: (id: string) => string,
) {
  if (chat.kind === "self") return "Избранное";
  if (chat.kind === "group") return chat.title ?? "Группа";
  if (chat.kind === "task") return chat.title ?? "Задача";
  if (chat.kind === "project") return chat.title ?? "Проект";
  if (chat.kind === "event") return chat.title ?? "Встреча";
  if (chat.kind === "topic") return chat.title ?? "Тема";
  return chat.peer_id ? name(chat.peer_id) : "Удалённый собеседник";
}

/** Текст системного сообщения группы. */
export function systemText(
  system: ChatSystem | null | undefined,
  actor: string | null,
  name: (id: string) => string,
): string {
  if (!system) return "";
  const who = actor ? name(actor) : "Кто-то";
  const users = (system.users ?? []).map(name).join(", ");
  switch (system.type) {
    case "created":
      return `${who} создал(а) группу «${system.title ?? ""}»`;
    case "added":
      return `${who} добавил(а): ${users}`;
    case "removed":
      return `${who} исключил(а): ${users}`;
    case "left":
      return `${users || who} вышел(а) из группы`;
    case "renamed":
      return `${who} переименовал(а) группу в «${system.title ?? ""}»`;
    case "channel_created":
      return `${who} создал(а) канал «${system.title ?? ""}»`;
    case "project_created":
      return `${who} создал(а) проект «${system.title ?? ""}»`;
    case "task_chat":
      return `${who} начал(а) обсуждение задачи`;
    case "event_chat":
      return `${who} начал(а) обсуждение встречи`;
    case "topics_on":
      return `${who} включил(а) темы`;
    case "topics_off":
      return `${who} выключил(а) темы`;
    case "topic_created":
      return `${who} создал(а) тему «${system.title ?? ""}»`;
    case "topic_renamed":
      return `${who} переименовал(а) тему в «${system.title ?? ""}»`;
    case "topic_closed":
      return `${who} закрыл(а) тему`;
    case "topic_reopened":
      return `${who} открыл(а) тему снова`;
    case "task_status":
      return `${who}: статус задачи — ${(STATUS_LABEL[system.title as TaskStatus] ?? system.title ?? "").toLowerCase()}`;
    case "call":
      return callSystemText({ ...system, type: "call" }, who);
    case "task_created":
      return taskCreatedText(system, who);
    default:
      return "";
  }
}

/** Источник состава чата: «Вся компания», «Отдел развития — все, с подразделениями ниже». */
export function sourceText(s: ChatSource): string {
  if (s.kind === "all") return "Вся компания — все сотрудники";
  const who = s.scope === "heads" ? "руководители и заместители" : "все сотрудники";
  return `${s.unit_name ?? "Подразделение"} — ${who}${s.with_subunits ? ", с подразделениями ниже" : ""}`;
}

// ---- Отложенные сообщения ---------------------------------------------------------

const at = (base: Date, days: number, h: number, m = 0) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
};

/** Быстрые варианты «Отправить позже» (время браузера). */
export function scheduleOptions(now: Date): { label: string; at: Date }[] {
  const hour = new Date(now.getTime() + 60 * 60_000);
  hour.setMinutes(Math.ceil(hour.getMinutes() / 5) * 5, 0, 0);
  const out = [
    { label: `Через час, в ${pad(hour.getHours())}:${pad(hour.getMinutes())}`, at: hour },
  ];
  if (now.getHours() < 17) out.push({ label: "Сегодня в 18:00", at: at(now, 0, 18) });
  out.push({ label: "Завтра в 9:00", at: at(now, 1, 9) });
  // Ближайший понедельник (не завтрашний — он уже есть).
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) out.push({ label: "В понедельник в 9:00", at: at(now, toMonday, 9) });
  return out;
}

/** «сегодня в 18:00», «завтра в 09:00», «пн, 10 нояб. в 09:00». */
export function scheduledLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  const wd = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.getDay()];
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${wd}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${year} в ${time}`;
}

/** Значение поля datetime-local (время браузера). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «задачу» / «задачи» / «задач» после числа. */
export function tasksWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "задачу";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "задачи";
  return "задач";
}

/** «Анна поставил(а) задачу #12 «…»» / «… 3 задачи: #12, #13, #14». */
export function taskCreatedText(system: ChatSystem, who: string): string {
  const nums = system.numbers ?? [];
  const count = system.count ?? nums.length;
  if (count <= 1) return `${who} поставил(а) задачу #${nums[0] ?? ""} «${system.title ?? ""}»`;
  const list = nums.map((n) => `#${n}`).join(", ") + (count > nums.length ? "…" : "");
  return `${who} поставил(а) ${count} ${tasksWord(count)}: ${list}`;
}

/** «12:40», «вчера», «пн», «3 нояб.», «3 нояб. 2025» — время в списке чатов. */
export function chatTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000);
  if (diffDays === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diffDays === 1) return "вчера";
  if (diffDays < 7) return ["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.getDay()];
  const month = MONTHS_SHORT[d.getMonth()];
  return d.getFullYear() === now.getFullYear()
    ? `${d.getDate()} ${month}`
    : `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/** Разделитель дней в переписке: «Сегодня», «Вчера», «3 ноября», «3 ноября 2025». */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  const label = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS_SHORT = [
  "янв.",
  "февр.",
  "мар.",
  "апр.",
  "мая",
  "июн.",
  "июл.",
  "авг.",
  "сент.",
  "окт.",
  "нояб.",
  "дек.",
];
const MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** Совпадает ли чат с поиском по названию (слова по началу, ё = е). */
export function chatMatches(title: string, query: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hay = norm(title);
  return words.every((w) => hay.includes(w));
}

/** Фрагмент поиска «…текст ⟦найдено⟧ текст…» → куски для подсветки. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /⟦([^⟧]*)⟧/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

// ---- Без звука (одно правило для списка, шапки, тем и папок) ------------------------

type Mutable = Pick<ChatRow, "notify" | "muted_until">;

/**
 * Заглушен ли чат: уведомления не «все» (только упоминания или выключены) или
 * «без звука» до времени в будущем. Счётчик такого чата — серый и в общее
 * число не входит.
 */
export function isMuted(c: Mutable, now = new Date()): boolean {
  return c.notify !== "all" || (!!c.muted_until && new Date(c.muted_until) > now);
}

/** «Без звука» на время: до какого момента ещё тихо (null — не на время). */
export function mutedUntil(c: Mutable, now = new Date()): Date | null {
  if (!c.muted_until) return null;
  const d = new Date(c.muted_until);
  return d > now ? d : null;
}

export type MuteChoice = {
  key: "1h" | "8h" | "2d" | "forever";
  label: string;
  notify: ChatNotify;
  until: Date | null;
};

/**
 * Пункты подменю «Без звука» (как в Telegram). На время — уведомления те же,
 * что были («все» или «только упоминания»), плюс `muted_until`: время вышло —
 * звук вернулся сам, упоминания приходят и в тишине. «Навсегда» — уведомления
 * выключены (`none`), пока их не включат.
 */
export function muteOptions(current: ChatNotify, now = new Date()): MuteChoice[] {
  const notify: ChatNotify = current === "none" ? "all" : current;
  const after = (ms: number) => new Date(now.getTime() + ms);
  return [
    { key: "1h", label: "На 1 час", notify, until: after(3_600_000) },
    { key: "8h", label: "На 8 часов", notify, until: after(8 * 3_600_000) },
    { key: "2d", label: "На 2 дня", notify, until: after(2 * 86_400_000) },
    { key: "forever", label: "Навсегда", notify: "none", until: null },
  ];
}

/** Настройка «Уведомления: Все / Упоминания / Без звука» в сведениях чата. */
export function notifyChoice(c: Mutable, now = new Date()): ChatNotify {
  if (c.notify === "none" || mutedUntil(c, now)) return "none";
  return c.notify;
}

/** «до 18:40», «до завтра, 09:00», «до 12 нояб., 09:00». */
export function untilLabel(d: Date, now = new Date()): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `до ${time}`;
  if (diff === 1) return `до завтра, ${time}`;
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `до ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${year}, ${time}`;
}

/** Подпись значка «без звука»: «Без звука до 18:40», «Только упоминания». */
export function muteLabel(c: Mutable, now = new Date()): string {
  const until = mutedUntil(c, now);
  if (c.notify === "none") return "Без звука";
  if (until) return `Без звука ${untilLabel(until, now)}`;
  if (c.notify === "mentions") return "Только упоминания";
  return "";
}

// ---- Превью последнего сообщения ------------------------------------------------------

/**
 * Что показать в превью строки списка: последнее сообщение, а если оно
 * удалено — предыдущее из уже загруженной переписки (как в Telegram).
 * «Сообщение удалено» — только если другого под рукой нет.
 */
export function previewOf(last: ChatPreview, loaded: ChatMessage[] | undefined): ChatPreview {
  if (!last.deleted) return last;
  const prev = [...(loaded ?? [])]
    .reverse()
    .find((m) => m.seq < last.seq && !m.deleted && !m.id.startsWith("local:"));
  if (!prev) return last;
  return {
    seq: prev.seq,
    author_id: prev.author_id,
    kind: prev.kind,
    text: prev.text,
    forward: !!prev.forward,
    system:
      prev.kind === "system" ? ((prev.content as { system?: ChatSystem } | null)?.system ?? null) : null,
  };
}

/** Сколько непрочитанных показывать: 99+. */
export function unreadLabel(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Картинка или видео — в сетку медиа; остальное — карточкой файла. */
export function isMedia(mime: string | undefined): boolean {
  return /^(image|video)\//.test(mime ?? "");
}
export function isImage(mime: string | undefined): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mime ?? "");
}

/** Быстрые реакции — в меню сообщения. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🙏", "👀", "✅"];
