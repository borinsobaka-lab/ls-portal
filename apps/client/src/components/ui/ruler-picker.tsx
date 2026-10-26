import { useEffect, useRef, useState } from "react";

type Props = {
  min: number;
  max: number;
  value: number | null;
  onChange: (v: number) => void;
  /** Pixel width per tick */
  tickWidth?: number;
  /** Highlight every Nth tick as a major tick */
  majorEvery?: number;
  /** How to format labels under major ticks */
  formatLabel?: (v: number) => string;
  /** Big value formatting */
  formatValue?: (v: number) => string;
  /** Unit shown under value (e.g. "кг") */
  unit?: string;
  className?: string;
};

export function RulerPicker({
  min,
  max,
  value,
  onChange,
  tickWidth = 12,
  majorEvery = 5,
  formatLabel = (v) => String(v),
  formatValue = (v) => String(v),
  unit,
  className,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const draggingRef = useRef(false);
  // Таймер «перетаскивание закончилось». Раньше хранился свойством функции
  // onScroll, которая пересоздаётся на каждый рендер, — clearTimeout читал
  // undefined, старые таймеры не отменялись, и флаг сбрасывался посреди жеста:
  // эффект ниже начинал выставлять scrollLeft и дёргал линейку под пальцем.
  const dragEndTimerRef = useRef<number | undefined>(undefined);
  const initialized = useRef(false);

  const count = max - min + 1;

  // Measure width
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Scroll to value when externally changed (only when not actively dragging)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || width === 0) return;
    const target = value ?? Math.round((min + max) / 2);
    const idx = target - min;
    const desired = idx * tickWidth;
    if (!initialized.current) {
      el.scrollLeft = desired;
      initialized.current = true;
      if (value == null) onChange(target);
      return;
    }
    if (!draggingRef.current && Math.abs(el.scrollLeft - desired) > 1) {
      el.scrollLeft = desired;
    }
  }, [value, width, min, max, tickWidth, onChange]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    draggingRef.current = true;
    const idx = Math.round(el.scrollLeft / tickWidth);
    const v = Math.min(max, Math.max(min, min + idx));
    if (v !== value) onChange(v);
    window.clearTimeout(dragEndTimerRef.current);
    dragEndTimerRef.current = window.setTimeout(() => {
      draggingRef.current = false;
    }, 150);
  };

  useEffect(() => () => window.clearTimeout(dragEndTimerRef.current), []);

  const pad = Math.max(0, Math.floor(width / 2));

  return (
    <div className={className}>
      {/* Plate with big value */}
      <div className="mx-auto w-full max-w-[220px] rounded-2xl bg-card border border-border py-4 text-center">
        <div className="text-5xl font-black tabular-nums leading-none">
          {value != null ? formatValue(value) : "—"}
        </div>
        {unit && <div className="mt-1 text-xs text-muted-foreground">{unit}</div>}
      </div>

      {/* Ruler */}
      <div className="relative mt-5 select-none">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="overflow-x-auto no-scrollbar"
          style={{
            scrollSnapType: "x mandatory",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div
            className="relative flex items-end h-20"
            style={{ paddingLeft: pad, paddingRight: pad }}
          >
            {Array.from({ length: count }).map((_, i) => {
              const v = min + i;
              const isMajor = v % majorEvery === 0;
              const isCenter = value === v;
              return (
                <div
                  key={v}
                  className="flex flex-col items-center justify-end shrink-0"
                  style={{ width: tickWidth, scrollSnapAlign: "center" }}
                >
                  {isMajor && (
                    <div
                      className={`mb-1 text-[11px] tabular-nums transition-colors ${
                        isCenter ? "text-foreground font-bold" : "text-muted-foreground"
                      }`}
                    >
                      {formatLabel(v)}
                    </div>
                  )}
                  <div
                    className={`rounded-full transition-colors ${
                      isCenter ? "bg-foreground" : isMajor ? "bg-foreground/60" : "bg-foreground/25"
                    }`}
                    style={{
                      width: 2,
                      height: isCenter ? 44 : isMajor ? 32 : 18,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Center indicator */}
        <div className="pointer-events-none absolute inset-0 flex justify-center">
          <div
            className="w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-foreground self-end"
            style={{ marginBottom: -2 }}
          />
        </div>
      </div>
    </div>
  );
}
