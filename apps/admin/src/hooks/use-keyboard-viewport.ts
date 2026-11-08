import { useEffect } from "react";

/**
 * Высота каркаса портала на телефоне — по видимой части экрана.
 *
 * Chrome на Android с `interactive-widget=resizes-content` (мета viewport в
 * `__root.tsx`) сам ужимает страницу под клавиатуру, а Safari на iPhone —
 * нет: `100dvh` остаётся во весь экран, клавиатура накрывает низ, и браузер
 * сдвигает всю страницу, чтобы показать поле — шапка чата уезжает вверх,
 * поле ввода прыгает. Поэтому на сенсорных экранах ставим `--app-height` =
 * высота `visualViewport` (без клавиатуры), и каркас (`_authenticated/route.tsx`)
 * берёт её вместо `100dvh`; сдвиг страницы — обратно к началу.
 *
 * При увеличении щипком (`scale` ≠ 1) видимая часть тоже меньше — тогда
 * высоту не трогаем, иначе страница сжалась бы под лупу.
 */
export function useKeyboardViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (Math.abs(vv.scale - 1) > 0.01) return;
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
      // Safari прокручивает документ, чтобы поле было над клавиатурой; каркас
      // уже по высоте видимой части — возвращаем страницу к началу.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      root.style.removeProperty("--app-height");
    };
  }, []);
}
