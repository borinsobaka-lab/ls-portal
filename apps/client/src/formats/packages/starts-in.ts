/**
 * «Вы записаны, начинается через 2 ч 15 мин» на карточке своей тренировки
 * (решение владельца 2026-10-14). Без запросов к базе — проверяют тесты.
 */

export type StartsIn = { days: number; hours: number; minutes: number };

/**
 * Сколько осталось до начала: минуты округляются вверх (за 30 секунд —
 * «через 1 мин»); началось — null.
 */
export function startsIn(startsAt: string, now: number): StartsIn | null {
  const ms = Date.parse(startsAt) - now;
  if (!(ms > 0)) return null;
  const total = Math.ceil(ms / 60_000);
  return {
    days: Math.floor(total / 1440),
    hours: Math.floor((total % 1440) / 60),
    minutes: total % 60,
  };
}

/**
 * Две старшие части: «1 д 3 ч», «2 ч 15 мин», «40 мин»; нулевая младшая
 * часть не пишется. Подписи единиц — через `unit` (переводы в словарях).
 */
export function startsInParts(s: StartsIn): { n: number; unit: "d" | "h" | "min" }[] {
  if (s.days > 0)
    return [
      { n: s.days, unit: "d" as const },
      ...(s.hours > 0 ? [{ n: s.hours, unit: "h" as const }] : []),
    ];
  if (s.hours > 0)
    return [
      { n: s.hours, unit: "h" as const },
      ...(s.minutes > 0 ? [{ n: s.minutes, unit: "min" as const }] : []),
    ];
  return [{ n: s.minutes, unit: "min" }];
}
