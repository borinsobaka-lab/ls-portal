import { cn } from "@/lib/utils";

/**
 * Иконка amoCRM-ссылки. Открывает CRM-карточку клиента в новой вкладке.
 * Используется рядом с кликабельной фамилией/именем клиента, поэтому
 * по клику останавливаем всплытие, чтобы не открывалась карточка клиента.
 *
 * Рисуется inline-SVG (синий кружок + белое «amo») — без внешних ассетов,
 * чтобы иконка не ломалась (раньше PNG хостился на Lovable и после переезда
 * отдавал 404).
 */
export function AmoCrmLinkIcon({
  href,
  className,
  size = 16,
  title = "Открыть в amoCRM",
}: {
  href: string | null | undefined;
  className?: string;
  size?: number;
  title?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 items-center justify-center align-middle transition-opacity hover:opacity-80",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 40 40"
        width={size}
        height={size}
        className="block"
        role="img"
        aria-hidden="true"
      >
        <circle cx="20" cy="20" r="20" fill="#2AA0DD" />
        <text
          x="20"
          y="21"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Segoe UI', system-ui, -apple-system, sans-serif"
          fontSize="16"
          fontWeight="800"
          fontStyle="italic"
          fill="#fff"
        >
          amo
        </text>
      </svg>
    </a>
  );
}
