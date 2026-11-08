/**
 * Видеозвонки чатов — подписи (без браузера и базы, есть тест):
 * сообщение звонка в переписке, итог звонка для тоста, ошибки RPC.
 * Схема — db/migrations/2026-11-08_zzz_chat_calls.sql.
 */

export type CallEndReason = "finished" | "missed" | "declined" | "cancelled" | "failed";
export type CallMemberState = "ringing" | "joined" | "left" | "declined" | "missed";

/** Системное сообщение звонка: {type: 'call', call_id, state, reason, duration}. */
export type CallSystem = {
  type: "call";
  call_id?: string;
  state?: "live" | "ended";
  reason?: CallEndReason | null;
  duration?: number | null;
};

/** «45 с», «12 мин», «1 ч 5 мин». */
export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

/** Текст сообщения звонка в переписке и превью списка чатов. */
export function callSystemText(system: CallSystem, who: string): string {
  if (system.state !== "ended") return `${who} начал(а) видеозвонок`;
  switch (system.reason) {
    case "finished":
      return system.duration
        ? `Видеозвонок · ${formatCallDuration(system.duration)}`
        : "Видеозвонок";
    case "declined":
      return "Видеозвонок отклонён";
    case "cancelled":
      return "Отменённый видеозвонок";
    case "failed":
      return "Видеозвонок не состоялся";
    default:
      return "Пропущенный видеозвонок";
  }
}

/** Что сказать, когда звонок закончился у меня в окне (null — ничего). */
export function callEndedNotice(
  reason: CallEndReason | null | undefined,
  kind: string,
  iStarted: boolean,
): string | null {
  switch (reason) {
    case "declined":
      return iStarted ? "Собеседник отклонил звонок" : null;
    case "missed":
      if (!iStarted) return null;
      return kind === "direct" ? "Собеседник не ответил" : "Никто не ответил на звонок";
    case "failed":
      return "Не удалось начать звонок";
    case "finished":
      return "Звонок завершён";
    default:
      return null;
  }
}

export function callErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    chat_call_disabled: "Видеозвонки не настроены на сервере",
    chat_call_room_failed: "Не удалось создать видеоконференцию. Попробуйте ещё раз",
    chat_call_self: "В «Избранном» звонить некому",
    chat_call_no_peer: "Собеседника нет в чате",
    chat_call_ended: "Звонок уже завершён",
    chat_call_not_ready: "Конференция ещё создаётся — попробуйте через пару секунд",
    chat_forbidden: "Нет доступа к этому чату",
  };
  for (const [k, v] of Object.entries(map)) if (msg.includes(k)) return v;
  return msg;
}
