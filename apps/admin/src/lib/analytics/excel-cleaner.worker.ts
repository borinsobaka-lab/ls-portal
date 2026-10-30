/**
 * «Очистка Excel» в фоновом потоке браузера (их CleanWorker в QThread):
 * файл не уходит со страницы, интерфейс не замирает на больших выгрузках.
 * Прогресс — как у них: сообщение, только когда меняются процент или текст.
 */
import { cleanWorkbook, formatReport, type DeflateStream } from "./excel-cleaner";
import type { Inflate } from "./onec/xlsx-read";

export type CleanerRequest = { name: string; bytes: ArrayBuffer };
export type CleanerMessage =
  | { type: "progress"; percent: number; message: string }
  | { type: "done"; report: string; output: ArrayBuffer }
  | { type: "error"; message: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CleanerRequest>) => void) | null;
  postMessage: (msg: CleanerMessage, transfer?: Transferable[]) => void;
};

const inflate: Inflate = async function* (data) {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
};

const deflate: DeflateStream = async (source) => {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const out: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(value);
    }
  })();
  try {
    for await (const chunk of source) await writer.write(chunk as BufferSource);
    await writer.close();
  } catch (e) {
    await writer.abort(e).catch(() => undefined);
    throw e;
  }
  await reading;
  return out;
};

ctx.onmessage = async (e) => {
  let lastPercent = -1;
  let lastMessage = "";
  try {
    const { report, output } = await cleanWorkbook(
      e.data.name,
      new Uint8Array(e.data.bytes),
      { inflate, deflate },
      (done, total, message) => {
        const percent = Math.min(Math.floor((done / Math.max(total, 1)) * 100), 100);
        if (percent === lastPercent && message === lastMessage) return;
        lastPercent = percent;
        lastMessage = message;
        ctx.postMessage({ type: "progress", percent, message });
      },
    );
    const buffer = output.buffer as ArrayBuffer;
    ctx.postMessage({ type: "done", report: formatReport(report), output: buffer }, [buffer]);
  } catch (err) {
    ctx.postMessage({ type: "error", message: (err as Error).message || String(err) });
  }
};
