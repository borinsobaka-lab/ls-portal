import { supabase } from "@/integrations/supabase/client";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { unwrap } from "@/lib/query";

/** Ключи запросов «Контента»: ["analytics", "content", …]. */
export const CONTENT_KEY = [ANALYTICS_KEY, "content"] as const;
export const CONTENT_BUCKET = "an-content";

export const contentRpc = <T>(name: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(name, args));

export type ContentCommunity = {
  id: number;
  brand: string;
  display_name: string;
  city: string;
  vk_community_id: string;
  timezone: string;
  trial_link: string;
  schedule_link: string;
  is_active: boolean;
  has_token: boolean;
  used: boolean;
};

export const contentCommunitiesQuery = {
  queryKey: [...CONTENT_KEY, "communities"],
  queryFn: () =>
    contentRpc<{ communities: ContentCommunity[]; media_token: boolean }>("an_content_communities"),
  meta: { errorMessage: "Не удалось загрузить группы контент-плана" },
};

export type ContentTarget = {
  community_id: number;
  display_name: string;
  city: string;
  timezone: string;
  scheduled_at: string | null;
  publication_status: string;
  vk_post_url: string;
  error_text: string;
};

export type ContentPost = {
  id: number;
  brand: string;
  title: string;
  body: string;
  publish_date: string;
  publish_time: string;
  publication_status: string;
  created_by_name: string;
  targets: ContentTarget[];
  media: { id: number; path: string; name: string }[];
};

/** Лента постов и подписанные ссылки картинок (бакет закрыт). */
export const contentPostsQuery = {
  queryKey: [...CONTENT_KEY, "posts"],
  queryFn: async () => {
    const posts = await contentRpc<ContentPost[]>("an_content_posts");
    const paths = posts.flatMap((p) => p.media.map((m) => m.path));
    const urls = new Map<string, string>();
    if (paths.length) {
      const { data } = await supabase.storage.from(CONTENT_BUCKET).createSignedUrls(paths, 3600);
      for (const s of data ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
    }
    return { posts, urls };
  },
  meta: { errorMessage: "Не удалось загрузить контент-план" },
};
