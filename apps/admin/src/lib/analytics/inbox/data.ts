import { supabase } from "@/integrations/supabase/client";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { unwrap } from "@/lib/query";

/** Ключи запросов «Диалогов VK»: ["analytics", "inbox", …]. */
export const INBOX_KEY = [ANALYTICS_KEY, "inbox"] as const;

export const inboxRpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type InboxCommunity = {
  id: number;
  vk_community_id: number;
  display_name: string;
  brand: string;
  city: string;
  is_active: boolean;
  connected_at: string;
  last_verified_at: string | null;
  last_sync_at: string | null;
  has_token: boolean;
  dialogs: number;
};

export type InboxPerson = {
  user_id: string;
  full_name: string;
  position: string | null;
  email: string | null;
  active: boolean;
  communities: number[];
  manager: boolean;
  admin: boolean;
};

export type InboxCommunities = { communities: InboxCommunity[]; people: InboxPerson[] };

/** «Подключения»: сообщества и лид-менеджеры (администратору аналитики). */
export const inboxCommunitiesQuery = {
  queryKey: [...INBOX_KEY, "communities"],
  queryFn: () => inboxRpc<InboxCommunities>("an_inbox_communities"),
  meta: { errorMessage: "Не удалось загрузить подключения сообществ VK" },
};

export type InboxQueueDialog = {
  id: number;
  community_id: number;
  peer_id: number;
  customer_vk_id: number | null;
  customer_name: string;
  customer_avatar_url: string;
  status: string;
  last_message_at: string | null;
  community_name: string;
  brand: string;
  city: string;
  last_body: string | null;
  last_direction: string | null;
  has_unread: boolean;
  last_sent_at: string | null;
};

export type InboxQueue = {
  admin: boolean;
  community: number | null;
  communities: { id: number; display_name: string; brand: string; city: string }[];
  dialogs: InboxQueueDialog[];
  counts: { total: number; unread: number };
  marker: string;
  next_offset: number | null;
};

export type InboxFilters = { community: number | null; unread: boolean; q: string };

/** Их первая страница очереди — 200 диалогов, дальше — по 100. */
export const inboxQueuePage = (f: InboxFilters, offset: number) =>
  inboxRpc<InboxQueue>("an_inbox_queue", {
    p_community: f.community,
    p_unread: f.unread,
    p_search: f.q,
    p_offset: offset,
    p_limit: offset === 0 ? 200 : 100,
  });

export const inboxQueueKey = (f: InboxFilters) =>
  [...INBOX_KEY, "queue", String(f.community ?? ""), f.unread ? "1" : "", f.q] as const;

export type InboxMessage = {
  id: number;
  direction: "incoming" | "outgoing" | "service";
  body: string;
  vk_sender_id: number | null;
  portal_sender_user_id: string | null;
  sent_at: string;
  edited_at: string | null;
  media: { photos: string[]; stickers: string[]; has_sticker: boolean };
};

export type InboxThread = {
  dialog: Omit<InboxQueueDialog, "last_body" | "last_direction" | "has_unread" | "last_sent_at">;
  messages: InboxMessage[];
  has_more: boolean;
};

export const inboxThreadKey = (dialog: number, community: number | null, before: number | null) =>
  [...INBOX_KEY, "thread", dialog, String(community ?? ""), String(before ?? "")] as const;

export const inboxOpen = (
  dialog: number,
  community: number | null,
  mark: boolean,
  before: number | null,
) =>
  inboxRpc<InboxThread>("an_inbox_open", {
    p_dialog: dialog,
    p_community: community,
    p_mark: mark,
    p_before: before,
  });

export type InboxTemplate = {
  id: number;
  title: string;
  body: string;
  visibility: "personal" | "shared";
};

export const inboxTemplatesQuery = {
  queryKey: [...INBOX_KEY, "templates"],
  queryFn: () => inboxRpc<{ admin: boolean; templates: InboxTemplate[] }>("an_inbox_templates"),
  meta: { errorMessage: "Не удалось загрузить шаблоны ответов" },
};
