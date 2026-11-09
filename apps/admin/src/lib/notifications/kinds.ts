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
    label: "Личное сообщение",
    defaultPush: true,
  },
  {
    key: "chat.mention",
    group: "Чаты",
    label: "Упоминание или ответ мне",
    defaultPush: true,
  },
  {
    key: "chat.call",
    group: "Чаты",
    label: "Входящий видеозвонок",
    hint: "Когда вам звонят, а портал не открыт перед глазами",
    defaultPush: true,
  },
  {
    key: "chat.channel",
    group: "Чаты",
    label: "Пост в канале",
    hint: "Объявления компании и отделов",
    defaultPush: true,
  },
  {
    key: "chat.ack",
    group: "Чаты",
    label: "Напоминание отметить пост канала «Прочитал(а)»",
    defaultPush: true,
  },
  {
    key: "chat.scheduled",
    group: "Чаты",
    label: "Отложенное сообщение не отправилось",
    defaultPush: true,
  },
  {
    key: "chat.group",
    group: "Чаты",
    label: "Сообщение в группе",
    hint: "Выключить звук отдельного чата — в самом чате",
    defaultPush: false,
  },
  {
    key: "task.assigned",
    group: "Задачи",
    label: "Новая задача мне",
    hint: "Или пункт чек-листа на мне",
    defaultPush: true,
  },
  {
    key: "task.review",
    group: "Задачи",
    label: "Задача ждёт моей проверки",
    defaultPush: true,
  },
  {
    key: "task.returned",
    group: "Задачи",
    label: "Мою задачу вернули на доработку",
    defaultPush: true,
  },
  {
    key: "task.soon",
    group: "Задачи",
    label: "До срока задачи остался час",
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
    label: "Моё напоминание по задаче",
    defaultPush: true,
  },
  {
    key: "task.digest",
    group: "Задачи",
    label: "Утренняя сводка по просроченным",
    hint: "Раз в день — по задачам, которые я поставил(а)",
    defaultPush: true,
  },
  {
    key: "task.done",
    group: "Задачи",
    label: "Завершена задача, которую я поставил(а)",
    defaultPush: false,
  },
  {
    key: "task.accepted",
    group: "Задачи",
    label: "Мою работу по задаче приняли",
    defaultPush: false,
  },
  {
    key: "task.deadline",
    group: "Задачи",
    label: "Срок задачи перенесён",
    defaultPush: false,
  },
  {
    key: "cal.invite",
    group: "Календарь",
    label: "Приглашение на встречу",
    defaultPush: true,
  },
  {
    key: "cal.change",
    group: "Календарь",
    label: "Встреча перенесена или отменена",
    defaultPush: true,
  },
  {
    key: "cal.remind",
    group: "Календарь",
    label: "Напоминание о встрече или событии",
    hint: "Когда — выбирается у события; у каждого участника свои",
    defaultPush: true,
  },
  {
    key: "cal.reply",
    group: "Календарь",
    label: "Ответ на моё приглашение",
    defaultPush: false,
  },
  {
    key: "test",
    group: "Служебные",
    label: "Проверка уведомлений",
    defaultPush: true,
    hidden: true,
  },
  {
    key: "company.birthday",
    group: "Компания",
    label: "День рождения коллеги",
    hint: "Коллеги по подразделению, утром в день рождения",
    defaultPush: false,
  },
];

export const NOTIF_KIND_BY_KEY = new Map(NOTIF_KINDS.map((k) => [k.key, k]));

/** Канал доставки уведомления помимо ленты портала. */
export type NotifChannel = "push" | "email";

/**
 * Настройки видов — только отличия от умолчаний (их хранит база,
 * portal_user_settings.prefs): пуш по умолчанию — `defaultPush` вида, почта
 * по умолчанию выключена у всех видов (решение владельца 2026-11-08: не
 * засорять почту тем, кто её не читает; notif_email_allowed в базе).
 */
export type NotifPrefs = Record<string, { push?: boolean; email?: boolean }>;

function channelDefault(key: string, channel: NotifChannel): boolean {
  if (channel === "email") return false;
  return NOTIF_KIND_BY_KEY.get(key)?.defaultPush ?? true;
}

/** Канал включён у вида: настройка человека, иначе умолчание. */
export function channelEnabled(prefs: NotifPrefs, key: string, channel: NotifChannel): boolean {
  const own = prefs[key]?.[channel];
  return typeof own === "boolean" ? own : channelDefault(key, channel);
}

/** Пуш включён у вида. */
export function pushEnabled(prefs: NotifPrefs, key: string): boolean {
  return channelEnabled(prefs, key, "push");
}

/** Письмо на почту включено у вида. */
export function emailEnabled(prefs: NotifPrefs, key: string): boolean {
  return channelEnabled(prefs, key, "email");
}

/** Включить или выключить канал вида; хранятся только отличия от умолчаний. */
export function withChannel(
  prefs: NotifPrefs,
  key: string,
  channel: NotifChannel,
  on: boolean,
): NotifPrefs {
  const next = { ...prefs };
  const own = { ...next[key] };
  if (on === channelDefault(key, channel)) delete own[channel];
  else own[channel] = on;
  if (Object.keys(own).length === 0) delete next[key];
  else next[key] = own;
  return next;
}

export function withPush(prefs: NotifPrefs, key: string, push: boolean): NotifPrefs {
  return withChannel(prefs, key, "push", push);
}

/** Сколько видов (из показываемых в настройках) уходит на почту. */
export function emailKindsCount(prefs: NotifPrefs): number {
  return NOTIF_KINDS.filter((k) => !k.hidden && emailEnabled(prefs, k.key)).length;
}
