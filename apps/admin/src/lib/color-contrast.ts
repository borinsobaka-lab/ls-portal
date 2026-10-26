/**
 * Контраст цветов по WCAG 2 — для цветов, которые выбирают не в коде:
 * цвет клуба (`studios.brand_color`) и заливки, смешанные из него.
 * Только #rgb / #rrggbb; остальное (var(--…), названия) — null.
 */

type Rgb = [number, number, number];

export function parseHex(color: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const toHex = (rgb: Rgb) =>
  "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function luminance([r, g, b]: Rgb) {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Смесь как у `color-mix(in srgb, color P%, base)`. */
export function mix(color: Rgb, base: Rgb, share: number): Rgb {
  return color.map((v, i) => v * share + base[i] * (1 - share)) as Rgb;
}

const WHITE: Rgb = [255, 255, 255];

/**
 * Цвет `color`, сдвинутый к белому (на тёмном `bg`) или к чёрному (на
 * светлом) ровно настолько, чтобы давать не меньше `min`: 3:1 — значок и
 * прочее не-текстовое, 4.5:1 — текст. Подходящий цвет возвращается как есть.
 */
export function readableOn(color: string, bg: string, min = 3): string {
  const c = parseHex(color);
  const b = parseHex(bg);
  if (!c || !b) return color;
  const target: Rgb = luminance(b) < 0.18 ? WHITE : [0, 0, 0];
  for (let step = 0; step <= 20; step++) {
    const out = mix(c, target, 1 - step / 20);
    if (contrastRatio(out, b) >= min) return step === 0 ? color : toHex(out);
  }
  return toHex(target);
}

/**
 * Белый или тёмный текст на заливке `color` долей `share` поверх белого —
 * что контрастнее. `dark` — цвет основного текста.
 */
export function textOnTint(color: string, share: number, dark = "#0f172a"): "light" | "dark" {
  const c = parseHex(color);
  const d = parseHex(dark);
  if (!c || !d) return share > 0.55 ? "light" : "dark";
  const bg = mix(c, WHITE, share);
  return contrastRatio(WHITE, bg) > contrastRatio(d, bg) ? "light" : "dark";
}
