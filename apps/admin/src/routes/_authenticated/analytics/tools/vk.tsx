import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FileSpreadsheet, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsVkToolsPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { AN_TITLES } from "@/lib/analytics/labels";
import { invalidateVk } from "@/lib/analytics/vk/data";
import { browserInflate, vkAccountsFromXlsx, type VkImportRecord } from "@/lib/analytics/vk/import";
import { importVkAccounts } from "@/lib/analytics/vk.functions";

export const Route = createFileRoute("/_authenticated/analytics/tools/vk")({
  head: () => ({ meta: [{ title: "Обслуживание VK Ads — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkToolsPageSkeleton,
  component: AnalyticsVkToolsPage,
});

/**
 * «Аналитика» → «Инструменты» → «Обслуживание VK Ads» (администратору
 * аналитики) — их программа «VK Ads Panel»: «Импортировать рекламные
 * кабинеты» из файла API_VK_ADS.xlsx (их export_vk_ads_accounts.py +
 * vk_ads_import.py). Файл читает браузер, ключи шифрует сервер.
 */
function AnalyticsVkToolsPage() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; records: VkImportRecord[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const pick = async (f: File) => {
    setReading(true);
    setResult(null);
    try {
      const records = await vkAccountsFromXlsx(
        new Uint8Array(await f.arrayBuffer()),
        browserInflate,
      );
      setFile({ name: f.name, records });
    } catch {
      setFile(null);
      toast.error("Не удалось прочитать файл — нужен Excel .xlsx.");
    } finally {
      setReading(false);
    }
  };

  const run = async () => {
    if (!file) return;
    if (!file.records.length) {
      toast.error("В файле не найдено ни одного кабинета с названием, ID и ключом.");
      return;
    }
    setImporting(true);
    try {
      const r = await importVkAccounts({ data: { records: file.records } });
      await invalidateVk(qc);
      setResult(
        `Импорт завершён: создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped}. ` +
          "Сбор остатков и расходов запущен; кабинеты без города видят только администраторы.",
      );
      setFile(null);
    } catch (e) {
      toast.error(`Импорт не выполнен: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <AdminShell title={AN_TITLES.vkTools}>
      <div className="max-w-3xl space-y-4">
        <InfoNote>
          Служебные действия их программы «VK Ads Panel». Сбор остатков и расходов идёт сам — раз в
          час («Фоновые задачи»).
        </InfoNote>
        <section className="space-y-3 rounded-lg border bg-background p-4">
          <div>
            <h2 className="font-semibold">Импортировать рекламные кабинеты</h2>
            <p className="text-sm text-muted-foreground">
              Загрузить или обновить кабинеты из файла API_VK_ADS.xlsx: активный лист, со второй
              строки; A — название кабинета, B — ID VK Ads, E — API-ключ. Есть кабинет с таким ID —
              обновятся название и ключ, кабинет включится; город, партнёр и бренд не стираются.
              Новые — бренд Lady Stretch без города: город и партнёра назначьте в{" "}
              <Link
                to="/analytics/vk/accounts"
                className="font-medium text-foreground underline underline-offset-2"
              >
                «Рекламных кабинетах»
              </Link>
              .
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={input}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void pick(f);
              }}
            />
            <Button
              variant="outline"
              disabled={reading || importing}
              onClick={() => input.current?.click()}
            >
              {reading ? <Loader2 className="animate-spin" /> : <FileUp />}
              {file ? "Другой файл" : "Файл API_VK_ADS.xlsx"}
            </Button>
            <Button onClick={() => void run()} disabled={!file || importing || reading}>
              {importing && <Loader2 className="animate-spin" />}
              Импортировать
            </Button>
            {file && (
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                <FileSpreadsheet className="size-4 shrink-0 text-emerald-700" />
                <span className="truncate">
                  {file.name} · кабинетов: {file.records.length}
                </span>
              </span>
            )}
          </div>
          {result && <InfoNote variant="info">{result}</InfoNote>}
        </section>
      </div>
    </AdminShell>
  );
}
