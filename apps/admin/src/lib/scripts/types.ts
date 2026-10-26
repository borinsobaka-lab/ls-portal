/**
 * «Скрипты LS» — типы данных (db/migrations/2026-10-10_scripts_ls.sql).
 * Перенос продукта «Скрипты» из «Аудиоаналитики»: формат разделов, скриптов
 * и сценариев звонков тот же, поэтому экспорт оттуда импортируется как есть.
 */

export type ScriptLang = "ru" | "en" | "ka";
export type ScriptKind = "chat" | "call" | "task" | "info";

export type LangText = Record<ScriptLang, string>;

/** Одно сообщение на трёх языках. Пустая строка — перевода нет. */
export type ScriptMessage = LangText & { label: string };

/** Вариант текста под студию; label — название студии, пусто — общий. */
export type ScriptVariant = { label: string; messages: ScriptMessage[] };

export type ScriptItem = {
  id: string;
  section_id: string;
  title: string;
  kind: ScriptKind;
  keywords: string;
  note: string;
  follow_up: string;
  variants: ScriptVariant[];
  position: number;
  updated_at: string | null;
  updated_by: string;
  /** Что изменили при последней правке — внизу карточки. */
  change_note: string;
};

export type ScriptItemDraft = Pick<
  ScriptItem,
  "section_id" | "title" | "kind" | "keywords" | "note" | "follow_up" | "variants"
>;

/** Ответ клиента в сценарии звонка — кнопка, ведущая к следующему блоку. */
export type CallAnswer = { label: string; to: string };

/** Блок сценария: что говорит администратор и куда дальше. */
export type CallNode = {
  id: string;
  title: string;
  /** main — этап разговора; objection — возражение или вопрос клиента. */
  group: "main" | "objection";
  text: LangText;
  /** Подсказка администратору — клиенту не говорится. */
  hint: string;
  /** Чего ждать от клиента. */
  client: string;
  answers: CallAnswer[];
};

export type CallFlow = { start: string; nodes: CallNode[] };

export type ScriptSection = {
  id: string;
  title: string;
  /** Ключ иконки (SECTION_ICONS); пусто — по умолчанию. */
  icon: string;
  position: number;
  /** text — текстовые скрипты; call — один сценарий звонка. */
  kind: "text" | "call";
  flow: CallFlow | null;
  flow_updated_at: string | null;
  flow_updated_by: string;
  flow_change_note: string;
  items: ScriptItem[];
};

export type ScriptVariable = LangText & {
  key: string;
  /** text — значения на языках; date — «через N дней от сегодня», ДД.ММ. */
  type: "text" | "date";
  description: string;
  offset_days: number;
};

/** Студия для {студия}: name — как в вариантах скриптов и переключателе. */
export type StudioNames = LangText & { name: string };

/** Настройки подстановки ({админ}, {студия}, свои переменные). */
export type ScriptSettings = {
  studios: StudioNames[];
  /** user_id → имя на трёх языках; нет — имя из профиля. */
  admins: Record<string, LangText>;
  variables: ScriptVariable[];
  updated_at: string | null;
  updated_by: string;
};

/** Сотрудник с разделом «Скрипты LS» (RPC scripts_staff). */
export type ScriptStaff = { user_id: string; full_name: string; email: string };

/** Версия скрипта в хронологии. У сценария звонка kind = "call" и flow. */
export type ScriptSnapshot = {
  title: string;
  kind: ScriptKind | "call";
  flow?: CallFlow;
  section: string;
  keywords?: string;
  note?: string;
  follow_up?: string;
  variants?: ScriptVariant[];
};

export type ScriptChange = {
  id: string;
  item_id: string | null;
  item_title: string;
  action: "created" | "updated" | "deleted";
  before: ScriptSnapshot | null;
  after: ScriptSnapshot | null;
  change_note: string;
  author: string;
  created_at: string;
};

export type ScriptSuggestion = {
  id: string;
  author_id: string;
  author_name: string;
  item_id: string | null;
  item_title: string;
  text: string;
  status: "open" | "done";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string;
};

export type LangCounts = { total: number; ru: number; en: number; ka: number };

export type CopyStats = {
  totals: LangCounts;
  items: (LangCounts & {
    item_id: string | null;
    title: string;
    section: string;
    deleted: boolean;
  })[];
  users: (LangCounts & { user_id: string; name: string })[];
};

/** Шаг звонка, как его хранит scripts_call_runs.path. */
export type CallRunStep = {
  id: string;
  title: string;
  group: "main" | "objection";
  answer: string;
  at: string;
};

export type CallRunRow = {
  id: string;
  section_id: string;
  user_id: string;
  user_name: string;
  path: CallRunStep[];
  started_at: string;
  updated_at: string;
  ended_at: string | null;
};

/** Ответ RPC scripts_call_stats — сырые счётчики, воронку складывает call-stats.ts. */
export type CallStatsRaw = {
  sections: { id: string; title: string; runs: number; deleted: boolean }[];
  section_id: string | null;
  users?: { user_id: string; name: string; runs: number }[];
  runs?: number;
  avg_steps?: number | null;
  reached?: Record<string, number>;
  ended?: { node_id: string; title: string; group: string; count: number }[];
  seen?: { id: string; title: string; group: string }[];
};
