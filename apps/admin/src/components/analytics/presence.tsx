import { useEffect } from "react";

import { supabase } from "@/integrations/supabase/client";
import { PRESENCE_IDLE_MS, PRESENCE_INTERVAL_MS } from "@/lib/analytics/core";

const INTERACTIONS = ["pointerdown", "mousemove", "keydown", "scroll", "touchstart", "change"];

/**
 * Пульс «Посещаемости» — их activity_script: сразу при открытии страницы и
 * раз в 15 секунд, пока вкладка видна и человек что-то делал последние
 * 3 минуты; сколько засчитать, решает база (an_presence). Прокрутка — и
 * внутренних областей (у них прокручивалась сама страница).
 */
export function AnalyticsPresence({ dashboard }: { dashboard: string }) {
  useEffect(() => {
    let lastInteraction = Date.now();
    const mark = () => {
      lastInteraction = Date.now();
    };
    const send = () => {
      supabase.rpc("an_presence", { p_dashboard: dashboard }).then(
        () => undefined,
        () => undefined,
      );
    };
    for (const e of INTERACTIONS) {
      document.addEventListener(e, mark, { passive: true, capture: true });
    }
    send();
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastInteraction <= PRESENCE_IDLE_MS
      ) {
        send();
      }
    }, PRESENCE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      for (const e of INTERACTIONS) document.removeEventListener(e, mark, { capture: true });
    };
  }, [dashboard]);
  return null;
}
