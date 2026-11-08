/**
 * Чаты портала — типы ответов базы (db/migrations/2026-11-08_chats.sql).
 */

export type ChatKind = "direct" | "group" | "self";
export type ChatRole = "owner" | "admin" | "member";
export type ChatNotify = "all" | "mentions" | "none";

export type ChatSystem = {
  type: "created" | "added" | "removed" | "left" | "renamed";
  title?: string;
  users?: string[];
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
};

export type ChatMember = {
  user_id: string;
  role: ChatRole;
  joined_at: string;
  last_read_seq: number;
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
