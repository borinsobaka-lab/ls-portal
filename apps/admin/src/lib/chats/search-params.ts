/** Параметры адреса раздела «Чаты»: папка `f`, сообщение `m` (seq). */
export type ChatsSearch = { f?: string; m?: number };

export function chatsSearch(search: Record<string, unknown>): ChatsSearch {
  const f =
    typeof search.f === "string" && /^(direct|group|[0-9a-f-]{36})$/.test(search.f)
      ? search.f
      : undefined;
  const raw = Number(search.m);
  const m = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  return { ...(f ? { f } : {}), ...(m ? { m } : {}) };
}
