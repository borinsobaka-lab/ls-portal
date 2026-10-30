/**
 * «Аналитика» → «Обработка 1С» в браузере: запросы страницы, загрузка
 * выгрузок в хранилище, справочники из Excel и в Excel (их формат). Схема —
 * db/migrations/2026-10-30_analytics_onec.sql, обработка — lib/analytics/onec/.
 */
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "./data";
import { ONEC_KIND_FOLDER, type OnecKind, type OnecReport } from "./onec/process";
import {
  ONEC_REF_FILES,
  onecRefSheet,
  parseOnecRef,
  type OnecRefKind,
  type OnecRefRow,
} from "./onec/refs";
import { iterRows, openXlsx, type Cell, type Inflate } from "./onec/xlsx-read";
import { writeXlsx, type Deflate } from "./onec/xlsx-write";

export const ONEC_BUCKET = "an-onec";
export const onecKey = (...parts: unknown[]) => [ANALYTICS_KEY, "onec", ...parts];

export type OnecRunStatus =
  | "queued"
  | "running"
  | "review"
  | "answered"
  | "done"
  | "error"
  | "cancelled";

export type OnecFile = {
  id: string;
  kind: OnecKind;
  name: string;
  size: number;
  sha256: string | null;
  cleaned: boolean;
  uploaded_at: string;
  uploaded_by: string | null;
};
export type OnecRunCard = {
  id: number;
  status: OnecRunStatus;
  requested_at: string;
  requested_by: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  cancel_requested: boolean;
  progress: string | null;
  error: string | null;
  snapshot_id: number | null;
  log_lines: number;
};
export type OnecReviewItem = {
  code: string;
  name: string;
  reason: string;
  suggested_designation: string;
};
export type OnecRun = OnecRunCard & {
  log: string[];
  review: { items: OnecReviewItem[]; choices: string[] } | null;
  result: { seconds?: number } | null;
};
export type OnecCoverage = {
  rows: number;
  min: string | null;
  max: string | null;
  source_rows: number;
};
export type OnecSnapshotCard = {
  id: number;
  state: "ready" | "current" | "previous";
  run_id: number | null;
  created_at: string;
  ready_at: string | null;
  activated_at: string | null;
  activated_by: string | null;
  generated_at: string | null;
  coverage: Record<OnecReport, OnecCoverage> | null;
  issues: Record<string, number>;
  zeroControls: { blankCostRows?: number; explicitZeroRows?: number; excludedTrialRows?: number };
  breakEvenCities: number;
};
export type OnecRefInfo = {
  rows: number;
  updated_at: string | null;
  updated_by: string | null;
  source: "import" | "edit" | "run" | null;
};
export type OnecOverview = {
  files: OnecFile[];
  refs: Record<OnecRefKind, OnecRefInfo>;
  runs: OnecRunCard[];
  snapshots: OnecSnapshotCard[];
};

export const ONEC_ACTIVE: OnecRunStatus[] = ["queued", "running"];

/** Пока идёт обработка — раз в 2 секунды (ход и журнал), иначе — раз в 30. */
export const onecOverviewQuery = {
  queryKey: onecKey("overview"),
  queryFn: () => unwrap<OnecOverview>(supabase.rpc("an_onec_overview")),
  refetchInterval: (q: { state: { data?: OnecOverview } }) => {
    const latest = q.state.data?.runs[0];
    return latest && ONEC_ACTIVE.includes(latest.status) ? 2_000 : 30_000;
  },
  meta: { errorMessage: "Не удалось загрузить «Обработку 1С»" },
};

/** Последний запуск целиком: перечитывается, когда в обзоре меняются его статус или журнал. */
export const onecRunQuery = (card: OnecRunCard | null) => ({
  queryKey: onecKey("run", card?.id ?? null, card?.status ?? null, card?.log_lines ?? 0),
  queryFn: () => unwrap<OnecRun>(supabase.rpc("an_onec_run_get", { p_id: card!.id })),
  enabled: card !== null,
  placeholderData: (prev: OnecRun | undefined) => (prev && prev.id === card?.id ? prev : undefined),
  meta: { errorMessage: "Не удалось загрузить журнал обработки" },
});

export const onecRefQuery = (ref: OnecRefKind) => ({
  queryKey: onecKey("ref", ref),
  queryFn: () => unwrap<OnecRefRow[]>(supabase.rpc("an_onec_ref_rows", { p_ref: ref })),
  meta: { errorMessage: "Не удалось загрузить справочник" },
});

// --- Подписи ---------------------------------------------------------------------

/** Виды выгрузок — их папки, по порядку окна обработчика. */
export const ONEC_KINDS: { kind: OnecKind; title: string; hint: string }[] = [
  {
    kind: "sales",
    title: ONEC_KIND_FOLDER.sales,
    hint: "По файлу на год: «Продажи 2026г.xlsx». Год в имени нужен воронке пробных.",
  },
  {
    kind: "classes",
    title: ONEC_KIND_FOLDER.classes,
    hint: "«Занятия 2018-2024.xlsx», «Занятия 2025.xlsx», «Занятия 2026.xlsx».",
  },
  {
    kind: "visits",
    title: ONEC_KIND_FOLDER.visits,
    hint: "По файлу на месяц: «Октябрь 2026.xlsx».",
  },
  {
    kind: "cash",
    title: ONEC_KIND_FOLDER.cash,
    hint: "Выгрузка движения денег: «НДЯ выгрузка.xlsx».",
  },
];

export const ONEC_REPORT_TITLES: Record<OnecReport, string> = {
  revenue: "Выручка",
  sales: "Продажи абонементов",
  activities: "Занятия",
  funnel: "Воронка пробных",
  trial_products: "Виды пробных",
  zero: "Нулевая номенклатура",
};

export const ONEC_REF_TITLES: Record<OnecRefKind, string> = {
  studios: "Справочник студий",
  nomenclature: "Справочник номенклатуры",
  break_even: "Точка 0",
};

export const ONEC_ISSUE_TITLES: Record<string, string> = {
  zero_invalid_rows: "Нулевая номенклатура: строк без даты, студии или названия (пропущены)",
};

export const ONEC_RUN_STATUS: Record<
  OnecRunStatus,
  { label: string; tone: "info" | "warning" | "positive" | "negative" | "neutral" }
> = {
  queued: { label: "В очереди", tone: "info" },
  running: { label: "Обработка", tone: "info" },
  review: { label: "Новые номенклатуры", tone: "warning" },
  answered: { label: "Категории выбраны", tone: "neutral" },
  done: { label: "Готово", tone: "positive" },
  error: { label: "Ошибка", tone: "negative" },
  cancelled: { label: "Отменена", tone: "neutral" },
};

/** Время по Москве, как в их обработчике: «28.10.2026 09:57 МСК». */
export function formatMsk(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${s.replace(",", "")} МСК`;
}

/** 00:00 — как счётчик в их окне. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

// --- Выгрузки ---------------------------------------------------------------------

/** Имя в папке без «_очищено» (у них обработчик берёт результат ExcelCleaner). */
export function onecFileName(fileName: string): { name: string; cleaned: boolean } {
  const m = fileName.match(/^(.*)_очищено(\.xlsx)$/i);
  return m ? { name: m[1] + m[2], cleaned: true } : { name: fileName, cleaned: false };
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Выгрузку — в бакет, затем в список; прежний файл с тем же именем удаляется. */
export async function uploadOnecFile(kind: OnecKind, file: File): Promise<void> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error(`«${file.name}» — не файл .xlsx`);
  const { name, cleaned } = onecFileName(file.name);
  const path = `${kind}/${crypto.randomUUID()}.xlsx`;
  const hash = await sha256(file);
  const { error } = await supabase.storage
    .from(ONEC_BUCKET)
    .upload(path, file, { contentType: XLSX_TYPE, upsert: false });
  if (error) throw new Error(`«${file.name}»: ${error.message}`);
  let old: string | null;
  try {
    old = await unwrap<string | null>(
      supabase.rpc("an_onec_file_register", {
        p_kind: kind,
        p_name: name,
        p_path: path,
        p_sha256: hash,
        p_cleaned: cleaned,
      }),
    );
  } catch (e) {
    await supabase.storage.from(ONEC_BUCKET).remove([path]);
    throw e;
  }
  if (old) await supabase.storage.from(ONEC_BUCKET).remove([old]);
}

export async function deleteOnecFile(id: string): Promise<void> {
  const path = await unwrap<string | null>(supabase.rpc("an_onec_file_delete", { p_id: id }));
  if (path) await supabase.storage.from(ONEC_BUCKET).remove([path]);
}

// --- Справочники в Excel ------------------------------------------------------------

const browserInflate: Inflate = async function* (data) {
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

const browserDeflate: Deflate = async (data) =>
  new Uint8Array(
    await new Response(
      new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );

/** Файл справочника (.xlsx, первый активный лист) → строки справочника. */
export async function readOnecRefFile(ref: OnecRefKind, file: File): Promise<OnecRefRow[]> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Нужен файл .xlsx");
  const book = await openXlsx(new Uint8Array(await file.arrayBuffer()), browserInflate, {
    sheet: "active",
  });
  const rows: Cell[][] = [];
  for await (const r of iterRows(book)) rows.push(r);
  return parseOnecRef(ref, rows);
}

/** Справочник → .xlsx с их именем файла. */
export async function downloadOnecRef(ref: OnecRefKind, rows: OnecRefRow[]): Promise<void> {
  const bytes = await writeXlsx([onecRefSheet(ref, rows)], browserDeflate);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: XLSX_TYPE }));
  const a = document.createElement("a");
  a.href = url;
  a.download = ONEC_REF_FILES[ref];
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Текст ошибки базы — по-русски. */
export function onecErrorText(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (m.includes("an_onec_busy")) return "Идёт обработка — дождитесь её окончания.";
  if (m.includes("an_forbidden")) return "Доступно только администратору аналитики.";
  if (m.includes("an_onec_no_object"))
    return "Файл не загрузился в хранилище — попробуйте ещё раз.";
  if (m.includes("an_onec_review_incomplete")) return "Выберите категорию для каждой номенклатуры.";
  if (m.includes("an_onec_review_bad_category"))
    return "Для каждой номенклатуры нужно выбрать определённую категорию.";
  if (m.includes("an_onec_no_review")) return "Окно новых номенклатур уже закрыто.";
  if (m.includes("an_onec_no_snapshot")) return "Этот снимок уже загружен или заменён.";
  if (m.includes("an_onec_no_previous")) return "Предыдущей копии нет.";
  if (m.includes("an_onec_no_code")) return "В справочнике номенклатуры есть строка без кода.";
  if (m.includes("an_onec_too_many_rows")) return "Слишком много строк в справочнике.";
  return m;
}
