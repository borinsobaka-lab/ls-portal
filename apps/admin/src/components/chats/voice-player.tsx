/**
 * Плеер голосового сообщения: круглая «Слушать / Пауза», волна (сыгранное —
 * цветом чата, нажатие или протяжка по волне — перемотка), время и
 * скорость 1× / 1,5× / 2× (помнится в браузере). Одновременно играет одно
 * голосовое: новое ставит прежнее на паузу. Ссылка — подписанная (chat-files).
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";

import { useChatFileUrl } from "@/lib/chats/files";
import type { ChatAttachment } from "@/lib/chats/types";
import { formatVoiceTime, nextVoiceRate, resampleWaveform } from "@/lib/chats/voice";
import { cn } from "@/lib/utils";

const BARS = 40;
const RATE_KEY = "chat_voice_rate";
let playing: HTMLAudioElement | null = null;

function readRate(): number {
  try {
    const r = Number(window.localStorage.getItem(RATE_KEY));
    return r === 1.5 || r === 2 ? r : 1;
  } catch {
    return 1;
  }
}

export function VoicePlayer({ file, mine = false }: { file: ChatAttachment; mine?: boolean }) {
  const { data: url, isError } = useChatFileUrl(file.path);
  const audio = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(file.duration ?? 0);
  const [rate, setRate] = useState(1);
  const wave = resampleWaveform(file.waveform, BARS);
  const share = duration > 0 ? Math.min(1, time / duration) : 0;

  useEffect(() => setRate(readRate()), []);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    const el = audio.current;
    return () => {
      if (el && playing === el) {
        el.pause();
        playing = null;
      }
    };
  }, []);

  const toggle = async () => {
    const el = audio.current;
    if (!el || !url) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    el.playbackRate = rate;
    setState("loading");
    try {
      await el.play();
    } catch {
      setState("idle");
    }
  };

  const seek = (clientX: number, target: HTMLElement) => {
    const el = audio.current;
    if (!el || !duration) return;
    const box = target.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration;
    el.currentTime = t;
    setTime(t);
  };

  const changeRate = () => {
    const r = nextVoiceRate(rate);
    setRate(r);
    try {
      window.localStorage.setItem(RATE_KEY, String(r));
    } catch {
      // без памяти скорости
    }
  };

  return (
    <div className="flex w-64 max-w-full items-center gap-2.5 py-0.5 sm:w-72">
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onPlaying={() => setState("playing")}
          onPause={() => setState("paused")}
          onWaiting={() => setState("loading")}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onEnded={(e) => {
            setState("idle");
            setTime(0);
            e.currentTarget.currentTime = 0;
            if (playing === e.currentTarget) playing = null;
          }}
        />
      )}
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={!url}
        aria-label={state === "playing" ? "Пауза" : "Слушать голосовое"}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-chat-accent text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {state === "loading" || (!url && !isError) ? (
          <Loader2 className="size-4 animate-spin" />
        ) : state === "playing" ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="ml-0.5 size-4 fill-current" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          className="flex h-7 cursor-pointer touch-none items-center gap-[2px]"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.buttons) seek(e.clientX, e.currentTarget);
          }}
          onKeyDown={(e) => {
            const el = audio.current;
            if (!el) return;
            if (e.key === "ArrowRight") el.currentTime = Math.min(duration, el.currentTime + 5);
            else if (e.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
            else if (e.key === " " || e.key === "Enter") void toggle();
            else return;
            e.preventDefault();
          }}
        >
          {wave.map((v, i) => (
            <span
              key={i}
              className={cn(
                "min-w-[2px] flex-1 rounded-full transition-colors",
                (i + 0.5) / wave.length <= share
                  ? "bg-chat-accent"
                  : mine
                    ? "bg-chat-accent/30"
                    : "bg-foreground/20",
              )}
              style={{ height: `${Math.max(12, v)}%` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>{formatVoiceTime(state === "idle" ? duration : time)}</span>
          {isError && <span className="text-destructive">не загрузилось</span>}
          <button
            type="button"
            onClick={changeRate}
            className="ml-auto rounded-full px-1.5 py-px font-medium hover:bg-black/5"
            aria-label={`Скорость ${rate}×`}
            title="Скорость"
          >
            {String(rate).replace(".", ",")}×
          </button>
        </div>
      </div>
    </div>
  );
}
