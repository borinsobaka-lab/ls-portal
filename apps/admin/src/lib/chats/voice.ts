/**
 * Голосовые сообщения чатов (решение владельца 2026-11-08): запись — пока
 * нажата кнопка микрофона (поле пустое), вложение `chat-files` с пометкой
 * `voice`, длительностью и волной (db/migrations/2026-11-08_zzzzzzzzzzzzzz_chat_voice.sql).
 * Здесь — без браузера: формат записи, волна, подписи, жесты.
 */
import type { ChatAttachment } from "./types";

/** Сколько полосок волны хранит сообщение (база принимает до 100). */
export const WAVEFORM_BARS = 48;
/** Дольше — запись останавливается и уходит сама. */
export const VOICE_MAX_SECONDS = 15 * 60;
/** Короче — не отправляем: нажали, а не держали. */
export const VOICE_MIN_SECONDS = 0.7;
/** Жест: увести палец влево — отмена, вверх — «без рук». */
export const CANCEL_DX = -90;
export const LOCK_DY = -70;

/** Форматы записи по порядку предпочтения (Chrome, Firefox — webm/opus; Safari — mp4/aac). */
export const VOICE_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

export function pickVoiceMime(isSupported: (mime: string) => boolean): string {
  return VOICE_MIME_CANDIDATES.find((m) => isSupported(m)) ?? "";
}

/** Расширение файла по типу записи. */
export function voiceExt(mime: string): string {
  if (/^audio\/webm/.test(mime)) return "webm";
  if (/^audio\/ogg/.test(mime)) return "ogg";
  if (/^audio\/(mp4|aac|x-m4a)/.test(mime)) return "m4a";
  return "webm";
}

/** Имя файла голосового: «Голосовое 2026-11-08 14-05.webm». */
export function voiceFileName(at: Date, mime: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Голосовое ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}.${voiceExt(mime)}`;
}

/** 0:07, 1:12, 12:05. */
export function formatVoiceTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Волна из уровней громкости записи (0–1, по кадру): `bars` полосок —
 * максимум куска, нормировка по самой громкой, 0–100. Тихая запись — не
 * ровный ноль: нижний предел, чтобы полоски было видно.
 */
export function buildWaveform(levels: number[], bars = WAVEFORM_BARS): number[] {
  if (levels.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  const max = Math.max(...out);
  return out.map((v) => (max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 4));
}

/** Волна для плеера: `bars` полосок из сохранённой (другой длины — растягиваем). */
export function resampleWaveform(wave: number[] | undefined, bars: number): number[] {
  if (!wave?.length) return Array.from({ length: bars }, () => 30);
  return Array.from({ length: bars }, (_, i) => {
    const v = wave[Math.min(wave.length - 1, Math.floor((i * wave.length) / bars))];
    return Math.max(4, Math.min(100, v));
  });
}

/** Жест удержания: что делает палец, уведённый от кнопки на (dx, dy). */
export function holdGesture(dx: number, dy: number): "cancel" | "lock" | "hold" {
  if (dx <= CANCEL_DX) return "cancel";
  if (dy <= LOCK_DY && Math.abs(dx) < 60) return "lock";
  return "hold";
}

export const isVoice = (a: Pick<ChatAttachment, "voice" | "mime">) =>
  !!a.voice && /^audio\//.test(a.mime);

/** Подпись вложений вместо текста (ответ, закреп, превью). */
export function attachmentsLabel(files: Pick<ChatAttachment, "voice" | "mime">[]): string {
  if (files.length === 0) return "";
  const f = files[0];
  if (isVoice(f)) return "Голосовое сообщение";
  if (/^image\//.test(f.mime)) return "Фото";
  if (/^video\//.test(f.mime)) return "Видео";
  return "Файл";
}

/** Скорость прослушивания по кругу: 1× → 1,5× → 2× → 1×. */
export const nextVoiceRate = (r: number) => (r < 1.5 ? 1.5 : r < 2 ? 2 : 1);
