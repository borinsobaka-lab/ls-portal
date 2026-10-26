import { Input } from "@/components/ui/input";
import { fieldClass } from "@/components/ui/field-styles";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Цвет: готовые образцы (если есть) + системная пипетка + код #RRGGBB.
 * Одно поле на всю админку — цвет клуба («Клубы»), цвет тренировки.
 * Образцы — кружки, как и все нажимаемые элементы; пипетка и код — поля.
 * Пока в поле недописанный код, пипетка показывает `fallback`.
 */
export function ColorInput({
  value,
  onChange,
  fallback,
  swatches,
}: {
  value: string;
  onChange: (value: string) => void;
  fallback: string;
  swatches?: { hex: string; label: string }[];
}) {
  const current = value.toLowerCase();
  return (
    <div className="space-y-2">
      {swatches && (
        <div className="flex flex-wrap gap-2">
          {swatches.map((c) => (
            <button
              key={c.hex}
              type="button"
              title={c.label}
              aria-label={c.label}
              aria-pressed={current === c.hex.toLowerCase()}
              onClick={() => onChange(c.hex)}
              className={cn(
                "size-8 cursor-pointer rounded-full border border-black/10 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:hover:scale-100",
                current === c.hex.toLowerCase() &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Выбрать цвет"
          data-field=""
          value={HEX.test(value) ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
          className={cn(fieldClass, "w-12 shrink-0 cursor-pointer p-1")}
        />
        <Input
          aria-label="Цвет в формате #RRGGBB"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          className="w-32 font-mono uppercase"
          maxLength={7}
        />
      </div>
    </div>
  );
}
