/**
 * Чаты портала — типы ответов базы (db/migrations/2026-11-08_chats.sql).
 */
import type { CallEndReason } from "./call-logic";

/** task — обсуждение задачи (db/migrations/2026-11-08_zz_tasks.sql): состав ведёт задача. */
export type ChatKind = "direct" | "group" | "self" | "task" | "project";
export type ChatRole = "owner" | "admin" | "member";
export type ChatNotify = "all" | "mentions" | "none";

export type ChatSystem = {
  type:
    | "created"
    | "added"
    | "removed"
    | "left"
    | "renamed"
    | "task_status"
    | "task_chat"
    | "call"
    | "project_created"
    | "task_created"
    | "channel_created";
  title?: string;
  /** Задача из сообщения (type = task_created): номера, сколько, сообщение. */
  numbers?: number[];
  count?: number;
  seq?: number;
  users?: string[];
  /** Видеозвонок (type = call, lib/chats/call-logic.ts). */
  call_id?: string;
  state?: "live" | "ended";
  reason?: CallEndReason | null;
  duration?: number | null;
};

export type ChatPreview = {
  seq: number;
  author_id: string | null;
  kind: "text" | "system";
  text: string;
  deleted?: boolean;
  forward?: boolean;
  system?: ChatSystem | null;
};

export type ChatSettings = {
  pin?: "admins" | "all";
  post?: "admins" | "all";
  add?: "admins" | "all";
  /** У чата задачи — её id и номер (ссылка «Открыть задачу»). */
  task_id?: string;
  task_number?: number;
  /** У чата проекта — его id (ссылка «Проект»). */
  project_id?: string;
  /** Канал: пишут только админы, у постов — «Прочитал». */
  channel?: boolean;
  /** Состав из оргструктуры (вся компания или подразделения). */
  auto?: boolean;
};

export type ChatRow = {
  id: string;
  kind: ChatKind;
  title: string | null;
  description: string | null;
  settings: ChatSettings;
  peer_id: string | null;
  member_count: number;
  my_role: ChatRole;
  notify: ChatNotify;
  muted_until: string | null;
  pinned_at: string | null;
  last_seq: number;
  last_read_seq: number;
  last_message: ChatPreview | null;
  last_message_at: string | null;
  unread: number;
  mentions: number;
  created_at: string;
};

export type ChatAttachment = {
  path: string;
  name: string;
  mime: string;
  size?: number;
  width?: number;
  height?: number;
};

export type ChatReaction = { emoji: string; count: number; mine: boolean; users: string[] };

export type ChatMessage = {
  id: string;
  chat_id: string;
  seq: number;
  author_id: string | null;
  kind: "text" | "system";
  /** Документ редактора (ProseMirror JSON); у системного — {system}. */
  content: ChatDoc | { system: ChatSystem } | null;
  text: string;
  attachments: ChatAttachment[];
  mentions: string[];
  mention_all: boolean;
  forward: { chat_id: string; seq: number; author_id: string | null; created_at: string } | null;
  reply: {
    seq: number;
    author_id: string | null;
    text: string;
    files: number;
    deleted: boolean;
  } | null;
  reactions: ChatReaction[];
  pinned: boolean;
  /** Свой client_id (только у своих сообщений). */
  client_id?: string | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  /** «Прочитал» у поста канала: отметили из тех, кто был в чате. */
  ack?: { count: number; total: number; mine: boolean } | null;
};

export type ChatMember = {
  user_id: string;
  role: ChatRole;
  joined_at: string;
  last_read_seq: number;
  /** auto — из подразделения или «всей компании»: не убрать вручную. */
  source?: "manual" | "auto";
};

/** Источник состава чата: вся компания или подразделение. */
export type ChatSource = {
  kind: "all" | "unit";
  unit_id: string | null;
  scope: "all" | "heads";
  with_subunits: boolean;
  unit_name?: string | null;
};

export type ChatFolder = { id: string; title: string; sort_order: number; chat_ids: string[] };

/** Узел документа редактора (ProseMirror JSON). */
export type ChatNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: ChatNode[];
};
export type ChatDoc = ChatNode & { type: "doc" };

export type ChatSearchHit = {
  message_id: string;
  chat_id: string;
  seq: number;
  author_id: string | null;
  created_at: string;
  snippet: string;
  has_files: boolean;
};
