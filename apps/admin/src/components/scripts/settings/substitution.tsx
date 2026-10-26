/**
 * «Подстановка»: то, что подставляется в тексты само.
 *
 * В скрипте пишут {админ}, {студия} или свою {переменную}, а администратор у
 * стойки видит и копирует уже готовый текст: своё имя, свою студию, нужные
 * значения — на языке переписки. Меньше мест, которые надо помнить и
 * заполнять руками, — меньше «Меня зовут Анастасия» от имени Марии.
 *
 * Всё на одной странице и сохраняется одной кнопкой: это одна форма, а не три
 * независимых списка.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ScriptsSubstitutionSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PLACEHOLDER_CLASS, VAR_CLASS, VAR_MISSING_CLASS } from "@/components/scripts/rich-text";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_KEY, useScriptSettings, useScriptStaff } from "@/lib/scripts/data";
import {
  BUILTIN_VARIABLES,
  LEGACY_CLUB_VARIABLE,
  dateAfter,
  dateAfterLabel,
  defaultFirstName,
  formatWhen,
  LANGS,
  VARIABLE_KEY_RE,
} from "@/lib/scripts/logic";
import type { LangText, ScriptSettings, ScriptVariable, StudioNames } from "@/lib/scripts/types";
import { cn } from "@/lib/utils";

type Draft = {
  studios: StudioNames[];
  admins: Record<string, LangText>;
  variables: ScriptVariable[];
};

const EMPTY_LANG: LangText = { ru: "", en: "", ka: "" };

const langOf = ({ ru, en, ka }: LangText): LangText => ({ ru, en, ka });
const hasText = (t: LangText) => LANGS.some((l) => t[l.key]?.trim());

/**
 * Как уйдёт в базу: пустые строки студий отброшены, имена — только
 * заполненные (нет записи — имя берётся из профиля), у переменных — только
 * известные поля.
 */
function clean(d: Draft) {
  return {
    studios: d.studios
      .map((s) => ({ name: s.name.trim(), ...langOf(s) }))
      .filter((s) => s.name || hasText(s)),
    admins: Object.fromEntries(
      Object.entries(d.admins)
        .filter(([, v]) => hasText(v))
        .map(([id, v]) => [id, langOf(v)]),
    ),
    variables: d.variables.map((v) => ({
      key: v.key,
      type: v.type,
      description: v.description,
      ...langOf(v),
      offset_days: v.offset_days,
    })),
  };
}

function fromSettings(s: ScriptSettings): Draft {
  return { studios: s.studios, admins: s.admins, variables: s.variables };
}

/** Что мешает сохранить; пусто — всё в порядке. */
function findProblem(d: Draft): string {
  const names = new Set<string>();
  for (const s of d.studios) {
    const name = s.name.trim();
    if (!name && hasText(s)) return "У клуба не указано название — как в вариантах скриптов";
    if (!name) continue;
    if (names.has(name.toLowerCase())) return `Клуб «${name}» указан дважды`;
    names.add(name.toLowerCase());
  }
  const keys = new Set<string>();
  for (const v of d.variables) {
    if (!VARIABLE_KEY_RE.test(v.key))
      return `Имя переменной «${v.key || "без имени"}» — только буквы, цифры и _, без пробелов`;
    const k = v.key.toLowerCase();
    if (k === LEGACY_CLUB_VARIABLE || BUILTIN_VARIABLES.some((b) => b.key === k))
      return `{${v.key}} подставляется автоматически — выберите другое имя`;
    if (keys.has(k)) return `Переменная {${v.key}} задана дважды`;
    keys.add(k);
  }
  return "";
}

export function SubstitutionTab({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data: settings, isPending } = useScriptSettings();
  const { data: staff = [], isPending: staffLoading } = useScriptStaff();

  // Правки держим отдельно от загруженных настроек: пока поле не трогали,
  // форма показывает данные с сервера (и свежие после «Обновить»).
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const base = useMemo(() => (settings ? fromSettings(settings) : null), [settings]);
  const form = draft ?? base;

  const dirty = useMemo(
    () => !!draft && !!base && JSON.stringify(clean(draft)) !== JSON.stringify(clean(base)),
    [draft, base],
  );
  const problem = useMemo(() => (form ? findProblem(form) : ""), [form]);

  if (isPending || !form || !settings) return <ScriptsSubstitutionSkeleton />;

  const update = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const setStudio = (i: number, patch: Partial<StudioNames>) =>
    update({ studios: form.studios.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setVariable = (i: number, patch: Partial<ScriptVariable>) =>
    update({ variables: form.variables.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const addVariable = (type: ScriptVariable["type"]) =>
    update({
      variables: [
        ...form.variables,
        { key: "", type, description: "", ...EMPTY_LANG, offset_days: type === "date" ? 1 : 0 },
      ],
    });

  const handleSave = async () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      // Пишем поверх текущей записи: ключи, которых эта форма не знает,
      // остаются как были.
      const { data: row, error: readError } = await supabase
        .from("scripts_settings")
        .select("data")
        .maybeSingle();
      if (readError) {
        toast.error("Не удалось сохранить настройки", { description: readError.message });
        return;
      }
      const current = (row?.data ?? {}) as Record<string, unknown>;
      const { error } = await supabase
        .from("scripts_settings")
        .upsert({ id: true, data: { ...current, ...clean(form) } });
      if (error) {
        toast.error("Не удалось сохранить настройки", { description: error.message });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: [SETTINGS_KEY] });
      setDraft(null);
      toast.success("Настройки сохранены — скрипты уже подставляют новые значения");
    } finally {
      setSaving(false);
    }
  };

  const status = problem
    ? problem
    : dirty
      ? "Есть несохранённые изменения"
      : settings.updated_at
        ? `Сохранено ${formatWhen(settings.updated_at)}${settings.updated_by ? ` · ${settings.updated_by}` : ""}`
        : "Пока не сохранялось — показаны имена по умолчанию";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (canEdit && dirty) void handleSave();
      }}
      className="space-y-4"
    >
      <p className="text-sm text-muted-foreground">
        В тексте скрипта пишут {"{админ}"}, {"{клуб}"} или свою {"{переменную}"} — администратор
        видит и копирует уже готовый текст: своё имя, свой клуб, нужные значения, на языке
        переписки.
      </p>

      {/* Без права правки — те же настройки, но только для просмотра:
          fieldset отключает разом все поля и кнопки внутри. */}
      <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
        <Block
          title="Клубы"
          hint="{клуб} — клуб, выбранный над скриптами. Название — как в вариантах скриптов и переключателе клуба."
        >
          {form.studios.length > 0 && <GridHead first="Название" />}
          {form.studios.map((s, i) => (
            <div key={i} className={ROW}>
              <Input
                value={s.name}
                aria-label="Название клуба"
                placeholder="Как в вариантах скриптов"
                onChange={(e) => setStudio(i, { name: e.target.value })}
              />
              <LangInputs
                value={s}
                placeholders={{ ru: s.name || "RU", en: "латиницей", ka: "по-грузински" }}
                onChange={(v) => setStudio(i, v)}
              />
              <RemoveButton
                label="Удалить клуб"
                onClick={() => update({ studios: form.studios.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
          {!form.studios.length && (
            <InfoNote variant="empty">Клубов пока нет — {"{клуб}"} не подставится.</InfoNote>
          )}
          {canEdit && (
            <div>
              <Button
                variant="outline"
                onClick={() => update({ studios: [...form.studios, { name: "", ...EMPTY_LANG }] })}
              >
                <Plus />
                Добавить клуб
              </Button>
            </div>
          )}
        </Block>

        <Block
          title="Имена администраторов"
          hint="{админ} — имя того, кто вошёл; так, как его пишут клиенту. Пусто по-русски — имя из профиля."
        >
          {staffLoading ? (
            // Строки сотрудников той же сетки: имя + три языка.
            Array.from({ length: 2 }, (_, i) => (
              <div key={i} className={ROW}>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))
          ) : staff.length ? (
            <>
              <GridHead first="Сотрудник" />
              {staff.map((a) => {
                const names = form.admins[a.user_id] ?? EMPTY_LANG;
                return (
                  <div key={a.user_id} className={ROW}>
                    <div className="min-w-0 self-center">
                      <p className="truncate font-medium">{a.full_name || a.email || "—"}</p>
                      {a.full_name && a.email && (
                        <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                      )}
                    </div>
                    <LangInputs
                      value={names}
                      placeholders={{
                        ru: defaultFirstName(a.full_name) || "RU",
                        en: "латиницей",
                        ka: "по-грузински",
                      }}
                      onChange={(v) =>
                        update({ admins: { ...form.admins, [a.user_id]: { ...names, ...v } } })
                      }
                    />
                    {/* Колонка под кнопку удаления у студий — чтобы поля стояли ровно. */}
                    <span aria-hidden className="max-md:hidden" />
                  </div>
                );
              })}
            </>
          ) : (
            <InfoNote variant="empty">
              Сотрудники с доступом к «Скриптам LS» добавляются в «Доступах».
            </InfoNote>
          )}
        </Block>

        <Block
          title="Переменные"
          hint="Текст на трёх языках — цены, ссылки, реквизиты; дата — через сколько дней от сегодня."
        >
          <VarLegend />

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {BUILTIN_VARIABLES.map((b) => (
              <span key={b.key} className="flex items-baseline gap-2">
                <code className={VAR_CLASS}>{`{${b.key}}`}</code>
                <span className="text-muted-foreground">{b.description}</span>
              </span>
            ))}
          </div>

          {form.variables.map((v, i) => (
            <div key={i} className="space-y-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex w-full items-center gap-1 sm:w-56">
                  <span aria-hidden className="text-muted-foreground">
                    {"{"}
                  </span>
                  <Input
                    value={v.key}
                    aria-label="Имя переменной"
                    placeholder="цена_пробного"
                    spellCheck={false}
                    onChange={(e) => setVariable(i, { key: e.target.value.trim() })}
                  />
                  <span aria-hidden className="text-muted-foreground">
                    {"}"}
                  </span>
                </div>
                <Input
                  value={v.description}
                  aria-label="Что это"
                  placeholder="Что это — подсказка в редакторе"
                  className="min-w-48 flex-1"
                  onChange={(e) => setVariable(i, { description: e.target.value })}
                />
                <VarStatus variable={v} />
                <RemoveButton
                  label="Удалить переменную"
                  onClick={() => update({ variables: form.variables.filter((_, j) => j !== i) })}
                />
              </div>
              {v.type === "date" ? (
                <DateOffset
                  days={v.offset_days ?? 0}
                  onChange={(days) => setVariable(i, { offset_days: days })}
                />
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {LANGS.map((l) => (
                    <Textarea
                      key={l.key}
                      lang={l.key}
                      rows={Math.min(6, Math.max(2, v[l.key].split("\n").length))}
                      className="min-h-0"
                      value={v[l.key]}
                      aria-label={l.name}
                      placeholder={`${l.label} · ${l.name}`}
                      onChange={(e) => setVariable(i, { [l.key]: e.target.value })}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => addVariable("text")}>
                <Plus />
                Текст
              </Button>
              <Button variant="outline" onClick={() => addVariable("date")}>
                <Plus />
                Дата
              </Button>
            </div>
          )}
        </Block>
      </fieldset>

      {canEdit && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-3">
          <span className={cn("text-sm", problem ? "text-destructive" : "text-muted-foreground")}>
            {status}
          </span>
          <Button type="submit" disabled={saving || !!problem || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Сохранить настройки
          </Button>
        </div>
      )}
      {!canEdit && settings.updated_at && <p className="text-sm text-muted-foreground">{status}</p>}
    </form>
  );
}

/** Строка сетки: подпись/название, три языка, кнопка удаления. */
const ROW =
  "grid grid-cols-1 gap-2 md:grid-cols-[minmax(10rem,14rem)_repeat(3,minmax(0,1fr))_2rem] md:items-center";

function Block({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-lg border bg-background p-4 sm:p-6">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function GridHead({ first }: { first: string }) {
  return (
    <div aria-hidden className={cn(ROW, "max-md:hidden")}>
      <span className="text-xs font-medium text-muted-foreground">{first}</span>
      {LANGS.map((l) => (
        <span key={l.key} className="text-xs font-medium text-muted-foreground">
          {l.label} · {l.name}
        </span>
      ))}
      <span />
    </div>
  );
}

function LangInputs({
  value,
  onChange,
  placeholders,
}: {
  value: LangText;
  onChange: (value: Partial<LangText>) => void;
  placeholders?: Partial<LangText>;
}) {
  return (
    <>
      {LANGS.map((l) => (
        <Input
          key={l.key}
          lang={l.key}
          value={value[l.key]}
          aria-label={l.name}
          placeholder={placeholders?.[l.key] ?? l.label}
          onChange={(e) => onChange({ [l.key]: e.target.value })}
        />
      ))}
    </>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className="justify-self-end"
      onClick={onClick}
    >
      <Trash2 />
    </Button>
  );
}

/** Как переменные выглядят в скриптах — теми же цветами, что там. */
function VarLegend() {
  const rows: { sample: ReactNode; title: string; text: string }[] = [
    {
      sample: <span className={VAR_CLASS}>Мари</span>,
      title: "Подставится.",
      text: "Переменная есть здесь и заполнена на языке текста — в скрипте и при копировании будет значение.",
    },
    {
      sample: <span className={VAR_MISSING_CLASS}>{"{скидка}"}</span>,
      title: "Не подставится.",
      text: "Переменной нет в настройках или она пустая на языке текста — останется в скобках и так же скопируется. Довнесите значение.",
    },
    {
      sample: <span className={PLACEHOLDER_CLASS}>[время]</span>,
      title: "Заполняют руками.",
      text: "Квадратные скобки — администратор меняет сам перед отправкой.",
    },
  ];
  return (
    <InfoNote className="space-y-2 text-sm">
      {rows.map((r) => (
        <div key={r.title} className="flex gap-3">
          <span className="w-20 shrink-0">{r.sample}</span>
          <span>
            <span className="font-medium text-foreground">{r.title}</span> {r.text}
          </span>
        </div>
      ))}
      <ul className="list-disc space-y-1 pl-5">
        <li>
          В тексте скрипта — в фигурных скобках: <code>{"{цена_пробного}"}</code>. Имя — буквы,
          цифры и _, без пробелов.
        </li>
        <li>
          <span className="font-medium text-foreground">Текст</span> — своё значение на RU, EN, GE.
          Пустой язык — оранжевая на этом языке.
        </li>
        <li>
          <span className="font-medium text-foreground">Дата</span> — через N дней от сегодня,
          ДД.ММ, на всех языках одинаково.
        </li>
      </ul>
    </InfoNote>
  );
}

/**
 * Состояние своей переменной по языкам: где подставится (синим), где
 * останется в скобках (оранжевым).
 */
function VarStatus({ variable }: { variable: ScriptVariable }) {
  if (!variable.key) return null;
  if (variable.type === "date")
    return (
      <span className="text-xs" title="Дата подставляется на всех языках одинаково">
        <span className={VAR_CLASS}>все языки</span>
      </span>
    );
  return (
    <span className="flex gap-1 text-xs">
      {LANGS.map((l) => {
        const ok = !!variable[l.key].trim();
        return (
          <span
            key={l.key}
            className={ok ? VAR_CLASS : VAR_MISSING_CLASS}
            title={
              ok
                ? `На ${l.inName} подставится значение`
                : `На ${l.inName} пусто — в скрипте останется {${variable.key}}`
            }
          >
            {l.label}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Дата «через N дней»: число дней и сразу значение на сегодня — видно, что
 * подставится в скрипт и не выпадает ли день на выходной.
 */
function DateOffset({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <label className="flex items-center gap-2">
        <span>через</span>
        <Input
          type="number"
          min={-365}
          max={365}
          value={days}
          className="w-24"
          aria-label="Через сколько дней от сегодня"
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            onChange(Number.isFinite(n) ? Math.max(-365, Math.min(365, n)) : 0);
          }}
        />
        <span className="text-muted-foreground">
          {days === 0 ? "дней — сегодня" : "дн. от сегодня"}
        </span>
      </label>
      <span className="text-muted-foreground">
        На сегодня: <span className="font-medium text-foreground">{dateAfterLabel(days)}</span> — в
        скрипте будет <span className={VAR_CLASS}>{dateAfter(days)}</span> на всех языках
      </span>
    </div>
  );
}
