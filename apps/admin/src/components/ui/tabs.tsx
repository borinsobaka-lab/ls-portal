import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { ActiveIndicator } from "@/components/ui/active-indicator";
import { useActiveIndicator } from "@/hooks/use-active-indicator";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * Активный таб подсвечивает не сам триггер, а общая плашка под ним, которая
 * переезжает к новому табу (useActiveIndicator). Табы переключают
 * содержимое под собой (TabsContent); выбор значения без своего содержимого
 * (язык, период, вид графика) — SegmentedControl, он выглядит так же.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    /** Табы, заводимые заново на каждой странице: плашка переезжает с прежнего места (useActiveIndicator). */
    indicatorMemoryKey?: string;
  }
>(({ className, children, indicatorMemoryKey, ...props }, ref) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const indicator = useActiveIndicator(
    listRef,
    '[role="tab"]',
    '[role="tab"][data-state="active"]',
    "data-state",
    indicatorMemoryKey,
  );
  // На телефоне длинная строка табов прокручивается вбок: выбранный таб
  // (из адреса или после нажатия) — в видимой части, а не за краем.
  const activeLeft = indicator?.left;
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const tab = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!tab) return;
    const left = tab.offsetLeft - 8;
    const right = tab.offsetLeft + tab.offsetWidth + 8;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }, [activeLeft]);

  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        "relative inline-flex h-10 items-center justify-center-safe rounded-full bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    >
      <ActiveIndicator indicator={indicator} />
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // relative z-10 — текст поверх плашки; фона у триггера нет, его рисует TabsList.
      "relative z-10 inline-flex items-center justify-center whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-medium ring-offset-background cursor-pointer transition-colors duration-200 data-[state=inactive]:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed data-[state=active]:text-selected-foreground",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
