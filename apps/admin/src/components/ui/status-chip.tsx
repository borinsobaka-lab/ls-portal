import * as React from "react";

import {
  STATUS_TONE_CLASS,
  statusChipBase,
  statusChipSize,
  type StatusTone,
} from "@/components/ui/status-chip-styles";
import { cn } from "@/lib/utils";

/**
 * Чип статуса — единый вид всех статусов админки (абонемент, запись,
 * заявка, платёж, NPS, выплата…): пилюля `text-xs font-medium`, фон `-100`.
 * Цвет — только по смыслу, из палитры статусов (.interface-design/system.md,
 * «Цвет»), а не по вкусу раздела:
 *
 * - `positive` — активный, оплачено, посетил, отработано, приход;
 * - `negative` — отрицательное: отменено, возврат, просрочено, расход;
 * - `info`     — нейтрально-информационное: заморожен, ждёт очереди,
 *                «Приложение»;
 * - `warning`  — требует внимания: новое, не отработано, долг;
 * - `neutral`  — прошедшее и служебное: закончился, заменён, без статуса;
 * - `strong`   — тёмная пилюля в цвет меню: признак без оценки, который
 *                должен читаться первым (вид заявки, роль).
 *
 * Новый статус — новый `tone` в своём бейдже-компоненте рядом с остальными
 * (membership-status-badge, booking-status-badge…), не строка классов в
 * странице.
 */
export function StatusChip({
  tone = "neutral",
  size = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone;
  size?: keyof typeof statusChipSize;
}) {
  return (
    <span
      className={cn(statusChipBase, statusChipSize[size], STATUS_TONE_CLASS[tone], className)}
      {...props}
    />
  );
}

/**
 * Счётчик непрочитанного / неотработанного у пункта меню, раздела рейки,
 * таба. Красный `destructive` с белым текстом (~4,6:1) — заметен и на тёмном
 * меню, и на белой плашке. Фирменный `--brand` сюда не берём: он только у
 * активного пункта и «сегодня», а его цвет выбирает владелец клуба — белый
 * текст на светлом бренде пропадал.
 */
export function CountBadge({
  count,
  tone = "urgent",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  count: number;
  /**
   * urgent — ждёт действия (неотработанные заявки и обращения): красный.
   * quiet — просто новое (непрочитанные ответы NPS): серый. Когда красным
   * горит всё сразу, красный перестаёт значить «срочно». Серый
   * `muted-foreground` с белым текстом читается и на тёмном меню, и на белом,
   * и на активном (тёмном) табе.
   */
  tone?: "urgent" | "quiet";
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-5 font-semibold text-white tabular-nums",
        tone === "urgent" ? "bg-destructive" : "bg-muted-foreground",
        className,
      )}
      {...props}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export type { StatusTone };
