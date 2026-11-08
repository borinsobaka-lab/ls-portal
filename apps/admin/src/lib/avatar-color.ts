import type { CSSProperties } from "react";

/**
 * Цвет аватарки без фото — по человеку (решение владельца 2026-11-08):
 * пастельные тона из «Ссылок на отзывы» «Аналитики» везде в портале, пока
 * человек не загрузил фото. Цвет считается от имени (у одного человека он
 * один на всех страницах — в списках, чатах, базе знаний), инициалы —
 * тёмно-фиолетовым (≥ 7:1 на любом из тонов).
 */
export const AVATAR_COLORS = ["#f8d9ed", "#e9d9ff", "#ffe4d5", "#d8eaff", "#f4d9ff", "#d7f4e7"];
export const AVATAR_TEXT = "#5c2a75";

export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function avatarStyle(seed: string): CSSProperties {
  return { background: avatarColor(seed), color: AVATAR_TEXT };
}
