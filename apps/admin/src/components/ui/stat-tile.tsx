import type * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Плитка показателя раздела: подпись и число («Не отработано», «Баланс ·
 * клуб»). Одна на все разделы — раньше её собирали на месте в каждом, и
 * подписи, отступы и болванки расходились. Плитки дашборда — свои
 * (`components/dashboard/stat-cards.tsx`: сравнение, график).
 *
 * tone — цвет числа, только когда оно требует внимания (страница сама решает,
 * когда: обычно при значении больше нуля). loading — болванка вместо числа при
 * настоящей подписи (system.md, «Скелетоны»).
 */
export function StatTile({
  label,
  icon,
  value,
  tone = "default",
  loading = false,
  className,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  value?: React.ReactNode;
  tone?: "default" | "warning" | "negative";
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-background p-4", className)}>
      <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{label}</span>
      </p>
      {loading ? (
        <Skeleton className="mt-1 h-8 w-20" />
      ) : (
        <p
          className={cn(
            "mt-1 truncate text-2xl font-semibold tabular-nums",
            tone === "warning" && "text-amber-700",
            tone === "negative" && "text-destructive",
          )}
        >
          {value}
        </p>
      )}
    </div>
  );
}
