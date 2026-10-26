import { Clapperboard, Code, MonitorPlay, Vk } from "lucide-react";

import type { KbEmbedProvider } from "@/lib/kb/embed";

/** Значки видео с сервисов — в меню «/» и в блоке (components/kb/media-blocks.tsx). */
export const EMBED_ICON: Record<KbEmbedProvider, typeof MonitorPlay> = {
  rutube: MonitorPlay,
  kinescope: Clapperboard,
  vk: Vk,
  iframe: Code,
};
