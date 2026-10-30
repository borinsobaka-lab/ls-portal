import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, RefreshCw, Settings } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import { formatMsk } from "@/lib/analytics/core";
import { saveFitbaseConnection, startFitbaseAction } from "@/lib/analytics/fitbase.functions";
import {
  invalidateFitbase,
  type FbConnectionRow,
  type FbNightly,
} from "@/lib/analytics/fitbase/data";
import { FB_BRANDS, fbAttendanceStateLabel, fbScheduleLabel } from "@/lib/analytics/fitbase/rules";

/** Их format_timestamp для секунд Unix: «дд.мм.гггг чч:мм» по Москве. */
const fbTime = (sec: number | null | undefined) =>
  sec ? formatMsk(new Date(sec * 1000).toISOString()) : "";

/** Их итог карточки студии. */
function fbSummary(c: FbConnectionRow): {
  text: string;
  tone: "info" | "positive" | "negative" | "neutral";
} {
  if (c.busy) return { text: "Выполняется загрузка", tone: "info" };
  if (c.sync_state === "Обновление завершено" || c.sync_state === "Синхронизация завершена") {
    return { text: "Данные обновлены", tone: "positive" };
  }
  if (c.sync_state === "Доступ подтверждён")
    return { text: "Подключение подтверждено", tone: "positive" };
  if (c.synced_at || c.sync_attempt_at) return { text: "Требует внимания", tone: "negative" };
  return { text: "Ожидает загрузки", tone: "neutral" };
}

/** Их карточка студии: итог, «Обновить всё», подробности загрузки. */
export function FbStudioCard({
  c,
  nightly,
  settingsLink = true,
}: {
  c: FbConnectionRow;
  nightly: FbNightly;
  settingsLink?: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const summary = fbSummary(c);
  const updateAll = async () => {
    setBusy(true);
    try {
      await startFitbaseAction({ data: { id: c.id, action: "all" } });
      toast.success("Загрузка студии запущена в фоне.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await invalidateFitbase(qc);
      setBusy(false);
    }
  };
  const rows: [string, string][] = [
    ["Состояние", c.sync_state],
    ["Текущий этап", c.job_progress || "—"],
    ["Лиды обновлены", fbTime(c.synced_at) || "Ещё не загружены"],
    ["Абонементы", c.sales_state || "Ещё не загружены"],
    ["Занятия", fbAttendanceStateLabel(c.attendance_state) || "Занятия ещё не загружены"],
    ["Выручка", (c.revenue_state || "Выручка ещё не загружена").replace(/^Выручка /, "")],
    ["Автообновление", fbScheduleLabel(c, nightly)],
  ];
  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-background p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <StatusChip tone="neutral">
            {c.brand} · {c.city}
          </StatusChip>
          <h3 className="mt-2 truncate text-base font-semibold">{c.name}</h3>
          <p className="truncate text-sm text-muted-foreground">{c.domain}</p>
        </div>
        {settingsLink && (
          <Button asChild size="sm" variant="outline">
            <Link to="/analytics/crm/fitbase/$connectionId" params={{ connectionId: String(c.id) }}>
              <Settings />
              Настройки
            </Link>
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip tone={summary.tone}>{summary.text}</StatusChip>
        <Button size="sm" disabled={c.busy || busy} onClick={() => void updateAll()}>
          {c.busy || busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {c.busy ? "Загрузка…" : "Обновить всё"}
        </Button>
      </div>
      <details className="group text-sm">
        <summary className="cursor-pointer text-muted-foreground select-none">
          Подробности загрузки
        </summary>
        <dl className="mt-2 grid gap-2">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {c.busy && (
          <p className="mt-2 text-xs text-muted-foreground">Статус обновляется автоматически.</p>
        )}
      </details>
    </article>
  );
}

const TIPS = {
  city: "Как в реестре рекламных расходов: по городу и направлению отчёты берут бюджет VK.",
  domain: "Поддомен клуба FitBase или его адрес, например studio.fitbase.io.",
  key: "Ключ API FitBase хранится зашифрованным и больше не показывается.",
  marketing: "Студия будет доступна только для аналитики FitBase.",
};

/** Их «Подключить студию» / «Изменить подключение». */
export function FbConnectionForm({
  current,
  onClose,
}: {
  current: FbConnectionRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: current?.name ?? "",
    brand: (current?.brand ?? "Lady Stretch") as (typeof FB_BRANDS)[number],
    city: current?.city ?? "",
    partner: current?.partner_name ?? "",
    domain: current?.domain ?? "",
    key: "",
    marketingDisabled: current?.marketing_disabled ?? false,
  });
  const [saving, setSaving] = useState(false);
  const set =
    (k: "name" | "city" | "partner" | "domain" | "key") => (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      await saveFitbaseConnection({ data: { id: current?.id ?? null, ...form } });
      await invalidateFitbase(qc);
      toast.success(current ? "Подключение сохранено." : "Студия добавлена.");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={save}>
      <DialogHeader>
        <DialogTitle>{current ? "Изменить подключение" : "Подключить студию"}</DialogTitle>
        <DialogDescription>Свяжите данные FitBase с маркетинговыми отчётами.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Название студии" required>
            <Input
              required
              maxLength={150}
              value={form.name}
              onChange={set("name")}
              placeholder="Lady Stretch · Тольятти"
            />
          </FormField>
          <FormField label="Направление" required>
            <Select
              value={form.brand}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, brand: v as (typeof FB_BRANDS)[number] }))
              }
            >
              <SelectTrigger aria-label="Направление">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FB_BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Город" required tip={TIPS.city}>
            <Input
              required
              maxLength={100}
              value={form.city}
              onChange={set("city")}
              placeholder="Как в реестре рекламных расходов"
            />
          </FormField>
          <FormField label="Партнёр">
            <Input
              maxLength={150}
              value={form.partner}
              onChange={set("partner")}
              placeholder="ФИО партнёра или название ИП"
            />
          </FormField>
          <FormField label="Домен FitBase" required tip={TIPS.domain}>
            <Input
              required
              value={form.domain}
              onChange={set("domain")}
              placeholder="Поддомен или адрес клуба.fitbase.io"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Ключ API" required={!current} tip={TIPS.key}>
            <Input
              type="password"
              autoComplete="new-password"
              required={!current}
              value={form.key}
              onChange={set("key")}
              placeholder={
                current ? "Оставьте пустым, чтобы сохранить ключ" : "Введите ключ FitBase"
              }
            />
          </FormField>
        </div>
        <SwitchRow
          title="Не делать маркетинговый отчёт"
          hint={TIPS.marketing}
          checked={form.marketingDisabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, marketingDisabled: v }))}
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отменить
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {current ? "Сохранить подключение" : "Добавить студию"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
