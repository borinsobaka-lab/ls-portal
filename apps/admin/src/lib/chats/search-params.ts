/**
 * Параметры адреса раздела «Чаты»: папка `f` (системная или своя), сообщение
 * `m` (seq), `scheduled=1` — открыть свои отложенные сообщения чата,
 * `g=1` — у группы с темами открыть «Общую» (без него на узком экране —
 * список тем).
 */
export type ChatsSearch = { f?: string; m?: number; scheduled?: boolean; g?: boolean };

const FOLDER_RE = /^(all|direct|channel|group|project|event|task|[0-9a-f-]{36})$/;

export function chatsSearch(search: Record<string, unknown>): ChatsSearch {
  const f = typeof search.f === "string" && FOLDER_RE.test(search.f) ? search.f : undefined;
  const raw = Number(search.m);
  const m = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const scheduled = search.scheduled === true || search.scheduled === "1" || search.scheduled === 1;
  const g = search.g === true || search.g === "1" || search.g === 1;
  return {
    ...(f ? { f } : {}),
    ...(m ? { m } : {}),
    ...(scheduled ? { scheduled: true } : {}),
    ...(g ? { g: true } : {}),
  };
}
