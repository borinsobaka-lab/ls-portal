/**
 * Виды уведомлений портала: подписи в настройках и пуш по умолчанию. Пуш по
 * умолчанию дублирует база (notif_default_push в
 * db/migrations/2026-11-07_zz_portal_notifications.sql) — тест сверяет.
 * Новый вид: строка здесь и, если пуш по умолчанию выключен, — в функции
 * базы новой миграцией.
 *
 * Правило (TASKS_CHATS_PLAN.md, «тихо по умолчанию»): пуш — когда от
 * человека что-то нужно; остальное — счётчики.
 */
export type NotifKind = {
  key: string;
  /** Блок в настройках. */
  group: string;
  label: string;
  hint?: string;
  defaultPush: boolean;
  /** Не показывать в настройках (служебные). */
  hidden?: boolean;
};

export const NOTIF_KINDS: NotifKind[] = [
  {
    key: "chat.direct",
    group: "Чаты",
    label: "Личные сообщения",
    defaultPush: true,
  },
  {
    key: "chat.mention",
    group: "Чаты",
    label: "Упоминания и ответы на мои сообщения",
    defaultPush: true,
  },
  {
    key: "chat.call",
    group: "Чаты",
    label: "Видеозвонки",
    hint: "Когда вам звонят, а портал не открыт перед глазами",
    defaultPush: true,
  },
  {
    key: "chat.group",
    group: "Чаты",
    label: "Сообщения в группах",
    hint: "Без звука в отдельных чатах — в самом чате",
    defaultPush: false,
  },
  {
    key: "test",
    group: "Служебные",
    label: "Проверка уведомлений",
    defaultPush: true,
    hidden: true,
  },
];

export const NOTIF_KIND_BY_KEY = new Map(NOTIF_KINDS.map((k) => [k.key, k]));

/** Пуш включён у вида: настройка человека, иначе умолчание. */
export function pushEnabled(prefs: NotifPrefs, key: string): boolean {
  const own = prefs[key]?.push;
  if (typeof own === "boolean") return own;
  return NOTIF_KIND_BY_KEY.get(key)?.defaultPush ?? true;
}

export type NotifPrefs = Record<string, { push: boolean }>;

/** Отличия от умолчаний — то, что хранит база. */
export function withPush(prefs: NotifPrefs, key: string, push: boolean): NotifPrefs {
  const next = { ...prefs };
  const def = NOTIF_KIND_BY_KEY.get(key)?.defaultPush ?? true;
  if (push === def) delete next[key];
  else next[key] = { push };
  return next;
}
