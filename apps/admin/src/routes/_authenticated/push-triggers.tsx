import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Save } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContentLangFlag,
  ContentLangLabel,
  ContentLangNote,
  ContentLangSwitch,
} from "@/components/content-lang";
import { PushTriggersPageSkeleton, PushTriggersListSkeleton } from "@/components/page-skeletons";
import { useStudios } from "@/hooks/use-studios";
import { useContentTranslations } from "@/hooks/use-content-translations";
import {
  hasTranslation,
  parseTranslations,
  type ContentLang,
  type ContentTranslations,
} from "@/lib/content-i18n";
import { getPushServiceStatus } from "@/lib/push.functions";
import { plural } from "@/lib/payroll";
import {
  TRIGGER_GROUPS,
  cleanParams,
  hourLabel,
  insertAt,
  triggersOfFormat,
  unknownVars,
  type TriggerDef,
  type TriggerParamKey,
  type TriggerParams,
} from "@/lib/push-triggers";
import {
  STUDIO_FORMATS,
  STUDIO_FORMAT_APP_URL,
  STUDIO_FORMAT_LABEL,
  type StudioFormat,
} from "@/lib/studio-formats";
import { cn } from "@/lib/utils";

/**
 * Триггерные уведомления: автоматические пуши клиентам по событиям
 * (напоминание о занятии, отмена, абонемент заканчивается, платёж…). У
 * каждого клиентского приложения (формата клубов) свой набор: включение,
 * тексты на трёх языках, параметры. Когда и кому уходит — решает база
 * (db/migrations/2026-10-15_push_triggers.sql), отправляет сервер админки
 * вместе с рассылками (lib/push/push-worker.server.ts); каталог с подписями
 * и переменными — lib/push-triggers.ts.
 */

const TIPS = {
  app: "У каждого клиентского приложения свой набор триггеров и свои тексты — для всех его клубов.",
  enabled:
    "Выключенный триггер ничего не отправляет. После включения он реагирует только на новые события — старые не рассылаются.",
  actionUrl:
    "Раздел приложения — /schedule (расписание), /memberships (абонементы), /club (студия), / (главная) — или ссылка https://…. Пусто — откроется уведомление в разделе «Уведомления».",
  vars: "Переменные подставляются для каждого клиента на языке его приложения. Нажмите, чтобы вставить в поле, где стоит курсор.",
};

/** За сколько дней статистика на карточке. */
const STATS_DAYS = 30;

export const Route = createFileRoute("/_authenticated/push-triggers")({
  head: () => ({ meta: [{ title: "Триггерные уведомления — Base40 Admin" }] }),
  pendingComponent: PushTriggersPageSkeleton,
  component: PushTriggersPage,
});

type TriggerRow = {
  format: StudioFormat;
  key: string;
  enabled: boolean;
  title: string;
  message: string | null;
  translations: ContentTranslations;
  action_url: string | null;
  params: TriggerParams;
};

type TriggerStats = {
  trigger_key: string;
  notifications: number;
  devices: number;
  sent: number;
  delivered: number;
  opened: number;
};

const TABLE = "push_triggers";

function PushTriggersPage() {
  const queryClient = useQueryClient();
  const { data: studios = [], isPending: studiosLoading } = useStudios();
  const formats = STUDIO_FORMATS.filter((f) => studios.some((s) => s.format === f));
  const [picked, setPicked] = useState<StudioFormat | null>(null);
  const format = picked && formats.includes(picked) ? picked : (formats[0] ?? null);

  const { data: rows = [], isPending: rowsLoading } = useQuery({
    queryKey: [TABLE],
    queryFn: () => unwrap<TriggerRow[]>(supabase.from(TABLE).select("*")),
    meta: { errorMessage: "Не удалось загрузить триггеры" },
  });

  const { data: stats = [] } = useQuery({
    queryKey: ["push_trigger_stats", format],
    queryFn: () =>
      unwrap<TriggerStats[]>(
        supabase.rpc("push_trigger_stats", {
          p_format: format,
          p_since: new Date(Date.now() - STATS_DAYS * 86_400_000).toISOString(),
        }),
      ),
    enabled: !!format,
    meta: { errorMessage: "Не удалось загрузить статистику триггеров" },
  });

  const serviceStatus = useServerFn(getPushServiceStatus);
  const { data: service } = useQuery({
    queryKey: ["push-service-status"],
    queryFn: () => serviceStatus(),
    staleTime: 5 * 60_000,
  });

  const [editing, setEditing] = useState<{ def: TriggerDef; row: TriggerRow } | null>(null);

  const setRow = (format: StudioFormat, key: string, patch: Partial<TriggerRow>) =>
    queryClient.setQueryData<TriggerRow[]>([TABLE], (prev = []) =>
      prev.map((r) => (r.format === format && r.key === key ? { ...r, ...patch } : r)),
    );

  const toggle = async (row: TriggerRow, enabled: boolean) => {
    setRow(row.format, row.key, { enabled });
    const { data, error } = await supabase
      .from(TABLE)
      .update({ enabled })
      .eq("format", row.format)
      .eq("key", row.key)
      .select("key");
    if (error || !data?.length) {
      setRow(row.format, row.key, { enabled: row.enabled });
      toast.error("Не удалось сохранить", {
        description: error?.message ?? "Нет доступа к триггерам этого приложения",
      });
      return;
    }
    toast.success(enabled ? "Триггер включён" : "Триггер выключен");
  };

  const loading = studiosLoading || rowsLoading;
  const formatRows = rows.filter((r) => r.format === format);
  const defs = format ? triggersOfFormat(format) : [];

  return (
    <AdminShell title="Триггерные уведомления">
      <div className="max-w-3xl space-y-6">
        {service && !service.ready ? (
          <InfoNote variant="warning">
            Рассылка не настроена на сервере: не задан сервис-ключ Supabase
            (APP_SUPABASE_SERVICE_KEY). Триггерные уведомления не отправляются.
          </InfoNote>
        ) : null}

        {formats.length > 1 && format ? (
          <FormField label="Приложение" tip={TIPS.app} htmlFor={null}>
            <SegmentedControl
              aria-label="Приложение"
              value={format}
              onChange={setPicked}
              options={formats.map((f) => ({
                value: f,
                label: STUDIO_FORMAT_APP_URL[f].replace(/^https?:\/\//, ""),
                title: STUDIO_FORMAT_LABEL[f],
              }))}
            />
          </FormField>
        ) : null}

        <InfoNote>
          Уходят автоматически клиентам с приложением: пуш — на телефоны с включёнными
          уведомлениями, на языке приложения клиента; у всех — в разделе «Уведомления». Одно событие
          — одно уведомление. Ночью (22:00–09:00 по Тбилиси) не приходят напоминания об оценке,
          пробном и остатке тренировок — они уходят утром.
        </InfoNote>

        {loading ? (
          <PushTriggersListSkeleton />
        ) : !format ? (
          <InfoNote variant="empty">У вас нет клубов — настраивать нечего.</InfoNote>
        ) : formatRows.length === 0 ? (
          <InfoNote variant="empty">
            Триггеров пока нет: они появятся после обновления базы (миграция
            2026-10-15_push_triggers.sql).
          </InfoNote>
        ) : (
          TRIGGER_GROUPS.map((g) => {
            const items = defs
              .filter((d) => d.group === g.key)
              .map((def) => ({ def, row: formatRows.find((r) => r.key === def.key) }))
              .filter((x): x is { def: TriggerDef; row: TriggerRow } => !!x.row);
            if (items.length === 0) return null;
            return (
              <section key={g.key} className="space-y-3">
                <h2 className="text-lg font-semibold">{g.title}</h2>
                {items.map(({ def, row }) => (
                  <TriggerCard
                    key={def.key}
                    def={def}
                    row={row}
                    stats={stats.find((s) => s.trigger_key === def.key)}
                    onToggle={(v) => toggle(row, v)}
                    onEdit={() => setEditing({ def, row })}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-xl">
          {editing ? (
            <TriggerForm
              key={`${editing.row.format}-${editing.row.key}`}
              def={editing.def}
              row={editing.row}
              onClose={() => setEditing(null)}
              onSaved={(saved) => setRow(saved.format, saved.key, saved)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Текст шаблона: {переменные} — подсвечены. */
function TemplateText({ text }: { text: string }) {
  const parts = text.split(/(\{[^{}\s]+\})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\{[^{}\s]+\}$/.test(p) ? (
          <span key={i} className="rounded-sm bg-muted px-0.5 font-medium text-foreground">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

function statsLine(s: TriggerStats | undefined): string {
  if (!s || s.notifications === 0) return `За ${STATS_DAYS} дней не срабатывал`;
  return [
    `За ${STATS_DAYS} дней: ${s.notifications} ${plural(s.notifications, ["уведомление", "уведомления", "уведомлений"])}`,
    `пуш принят на ${s.sent} ${plural(s.sent, ["телефоне", "телефонах", "телефонах"])}`,
    `прочитано ${s.opened}`,
  ].join(" · ");
}

function TriggerCard({
  def,
  row,
  stats,
  onToggle,
  onEdit,
}: {
  def: TriggerDef;
  row: TriggerRow;
  stats: TriggerStats | undefined;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
}) {
  const translations = parseTranslations(row.translations);
  const langs = (["en", "ka"] as const).filter((l) => hasTranslation(translations, l));
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{def.name}</span>
          {!row.enabled ? <StatusChip tone="neutral">Выключен</StatusChip> : null}
          {langs.map((l) => (
            <ContentLangFlag key={l} lang={l} className="size-3.5" />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{def.describe(row.params)}</p>
        <InfoNote className={cn("text-sm", !row.enabled && "opacity-60")}>
          <div className="font-medium text-foreground">
            <TemplateText text={row.title} />
          </div>
          {row.message ? (
            <div className="mt-0.5 text-muted-foreground">
              <TemplateText text={row.message} />
            </div>
          ) : null}
        </InfoNote>
        <p className="text-xs text-muted-foreground">{statsLine(stats)}</p>
      </div>
      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
        <Switch
          checked={row.enabled}
          onCheckedChange={onToggle}
          aria-label={row.enabled ? `Выключить «${def.name}»` : `Включить «${def.name}»`}
        />
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil />
          Изменить
        </Button>
      </div>
    </div>
  );
}

/** Пример подстановки для «Как увидит клиент». */
const SAMPLES: Record<ContentLang, Record<string, string>> = {
  ru: {
    name: "Анна",
    class: "Стретчинг",
    when: "сегодня в 18:00",
    date: "17.10",
    time: "18:00",
    trainer: "Ольга",
    club: "Ваке",
    membership: "Пакет 8",
    days: "3",
    left: "2",
    amount: "150",
  },
  en: {
    name: "Anna",
    class: "Stretching",
    when: "today at 18:00",
    date: "17.10",
    time: "18:00",
    trainer: "Olga",
    club: "Vake",
    membership: "Package 8",
    days: "3",
    left: "2",
    amount: "150",
  },
  ka: {
    name: "ანა",
    class: "სტრეჩინგი",
    when: "დღეს 18:00-ზე",
    date: "17.10",
    time: "18:00",
    trainer: "ოლგა",
    club: "ვაკე",
    membership: "პაკეტი 8",
    days: "3",
    left: "2",
    amount: "150",
  },
};

const fillSample = (text: string, lang: ContentLang) =>
  text.replace(/\{([^{}\s]+)\}/g, (m, v: string) => SAMPLES[lang][v] ?? m);

type ParamDraft = Partial<Record<TriggerParamKey, string>>;

function TriggerForm({
  def,
  row,
  onClose,
  onSaved,
}: {
  def: TriggerDef;
  row: TriggerRow;
  onClose: () => void;
  onSaved: (row: TriggerRow) => void;
}) {
  const tr = useContentTranslations(row.translations);
  const [enabled, setEnabled] = useState(row.enabled);
  const [title, setTitle] = useState(row.title);
  const [message, setMessage] = useState(row.message ?? "");
  const [actionUrl, setActionUrl] = useState(row.action_url ?? "");
  const [params, setParams] = useState<ParamDraft>(() =>
    Object.fromEntries(
      def.params.map((p) => [p.key, String(row.params[p.key] ?? def.defaults[p.key] ?? "")]),
    ),
  );
  const [saving, setSaving] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  // Куда вставлять переменную: поле, где был курсор последним.
  const [target, setTarget] = useState<"title" | "message">("message");

  const titleText = tr.text("title", title, setTitle, "Заголовок уведомления");
  const messageText = tr.text("message", message, setMessage, "Текст уведомления");
  const unknown = unknownVars([titleText.value, messageText.value], def.vars);
  const parsedParams: TriggerParams = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, v === "" ? Number.NaN : Number(v)]),
  );

  const insertVar = (name: string) => {
    const binding = target === "title" ? titleText : messageText;
    const el = target === "title" ? titleRef.current : messageRef.current;
    const { text, caret } = insertAt(
      binding.value,
      `{${name}}`,
      el?.selectionStart,
      el?.selectionEnd,
    );
    binding.onChange(text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const handleSave = async () => {
    if (!title.trim()) {
      tr.setLang("ru");
      toast.error("Укажите заголовок");
      return;
    }
    for (const p of def.params) {
      const v = parsedParams[p.key];
      if (v === undefined || !Number.isInteger(v) || v < p.min || v > p.max) {
        toast.error(`«${p.label}» — целое число от ${p.min} до ${p.max}`);
        return;
      }
    }
    const payload = {
      enabled,
      title: title.trim(),
      message: message.trim() || null,
      translations: tr.cleaned(),
      action_url: actionUrl.trim() || null,
      params: cleanParams(def, parsedParams),
    };
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .update(payload)
        .eq("format", row.format)
        .eq("key", row.key)
        .select("key");
      if (error || !data?.length) {
        toast.error("Не удалось сохранить", {
          description: error?.message ?? "Нет доступа к триггерам этого приложения",
        });
        return;
      }
      onSaved({ ...row, ...payload });
      toast.success("Триггер сохранён");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const previewTitle = fillSample(titleText.value || title, tr.lang);
  const previewMessage = fillSample(messageText.value || message, tr.lang);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{def.name}</DialogTitle>
        <DialogDescription>
          {def.describe(
            Object.fromEntries(Object.entries(parsedParams).filter(([, v]) => Number.isFinite(v))),
          )}
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <SwitchRow
              title="Триггер включён"
              tip={TIPS.enabled}
              checked={enabled}
              onCheckedChange={setEnabled}
            />

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Заголовок</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input
                ref={titleRef}
                value={titleText.value}
                placeholder={titleText.placeholder}
                onChange={(e) => titleText.onChange(e.target.value)}
                onFocus={() => setTarget("title")}
                maxLength={150}
              />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Сообщение</ContentLangLabel>}
              tip="На экране блокировки видно 2–3 строки — главное пишите в начале."
              optional
            >
              <Textarea
                ref={messageRef}
                value={messageText.value}
                placeholder={messageText.placeholder}
                onChange={(e) => messageText.onChange(e.target.value)}
                onFocus={() => setTarget("message")}
                rows={4}
                maxLength={600}
              />
            </FormField>

            <FormField label="Переменные" tip={TIPS.vars} htmlFor={null}>
              <ul className="space-y-1">
                {Object.entries(def.vars).map(([name, hint]) => (
                  <li key={name} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Button
                      variant="outline"
                      size="xs"
                      className="w-24 shrink-0"
                      onClick={() => insertVar(name)}
                    >
                      {`{${name}}`}
                    </Button>
                    <span>{hint}</span>
                  </li>
                ))}
              </ul>
            </FormField>

            {unknown.length > 0 ? (
              <InfoNote variant="warning">
                У этого триггера нет{" "}
                {plural(unknown.length, ["переменной", "переменных", "переменных"])}{" "}
                {unknown.map((v) => `{${v}}`).join(", ")} — клиент увидит их как есть.
              </InfoNote>
            ) : null}

            {previewTitle ? <PreviewBox title={previewTitle} message={previewMessage} /> : null}

            {def.params.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {def.params.map((p) =>
                  p.key === "send_hour" ? (
                    <FormField key={p.key} label={p.label} tip={p.tip} required>
                      <Select
                        value={params.send_hour ?? ""}
                        onValueChange={(v) => setParams((prev) => ({ ...prev, send_hour: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Час" />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: p.max - p.min + 1 }, (_, i) => p.min + i).map(
                            (h) => (
                              <SelectItem key={h} value={String(h)}>
                                {hourLabel(h)}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </FormField>
                  ) : (
                    <FormField
                      key={p.key}
                      label={p.label}
                      tip={p.tip}
                      hint={`От ${p.min} до ${p.max}`}
                      required
                    >
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={p.min}
                        max={p.max}
                        step={1}
                        value={params[p.key] ?? ""}
                        onChange={(e) =>
                          setParams((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                      />
                    </FormField>
                  ),
                )}
              </div>
            ) : null}

            <FormField label="Ссылка перехода" optional tip={TIPS.actionUrl}>
              <Input
                value={actionUrl}
                onChange={(e) => setActionUrl(e.target.value)}
                placeholder="/schedule или https://…"
                maxLength={1000}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/** «Как увидит клиент»: пример с подставленными значениями. */
function PreviewBox({ title, message }: { title: string; message: string }): ReactNode {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">Как увидит клиент (пример)</div>
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <div className="font-semibold">{title}</div>
        {message ? <div className="mt-0.5 text-muted-foreground">{message}</div> : null}
      </div>
    </div>
  );
}
