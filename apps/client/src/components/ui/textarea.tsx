import * as React from "react";

import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui/input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea className={cn("flex min-h-14 py-4", fieldClass, className)} ref={ref} {...props} />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
