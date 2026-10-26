/**
 * Урок из статьи базы знаний — копией (решение владельца 2026-10-25): текст
 * опубликованной версии и копии её файлов в папку курса. Ученику не нужен
 * доступ к базе знаний, а вопросы теста не «уезжают» от текста, пока статью
 * правят. Читает статью создатель курса — нужен доступ к её базе.
 */
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { copyKbFiles } from "@/lib/kb/files";
import { acadCourseFolder } from "./data";

export async function copyArticleForLesson(
  nodeId: string,
  courseId: string,
): Promise<{ title: string; content: unknown[]; publishedAt: string | null; failed: number }> {
  const row = await unwrap<{
    title: string;
    content: unknown[] | null;
    published_at: string | null;
  }>(supabase.from("kb_nodes").select("title, content, published_at").eq("id", nodeId).single());
  const { content, failed } = await copyKbFiles(row.content ?? [], acadCourseFolder(courseId));
  return { title: row.title, content, publishedAt: row.published_at, failed };
}
