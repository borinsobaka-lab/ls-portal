import { useEffect, type RefObject } from "react";

import { supabase } from "@/integrations/supabase/client";

/** Шаг счёта времени, с. */
const TICK_S = 5;
/** Без движения мыши, клавиш, прокрутки дольше этого — человек не читает. */
const IDLE_MS = 90_000;
/** Как часто отправлять накопленное (база берёт не больше 60 с за раз). */
const FLUSH_MS = 30_000;
/** Прокрутку начинаем мерить, когда текст статьи уже отрисован. */
const ARM_MS = 1_500;

/**
 * Учёт чтения статьи (аналитика базы знаний, kb_track_reading): секунды,
 * пока вкладка видна и человек что-то делает (двигает мышь, листает,
 * нажимает клавиши — последние 90 секунд), и докуда он прокрутил текст —
 * доля статьи над нижним краем рабочей области, максимум за визит. Шлёт
 * раз в 30 секунд, при уходе со вкладки и со статьи. В режиме правки и
 * пока текст грузится — выключен (`enabled`): правка — не чтение.
 */
export function useReadingTracker(
  nodeId: string,
  articleRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const article = articleRef.current;
    if (!enabled || !article) return;
    const main = article.closest<HTMLElement>(".admin-main");
    let lastActive = Date.now();
    let pending = 0;
    let maxScroll = 0;
    let sentScroll = 0;
    let armed = false;

    const measure = () => {
      if (!armed) return;
      const rect = article.getBoundingClientRect();
      if (rect.height <= 0) return;
      const bottom = main ? main.getBoundingClientRect().bottom : window.innerHeight;
      const seen = Math.round(Math.min(1, Math.max(0, (bottom - rect.top) / rect.height)) * 100);
      if (seen > maxScroll) maxScroll = seen;
    };
    const activity = () => {
      lastActive = Date.now();
    };
    const onScroll = () => {
      activity();
      measure();
    };
    const flush = () => {
      if (pending <= 0 && maxScroll <= sentScroll) return;
      const seconds = Math.min(pending, 60);
      pending -= seconds;
      sentScroll = maxScroll;
      // Запрос PostgREST ленивый: без then он не уходит.
      void supabase
        .rpc("kb_track_reading", { p_node: nodeId, p_seconds: seconds, p_scroll: maxScroll })
        .then(() => undefined);
    };

    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastActive < IDLE_MS)
        pending += TICK_S;
    }, TICK_S * 1000);
    const send = window.setInterval(flush, FLUSH_MS);
    const arm = window.setTimeout(() => {
      armed = true;
      measure();
    }, ARM_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else activity();
    };
    const resize = new ResizeObserver(measure);
    resize.observe(article);
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    main?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(send);
      window.clearTimeout(arm);
      resize.disconnect();
      events.forEach((e) => window.removeEventListener(e, activity));
      main?.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [nodeId, articleRef, enabled]);
}
