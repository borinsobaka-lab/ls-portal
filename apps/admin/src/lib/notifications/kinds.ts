/**
 * Виды уведомлений портала: подписи в настройках и пуш по умолчанию. Пуш по
 * умолчанию дублирует база (notif_default_push — актуальное определение в
 * последней миграции, где она есть) — тест сверяет.
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
    key: "chat.channel",
    group: "Чаты",
    label: "Посты в каналах",
    hint: "Объявления компании и отделов",
    defaultPush: true,
  },
  {
    key: "chat.ack",
    group: "Чаты",
    label: "Просьба отметить «Прочитал»",
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
    key: "task.assigned",
    group: "Задачи",
    label: "Мне поставили задачу или пункт чек-листа",
    defaultPush: true,
  },
  {
    key: "task.review",
    group: "Задачи",
    label: "Моя задача ждёт проверки",
    defaultPush: true,
  },
  {
    key: "task.returned",
    group: "Задачи",
    label: "Задачу вернули на доработку",
    defaultPush: true,
  },
  {
    key: "task.soon",
    group: "Задачи",
    label: "Срок задачи через час",
    defaultPush: true,
  },
  {
    key: "task.overdue",
    group: "Задачи",
    label: "Задача просрочена",
    hint: "Один раз — в момент просрочки",
    defaultPush: true,
  },
  {
    key: "task.reminder",
    group: "Задачи",
    label: "Мои напоминания",
    defaultPush: true,
  },
  {
    key: "task.digest",
    group: "Задачи",
    label: "Сводка просроченного у исполнителей",
    hint: "Раз в день, утром — по задачам, которые я поставил",
    defaultPush: true,
  },
  {
    key: "task.done",
    group: "Задачи",
    label: "Поставленная мной задача завершена",
    defaultPush: false,
  },
  {
    key: "task.accepted",
    group: "Задачи",
    label: "Мою работу приняли",
    defaultPush: false,
  },
  {
    key: "task.deadline",
    group: "Задачи",
    label: "Срок задачи перенесли",
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
