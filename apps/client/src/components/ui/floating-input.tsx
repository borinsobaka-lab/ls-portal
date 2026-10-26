import * as React from "react";

import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui/input";

/* ───────── Floating label input ───────── */
interface FloatingLabelInputProps extends React.ComponentProps<"input"> {
  label: string;
}

const FloatingLabelInput = React.forwardRef<HTMLInputElement, FloatingLabelInputProps>(
  ({ className, label, onFocus, onBlur, value, placeholder, ...props }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const hasValue = String(value ?? "").length > 0;
    // У date-поля браузер всегда рисует маску «дд.мм.гггг» — подпись поверх
    // неё накладывалась, поэтому она всегда в поднятом положении.
    const active = focused || hasValue || props.type === "date";

    return (
      <div className="relative">
        <input
          ref={ref}
          value={value}
          // Плейсхолдер — только когда подпись поднята, иначе они накладываются.
          placeholder={active ? placeholder : undefined}
          className={cn(
            "flex h-14",
            fieldClass,
            "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
            active ? "pt-5 pb-1" : "py-1",
            className,
          )}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />
        <label
          className={cn(
            "absolute left-4 pointer-events-none transition-all duration-200 origin-left",
            active
              ? "top-1.5 text-[11px] text-muted-foreground"
              : "top-1/2 -translate-y-1/2 text-base text-field-placeholder",
          )}
        >
          {label}
        </label>
      </div>
    );
  },
);
FloatingLabelInput.displayName = "FloatingLabelInput";

/* ───────── Floating label select ───────── */
interface FloatingLabelSelectProps {
  label: string;
  value?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

const FloatingLabelSelect = React.forwardRef<HTMLButtonElement, FloatingLabelSelectProps>(
  ({ label, value, onValueChange, placeholder, children, disabled, className }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    // "unset" тоже значение: SelectValue показывает текст пункта («Не указано»),
    // и опущенная подпись ложилась прямо на него.
    const hasValue = !!value;
    const active = focused || open || hasValue;

    return (
      <div className={cn("relative", className)}>
        {/* We re-render Radix Select so open state is tracked */}
        <SelectRootWrapper
          value={value}
          onValueChange={onValueChange}
          onOpenChange={setOpen}
          focused={focused}
          setFocused={setFocused}
          ref={ref}
          placeholder={placeholder}
          disabled={disabled}
          active={active}
        >
          {children}
        </SelectRootWrapper>
        <span
          className={cn(
            "absolute left-4 pointer-events-none transition-all duration-200 origin-left",
            active
              ? "top-1.5 text-[11px] text-muted-foreground"
              : "top-1/2 -translate-y-1/2 text-base text-field-placeholder",
          )}
        >
          {label}
        </span>
      </div>
    );
  },
);
FloatingLabelSelect.displayName = "FloatingLabelSelect";

/* Internal helper that bridges Radix Select with focus tracking */
import { Select, SelectTrigger, SelectValue, SelectContent } from "@/components/ui/select";

interface SelectRootWrapperProps {
  value?: string;
  onValueChange?: (v: string) => void;
  onOpenChange: (open: boolean) => void;
  focused: boolean;
  setFocused: (v: boolean) => void;
  placeholder?: string;
  disabled?: boolean;
  active: boolean;
  children?: React.ReactNode;
}

const SelectRootWrapper = React.forwardRef<HTMLButtonElement, SelectRootWrapperProps>(
  (
    { value, onValueChange, onOpenChange, setFocused, placeholder, disabled, active, children },
    ref,
  ) => {
    return (
      <Select
        value={value}
        onValueChange={onValueChange}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <SelectTrigger
          ref={ref}
          className={cn(
            "flex h-14 items-center justify-between whitespace-nowrap cursor-pointer",
            fieldClass,
            "data-[placeholder]:text-field-placeholder data-[state=open]:bg-field-focus focus:ring-0 [&>span]:line-clamp-1",
            active ? "pt-5 pb-1" : "py-1",
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          <SelectValue placeholder={active ? undefined : placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    );
  },
);
SelectRootWrapper.displayName = "SelectRootWrapper";

export { FloatingLabelInput, FloatingLabelSelect };
