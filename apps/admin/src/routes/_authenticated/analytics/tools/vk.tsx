import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { CalendarSearch, FileSpreadsheet, FileUp, Loader2, Play, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsVkToolsPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AN_TITLES } from "@/lib/analytics/labels";
import { invalidateVk, vkLfOverviewQuery } from "@/lib/analytics/vk/data";
import { browserInflate, vkAccountsFromXlsx, type VkImportRecord } from "@/lib/analytics/vk/import";
import { importVkAccounts } from "@/lib/analytics/vk.functions";
import {
  auditLeadFormDates,
  backfillLeadFormMetrics,
  collectLeadFormsNow,
  verifyLeadFormSheets,
} from "@/lib/analytics/vk-lf.functions";

export const Route = createFileRoute("/_authenticated/analytics/tools/vk")({
  head: () => ({ meta: [{ title: "Обслуживание VK Ads — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkToolsPageSkeleton,
  component: AnalyticsVkToolsPage,
});

/**
 * «Аналитика» → «Инструменты» → «Обслуживание VK Ads» (администратору
 * аналитики) — их программа «VK Ads Panel»: «Импортировать рекламные
 * кабинеты» из файла API_VK_ADS.xlsx (их export_vk_ads_accounts.py +
 * vk_ads_import.py; файл читает браузер, ключи шифрует сервер) и кнопки
 * лид-форм: проверка Google-таблиц, сбор новых ЛФ кабинета, даты ЛФ,
 * заявки ЛФ за текущий месяц.
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
          Служебные действия их программы «VK Ads Panel». Сбор остатков и расходов, заявки ЛФ за
          месяц — сами, раз в час («Фоновые задачи»).
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
        <LeadFormTools />
      </div>
    </AdminShell>
  );
}

/** Кнопки лид-форм их «VK Ads Panel». */
function LeadFormTools() {
  const { data } = useQuery(vkLfOverviewQuery);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [sheets, setSheets] = useState<
    { account: string; city: string; ok: boolean; text: string }[] | null
  >(null);
  const [account, setAccount] = useState("");
  const [collected, setCollected] = useState<string | null>(null);
  const [city, setCity] = useState("");
  const [dates, setDates] = useState<string | null>(null);
  const sources = data?.sources ?? [];

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const spin = (key: string, icon: ReactNode) =>
    busy === key ? <Loader2 className="animate-spin" /> : icon;

  return (
    <>
      <section className="space-y-3 rounded-lg border bg-background p-4">
        <div>
          <h2 className="font-semibold">Заполнить заявки ЛФ за текущий месяц</h2>
          <p className="text-sm text-muted-foreground">
            Догрузит в реестр таргета количество заявок по всем кабинетам с 1-го числа. Старые
            заявки в таблицы не попадут. То же делает фоновая задача раз в час.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void act("backfill", async () => {
              const r = await backfillLeadFormMetrics();
              toast.success(r.message);
            })
          }
        >
          {spin("backfill", <Play />)}
          Заполнить заявки ЛФ
        </Button>
      </section>
      <section className="space-y-3 rounded-lg border bg-background p-4">
        <div>
          <h2 className="font-semibold">Проверить Google-таблицы ЛФ</h2>
          <p className="text-sm text-muted-foreground">
            Проверка доступа к таблице каждого кабинета без добавления заявок или изменения таблиц.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy !== null || !sources.length}
          onClick={() =>
            void act("sheets", async () => {
              setSheets(await verifyLeadFormSheets());
            })
          }
        >
          {spin("sheets", <ShieldCheck />)}
          Проверить таблицы
        </Button>
        {sheets && (
          <ul className="space-y-1 text-sm">
            {sheets.length === 0 && <li className="text-muted-foreground">Таблиц нет.</li>}
            {sheets.map((r, i) => (
              <li key={i} className={r.ok ? undefined : "text-destructive"}>
                {r.ok ? "✓" : "✕"} {r.city || "Город не назначен"} · {r.account} — {r.text}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3 rounded-lg border bg-background p-4">
        <div>
          <h2 className="font-semibold">Проверить сбор новых ЛФ</h2>
          <p className="text-sm text-muted-foreground">
            Запустит обычный сбор одного кабинета без сброса старта: новые заявки запишутся в его
            таблицу.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="sm:w-80" aria-label="Кабинет">
              <SelectValue placeholder={sources.length ? "Кабинет с таблицей" : "Таблиц нет"} />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.account_id} value={String(s.account_id)}>
                  {s.city || "Город не назначен"} · {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={busy !== null || !account}
            onClick={() =>
              void act("collect", async () => {
                const r = await collectLeadFormsNow({ data: { accountId: Number(account) } });
                await invalidateVk(qc);
                setCollected(
                  `${r.account}: форм ${r.forms_checked}, заявок просмотрено ${r.leads_seen}, новых ${r.new_saved}, ` +
                    `записано в таблицу ${r.sheet_sent}, ошибок форм ${r.failed_forms}.`,
                );
              })
            }
          >
            {spin("collect", <Play />)}
            Запустить сбор
          </Button>
        </div>
        {collected && <InfoNote variant="info">{collected}</InfoNote>}
      </section>
      <section className="space-y-3 rounded-lg border bg-background p-4">
        <div>
          <h2 className="font-semibold">Проверить даты ЛФ для расчёта</h2>
          <p className="text-sm text-muted-foreground">
            Без персональных данных покажет, какие даты VK отдаёт по заявкам ЛФ города (до 5 заявок
            с трёх форм каждого кабинета).
          </p>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void act("dates", async () => {
              const r = await auditLeadFormDates({ data: { city } });
              setDates(
                `${r.city_matched ? "Город найден" : "Город не найден — проверены первые кабинеты"}: ` +
                  `кабинетов ${r.accounts}, заявок ${r.lead_samples}. Поля дат: ${r.date_fields.join(", ") || "—"}. ` +
                  `created_at: ${r.created_at_samples.join(" · ") || "—"}`,
              );
            });
          }}
        >
          <FormField label="Город" className="sm:w-64">
            <Input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Например, Абакан"
            />
          </FormField>
          <Button type="submit" variant="outline" disabled={busy !== null}>
            {spin("dates", <CalendarSearch />)}
            Проверить даты
          </Button>
        </form>
        {dates && <InfoNote variant="info">{dates}</InfoNote>}
      </section>
    </>
  );
}
