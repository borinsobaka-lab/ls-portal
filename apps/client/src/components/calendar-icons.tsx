/**
 * Иконки календарей в окне «Выберите календарь» (окно тренировки) — в бандле
 * вместо прежних картинок из Lovable, которые перестали загружаться (решение
 * владельца 2026-10-13). Google Календарь и Outlook — картинки, присланные
 * владельцем (Outlook — значок 2025 года), остальные — свои SVG.
 */

import googleCalendarSrc from "@/assets/calendar-google.png";
import outlookSrc from "@/assets/calendar-outlook.png";

type IconProps = { className?: string };

export function GoogleCalendarIcon({ className }: IconProps) {
  return <img src={googleCalendarSrc} alt="" aria-hidden="true" className={className} />;
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Как значок «Календаря» на iPhone: сегодняшние день недели и число. */
export function AppleCalendarIcon({ className }: IconProps) {
  const today = new Date();
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="44"
        height="44"
        rx="10"
        fill="#fff"
        stroke="#e5e5ea"
        strokeWidth="1.5"
      />
      <text
        x="24"
        y="15"
        fill="#ff3b30"
        fontFamily="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"
        fontSize="8"
        fontWeight="600"
        textAnchor="middle"
        letterSpacing=".3"
      >
        {WEEKDAYS[today.getDay()]}
      </text>
      <text
        x="24"
        y="37.5"
        fill="#1c1c1e"
        fontFamily="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
        fontSize="22"
        fontWeight="400"
        textAnchor="middle"
      >
        {today.getDate()}
      </text>
    </svg>
  );
}

export function OutlookIcon({ className }: IconProps) {
  return <img src={outlookSrc} alt="" aria-hidden="true" className={className} />;
}

/** Прочие календари (.ics-файл). */
export function IcsFileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#e8eaed" d="M12 4h17l11 11v27a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      <path fill="#c4c7cc" d="M29 4v9a2 2 0 0 0 2 2h9z" />
      <rect
        x="15"
        y="22"
        width="18"
        height="15"
        rx="2"
        fill="#fff"
        stroke="#80868b"
        strokeWidth="1.6"
      />
      <path fill="#80868b" d="M15 24a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3H15z" />
      <path stroke="#80868b" strokeWidth="1.6" strokeLinecap="round" d="M19 20v4M29 20v4" />
    </svg>
  );
}
