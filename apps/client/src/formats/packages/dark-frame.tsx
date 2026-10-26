import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { GlowBlobs } from "@/components/page-shell";
import packagesLogo from "@/assets/packages-logo.svg";

/**
 * Полноэкранный экран пакетного приложения в оформлении разделов (PageShell):
 * сверху тёмная зона с огоньками, под ней белая скруглённая панель с
 * содержимым; кнопка (footer) — внизу панели. Онбординг и вход.
 *
 * Тёмная зона: top (логотип, «Назад» и прогресс) → art (иллюстрация) →
 * header (заголовок). tall — вход, вступление, финал и шаги с картинкой:
 * тёмная зона занимает всё свободное место, белая панель — по содержимому.
 *
 * Слои: картинка → огоньки → текст. Огоньки идут поверх картинки, но не в
 * её центре, где сам рисунок: маска с «дыркой» по замеру картинки.
 *
 * Клавиатура: кадр фиксирован и по высоте равен видимой области
 * (visualViewport) — при открытой клавиатуре он ужимается за счёт тёмной
 * зоны, поле и кнопка остаются видны (Android по умолчанию клавиатуру
 * только накладывает, и 100dvh её не учитывает). Картинку при вводе с
 * телефона прячем сразу (data-typing / data-kb на кадре, без перерисовки
 * React), а не ужимаем; так же — если места под неё меньше ART_MIN_PX.
 */
export function DarkFrame({
  tall = false,
  top,
  art,
  header,
  footer,
  children,
}: {
  tall?: boolean;
  top?: ReactNode;
  art?: string;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const [hole, setHole] = useState<{ x: number; y: number; r: number } | null>(null);

  useVisualViewportFrame(rootRef);

  // Центр и радиус картинки относительно кадра — для «дырки» в огоньках.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const box = artRef.current;
    if (!root || !box) {
      setHole(null);
      return;
    }
    const measure = () => {
      const a = box.getBoundingClientRect();
      const f = root.getBoundingClientRect();
      setHole({
        x: a.left - f.left + a.width / 2,
        y: a.top - f.top + a.height / 2,
        r: Math.min(a.width, a.height) / 2,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(root);
    return () => ro.disconnect();
  }, [art]);

  // До замера (в т.ч. на сервере) картинку показываем.
  const artTooSmall = !!hole && hole.r * 2 < ART_MIN_PX;
  const holeMask =
    art && hole && !artTooSmall
      ? `radial-gradient(circle at ${hole.x}px ${hole.y}px, transparent ${hole.r * 0.45}px, #000 ${hole.r * 0.85}px)`
      : undefined;

  return (
    <div
      ref={rootRef}
      data-dark-frame=""
      className="fixed inset-x-0 top-0 mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden bg-[#2A2B2F]"
    >
      <div
        aria-hidden="true"
        className={`frame-blobs pointer-events-none absolute z-[2] ${
          tall ? "inset-0" : "inset-x-0 top-0 h-[320px]"
        }`}
        style={holeMask ? { WebkitMaskImage: holeMask, maskImage: holeMask } : undefined}
      >
        <GlowBlobs />
      </div>

      {/* Без z-index: иначе картинка и текст окажутся в одном слое. */}
      <div
        className={`relative text-white pt-[max(env(safe-area-inset-top),0.75rem)] ${
          tall ? "flex min-h-0 flex-1 flex-col" : "shrink-0"
        }`}
      >
        {top && <div className="relative z-[3] shrink-0">{top}</div>}
        {art ? (
          <div ref={artRef} className="relative z-[1] mx-6 my-auto min-h-0 max-h-[400px] flex-1">
            {artTooSmall ? null : (
              <img
                src={art}
                alt=""
                className="frame-art art-fade absolute inset-0 m-auto h-full w-full object-contain"
              />
            )}
          </div>
        ) : (
          tall && <div className="flex-1" />
        )}
        <div className="relative z-[3] shrink-0">{header}</div>
      </div>

      <div
        className={`relative z-10 -mt-4 flex flex-col overflow-hidden rounded-t-3xl bg-background shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.08)] ${
          tall ? "max-h-[85%] shrink-0" : "min-h-0 flex-1"
        }`}
      >
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
        <div className="px-4 pt-3 pb-[max(env(safe-area-inset-bottom),1.5rem)]">{footer}</div>
      </div>
    </div>
  );
}

/**
 * Заставка пакетного приложения: тёмный экран с огоньками и логотипом — пока
 * идёт вход и проверка анкеты (__root.tsx) и пока анкета загружается. Раньше
 * в это время был виден каркас главной, и она мелькала перед онбордингом.
 */
export function DarkSplash() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[#2A2B2F]">
      <GlowBlobs />
      <img src={packagesLogo} alt="" className="relative w-[180px] max-w-[60%]" />
    </div>
  );
}

/** Меньше — картинку не показываем вовсе (ужатая до крохи только мешает). */
const ART_MIN_PX = 160;

/** Поля, на которых телефон открывает клавиатуру. */
function opensKeyboard(t: EventTarget | null) {
  if (t instanceof HTMLTextAreaElement) return true;
  if (!(t instanceof HTMLInputElement)) return false;
  return !["date", "checkbox", "radio", "button", "submit", "range"].includes(t.type);
}

/**
 * Высота и сдвиг кадра — по видимой области (visualViewport): открытая
 * клавиатура уменьшает её, кадр ужимается следом (раз в кадр анимации, без
 * перерисовки React). Поле в фокусе после этого докручивается в видимую часть
 * своей прокрутки.
 */
function useVisualViewportFrame(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = rootRef.current;
    if (!vv || !el) return;

    // Клавиатура определяется по видимой области: она ниже обычной высоты
    // (самой большой без клавиатуры) больше чем на KB_PX. innerHeight не
    // годится: в установленном приложении Android ужимает и его.
    const KB_PX = 120;
    let base = vv.height;
    let kbOpen = false;

    // Картинку прячем уже при нажатии на поле (data-typing), не дожидаясь
    // клавиатуры, — но возвращает её закрытие клавиатуры, а не потеря
    // фокуса: на Android клавиатуру убирают «назад» или тапом мимо, и поле
    // остаётся в фокусе. Если клавиатура так и не появилась (внешняя,
    // компьютер), через секунду возвращаем сами.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    let fallback = 0;
    const startTyping = (t: EventTarget | null) => {
      if (!touch || !opensKeyboard(t)) return;
      el.dataset.typing = "";
      window.clearTimeout(fallback);
      fallback = window.setTimeout(() => {
        if (!kbOpen) delete el.dataset.typing;
      }, 1000);
    };
    const stopTyping = () => {
      window.clearTimeout(fallback);
      delete el.dataset.typing;
    };
    const onFocusIn = (e: FocusEvent) => startTyping(e.target);
    // Повторное нажатие на поле, уже бывшее в фокусе: focusin не придёт.
    const onPointerDown = (e: PointerEvent) => startTyping(e.target);
    const onFocusOut = () => {
      if (!kbOpen) stopTyping();
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("focusout", onFocusOut);

    let raf = 0;
    let lastHeight = vv.height;
    const apply = () => {
      raf = 0;
      el.style.height = `${vv.height}px`;
      el.style.top = `${vv.offsetTop}px`;
      const wasOpen = kbOpen;
      kbOpen = base - vv.height > KB_PX;
      if (!kbOpen) base = Math.max(base, vv.height);
      if (kbOpen) el.dataset.kb = "";
      else delete el.dataset.kb;
      // Клавиатуру убрали — картинка возвращается, даже если поле в фокусе.
      if (wasOpen && !kbOpen) stopTyping();
      const shrank = vv.height < lastHeight;
      lastHeight = vv.height;
      const active = document.activeElement;
      if (shrank && active instanceof HTMLElement && el.contains(active)) {
        active.scrollIntoView({ block: "nearest" });
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    // Поворот экрана меняет обычную высоту — меряем заново.
    const onOrientation = () => {
      base = 0;
      schedule();
    };
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", onOrientation);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", onOrientation);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("focusout", onFocusOut);
      el.style.height = "";
      el.style.top = "";
    };
  }, [rootRef]);
}
