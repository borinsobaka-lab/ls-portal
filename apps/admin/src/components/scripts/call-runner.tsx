/**
 * Звонок по сценарию: администратор читает с экрана и нажимает, что ответил
 * клиент, — сценарий сам ведёт к следующему блоку.
 *
 * Задача — не зубрить ветки разговора. На экране всегда:
 * - слева — путь: пройденные блоки и что отвечал клиент (потребность,
 *   выбранная студия), по нажатию можно вернуться на любой шаг;
 * - в центре — что говорить сейчас, подсказка и кнопки ответов клиента
 *   (с клавиатуры — цифрами 1–9, назад — Backspace);
 * - справа — возражения и этапы: перейти в любой блок в любой момент.
 * На телефоне карточка блока идёт первой, панели — под ней.
 *
 * Имя клиента вписывается сверху и подставляется в {имя} по всему
 * сценарию. «Нет нужного ответа» — записать, что сказал клиент: уйдёт в
 * «Предложения», чтобы дописать сценарий.
 *
 * Место в сценарии и имя живут в sessionStorage вкладки: случайный переход
 * в другой раздел посреди звонка не сбрасывает разговор.
 *
 * «Тест» — пробный прогон: проходится так же, но в статистику не уходит;
 * «Закончить тест» возвращает к обычному звонку с начала.
 *
 * Путь по блокам тихо уходит в статистику звонков (lib/scripts/call-run.ts):
 * докуда дошёл разговор и на каком блоке закончился — чтобы видеть, где
 * сценарий теряет клиентов. Администратору ничего нажимать не нужно.
 * Перенесено из «Аудиоаналитики» (dashboard/src/scripts/CallRunner.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  FlaskConical,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
} from "lucide-react";

import { Formatted } from "@/components/scripts/rich-text";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/ui/status-chip";
import { TableToolbar } from "@/components/table-toolbar";
import { supabase } from "@/integrations/supabase/client";
import { newRunId, useCallRun, type CallStep } from "@/lib/scripts/call-run";
import { langInfo, type VarResolver } from "@/lib/scripts/logic";
import type { CallFlow, CallNode, ScriptLang, ScriptSection } from "@/lib/scripts/types";
import { cn } from "@/lib/utils";
import { ChoiceCard } from "@/components/ui/choice-card";
import { ListItemButton } from "@/components/ui/list-item-button";

type Saved = {
  path: CallStep[];
  name: string;
  /** id звонка в статистике: повторная отправка — обновление, не дубль. */
  runId?: string;
  /** Тестовый прогон — в статистику не уходит. */
  test?: boolean;
};

type RunnerProps = {
  section: ScriptSection;
  lang: ScriptLang;
  /** Выбранная студия — уходит в статистику звонка. */
  studio: string;
  resolveVar: VarResolver;
  resolveRef: (title: string) => (() => void) | null;
  resolveId: (id: string) => { open: () => void; title: string } | null;
  canEdit: boolean;
  onEdit: () => void;
};

const SIDE_TITLE = "text-xs font-medium uppercase text-muted-foreground";

function fresh(start: string, test = false): Saved {
  return { path: [{ id: start, at: new Date().toISOString() }], name: "", runId: newRunId(), test };
}

function storageKey(sectionId: string) {
  return `scripts_call:${sectionId}`;
}

function load(sectionId: string, start: string): Saved {
  try {
    const raw = window.sessionStorage.getItem(storageKey(sectionId));
    if (raw) {
      const saved = JSON.parse(raw) as Saved;
      if (Array.isArray(saved.path) && saved.path.length)
        return {
          ...saved,
          name: typeof saved.name === "string" ? saved.name : "",
          runId: saved.runId || newRunId(),
        };
    }
  } catch {
    // нет sessionStorage — начинаем сначала
  }
  return fresh(start);
}

/** Текст блока на языке; нет перевода — русский (или любой, какой есть), с пометкой. */
function nodeText(node: CallNode, lang: ScriptLang): { text: string; fallback: boolean } {
  if (node.text[lang]?.trim()) return { text: node.text[lang], fallback: false };
  return { text: node.text.ru || node.text.en || node.text.ka || "", fallback: lang !== "ru" };
}

/** Ближайший прокручиваемый предок — в админке прокручивается main, а не окно. */
function scrollParentTop(el: HTMLElement): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight)
      return p.getBoundingClientRect().top;
  }
  return 0;
}

export function CallRunner(props: RunnerProps) {
  const { section, canEdit, onEdit } = props;
  if (!section.flow?.nodes.length) {
    return (
      <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
        <p>В сценарии пока нет ни одного блока.</p>
        {canEdit && (
          <Button variant="outline" className="mt-4" onClick={onEdit}>
            <Pencil />
            Редактировать сценарий
          </Button>
        )}
      </div>
    );
  }
  // Другой раздел — другой звонок: состояние заводится заново, а не тянется
  // из прежнего сценария.
  return <Runner key={section.id} {...props} flow={section.flow} />;
}

function Runner({
  section,
  lang,
  studio,
  resolveVar,
  resolveRef,
  resolveId,
  canEdit,
  onEdit,
  flow,
}: RunnerProps & { flow: CallFlow }) {
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const start = byId.has(flow.start) ? flow.start : flow.nodes[0].id;
  const [state, setState] = useState<Saved>(() => load(section.id, start));
  const { name } = state;

  // Сценарий могли поменять в редакторе: шагов, которых больше нет, — убираем.
  const clean = useCallback(
    (path: CallStep[]): CallStep[] => {
      const kept = path.filter((s) => byId.has(s.id));
      return kept.length ? kept : [{ id: start, at: new Date().toISOString() }];
    },
    [byId, start],
  );
  const path = useMemo(() => clean(state.path), [clean, state.path]);
  const current = byId.get(path[path.length - 1].id) ?? flow.nodes[0];
  const visited = useMemo(() => new Set(path.map((s) => s.id)), [path]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey(section.id), JSON.stringify(state));
    } catch {
      // не сохранится между переходами — не страшно
    }
  }, [state, section.id]);

  const go = useCallback(
    (to: string, answer: string) => {
      setState((s) => {
        const p = clean(s.path);
        const last = p[p.length - 1];
        return {
          ...s,
          path: [...p.slice(0, -1), { ...last, answer }, { id: to, at: new Date().toISOString() }],
        };
      });
    },
    [clean],
  );

  const back = useCallback(() => {
    setState((s) => {
      const p = clean(s.path);
      if (p.length < 2) return s;
      const prev = p[p.length - 2];
      return { ...s, path: [...p.slice(0, -2), { id: prev.id, at: prev.at }] };
    });
  }, [clean]);

  const backTo = (index: number) =>
    setState((s) => {
      const p = clean(s.path);
      if (!p[index]) return s;
      return { ...s, path: [...p.slice(0, index), { id: p[index].id, at: p[index].at }] };
    });

  // Путь звонка тихо уходит в статистику; конец сценария — блок без ответов.
  // Без id звонок не отправляется — так тестовый прогон не попадает в статистику.
  const endRun = useCallRun({
    sectionId: section.id,
    byId,
    path,
    runId: state.test ? undefined : state.runId,
    atEnd: current.answers.length === 0,
    studio,
    lang,
  });

  /** «Новый звонок»: прежний закончился на текущем блоке. В тесте — новый тестовый прогон. */
  const restart = () => {
    endRun();
    setState(fresh(start, state.test));
  };

  /**
   * Тест начинается с начала сценария; начатый звонок заканчивается там,
   * где его оставили, — как по «Новый звонок».
   */
  const startTest = () => {
    endRun();
    setState(fresh(start, true));
  };
  const endTest = () => setState(fresh(start));

  // {имя} — имя клиента из поля сверху; остальные переменные — как везде.
  const callVar: VarResolver = useCallback(
    (key) => {
      if (key.toLowerCase() === "имя")
        return name.trim()
          ? { value: name.trim() }
          : { value: null, why: "Впишите имя клиента в поле над сценарием" };
      return resolveVar(key);
    },
    [name, resolveVar],
  );

  // Клавиатура: 1–9 — ответ клиента, Backspace — шаг назад. Не мешает
  // печатать в полях и не работает поверх окон и выпадающих списков.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (
        el?.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog], [role=listbox], [role=menu]",
        )
      )
        return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      if (/^[1-9]$/.test(e.key)) {
        const a = current.answers[Number(e.key) - 1];
        if (a) {
          e.preventDefault();
          go(a.to, a.label);
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, go, back]);

  // Новый блок — к началу карточки: длинные реплики уводят прокрутку вниз.
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    // Под закреплённой панелью поиска карточка тоже считается уехавшей.
    const margin = el ? parseFloat(getComputedStyle(el).scrollMarginTop) || 0 : 0;
    if (el && el.getBoundingClientRect().top < scrollParentTop(el) + margin)
      el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [current.id]);

  const shown = nodeText(current, lang);
  const mains = flow.nodes.filter((n) => n.group === "main");
  const objections = flow.nodes.filter((n) => n.group === "objection");
  const isObjection = current.group === "objection";
  const fmt = { terms: [], resolveVar: callVar, resolveRef, resolveId };

  return (
    <div className="space-y-3">
      {state.test && (
        <InfoNote
          variant="warning"
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
        >
          <span>
            <span className="font-semibold">Тестовый прогон</span> — в статистику звонков не
            попадает
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={endTest}>
            Закончить тест
          </Button>
        </InfoNote>
      )}

      <TableToolbar>
        <Input
          className="toolbar-full w-full sm:w-72"
          value={name}
          aria-label="Имя клиента"
          placeholder="Имя клиента — подставится в {имя}"
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
        />
        <span className="text-xs text-muted-foreground max-lg:hidden">
          1–9 — ответ клиента · Backspace — назад
        </span>
        <div className="toolbar-full flex flex-wrap gap-2 sm:ml-auto max-sm:[&>*]:flex-1">
          <Button variant="outline" onClick={restart}>
            <RotateCcw />
            {state.test ? "Заново" : "Новый звонок"}
          </Button>
          {!state.test && (
            <Button
              variant="outline"
              onClick={startTest}
              title="Пробный прогон сценария — в статистику не попадёт"
            >
              <FlaskConical />
              Тест
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" onClick={onEdit}>
              <Pencil />
              <span>
                Редактировать<span className="max-sm:hidden"> сценарий</span>
              </span>
            </Button>
          )}
        </div>
      </TableToolbar>

      <div className="grid items-start gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_14rem]">
        <aside
          aria-label="Пройденный путь"
          className="order-last space-y-2 rounded-lg border bg-background p-3 lg:order-none"
        >
          <h3 className={SIDE_TITLE}>Путь</h3>
          <ol className="space-y-1">
            {path.map((step, i) => {
              const node = byId.get(step.id);
              const isCurrent = i === path.length - 1;
              const body = (
                <>
                  <span className="text-sm font-medium">
                    <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">
                      {i + 1}.
                    </span>
                    {node?.title ?? step.id}
                  </span>
                  {step.answer && (
                    <span className="text-xs font-normal text-muted-foreground">{step.answer}</span>
                  )}
                </>
              );
              return (
                <li key={i}>
                  {isCurrent ? (
                    <div
                      aria-current="step"
                      className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2"
                    >
                      {body}
                    </div>
                  ) : (
                    // Строка пути — двухстрочная: высота по содержимому.
                    <ListItemButton
                      className="flex-col items-start gap-0.5 py-2"
                      title="Вернуться к этому шагу"
                      onClick={() => backTo(i)}
                    >
                      {body}
                    </ListItemButton>
                  )}
                </li>
              );
            })}
          </ol>
        </aside>

        <section
          ref={cardRef}
          aria-live="polite"
          className={cn(
            "order-first scroll-mt-36 sm:scroll-mt-28 rounded-lg border bg-background lg:order-none",
            isObjection && "border-amber-300",
          )}
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
            <span className="text-xs text-muted-foreground tabular-nums">Шаг {path.length}</span>
            <h2 className="text-lg leading-tight font-semibold">{current.title}</h2>
            {isObjection && <StatusChip tone="warning">Возражение</StatusChip>}
          </header>

          <div className="space-y-4 p-4">
            {shown.fallback && (
              <InfoNote variant="warning">
                Текста на {langInfo(lang).inName} нет — показан русский.
              </InfoNote>
            )}
            <div className="space-y-1.5">
              <p className={SIDE_TITLE}>Что сказать</p>
              <div lang={shown.fallback ? "ru" : lang} className="text-base leading-relaxed">
                <Formatted text={shown.text} {...fmt} />
              </div>
            </div>
            {current.hint && (
              <InfoNote className="space-y-1 text-sm">
                <p className="font-medium text-foreground">Подсказка</p>
                <Formatted text={current.hint} className="text-muted-foreground" {...fmt} />
              </InfoNote>
            )}
            {current.client && (
              <p className="text-sm">
                <span className="text-muted-foreground">Клиент:</span> {current.client}
              </p>
            )}
          </div>

          <div className="space-y-2 px-4 pb-4">
            {current.answers.length ? (
              current.answers.map((a, i) => (
                // Ответ бывает длинным — карточка растёт по высоте, а не обрезает текст.
                <ChoiceCard key={i} compact onClick={() => go(a.to, a.label)}>
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1">{a.label}</span>
                  {byId.get(a.to) && (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground max-sm:hidden">
                      → {byId.get(a.to)?.title}
                    </span>
                  )}
                </ChoiceCard>
              ))
            ) : (
              <div className="space-y-3 rounded-md border border-dashed p-4 text-center">
                <p className="font-semibold">Конец сценария</p>
                <Button onClick={restart}>
                  <RotateCcw />
                  {state.test ? "Заново" : "Новый звонок"}
                </Button>
              </div>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
            <Button variant="ghost" size="sm" disabled={path.length < 2} onClick={back}>
              <ArrowLeft />
              Назад
            </Button>
            <NoAnswer key={current.id} sectionTitle={section.title} node={current} />
          </footer>
        </section>

        <aside
          aria-label="Перейти к блоку"
          className="space-y-4 rounded-lg border bg-background p-3"
        >
          {objections.length > 0 && (
            <JumpList
              title="Возражения"
              nodes={objections}
              currentId={current.id}
              visited={null}
              onJump={(id) => go(id, "→ переход")}
            />
          )}
          <JumpList
            title="Этапы звонка"
            nodes={mains}
            currentId={current.id}
            visited={visited}
            onJump={(id) => go(id, "→ переход")}
          />
        </aside>
      </div>
    </div>
  );
}

/** Список блоков для перехода в любой момент; пройденные этапы — с галочкой. */
function JumpList({
  title,
  nodes,
  currentId,
  visited,
  onJump,
}: {
  title: string;
  nodes: CallNode[];
  currentId: string;
  /** null — не отмечать пройденные (возражения). */
  visited: Set<string> | null;
  onJump: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className={SIDE_TITLE}>{title}</h3>
      <div className="space-y-1.5">
        {nodes.map((n) => {
          const isCurrent = n.id === currentId;
          const done = !isCurrent && visited?.has(n.id);
          return (
            // Название блока бывает в две строки — высота по содержимому.
            <ListItemButton
              key={n.id}
              variant="outline"
              active={isCurrent}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                n.group === "objection" && "border-amber-200 hover:bg-amber-100",
                done && "text-muted-foreground",
              )}
              onClick={() => !isCurrent && onJump(n.id)}
            >
              <span className="flex-1">{n.title}</span>
              {done && <Check aria-label="Пройден" />}
            </ListItemButton>
          );
        })}
      </div>
    </div>
  );
}

/**
 * «Нет нужного ответа»: что сказал клиент — в «Предложения», чтобы дописать
 * сценарий. Разговор при этом продолжается. На новом блоке поле сбрасывается
 * (key по id блока).
 */
function NoAnswer({ sectionTitle, node }: { sectionTitle: string; node: CallNode }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function send() {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("scripts_suggestions").insert({
        text: `Звонок «${sectionTitle}», блок «${node.title}» — нет нужного ответа. Клиент: ${text.trim()}`,
        item_id: null,
      });
      if (error) throw new Error(error.message);
      setSent(true);
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["scripts_suggestions"] });
    } catch (e) {
      toast.error(`Не удалось записать: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
        <Check className="size-4" />
        Записано в «Предложения»
      </span>
    );
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <MessageSquare />
        Нет нужного ответа
      </Button>
    );
  return (
    <div className="flex w-full gap-2 sm:w-auto sm:flex-1 sm:justify-end">
      <Input
        autoFocus
        className="sm:max-w-80"
        value={text}
        maxLength={500}
        aria-label="Что сказал клиент"
        placeholder="Что сказал клиент?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button disabled={busy || text.trim().length < 3} onClick={() => void send()}>
        {busy && <Loader2 className="animate-spin" />}
        Записать
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
        Отмена
      </Button>
    </div>
  );
}
