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
