import type { Indicator } from "@/hooks/use-active-indicator";

/** Сама плашка: тёмная пилюля под активным табом или сегментом. */
export function ActiveIndicator({ indicator }: { indicator: Indicator | null }) {
  if (!indicator) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 rounded-full bg-selected transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none"
      style={{
        width: indicator.width,
        height: indicator.height,
        transform: `translate(${indicator.left}px, ${indicator.top}px)`,
      }}
    />
  );
}
