/**
 * Путь звонка по сценарию — в статистику звонков (scripts_call_runs).
 *
 * Звонок начинается с первого ответа клиента и шлётся после каждого шага
 * целиком, под одним id: повторная отправка — обновление, не дубль, а шаг
 * назад убирает шаг и в статистике. Отправка с задержкой, чтобы быстрые
 * клики не превращались в пачку запросов, и досылается при уходе со
 * страницы. Разговор от статистики не зависит: ошибки глотаются.
 * Перенесено из «Аудиоаналитики» (dashboard/src/scripts/callRun.ts).
 */
import { useCallback, useEffect, useRef } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { CallNode, CallRunStep, ScriptLang } from "./types";

export type CallStep = {
  id: string;
  /** Что ответил клиент на этом шаге (кнопка), или «переход» из панели. */
  answer?: string;
  /** Когда открыли блок. */
  at?: string;
};

/** Аргументы RPC scripts_save_call_run. */
export type CallRunBody = {
  _id: string;
  _section_id: string;
  _path: CallRunStep[];
  _finished: boolean;
  _studio: string;
  _lang: ScriptLang;
};

export function newRunId(): string {
  // randomUUID есть только на https и localhost.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function runBody({
  runId,
  sectionId,
  byId,
  path,
  finished,
  studio,
  lang,
}: {
  runId: string;
  sectionId: string;
  byId: Map<string, CallNode>;
  path: CallStep[];
  finished: boolean;
  studio: string;
  lang: ScriptLang;
}): CallRunBody {
  const now = new Date().toISOString();
  return {
    _id: runId,
    _section_id: sectionId,
    _path: path.map((s) => {
      const node = byId.get(s.id);
      return {
        id: s.id,
        title: (node?.title ?? s.id).slice(0, 120),
        group: node?.group ?? "main",
        answer: (s.answer ?? "").slice(0, 120),
        at: s.at ?? now,
      };
    }),
    _finished: finished,
    _studio: studio.slice(0, 120),
    _lang: lang,
  };
}

function send(body: CallRunBody) {
  // Ошибки не показываем: статистика не должна мешать разговору.
  void supabase.rpc("scripts_save_call_run", body).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Следит за путём и шлёт его в статистику. runId = undefined — не слать
 * (тестовый прогон). Возвращает end(): звонок закончился на текущем блоке —
 * например, нажали «Новый звонок».
 */
export function useCallRun({
  sectionId,
  byId,
  path,
  runId,
  atEnd,
  studio,
  lang,
}: {
  sectionId: string;
  byId: Map<string, CallNode>;
  path: CallStep[];
  runId: string | undefined;
  atEnd: boolean;
  studio: string;
  lang: ScriptLang;
}): () => void {
  const started = path.length > 1;
  const pending = useRef<CallRunBody | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    pending.current = null;
    if (body) send(body);
  }, []);

  useEffect(() => {
    if (!started || !runId) return;
    pending.current = runBody({ runId, sectionId, byId, path, finished: atEnd, studio, lang });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [path, started, atEnd, runId, sectionId, byId, studio, lang, flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return useCallback(() => {
    if (started && runId) {
      pending.current = runBody({ runId, sectionId, byId, path, finished: true, studio, lang });
      flush();
    }
  }, [started, runId, sectionId, byId, path, studio, lang, flush]);
}
