import type { FunnelStep } from "@/lib/dashboard-marketing";
import { formatStat } from "@/lib/dashboard-stats";
import { formatNumber } from "@/lib/format";

/**
 * «Путь новых клиентов» на дашборде «Маркетинг»: шаг, полоса доли от первого
 * шага (всех новых клиентов), число и процент. Шаги не вложены друг в
 * друга — полоса короче не значит «из предыдущего» (lib/dashboard-marketing.ts).
 */
export function FunnelBars({ steps, color }: { steps: FunnelStep[]; color: string }) {
  const base = steps[0]?.value ?? 0;
  return (
    <ol className="space-y-3">
      {steps.map((step, idx) => {
        const share = base ? (step.value / base) * 100 : 0;
        return (
          <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
            <div className="min-w-0">
              <div className="truncate text-sm">{step.label}</div>
              <div className="mt-1 h-6 rounded-md bg-muted">
                <div
                  className="h-full rounded-md"
                  style={{
                    width: `${idx === 0 && base ? 100 : share}%`,
                    // Первый шаг — полный цвет, дальше светлее: видно, где теряем.
                    backgroundColor: `color-mix(in srgb, ${color} ${100 - idx * 14}%, transparent)`,
                  }}
                />
              </div>
            </div>
            <div className="pb-0.5 text-right">
              <div className="text-sm font-semibold tabular-nums">{formatNumber(step.value)}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {idx === 0 ? "100%" : base ? formatStat("percent", share) : "—"}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
