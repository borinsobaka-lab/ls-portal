/**
 * Редактор сценария звонка.
 *
 * Слева — блоки: этапы разговора по порядку и возражения. Справа — выбранный
 * блок: что говорит администратор (с форматированием и переменными),
 * подсказка, чего ждать от клиента и кнопки ответов — каждая ведёт в блок,
 * который выбирают из списка или создают тут же. Сохраняется весь сценарий
 * разом, с «Что изменили?» — как у текстовых скриптов: триггер в базе без
 * пояснения правку сценария не примет и пишет её в хронологию.
 * Перенесено из «Аудиоаналитики» (dashboard/src/scripts/CallEditor.tsx).
 */
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Play, Plus, Trash2, X } from "lucide-react";

import { useConfirm } from "@/components/confirm-dialog";
import { FormatBar, VariableChips } from "@/components/scripts/format-bar";
import { Button } from "@/components/ui/button";
import { FieldIdContext } from "@/components/ui/field-context";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { LANGS } from "@/lib/scripts/logic";
import type {
  CallAnswer,
  CallFlow,
  CallNode,
  ScriptLang,
  ScriptSection,
} from "@/lib/scripts/types";
import { cn } from "@/lib/utils";
import { ListItemButton } from "@/components/ui/list-item-button";

type Group = CallNode["group"];

const GROUPS: { key: Group; title: string; add: string }[] = [
  { key: "main", title: "Этапы звонка", add: "Этап" },
  { key: "objection", title: "Возражения и вопросы", add: "Возражение" },
];

const MAX_ANSWERS = 12;
const NEW_MAIN = "__new_main";
const NEW_OBJECTION = "__new_obj";
const SIDE_TITLE = "text-xs font-medium uppercase text-muted-foreground";

/** id полей с текстом — сюда вставляются {переменные}. */
const TEXT_ID: Record<ScriptLang, string> = {
  ru: "call-text-ru",
  en: "call-text-en",
  ka: "call-text-ka",
};
const HINT_ID = "call-hint";

function newId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function blankNode(group: Group, title: string): CallNode {
  return {
    id: newId(),
    title,
    group,
    text: { ru: "", en: "", ka: "" },
    hint: "",
    client: "",
    answers: [],
  };
}

function initialFlow(flow: CallFlow | null): CallFlow {
  if (flow?.nodes.length) return structuredClone(flow);
  // Пустой сценарий — сразу с первым этапом, иначе редактировать нечего.
  const first = blankNode("main", "Приветствие");
  return { start: first.id, nodes: [first] };
}

/** Высота поля по тексту: сколько строк, плюс одна, в разумных пределах. */
function rows(value: string, min = 3) {
  return Math.max(min, Math.min(16, value.split("\n").length + 1));
}

export function CallEditor({
  section,
  sections,
  variables,
  onSaved,
  onCancel,
}: {
  section: ScriptSection;
  sections: ScriptSection[];
  variables: { key: string; description: string }[];
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [flow, setFlow] = useState<CallFlow>(() => initialFlow(section.flow));
  const [selected, setSelected] = useState(flow.start);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [otherLangs, setOtherLangs] = useState(false);
  // Последнее поле с текстом в фокусе — туда вставляется {переменная}.
  const lastField = useRef<string>(TEXT_ID.ru);

  const node = flow.nodes.find((n) => n.id === selected) ?? flow.nodes[0];
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const dirty = JSON.stringify(flow) !== JSON.stringify(section.flow);

  // Сколько ответов ведёт в каждый блок — чтобы видеть «потерянные» блоки.
  const incoming = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of flow.nodes)
      for (const a of n.answers) count.set(a.to, (count.get(a.to) ?? 0) + 1);
    return count;
  }, [flow]);

  // Соседи в своей группе — для стрелок «выше/ниже».
  const sameGroup = flow.nodes.filter((n) => n.group === node.group);
  const groupIndex = sameGroup.findIndex((n) => n.id === node.id);

  function patchNode(id: string, patch: Partial<CallNode>) {
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
  }

  function patchText(lang: ScriptLang, value: string) {
    patchNode(node.id, { text: { ...node.text, [lang]: value } });
  }

  function patchAnswer(index: number, patch: Partial<CallAnswer>) {
    patchNode(node.id, {
      answers: node.answers.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    });
  }

  function select(id: string) {
    setSelected(id);
    setAsking(false);
  }

  /** Новый блок; linkFrom — номер ответа текущего блока, который поведёт в него. */
  function addNode(group: Group, linkFrom?: number) {
    const fresh = blankNode(group, group === "main" ? "Новый этап" : "Новое возражение");
    setFlow((f) => {
      const nodes = [...f.nodes];
      // Новый этап — сразу после текущего, возражение — в конец.
      const at = group === "main" ? nodes.findIndex((n) => n.id === node.id) + 1 : nodes.length;
      nodes.splice(at, 0, fresh);
      return {
        ...f,
        nodes:
          linkFrom === undefined
            ? nodes
            : nodes.map((n) =>
                n.id === node.id
                  ? {
                      ...n,
                      answers: n.answers.map((a, i) =>
                        i === linkFrom ? { ...a, to: fresh.id } : a,
                      ),
                    }
                  : n,
              ),
      };
    });
    select(fresh.id);
  }

  function move(delta: -1 | 1) {
    setFlow((f) => {
      const nodes = [...f.nodes];
      const i = nodes.findIndex((n) => n.id === node.id);
      // Двигаем среди блоков той же группы.
      let j = i + delta;
      while (j >= 0 && j < nodes.length && nodes[j].group !== node.group) j += delta;
      if (j < 0 || j >= nodes.length) return f;
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      return { ...f, nodes };
    });
  }

  async function remove() {
    const leading = incoming.get(node.id) ?? 0;
    const ok = await confirm({
      title: "Удалить блок?",
      description:
        `Блок «${node.title || "Без названия"}» уйдёт из сценария` +
        (leading
          ? `, вместе с ответами, которые в него ведут (${leading}).`
          : ". Ответов, которые в него ведут, нет.") +
        " В базе изменится после «Сохранить».",
    });
    if (!ok) return;
    const gone = node.id;
    const rest = flow.nodes.filter((n) => n.id !== gone);
    // Удалили начало звонка — начинаем с первого оставшегося этапа.
    const start =
      flow.start === gone ? (rest.find((n) => n.group === "main") ?? rest[0]).id : flow.start;
    setFlow({
      start,
      nodes: rest.map((n) => ({ ...n, answers: n.answers.filter((a) => a.to !== gone) })),
    });
    select(start);
  }

  const problem = useMemo(() => {
    for (const n of flow.nodes) {
      if (!n.title.trim()) return "У блока нет названия";
      if (!n.text.ru.trim() && !n.text.en.trim() && !n.text.ka.trim())
        return `В блоке «${n.title}» нет текста`;
      for (const a of n.answers) {
        if (!a.label.trim()) return `В блоке «${n.title}» есть ответ без текста кнопки`;
        if (!byId.has(a.to)) return `Ответ «${a.label}» в блоке «${n.title}» никуда не ведёт`;
      }
    }
    return "";
  }, [flow, byId]);

  async function save() {
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!note.trim()) {
      toast.error("Напишите, что изменили");
      return;
    }
    setSaving(true);
    try {
      const clean: CallFlow = {
        start: flow.start,
        nodes: flow.nodes.map((n) => ({
          ...n,
          title: n.title.trim(),
          hint: n.hint.trim(),
          client: n.client.trim(),
          text: { ru: n.text.ru.trim(), en: n.text.en.trim(), ka: n.text.ka.trim() },
          answers: n.answers.map((a) => ({ label: a.label.trim(), to: a.to })),
        })),
      };
      const { data, error } = await supabase
        .from("scripts_sections")
        .update({ flow: clean, flow_change_note: note.trim() })
        .eq("id", section.id)
        .select("id");
      if (error) throw new Error(error.message);
      // RLS молча не обновляет чужое: ноль строк — прав на правку нет.
      if (!data?.length) throw new Error("нет прав на правку сценария");
      toast.success("Сценарий сохранён");
      await onSaved();
    } catch (e) {
      toast.error(`Не удалось сохранить сценарий: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if (
      dirty &&
      !(await confirm({
        title: "Выйти без сохранения?",
        description: "Изменения в сценарии пропадут.",
        confirmLabel: "Выйти",
      }))
    )
      return;
    onCancel();
  }

  function insertVariable(fieldId: string, next: string) {
    if (fieldId === HINT_ID) {
      patchNode(node.id, { hint: next });
      return;
    }
    const lang = LANGS.find((l) => TEXT_ID[l.key] === fieldId)?.key;
    if (lang) patchText(lang, next);
  }

  const vars = [
    { key: "имя", description: "имя клиента — из поля на экране звонка" },
    ...variables,
  ];
  const remember = (id: string) => () => {
    lastField.current = id;
  };

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-label="Блоки сценария" className="space-y-4 rounded-lg border bg-background p-3">
        {GROUPS.map((g) => (
          <div key={g.key} className="space-y-1">
            <h3 className={cn(SIDE_TITLE, "pb-1")}>{g.title}</h3>
            {flow.nodes
              .filter((n) => n.group === g.key)
              .map((n) => {
                const isStart = n.id === flow.start;
                const orphan = !isStart && n.group === "main" && !incoming.get(n.id);
                return (
                  // Название блока бывает в две строки — высота по содержимому.
                  <ListItemButton
                    key={n.id}
                    active={n.id === node.id}
                    aria-current={n.id === node.id ? "true" : undefined}
                    className="px-2"
                    onClick={() => select(n.id)}
                  >
                    {isStart && (
                      <Play
                        className="text-muted-foreground"
                        aria-label="С этого блока начинается звонок"
                      />
                    )}
                    <span className="min-w-0 flex-1">{n.title || "Без названия"}</span>
                    {orphan && (
                      <StatusChip
                        tone="warning"
                        title="Ни один ответ сюда не ведёт — попасть можно только из панели этапов"
                      >
                        нет входа
                      </StatusChip>
                    )}
                    <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                      {n.answers.length || "конец"}
                    </span>
                  </ListItemButton>
                );
              })}
            <Button variant="ghost" size="sm" onClick={() => addNode(g.key)}>
              <Plus />
              {g.add}
            </Button>
          </div>
        ))}
      </aside>

      <section aria-label="Блок" className="space-y-4 rounded-lg border bg-background p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <FormField label="Название блока" required>
            <Input
              value={node.title}
              maxLength={120}
              onChange={(e) => patchNode(node.id, { title: e.target.value })}
            />
          </FormField>
          <FormField
            label="Где показывать"
            required
            tip="Этапы идут по порядку разговора; возражения и вопросы всегда под рукой в панели справа на экране звонка."
          >
            <Select
              value={node.group}
              onValueChange={(v) => patchNode(node.id, { group: v === "objection" ? v : "main" })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="main">Этап звонка</SelectItem>
                <SelectItem value="objection">Возражение / вопрос</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {flow.start === node.id ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Play className="size-4" />С этого блока начинается звонок
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFlow((f) => ({ ...f, start: node.id }))}
            >
              <Play />
              Начинать звонок с этого блока
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Выше"
              title="Выше"
              disabled={groupIndex <= 0}
              onClick={() => move(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Ниже"
              title="Ниже"
              disabled={groupIndex === sameGroup.length - 1}
              onClick={() => move(1)}
            >
              <ArrowDown />
            </Button>
            {flow.nodes.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => void remove()}
              >
                <Trash2 />
                Удалить блок
              </Button>
            )}
          </div>
        </div>

        <FormField
          label="Что говорит администратор (RU)"
          required={!node.text.en.trim() && !node.text.ka.trim()}
          htmlFor={TEXT_ID.ru}
        >
          {/* Свой контекст без id: иначе поиск скрипта в панели получил бы id поля. */}
          <FieldIdContext.Provider value={undefined}>
            <FormatBar
              targetId={TEXT_ID.ru}
              value={node.text.ru}
              sections={sections}
              onChange={(ru) => patchText("ru", ru)}
            />
          </FieldIdContext.Provider>
          <Textarea
            id={TEXT_ID.ru}
            rows={rows(node.text.ru, 5)}
            value={node.text.ru}
            onFocus={remember(TEXT_ID.ru)}
            onChange={(e) => patchText("ru", e.target.value)}
          />
          <VariableChips
            variables={vars}
            targetId={() => lastField.current}
            onInsert={insertVariable}
            onMissingTarget={() => toast.error("Поставьте курсор в текст, куда вставить")}
          />
          <p className="text-xs text-muted-foreground">
            Переменная вставится туда, где стоит курсор: в текст на любом языке или в подсказку.
          </p>
        </FormField>

        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setOtherLangs((v) => !v)}>
            {otherLangs ? "Скрыть EN и GE" : "Текст на EN и GE"}
          </Button>
          {otherLangs &&
            LANGS.filter((l) => l.key !== "ru").map((l) => (
              <FormField
                key={l.key}
                label={`${l.label} · ${l.name}`}
                htmlFor={TEXT_ID[l.key]}
                optional
                hint="Нет перевода — на экране звонка будет русский текст с пометкой."
              >
                <Textarea
                  id={TEXT_ID[l.key]}
                  lang={l.key}
                  rows={rows(node.text[l.key])}
                  value={node.text[l.key]}
                  onFocus={remember(TEXT_ID[l.key])}
                  onChange={(e) => patchText(l.key, e.target.value)}
                />
              </FormField>
            ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            label="Подсказка администратору"
            htmlFor={HINT_ID}
            optional
            hint="Клиенту не говорится."
          >
            <Textarea
              id={HINT_ID}
              rows={rows(node.hint, 2)}
              value={node.hint}
              onFocus={remember(HINT_ID)}
              onChange={(e) => patchNode(node.id, { hint: e.target.value })}
            />
          </FormField>
          <FormField label="Чего ждать от клиента" optional>
            <Input
              value={node.client}
              maxLength={300}
              placeholder="Например: говорит день"
              onChange={(e) => patchNode(node.id, { client: e.target.value })}
            />
          </FormField>
        </div>

        <FormField
          label="Ответы клиента — кнопки перехода"
          htmlFor={null}
          tip="На экране звонка это кнопки (и цифры 1–9 на клавиатуре): что ответил клиент и в какой блок перейти."
        >
          {node.answers.length === 0 && (
            <InfoNote variant="empty">Ответов нет — на этом блоке звонок заканчивается.</InfoNote>
          )}
          {node.answers.map((a, i) => (
            <div
              key={i}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_14rem_auto]"
            >
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums"
              >
                {i + 1}
              </span>
              <Input
                value={a.label}
                maxLength={120}
                aria-label={`Ответ ${i + 1}: что ответил клиент`}
                placeholder="Что ответил клиент"
                onChange={(e) => patchAnswer(i, { label: e.target.value })}
              />
              <Select
                value={byId.has(a.to) ? a.to : ""}
                onValueChange={(v) => {
                  if (v === NEW_MAIN) addNode("main", i);
                  else if (v === NEW_OBJECTION) addNode("objection", i);
                  else patchAnswer(i, { to: v });
                }}
              >
                <SelectTrigger
                  aria-label={`Ответ ${i + 1}: куда ведёт`}
                  className="max-sm:order-last max-sm:col-span-full"
                >
                  <SelectValue placeholder="Выберите блок" />
                </SelectTrigger>
                <SelectContent>
                  {GROUPS.map((g) => (
                    <SelectGroup key={g.key}>
                      <SelectLabel className="text-xs font-medium text-muted-foreground">
                        {g.title}
                      </SelectLabel>
                      {flow.nodes
                        .filter((n) => n.group === g.key)
                        .map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {n.title || "Без названия"}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))}
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel className="text-xs font-medium text-muted-foreground">
                      Создать
                    </SelectLabel>
                    <SelectItem value={NEW_MAIN}>+ Новый этап</SelectItem>
                    <SelectItem value={NEW_OBJECTION}>+ Новое возражение</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Убрать ответ ${i + 1}`}
                title="Убрать ответ"
                onClick={() =>
                  patchNode(node.id, { answers: node.answers.filter((_, j) => j !== i) })
                }
              >
                <X />
              </Button>
            </div>
          ))}
          {node.answers.length < MAX_ANSWERS ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patchNode(node.id, {
                  answers: [
                    ...node.answers,
                    { label: "", to: flow.nodes.find((n) => n.id !== node.id)?.id ?? node.id },
                  ],
                })
              }
            >
              <Plus />
              Ответ
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Не больше {MAX_ANSWERS} ответов в блоке.
            </p>
          )}
        </FormField>

        <div className="border-t pt-4">
          {asking ? (
            <form
              noValidate
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <FormField
                label="Что изменили?"
                required
                className="min-w-0 flex-1 basis-64"
                tip="Пояснение попадёт в хронологию изменений — по нему видно, кто и зачем правил сценарий."
              >
                <Input
                  autoFocus
                  value={note}
                  maxLength={500}
                  placeholder="Например: добавили возражение «Дорого»"
                  onChange={(e) => setNote(e.target.value)}
                />
              </FormField>
              <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
                <Button variant="outline" disabled={saving} onClick={() => setAsking(false)}>
                  Назад
                </Button>
                <Button type="submit" disabled={saving || !note.trim()}>
                  {saving && <Loader2 className="animate-spin" />}
                  Сохранить сценарий
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p
                className={cn(
                  "min-w-0 flex-1 basis-64 text-sm",
                  problem ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {problem || (dirty ? "Есть несохранённые изменения" : "Изменений нет")}
              </p>
              <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
                <Button variant="outline" onClick={() => void cancel()}>
                  Отмена
                </Button>
                <Button disabled={!dirty || Boolean(problem)} onClick={() => setAsking(true)}>
                  Сохранить
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
      {confirmDialog}
    </div>
  );
}
