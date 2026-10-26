import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

/**
 * Итог одной записи: «error» — сеть или сервер (повторим), «conflict» —
 * дальше писать нельзя (кто-то сохранил поверх, правки не затираем).
 */
export type AutosaveResult = "ok" | "error" | "conflict";

const RETRY_MS = 5000;

/**
 * Автосохранение документа редактора (BlockNote): через `delayMs` после
 * паузы в наборе, по одному запросу за раз (поздний ответ старого запроса
 * не перепишет новый текст), ошибка сети — повтор через 5 с, уход со
 * страницы — дописывает, закрывают вкладку с несохранённым — браузер
 * спросит. Как писать — решает `save` (черновик статьи, текст урока).
 */
export function useAutosave(save: (doc: unknown[]) => Promise<AutosaveResult>, delayMs: number) {
  const [state, setState] = useState<AutosaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pendingDoc = useRef<unknown[] | null>(null);
  const lastSaved = useRef<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current;
    const doc = pendingDoc.current;
    if (!doc || stopped.current) return !stopped.current;
    pendingDoc.current = null;
    const json = JSON.stringify(doc);
    if (json === lastSaved.current) {
      setState("saved");
      return true;
    }
    setState("saving");
    let ok = true;
    inflight.current = (async () => {
      const result = await saveRef.current(doc);
      if (result === "conflict") {
        ok = false;
        stopped.current = true;
        setState("conflict");
        return;
      }
      if (result === "error") {
        ok = false;
        // Правки остаются в очереди до следующей попытки.
        pendingDoc.current ??= doc;
        setState("error");
        return;
      }
      lastSaved.current = json;
      setSavedAt(new Date());
      setState(pendingDoc.current ? "pending" : "saved");
    })();
    await inflight.current;
    inflight.current = null;
    if (ok && pendingDoc.current && !stopped.current) return flush();
    return ok;
  }, []);

  const schedule = useCallback(
    (doc: unknown[]) => {
      if (stopped.current) return;
      pendingDoc.current = doc;
      setState("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [flush, delayMs],
  );

  useEffect(() => {
    if (state !== "error") return;
    const t = setTimeout(() => void flush(), RETRY_MS);
    return () => clearTimeout(t);
  }, [state, flush]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (pendingDoc.current || inflight.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      if (pendingDoc.current) void flush();
    };
  }, [flush]);

  /** Документ, каким его открыли: без правок сохранять нечего. */
  const setBaseline = useCallback((doc: unknown[]) => {
    lastSaved.current = JSON.stringify(doc);
  }, []);

  return { state, savedAt, schedule, flush, setBaseline };
}
