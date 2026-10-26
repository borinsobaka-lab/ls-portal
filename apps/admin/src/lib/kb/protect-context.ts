import { createContext } from "react";

/**
 * Включена ли защита содержимого статьи (components/kb/protected-area.tsx):
 * тогда у своего видео нет «Скачать» в плеере, у картинок — «Скачать» в окне
 * просмотра (components/kb/media-blocks.tsx, kb-document.tsx).
 */
export const KbProtectContext = createContext(false);
