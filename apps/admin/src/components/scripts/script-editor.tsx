/**
 * Правка скрипта — у кого «Правка скриптов» в «Доступах».
 *
 * Форма повторяет устройство карточки: пояснение, варианты по студиям,
 * сообщения на трёх языках, «что дальше». Сохранение правки — в два шага:
 * сначала «Что изменили?» (увидят все внизу карточки и в хронологии), потом
 * запись. Новый скрипт сохраняется сразу — у него «Новый скрипт».
 * Удаление — после двух подтверждений: скрипт пропадает у всех сразу.
 */
import { useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { FormatBar, VariableChips } from "@/components/scripts/format-bar";
import { cleanDraft, emptyMessage, KIND_LABELS, LANGS } from "@/lib/scripts/logic";
import type {
  ScriptItemDraft,
  ScriptKind,
  ScriptLang,
  ScriptMessage,
  ScriptSection,
  ScriptVariant,
} from "@/lib/scripts/types";

function rowsFor(value: string, min = 3): number {
  return Math.min(18, Math.max(min, value.split("\n").length + 1));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ScriptEditor({
  initial,
  initialTitle,
  sections,
  studios,
  variables,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  initial: ScriptItemDraft;
  /** Название до правки — для вопроса об удалении. */
  initialTitle?: string;
  /** Текстовые разделы — куда можно положить скрипт. */
  sections: ScriptSection[];
  /** Названия студий, под которые можно разделить текст. */
  studios: string[];
  /** Что можно вставить в текст: {админ}, {студия}, свои. */
  variables: { key: string; description: string }[];
  isNew: boolean;
  onSave: (draft: ScriptItemDraft, changeNote: string) => Promise<void>;
  /** Удаление — только у существующего скрипта. */
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [draft, setDraft] = useState<ScriptItemDraft>(() => clone(initial));
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  // Поле, в котором стоял курсор: туда вставляется переменная по кнопке.
  const lastField = useRef<string | null>(null);
  const byStudio = draft.variants.length > 1;

  const patch = (fields: Partial<ScriptItemDraft>) => setDraft((d) => ({ ...d, ...fields }));
  const setVariants = (fn: (variants: ScriptVariant[]) => ScriptVariant[]) =>
    setDraft((d) => ({ ...d, variants: fn(clone(d.variants)) }));
  const setMessage = (vi: number, mi: number, fields: Partial<ScriptMessage>) =>
    setVariants((vs) => {
      vs[vi].messages[mi] = { ...vs[vi].messages[mi], ...fields };
      return vs;
    });
  const moveMessage = (vi: number, mi: number, delta: -1 | 1) =>
    setVariants((vs) => {
      const list = vs[vi].messages;
      const [m] = list.splice(mi, 1);
      list.splice(mi + delta, 0, m);
      return vs;
    });

  /** Разделить по клубам: обычно отличается только адрес и дорога — тексты копируются. */
  const splitByStudio = () =>
    setVariants((vs) => {
      const labels = studios.length >= 2 ? studios : ["Клуб 1", "Клуб 2"];
      return labels.map((label) => ({ label, messages: clone(vs[0].messages) }));
    });

  const removeVariant = (vi: number) =>
    setVariants((vs) => {
      vs.splice(vi, 1);
      if (vs.length === 1) vs[0].label = "";
      return vs;
    });

  const focusProps = (id: string) => ({
    id,
    onFocus: () => {
      lastField.current = id;
    },
  });

  function insertInto(fieldId: string, next: string) {
    const m = /^msg-(\d+)-(\d+)-(ru|en|ka)$/.exec(fieldId);
    if (m) setMessage(Number(m[1]), Number(m[2]), { [m[3] as ScriptLang]: next });
    else if (fieldId === "ed-note") patch({ note: next });
    else if (fieldId === "ed-follow") patch({ follow_up: next });
  }

  function validate(): string | null {
    if (!draft.title.trim()) return "Дайте скрипту название — по нему его будут искать";
    const labels = draft.variants.map((v) => v.label.trim());
    if (byStudio && labels.some((l) => !l)) return "У каждого варианта должно быть название клуба";
    if (new Set(labels).size !== labels.length) return "Названия вариантов повторяются";
    for (const v of draft.variants) {
      if (!v.messages.some((m) => LANGS.some((l) => m[l.key].trim())))
        return v.label
          ? `В варианте «${v.label}» нет ни одного текста`
          : "Добавьте текст хотя бы на одном языке";
    }
    return null;
  }

  async function commit(note: string) {
    if (!note.trim()) {
      toast.error("Опишите в двух словах, что изменили, — это увидят все на карточке скрипта");
      return;
    }
    setSaving(true);
    try {
      await onSave(cleanDraft(draft), note.trim());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit() {
    if (asking) {
      void commit(changeNote);
      return;
    }
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    if (isNew) void commit("Новый скрипт");
    else setAsking(true);
  }

  async function handleDelete() {
    if (!onDelete) return;
    const title = draft.title || initialTitle || "";
    if (!(await confirm({ title: "Удалить скрипт?", description: `«${title}» пропадёт у всех.` })))
      return;
    if (
      !(await confirm({
        title: "Точно удалить?",
        description:
          "Скрипт пропадёт у всех сразу, вернуть его будет нельзя — только переписать по хронологии.",
        confirmLabel: "Удалить навсегда",
      }))
    )
      return;
    setSaving(true);
    try {
      await onDelete();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isNew ? "Новый скрипт" : "Правка скрипта"}</DialogTitle>
        <DialogDescription>
          {asking
            ? "Скрипт поменяется у всех сразу — коротко скажите, что и зачем."
            : "Тексты сообщений уходят клиенту как есть; оформление — только в подсказках."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody>
          {asking ? (
            <FormField
              label="Что изменили?"
              required
              hint="Это увидят все на карточке скрипта и в хронологии."
            >
              <Input
                autoFocus
                maxLength={500}
                value={changeNote}
                placeholder="Например: обновили цену пробного, добавили ветку для EN"
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </FormField>
          ) : (
            <div className="space-y-4">
              <FormField label="Название" required>
                <Input
                  autoFocus={isNew}
                  value={draft.title}
                  maxLength={255}
                  placeholder="Например: «Где мы?» или «Дорого»"
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </FormField>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField label="Тип" required>
                  <Select
                    value={draft.kind}
                    onValueChange={(v) => patch({ kind: v as ScriptKind })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(KIND_LABELS) as ScriptKind[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {KIND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  label="Раздел"
                  required
                  tip="Перенесённый в другой раздел скрипт встаёт в его конец."
                >
                  <Select value={draft.section_id} onValueChange={(v) => patch({ section_id: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sections.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <FormField
                label="Как использовать"
                optional
                htmlFor="ed-note"
                hint="Подсказка сотрудникам: когда отправлять, что проверить. Клиенту не копируется."
              >
                <FormatBar
                  targetId="ed-note"
                  value={draft.note}
                  onChange={(note) => patch({ note })}
                  sections={sections}
                />
                <Textarea
                  {...focusProps("ed-note")}
                  value={draft.note}
                  rows={rowsFor(draft.note, 2)}
                  onChange={(e) => patch({ note: e.target.value })}
                />
              </FormField>

              {draft.variants.map((variant, vi) => (
                <div
                  key={vi}
                  className={byStudio ? "space-y-3 rounded-md border p-3" : "space-y-3"}
                >
                  {byStudio && (
                    <div className="flex items-end gap-2">
                      <FormField label="Клуб" required className="flex-1">
                        <Input
                          value={variant.label}
                          onChange={(e) =>
                            setVariants((vs) => {
                              vs[vi].label = e.target.value;
                              return vs;
                            })
                          }
                        />
                      </FormField>
                      <Button variant="ghost" onClick={() => removeVariant(vi)}>
                        Убрать вариант
                      </Button>
                    </div>
                  )}

                  {variant.messages.map((message, mi) => (
                    <div key={mi} className="space-y-2 rounded-md border bg-background p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          className="min-w-0 flex-1"
                          value={message.label}
                          aria-label="Подпись сообщения"
                          placeholder={
                            variant.messages.length > 1
                              ? `Сообщение ${mi + 1} — подпись, например «Если выбирают…»`
                              : "Подпись сообщения — необязательно"
                          }
                          onChange={(e) => setMessage(vi, mi, { label: e.target.value })}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mi === 0}
                          aria-label="Сообщение выше"
                          onClick={() => moveMessage(vi, mi, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mi === variant.messages.length - 1}
                          aria-label="Сообщение ниже"
                          onClick={() => moveMessage(vi, mi, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={variant.messages.length === 1}
                          onClick={() =>
                            setVariants((vs) => {
                              vs[vi].messages.splice(mi, 1);
                              return vs;
                            })
                          }
                        >
                          Удалить
                        </Button>
                      </div>
                      {LANGS.map((l) => (
                        <div key={l.key} className="flex gap-2">
                          <span
                            className="mt-2.5 w-7 shrink-0 text-xs font-semibold text-muted-foreground"
                            title={l.name}
                          >
                            {l.label}
                          </span>
                          <Textarea
                            {...focusProps(`msg-${vi}-${mi}-${l.key}`)}
                            aria-label={`Текст на ${l.inName}`}
                            lang={l.key}
                            value={message[l.key]}
                            rows={rowsFor(message[l.key])}
                            placeholder={`Текст на ${l.inName}${l.key === "ru" ? "" : " — если есть"}`}
                            onChange={(e) => setMessage(vi, mi, { [l.key]: e.target.value })}
                          />
                        </div>
                      ))}
                    </div>
                  ))}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setVariants((vs) => {
                        vs[vi].messages.push(emptyMessage());
                        return vs;
                      })
                    }
                  >
                    <Plus />
                    Сообщение
                  </Button>
                </div>
              ))}

              <div>
                {byStudio ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setVariants((vs) => [...vs, { label: "", messages: clone(vs[0].messages) }])
                    }
                  >
                    <Plus />
                    Вариант для клуба
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={splitByStudio}>
                    Разделить по клубам
                  </Button>
                )}
              </div>

              <FormField label="Вставить переменную — туда, где курсор" htmlFor={null}>
                <VariableChips
                  variables={variables}
                  targetId={() => lastField.current}
                  onInsert={insertInto}
                  onMissingTarget={() =>
                    toast.error("Поставьте курсор в текст, а потом нажмите на переменную")
                  }
                />
                <InfoNote>
                  {"{переменные}"} в фигурных скобках подставляются сами — имя вошедшего, клуб,
                  значения из настроек — на языке текста. [день], [время] в квадратных скобках —
                  места, которые администратор заполняет руками.
                </InfoNote>
              </FormField>

              <FormField label="Дальше — что сделать после отправки" optional htmlFor="ed-follow">
                <FormatBar
                  targetId="ed-follow"
                  value={draft.follow_up}
                  onChange={(follow_up) => patch({ follow_up })}
                  sections={sections}
                />
                <Textarea
                  {...focusProps("ed-follow")}
                  value={draft.follow_up}
                  rows={rowsFor(draft.follow_up, 2)}
                  placeholder="Например: через 2 дня поставить задачу — выделите название и нажмите «Ссылка на скрипт»"
                  onChange={(e) => patch({ follow_up: e.target.value })}
                />
              </FormField>

              <FormField
                label="Слова для поиска"
                optional
                tip="Чего нет в тексте, но по чему будут искать: цена, прайс, адрес."
              >
                <Input
                  value={draft.keywords}
                  maxLength={1000}
                  onChange={(e) => patch({ keywords: e.target.value })}
                />
              </FormField>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {asking ? (
            <Button variant="outline" disabled={saving} onClick={() => setAsking(false)}>
              Назад к правке
            </Button>
          ) : (
            <>
              {onDelete && (
                <Button
                  variant="ghost"
                  className="mr-auto text-destructive hover:text-destructive"
                  disabled={saving}
                  onClick={handleDelete}
                >
                  Удалить
                </Button>
              )}
              <Button variant="outline" disabled={saving} onClick={onClose}>
                Отмена
              </Button>
            </>
          )}
          <Button type="submit" disabled={saving || (asking && !changeNote.trim())}>
            {saving && <Loader2 className="animate-spin" />}
            {asking ? "Сохранить изменения" : isNew ? "Добавить скрипт" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogForm>
      {confirmDialog}
    </>
  );
}
