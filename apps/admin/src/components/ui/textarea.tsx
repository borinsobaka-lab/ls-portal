import * as React from "react";

import { useFieldAria, useFieldId } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

/**
 * `note` — поле заметки или комментария: «бумажка» (тёплый тон и тень,
 * styles.css, `textarea[data-note]`), чтобы заметки выделялись среди
 * обычных полей (решение владельца 2026-10-11).
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea"> & { note?: boolean }
>(({ className, id, note, ...props }, ref) => {
  const fieldId = useFieldId(id);
  const aria = useFieldAria(fieldId);
  return (
    <textarea
      id={fieldId}
      {...aria}
      data-note={note ? "" : undefined}
      className={cn(
        "flex min-h-20 w-full resize-y rounded-md border border-input bg-field px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
