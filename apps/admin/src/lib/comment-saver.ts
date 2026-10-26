import { supabase } from "@/integrations/supabase/client";

/** Сохраняет текст (пусто — null); возвращает текст ошибки или null. */
export type CommentSaver = (value: string | null) => Promise<string | null>;

/**
 * Комментарий одной колонкой таблицы: пишет и стирает. Для окон и таблиц,
 * где комментарий правят на месте, без окна редактирования записи.
 */
export function commentSaver(table: string, id: string, column = "comment"): CommentSaver {
  return async (value) => {
    const { error } = await supabase
      .from(table)
      .update({ [column]: value })
      .eq("id", id);
    return error ? error.message : null;
  };
}
