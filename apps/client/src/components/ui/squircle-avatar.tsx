"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

import { cn } from "@/lib/utils";

type SquircleAvatarProps = React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
  /** Pixel size of the avatar (square). Defaults to 44. */
  size?: number;
  /** @deprecated kept for backwards compatibility — Clubhouse shape is fixed. */
  cornerRadius?: number;
  /** @deprecated kept for backwards compatibility — Clubhouse shape is fixed. */
  cornerSmoothing?: number;
};

/**
 * Clubhouse-style avatar — uses the exact organic squircle path from the
 * Clubhouse iOS app (viewBox 9300x9300), scaled to the requested size.
 */
const CLUBHOUSE_VIEWBOX = 9300;
const CLUBHOUSE_PATH =
  "M4285 9293c-1347-62-2295-378-3012-1005-218-190-463-488-622-756-354-596-547-1278-628-2212-25-292-25-1049 0-1340 81-932 270-1605 618-2196 208-354 498-682 811-918 663-500 1459-760 2598-848 253-19 1003-16 1265 6 987 81 1724 302 2318 692 325 214 542 411 779 708 425 532 712 1285 823 2161 49 389 59 568 59 1065 0 485-9 663-55 1035-87 714-286 1335-590 1847-204 345-494 670-801 902-411 310-872 526-1426 667-162 41-202 47-203 27 0-7-4-4-9 8-7 18-27 24-136 43-498 87-932 123-1454 119-151-1-302-3-335-5z";

/** Scale every numeric value in an SVG path string by `s`. */
function scalePath(d: string, s: number): string {
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    const v = parseFloat(n) * s;
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  });
}

function useClubhousePath(size: number) {
  return React.useMemo(() => scalePath(CLUBHOUSE_PATH, size / CLUBHOUSE_VIEWBOX), [size]);
}

const SquircleAvatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  SquircleAvatarProps
>(({ className, style, size = 44, cornerRadius: _cr, cornerSmoothing: _cs, ...props }, ref) => {
  const path = useClubhousePath(size);
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn("relative flex shrink-0 overflow-hidden", className)}
      style={{
        width: size,
        height: size,
        clipPath: `path('${path}')`,
        WebkitClipPath: `path('${path}')`,
        ...style,
      }}
      {...props}
    />
  );
});
SquircleAvatar.displayName = "SquircleAvatar";

const SquircleAvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full object-cover", className)}
    {...props}
  />
));
SquircleAvatarImage.displayName = "SquircleAvatarImage";

const SquircleAvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex h-full w-full items-center justify-center bg-muted", className)}
    {...props}
  />
));
SquircleAvatarFallback.displayName = "SquircleAvatarFallback";

export { SquircleAvatar, SquircleAvatarImage, SquircleAvatarFallback };

/** Returns a CSS `clip-path: path(...)` value for the Clubhouse avatar shape. */
export function squircleClipPath(size: number, _cornerRadius?: number, _cornerSmoothing?: number) {
  return `path('${scalePath(CLUBHOUSE_PATH, size / CLUBHOUSE_VIEWBOX)}')`;
}
