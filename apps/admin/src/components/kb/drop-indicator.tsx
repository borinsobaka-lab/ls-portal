import type { Instruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item";

import { cn } from "@/lib/utils";

/**
 * Куда встанет перетаскиваемая строка (useDragRow): линия с точкой над или
 * под строкой, «внутрь папки» — рамка вокруг неё. Цвет — клуба, на тёмном
 * меню — его светлый вариант. Родителю строки нужен `relative`.
 */
export function DropIndicator({
  instruction,
  onDark,
}: {
  instruction: Instruction | null;
  /** Строка в тёмном боковом меню. */
  onDark?: boolean;
}) {
  if (!instruction || instruction.blocked) return null;
  const color = onDark ? "bg-brand-on-dark" : "bg-brand-on-light";
  if (instruction.operation === "combine") {
    return (
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-md ring-2",
          onDark ? "ring-brand-on-dark" : "ring-brand-on-light",
        )}
      />
    );
  }
  const before = instruction.operation === "reorder-before";
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full",
        color,
        before ? "-top-px" : "-bottom-px",
      )}
    >
      <span className={cn("absolute -top-[3px] -left-1 size-2 rounded-full", color)} />
    </span>
  );
}
