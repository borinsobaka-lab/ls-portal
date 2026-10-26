import { supabase } from "@/integrations/supabase/client";

/**
 * Convert a stored media value to a displayable URL.
 * Accepts full URLs, data URLs, or storage paths (with optional "bucket/path").
 * Defaults to the news-media bucket.
 */
export function mediaUrl(
  value: string | null | undefined,
  defaultBucket = "news-media",
): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^(https?:|data:|blob:)/i.test(v)) return v;
  // If value looks like "bucket/path", split — but only when the first
  // segment doesn't look like a UUID/folder we know is inside the default bucket.
  // Safer: always use the default bucket and treat the whole value as path.
  const { data } = supabase.storage.from(defaultBucket).getPublicUrl(v);
  return data.publicUrl;
}
