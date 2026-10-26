/**
 * Скрипты без React: поиск, выбор текста, переменные, копирование.
 *
 * Отдельно от компонентов, потому что это правила, а не вёрстка: какой
 * вариант показать, что делать с отсутствующим переводом, что считается
 * совпадением. Их легко сломать правкой разметки, если они в ней живут.
 * Перенесено из «Аудиоаналитики» (dashboard/src/scripts/logic.ts).
 */
import type {
  LangText,
  ScriptItem,
  ScriptItemDraft,
  ScriptKind,
  ScriptLang,
  ScriptMessage,
  ScriptSection,
  ScriptSettings,
  ScriptVariant,
} from "./types";

export const LANGS: { key: ScriptLang; label: string; name: string; inName: string }[] = [
  { key: "ru", label: "RU", name: "русский", inName: "русском" },
  { key: "en", label: "EN", name: "английский", inName: "английском" },
  // В документе и в речи администраторов — «GE», не ISO-шное «KA».
  { key: "ka", label: "GE", name: "грузинский", inName: "грузинском" },
];

export const KIND_LABELS: Record<ScriptKind, string> = {
  chat: "Чат",
  call: "Звонок",
  task: "Задача",
  info: "Справка",
};

export function langInfo(lang: ScriptLang) {
  return LANGS.find((l) => l.key === lang) ?? LANGS[0];
}

export function isLang(value: unknown): value is ScriptLang {
  return value === "ru" || value === "en" || value === "ka";
}

/**
 * Строка для сравнения: регистр и «ё» не должны мешать найти «ещё».
 * Посимвольно и с сохранением длины: по индексам совпадений в нормальной
 * строке потом подсвечиваются куски исходной.
 */
export function normalize(text: string): string {
  let out = "";
  for (const c of text.split("")) {
    const lower = c.toLowerCase();
    if (lower.length !== 1) out += c;
    else out += lower === "ё" ? "е" : lower;
  }
  return out;
}

export function searchTerms(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

export type SearchHit = { item: ScriptItem; section: ScriptSection };

/**
 * Совпадение — все слова запроса найдены где угодно в скрипте: в названии,
 * словах для поиска, пояснениях и текстах на любом языке. Сначала идут
 * скрипты, где слова стоят в названии: «дорого» должно поднимать возражение
 * «Дорого», а не каждое сообщение, где встречается «недорого».
 */
export function searchScripts(sections: ScriptSection[], terms: string[]): SearchHit[] {
  if (!terms.length) return [];
  const scored: { hit: SearchHit; score: number; order: number }[] = [];
  let order = 0;
  for (const section of sections) {
    for (const item of section.items) {
      order++;
      const title = normalize(item.title);
      const keywords = normalize(item.keywords);
      const body = normalize(
        [
          section.title,
          stripMarkup(item.note),
          stripMarkup(item.follow_up),
          ...item.variants.flatMap((v) => [
            v.label,
            ...v.messages.flatMap((m) => [m.label, m.ru, m.en, m.ka]),
          ]),
        ].join("\n"),
      );
      let score = 0;
      let all = true;
      for (const term of terms) {
        if (title.includes(term)) score += title.startsWith(term) ? 14 : 10;
        else if (keywords.includes(term)) score += 5;
        else if (body.includes(term)) score += 1;
        else {
          all = false;
          break;
        }
      }
      if (all) scored.push({ hit: { item, section }, score, order });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.hit);
}

/** Студии, для которых у скриптов есть свои варианты текста. */
export function studioLabels(sections: ScriptSection[]): string[] {
  const seen: string[] = [];
  for (const section of sections)
    for (const item of section.items)
      for (const variant of item.variants)
        if (variant.label && !seen.includes(variant.label)) seen.push(variant.label);
  return seen;
}

/** Вариант под выбранную студию; если у скрипта такого нет — первый. */
export function pickVariant(item: ScriptItem, studio: string): ScriptVariant {
  return (
    item.variants.find((v) => v.label && v.label === studio) ??
    item.variants[0] ?? { label: "", messages: [] }
  );
}

export type ShownText = {
  text: string;
  lang: ScriptLang;
  /** Перевода на выбранный язык нет, показан другой. */
  fallback: boolean;
};

/**
 * Текст сообщения на выбранном языке. Перевода нет — показываем другой язык
 * и говорим об этом прямо: молча подставленный русский в английском чате —
 * ошибка, которую администратор заметит уже после отправки.
 */
export function messageText(message: ScriptMessage, lang: ScriptLang): ShownText {
  if (message[lang]?.trim()) return { text: message[lang], lang, fallback: false };
  const other = LANGS.find((l) => message[l.key]?.trim());
  return { text: other ? message[other.key] : "", lang: other?.key ?? lang, fallback: true };
}

/**
 * Копирование в буфер. Clipboard API есть только на https и в фокусе;
 * запасной путь через выделение textarea — для всего остального.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // ниже — запасной путь
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function totalScripts(sections: ScriptSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/** Поиск скрипта по названию — для ссылок «…» в пояснениях. */
export function findByTitle(sections: ScriptSection[], title: string): SearchHit | null {
  const wanted = normalize(title.trim());
  for (const section of sections)
    for (const item of section.items)
      if (normalize(item.title) === wanted) return { item, section };
  return null;
}

/** Где лежит скрипт (по id): его могли перенести в другой раздел. */
export function findById(sections: ScriptSection[], id: string): SearchHit | null {
  for (const section of sections)
    for (const item of section.items) if (item.id === id) return { item, section };
  return null;
}

/**
 * Полная ссылка на скрипт — для CRM, базы знаний, переписки. Ведёт по id:
 * если скрипт потом перенесут в другой раздел, страница сама найдёт его.
 */
export function scriptUrl(sectionId: string, itemId: string): string {
  return `${window.location.origin}/scripts/${sectionId}?item=${itemId}`;
}

/* --- Переменные: {админ}, {клуб}, свои ---------------------------------- */

/**
 * {ключ}: буквы, цифры, подчёркивание. Квадратные скобки [день] — другое:
 * это места, которые администратор заполняет руками.
 */
export const VARIABLE_RE = /\{([0-9A-Za-zА-Яа-яЁё_]{1,40})\}/g;
export const VARIABLE_KEY_RE = /^[0-9A-Za-zА-Яа-яЁё_]{1,40}$/;

/**
 * Прежнее имя {клуб}: так переменная называлась, пока в админке был термин
 * «студия». В старых текстах скриптов она осталась — подставляется так же,
 * но в списках для вставки не показывается.
 */
export const LEGACY_CLUB_VARIABLE = "студия";

export const BUILTIN_VARIABLES: { key: string; description: string }[] = [
  { key: "админ", description: "имя того, кто вошёл, — из настроек скриптов" },
  { key: "клуб", description: "выбранный клуб — название на языке текста" },
];

export type VarValue = {
  /** null — переменная известна, но на этом языке значения нет. */
  value: string | null;
  /** Почему нет значения — для подсказки на подсвеченной переменной. */
  why?: string;
};

/**
 * Подстановщик для текущего языка, студии и вошедшего. null в value —
 * подставлять нечего (переменной нет в настройках или нет значения на этом
 * языке): она подсвечивается оранжевым. undefined — настройки ещё не
 * загружены, и текст в фигурных скобках пока остаётся текстом.
 */
export type VarResolver = (key: string) => VarValue | undefined;

function pick(texts: LangText | undefined, lang: ScriptLang): string | null {
  const value = texts?.[lang]?.trim();
  return value ? value : null;
}

/**
 * Имя по умолчанию — из профиля: там «Фамилия Имя», клиенту пишут имя
 * («Меня зовут Анна», а не «Гелашвили Анна»).
 */
export function defaultFirstName(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[1] : (parts[0] ?? "");
}

/** Имена сотрудника на трёх языках: сохранённые, а русское — хотя бы из профиля. */
export function adminNames(
  settings: ScriptSettings | null,
  userId: string,
  fullName: string | null | undefined,
): LangText {
  const saved = settings?.admins[userId];
  return {
    ru: saved?.ru?.trim() || defaultFirstName(fullName),
    en: saved?.en ?? "",
    ka: saved?.ka ?? "",
  };
}

export function makeResolver({
  settings,
  me,
  lang,
  studio,
}: {
  settings: ScriptSettings | null;
  /** Кто вошёл: id и ФИО из профиля. */
  me: { id: string; fullName: string | null } | null;
  lang: ScriptLang;
  /** Выбранная студия — название варианта (совпадает с названием в настройках). */
  studio: string;
}): VarResolver {
  const inLang = langInfo(lang).inName;
  return (rawKey) => {
    const key = rawKey.toLowerCase();
    if (key === "админ") {
      if (!me) return { value: null, why: "Профиль ещё загружается" };
      const value = pick(adminNames(settings, me.id, me.fullName), lang);
      return value
        ? { value }
        : { value: null, why: `Нет имени на ${inLang} — задайте в «Настройках» → «Подстановка»` };
    }
    if (key === "клуб" || key === LEGACY_CLUB_VARIABLE) {
      const studios = settings?.studios ?? [];
      const names =
        studios.find((s) => s.name === studio || s.ru === studio) ??
        (studios.length === 1 ? studios[0] : undefined);
      if (!names) return { value: null, why: "Выберите клуб над скриптами" };
      const value = pick(names, lang);
      return value
        ? { value }
        : { value: null, why: `Нет названия клуба на ${inLang} — задайте в настройках` };
    }
    const custom = settings?.variables.find((v) => v.key.toLowerCase() === key);
    if (!custom) {
      // Пока настройки не пришли, неизвестное не красим: это ещё не ошибка.
      if (!settings) return undefined;
      return {
        value: null,
        why: `Переменной {${rawKey}} нет в настройках — добавьте её в «Настройки» → «Подстановка»`,
      };
    }
    if (custom.type === "date") return { value: dateAfter(custom.offset_days ?? 0) };
    const value = pick(custom, lang);
    return value
      ? { value }
      : { value: null, why: `Нет значения на ${inLang} — задайте в настройках` };
  };
}

/**
 * Дата через N дней от сегодня — только день и месяц, «12.06»: так пишут в
 * чате о свободных местах, и так одинаково на всех трёх языках. Считается
 * по часам компьютера администратора — то есть по тбилисскому времени.
 */
export function dateAfter(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Подпись к дате в настройках: «ср, 07.10» — видно, не выходной ли. */
export function dateAfterLabel(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${WEEKDAYS[d.getDay()]}, ${dateAfter(days, from)}`;
}

/**
 * Текст с подставленными переменными — то, что уйдёт в чат по кнопке
 * «Копировать». Неизвестные и пустые остаются как были, в скобках: их
 * видно и в чате, и на экране, где они подсвечены.
 */
export function resolveText(text: string, resolve: VarResolver): string {
  return text.replace(VARIABLE_RE, (whole, key: string) => resolve(key)?.value ?? whole);
}

/**
 * Текст подсказки без разметки (**жирный**, __подчёркнутый__, ссылки на
 * скрипты, [[копируемое]]) — для поиска и копирования.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/\[\[([^\]\n]+?)\]\]/g, "$1")
    .replace(/\[([^\]\n]+)\]\(script:[0-9a-fA-F-]{36}\)/g, "$1")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/__([^_\n]+?)__/g, "$1");
}

/** Склонение: plural(3, "скрипт", "скрипта", "скриптов"). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «сегодня, 14:05», «вчера, 09:12», «12.10.2026, 18:40». */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 86_400_000);
  if (diff === 0) return `сегодня, ${time}`;
  if (diff === 1) return `вчера, ${time}`;
  return `${d.toLocaleDateString("ru-RU")}, ${time}`;
}

/* --- Черновик скрипта для редактора ------------------------------------- */

export const emptyMessage = (): ScriptMessage => ({ label: "", ru: "", en: "", ka: "" });

export function emptyDraft(sectionId: string): ScriptItemDraft {
  return {
    section_id: sectionId,
    title: "",
    kind: "chat",
    keywords: "",
    note: "",
    follow_up: "",
    variants: [{ label: "", messages: [emptyMessage()] }],
  };
}

/** Тексты без пустых краёв и виндовых переводов строк: в чат уходит то, что видно. */
export function cleanDraft(draft: ScriptItemDraft): ScriptItemDraft {
  const clean = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return {
    ...draft,
    title: draft.title.trim(),
    keywords: draft.keywords.trim(),
    note: clean(draft.note),
    follow_up: clean(draft.follow_up),
    variants: draft.variants.map((v) => ({
      label: v.label.trim(),
      messages: v.messages.map((m) => ({
        label: m.label.trim(),
        ru: clean(m.ru),
        en: clean(m.en),
        ka: clean(m.ka),
      })),
    })),
  };
}
