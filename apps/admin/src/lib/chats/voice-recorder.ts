/**
 * Запись голосового в браузере: микрофон (getUserMedia с шумоподавлением),
 * MediaRecorder в формате, который умеет браузер (`pickVoiceMime`), и
 * уровни громкости раз в 50 мс (AnalyserNode) — для живой волны во время
 * записи и волны сообщения. Микрофон освобождается сразу после записи.
 */
import { buildWaveform, pickVoiceMime, VOICE_MIN_SECONDS } from "./voice";

export type VoiceRecording = { blob: Blob; mime: string; duration: number; waveform: number[] };

export class MicUnavailable extends Error {}

export type VoiceRecorder = {
  /** Запись пошла (разрешение получено, микрофон открыт). */
  ready: Promise<void>;
  /** Уровни громкости с начала записи, 0–1. */
  levels: () => number[];
  /** Секунд с начала записи. */
  elapsed: () => number;
  /** Закончить; null — слишком короткая или не началась. */
  stop: () => Promise<VoiceRecording | null>;
  /** Бросить без файла. */
  cancel: () => void;
};

export const canRecordVoice = () =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;

export function startVoiceRecording(): VoiceRecorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let ctx: AudioContext | null = null;
  let timer = 0;
  let startedAt = 0;
  let stoppedAt = 0;
  let aborted = false;
  const chunks: Blob[] = [];
  const levels: number[] = [];

  const release = () => {
    window.clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => {});
    stream = null;
    ctx = null;
  };

  const ready = (async () => {
    if (!canRecordVoice()) throw new MicUnavailable("Браузер не умеет записывать звук");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      throw new MicUnavailable(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Нет доступа к микрофону — разрешите его в настройках браузера для портала"
          : name === "NotFoundError"
            ? "Микрофон не найден"
            : "Не удалось включить микрофон",
      );
    }
    if (aborted) {
      release();
      return;
    }
    const mime = pickVoiceMime((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          // Корень RMS — тихая речь не теряется рядом с громкой.
          levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6));
        }, 50);
      }
    } catch {
      // без волны — запись всё равно идёт
    }
    recorder.start(1000);
    startedAt = performance.now();
  })();

  const elapsed = () => (startedAt ? ((stoppedAt || performance.now()) - startedAt) / 1000 : 0);

  return {
    ready,
    levels: () => levels,
    elapsed,
    cancel: () => {
      aborted = true;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      release();
    },
    stop: async () => {
      aborted = true;
      await ready.catch(() => {});
      const rec = recorder;
      if (!rec || rec.state === "inactive") {
        release();
        return null;
      }
      stoppedAt = performance.now();
      const done = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      await done;
      release();
      const duration = elapsed();
      if (duration < VOICE_MIN_SECONDS || chunks.length === 0) return null;
      const mime = (rec.mimeType || chunks[0].type || "audio/webm").split(";")[0];
      return {
        blob: new Blob(chunks, { type: mime }),
        mime,
        duration: Math.round(duration * 10) / 10,
        waveform: buildWaveform(levels),
      };
    },
  };
}
