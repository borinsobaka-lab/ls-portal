import * as React from "react";

import { useFieldAria, useFieldId } from "@/components/ui/field-context";
import { fieldClass } from "@/components/ui/field-styles";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, id, ...props }, ref) => {
    const fieldId = useFieldId(id);
    const aria = useFieldAria(fieldId);
    return (
      <input
        type={type}
        id={fieldId}
        {...aria}
        data-field=""
        className={cn(
          "flex py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          fieldClass,
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
