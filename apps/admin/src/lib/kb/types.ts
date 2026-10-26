/** Строки базы знаний (db/migrations/2026-10-24_knowledge_base.sql). */
import type { KbLevel } from "./access";

export type KbBase = {
  id: string;
  title: string;
  rail_title: string;
  icon: string;
  description: string;
  sort_order: number;
  /** Защита содержимого статей базы по умолчанию (запрет копирования, водяной знак). */
  protect_content: boolean;
  /** Фирменный цвет базы (#rrggbb); null — цвет клуба. */
  brand_color: string | null;
};

/** База с уровнем доступа вошедшего. */
export type KbBaseWithLevel = KbBase & { level: KbLevel };

export type KbProtect = "inherit" | "on" | "off";

export type KbStatus = "draft" | "published" | "archived";
export type KbKind = "folder" | "article";

/** Строка дерева — без текста статьи (дерево грузится целиком). */
export type KbTreeNode = {
  id: string;
  base_id: string;
  parent_id: string | null;
  kind: KbKind;
  title: string;
  description: string;
  /** Иконка раздела (папки верхнего уровня), ключ KB_SECTION_ICONS; null — папка. */
  icon: string | null;
  /** Защита содержимого статьи: как в базе / включена / выключена. */
  protect: KbProtect;
  /** Оценка статьи в её конце (три смайлика). */
  feedback_enabled: boolean;
  /** «Предыдущая / Следующая» в конце статьи. */
  pager_enabled: boolean;
  sort_order: number;
  status: KbStatus;
  reader_visible: boolean;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_by: string | null;
};

/** Статья целиком: опубликованный текст (документ BlockNote). */
export type KbNodeFull = KbTreeNode & { content: unknown[] | null };

export type KbDraft = {
  node_id: string;
  content: unknown[];
  updated_by: string | null;
  updated_at: string;
};

export const KB_STATUS_LABEL: Record<KbStatus, string> = {
  draft: "Черновик",
  published: "Опубликовано",
  archived: "Архив",
};
