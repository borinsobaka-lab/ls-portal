/**
 * Уведомления портала — запросы (схема —
 * db/migrations/2026-11-07_zz_portal_notifications.sql): лента, счётчик
 * непрочитанных, личные настройки, устройства для пушей.
 */
import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import type { NotifPrefs } from "./kinds";

export type NotifItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  count: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
};

export type PortalSettings = {
  timezone: string;
  workday_end: string;
  prefs: NotifPrefs;
  dnd_until: string | null;
  quiet_enabled: boolean;
  quiet_from: string;
  quiet_to: string;
  quiet_weekends: boolean;
};

export type PushDeviceRow = {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_sent_at: string | null;
};

const KEY = "notif_items";

/** Счётчик «Уведомлений» в рейке: раз в 30 секунд и при возврате во вкладку. */
export const notifUnreadQuery = queryOptions({
  queryKey: [KEY, "unread"],
  queryFn: async () => (await unwrap<number | null>(supabase.rpc("notif_unread_count"))) ?? 0,
  refetchInterval: 30_000,
  refetchOnWindowFocus: true,
});

export function useNotifUnread(): number {
  return useQuery(notifUnreadQuery).data ?? 0;
}

const PAGE = 30;

export function useNotifFeed(unreadOnly: boolean, enabled = true) {
  return useInfiniteQuery({
    queryKey: [KEY, "feed", unreadOnly],
    queryFn: async ({ pageParam }) =>
      (await unwrap<NotifItem[] | null>(
        supabase.rpc("notif_list", {
          p_before: pageParam,
          p_limit: PAGE,
          p_unread_only: unreadOnly,
        }),
      )) ?? [],
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1].updated_at),
    enabled,
    refetchOnWindowFocus: true,
    meta: { errorMessage: "Не удалось загрузить уведомления" },
  });
}

/** Отметить прочитанным: выбранные или все (ids не передан). */
export function useMarkNotifRead() {
  const queryClient = useQueryClient();
  return useCallback(
    async (ids?: string[]) => {
      if (ids && ids.length === 0) return;
      await unwrap(supabase.rpc("notif_mark_read", { p_ids: ids ?? null }));
      await queryClient.invalidateQueries({ queryKey: [KEY] });
    },
    [queryClient],
  );
}

export const portalSettingsQuery = queryOptions({
  queryKey: ["portal_user_settings"],
  queryFn: async () => (await unwrap<PortalSettings>(supabase.rpc("portal_settings_get")))!,
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить настройки" },
});

export function usePortalSettings() {
  return useQuery(portalSettingsQuery);
}

export function useSavePortalSettings() {
  const queryClient = useQueryClient();
  return useCallback(
    async (patch: Partial<PortalSettings>) => {
      const next = await unwrap<PortalSettings>(supabase.rpc("portal_settings_save", { p: patch }));
      queryClient.setQueryData(portalSettingsQuery.queryKey, next ?? undefined);
      return next;
    },
    [queryClient],
  );
}

export const pushDevicesQuery = queryOptions({
  queryKey: ["portal_push_devices"],
  queryFn: async () =>
    (await unwrap<PushDeviceRow[] | null>(supabase.rpc("portal_push_devices"))) ?? [],
  meta: { errorMessage: "Не удалось загрузить устройства" },
});

/** Сейчас действует «Не беспокоить» (разово). */
export function dndActive(settings: PortalSettings | undefined, now = Date.now()): boolean {
  return !!settings?.dnd_until && new Date(settings.dnd_until).getTime() > now;
}
