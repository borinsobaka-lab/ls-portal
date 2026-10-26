/**
 * «Скрипты LS» — то, что администратор пишет клиенту и говорит по телефону
 * (перенос продукта «Скрипты» из «Аудиоаналитики», вёрстка — админки Base40).
 *
 * Замена Google-документа «Скрипты LS Tbilisi». В документе нужный ответ
 * искали прокруткой через три языка, а копировали выделением мышью — вместе
 * с пометками «RU:» и «После отправки…». Здесь:
 * - поиск по всему сразу, с подсветкой; «/» ставит курсор в поиск, Esc чистит;
 * - язык и студия выбираются один раз на все скрипты и запоминаются;
 * - каждое сообщение копируется одной кнопкой, ровно то, что уйдёт в чат;
 * - ссылка на скрипт открывает его и подсвечивает, даже если его перенесли.
 *
 * Одна страница на «Все скрипты» (/scripts) и раздел (/scripts/<id>);
 * раздел-звонок — сценарий (CallRunner) вместо карточек.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { Button } from "@/components/ui/button";
import { ListItemButton } from "@/components/ui/list-item-button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusChip } from "@/components/ui/status-chip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TableToolbar } from "@/components/table-toolbar";
import { ScriptsListSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/confirm-dialog";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { EmptyCard } from "@/components/scripts/empty-card";
import { ScriptCard } from "@/components/scripts/script-card";
import { ScriptEditor } from "@/components/scripts/script-editor";
import { SectionDialogContent, type SectionFormValue } from "@/components/scripts/section-dialog";
import { SuggestDialogContent, type SuggestTarget } from "@/components/scripts/suggest-dialog";
import { CallRunner } from "@/components/scripts/call-runner";
import { CallEditor } from "@/components/scripts/call-editor";
import {
  invalidateScripts,
  usePlaybook,
  useScriptAccess,
  useScriptPrefs,
  useScriptSettings,
} from "@/lib/scripts/data";
import {
  BUILTIN_VARIABLES,
  emptyDraft,
  findById,
  findByTitle,
  formatWhen,
  LANGS,
  makeResolver,
  plural,
  searchScripts,
  searchTerms,
  studioLabels,
  totalScripts,
} from "@/lib/scripts/logic";
import type { CallFlow, ScriptItem, ScriptItemDraft, ScriptSection } from "@/lib/scripts/types";

/** Новый раздел-звонок начинается с одного блока — дальше его строят в редакторе. */
const BLANK_FLOW: CallFlow = {
  start: "start",
  nodes: [
    {
      id: "start",
      title: "Приветствие",
      group: "main",
      text: {
        ru: "{имя}, добрый день! Меня зовут {админ}, студия растяжки Lady Stretch.",
        en: "",
        ka: "",
      },
      hint: "",
      client: "",
      answers: [],
    },
  ],
};

async function check(result: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await result;
  if (error) throw new Error(error.message);
}

type Editing = { item: ScriptItem | null; draft: ScriptItemDraft };
type SectionForm = { section: ScriptSection | null };

export function ScriptsPage({ sectionId, focusId }: { sectionId?: string; focusId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const access = useScriptAccess();
  const canEdit = !!access?.canEdit;
  const { data: sections = [], isLoading } = usePlaybook(!!access?.canRead);
  const { data: settings = null } = useScriptSettings(!!access?.canRead);
  const { data: profile } = useStaffProfile();
  const { lang, setLang, studio, setStudio } = useScriptPrefs();
  const href = useRouterState({ select: (s) => s.location.href });

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sectionForm, setSectionForm] = useState<SectionForm | null>(null);
  const [suggesting, setSuggesting] = useState<SuggestTarget | null>(null);
  const [editingFlow, setEditingFlow] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => searchTerms(query), [query]);
  const hits = useMemo(() => searchScripts(sections, terms), [sections, terms]);
  const section = sectionId ? sections.find((s) => s.id === sectionId) : undefined;
  const isCall = section?.kind === "call";
  // Текстовые скрипты живут только в текстовых разделах: звонок — один сценарий.
  const textSections = useMemo(() => sections.filter((s) => s.kind !== "call"), [sections]);

  // Студии — и те, под которые у скриптов есть свои варианты текста, и
  // заведённые в настройках: от выбранной зависит и вариант, и {студия}.
  const studios = useMemo(() => {
    const names = studioLabels(sections);
    for (const s of settings?.studios ?? [])
      if (s.name && !names.includes(s.name)) names.push(s.name);
    return names;
  }, [sections, settings]);
  const activeStudio = studios.includes(studio) ? studio : (studios[0] ?? "");

  const me = useMemo(
    () => (profile ? { id: profile.id, fullName: profile.fullName } : null),
    [profile],
  );
  const resolveVar = useMemo(
    () => makeResolver({ settings, me, lang, studio: activeStudio }),
    [settings, me, lang, activeStudio],
  );
  const insertable = useMemo(
    () => [
      ...BUILTIN_VARIABLES,
      ...(settings?.variables ?? []).map((v) => ({ key: v.key, description: v.description })),
    ],
    [settings],
  );

  // Переход в другой раздел — это просмотр, а не поиск: запрос сбрасывается.
  useEffect(() => {
    setQuery("");
    setEditingFlow(false);
  }, [sectionId]);

  // «/» — к поиску из любого места страницы, кроме полей ввода и окон.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openScript = useCallback(
    (sectionTo: string, item?: string) => {
      setQuery("");
      void navigate({
        to: "/scripts/$sectionId",
        params: { sectionId: sectionTo },
        search: item ? { item } : {},
      });
    },
    [navigate],
  );

  // Ссылка ведёт по id. Скрипт с тех пор перенесли в другой раздел (или
  // ссылка без раздела) — открыть его настоящий раздел.
  useEffect(() => {
    if (!focusId || !sections.length) return;
    const home = findById(sections, focusId);
    if (home && home.section.id !== sectionId)
      void navigate({
        to: "/scripts/$sectionId",
        params: { sectionId: home.section.id },
        search: { item: focusId },
        replace: true,
      });
  }, [focusId, sections, sectionId, navigate]);

  // Докрутить и подсветить — один раз на переход: данные могут прийти
  // повторно (кэш, потом свежие), второй прокрутки быть не должно.
  const focused = useRef("");
  useEffect(() => {
    if (!focusId || !sections.length || focused.current === href) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(`script-${focusId}`);
      if (!el) return;
      focused.current = href;
      el.scrollIntoView({ block: "start" });
      setFlash(focusId);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, sections, href]);

  // Подсветка гаснет сама.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const resolveId = useCallback(
    (id: string) => {
      const found = findById(sections, id);
      return found
        ? { open: () => openScript(found.section.id, found.item.id), title: found.item.title }
        : null;
    },
    [sections, openScript],
  );
  const resolveRef = useCallback(
    (title: string) => {
      const found = findByTitle(sections, title);
      return found ? () => openScript(found.section.id, found.item.id) : null;
    },
    [sections, openScript],
  );

  const reload = () => invalidateScripts(queryClient);

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      await reload();
    }
  }

  function startNewScript() {
    const target = section && !isCall ? section.id : textSections[0]?.id;
    if (!target) return;
    setEditing({ item: null, draft: emptyDraft(target) });
  }

  async function saveItem(item: ScriptItem | null, draft: ScriptItemDraft, changeNote: string) {
    const body = { ...draft, change_note: changeNote };
    if (item) await check(supabase.from("scripts_items").update(body).eq("id", item.id));
    else await check(supabase.from("scripts_items").insert(body));
    await reload();
    setEditing(null);
    toast.success(item ? "Скрипт сохранён" : "Скрипт добавлен");
    if (draft.section_id !== sectionId) openScript(draft.section_id);
  }

  async function deleteItem(item: ScriptItem) {
    await check(supabase.from("scripts_items").delete().eq("id", item.id));
    await reload();
    setEditing(null);
    toast.success("Скрипт удалён");
  }

  function moveItem(sec: ScriptSection, index: number, delta: -1 | 1) {
    const ids = sec.items.map((i) => i.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    void run(() => check(supabase.rpc("scripts_reorder", { _section_id: sec.id, _ids: ids })));
  }

  function moveSection(sec: ScriptSection, delta: -1 | 1) {
    const ids = sections.map((s) => s.id);
    const index = ids.indexOf(sec.id);
    ids.splice(index, 1);
    ids.splice(index + delta, 0, sec.id);
    void run(() => check(supabase.rpc("scripts_reorder", { _section_id: null, _ids: ids })));
  }

  async function saveSection(target: ScriptSection | null, value: SectionFormValue) {
    if (target) {
      await check(
        supabase
          .from("scripts_sections")
          .update({ title: value.title, icon: value.icon })
          .eq("id", target.id),
      );
      await reload();
      setSectionForm(null);
      return;
    }
    const { data, error } = await supabase
      .from("scripts_sections")
      .insert({
        title: value.title,
        icon: value.icon,
        kind: value.kind,
        flow: value.kind === "call" ? BLANK_FLOW : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await reload();
    setSectionForm(null);
    openScript((data as { id: string }).id);
  }

  async function deleteSection(sec: ScriptSection) {
    if (
      !(await confirm({
        title: "Удалить раздел?",
        description: `«${sec.title}» пропадёт из меню у всех.`,
      }))
    )
      return;
    await run(async () => {
      await check(supabase.from("scripts_sections").delete().eq("id", sec.id));
      toast.success("Раздел удалён");
      if (sectionId === sec.id) void navigate({ to: "/scripts" });
    });
  }

  /** «⋯» у раздела: название и иконка, порядок в меню, удаление пустого. */
  function sectionMenu(sec: ScriptSection) {
    if (!canEdit) return null;
    const index = sections.indexOf(sec);
    return (
      <SectionMenu
        title={sec.title}
        canDelete={sec.kind === "call" || sec.items.length === 0}
        isFirst={index <= 0}
        isLast={index >= sections.length - 1}
        onEdit={() => setSectionForm({ section: sec })}
        onMove={(delta) => moveSection(sec, delta)}
        onDelete={() => void deleteSection(sec)}
      />
    );
  }

  function renderCard(item: ScriptItem, sec: ScriptSection, index: number, showSection: boolean) {
    return (
      <ScriptCard
        key={item.id}
        item={item}
        section={sec}
        showSection={showSection}
        terms={terms}
        lang={lang}
        studio={activeStudio}
        onStudio={setStudio}
        resolveRef={resolveRef}
        resolveId={resolveId}
        resolveVar={resolveVar}
        flash={flash === item.id}
        canEdit={canEdit}
        onEdit={() => setEditing({ item, draft: item })}
        onSuggest={() => setSuggesting({ id: item.id, title: item.title, section: sec.title })}
        onMove={(delta) => moveItem(sec, index, delta)}
        isFirst={index === 0}
        isLast={index === sec.items.length - 1}
      />
    );
  }

  function renderItems(sec: ScriptSection) {
    if (!sec.items.length)
      return (
        <EmptyCard>
          В разделе пока нет скриптов.{" "}
          {canEdit
            ? "Добавьте первый кнопкой «Скрипт» вверху."
            : "Их добавит тот, кто правит скрипты."}
        </EmptyCard>
      );
    return sec.items.map((item, i) => renderCard(item, sec, i, false));
  }

  const searching = terms.length > 0;
  const total = totalScripts(sections);
  const title = searching
    ? "Поиск"
    : section
      ? section.title
      : sectionId
        ? "Скрипты LS"
        : "Все скрипты";
  const hint = searching
    ? `${hits.length} ${plural(hits.length, "скрипт", "скрипта", "скриптов")} по запросу «${query.trim()}»`
    : section && isCall
      ? [
          "Сценарий звонка",
          section.flow_updated_at && `обновлён ${formatWhen(section.flow_updated_at)}`,
          section.flow_updated_by,
        ]
          .filter(Boolean)
          .join(" · ") + (section.flow_change_note ? ` — ${section.flow_change_note}` : "")
      : section
        ? `${section.items.length} ${plural(section.items.length, "скрипт", "скрипта", "скриптов")}`
        : `${total} ${plural(total, "скрипт", "скрипта", "скриптов")} в ${sections.length} ${plural(sections.length, "разделе", "разделах", "разделах")}`;

  const canAddScript = !isCall && textSections.length > 0;
  const actions = canEdit && (
    <div className="flex flex-wrap gap-2">
      {!searching && section && sectionMenu(section)}
      {!sectionId && (
        // Второстепенная (outline) — только рядом с «Скрипт»; одна — главная.
        <Button
          variant={canAddScript ? "outline" : "default"}
          onClick={() => setSectionForm({ section: null })}
        >
          <Plus />
          Раздел
        </Button>
      )}
      {canAddScript && (
        <Button onClick={startNewScript}>
          <Plus />
          Скрипт
        </Button>
      )}
    </div>
  );

  let content: React.ReactNode;
  if (isLoading || !access) {
    // Болванки карточек скриптов: в «Все скрипты» — по разделам.
    content = <ScriptsListSkeleton grouped={!sectionId} />;
  } else if (searching) {
    content = hits.length ? (
      <div className="space-y-3">
        {hits.map(({ item, section: sec }) => renderCard(item, sec, sec.items.indexOf(item), true))}
      </div>
    ) : (
      <EmptyCard>
        Ничего не нашлось. Ищем по названиям, текстам на всех языках и пояснениям — попробуйте
        другое слово или начало слова: «шпагат», «оплат».
      </EmptyCard>
    );
  } else if (section && isCall && section.flow) {
    content =
      canEdit && editingFlow ? (
        <CallEditor
          section={section}
          sections={sections}
          variables={insertable}
          onSaved={async () => {
            await reload();
            setEditingFlow(false);
          }}
          onCancel={() => setEditingFlow(false)}
        />
      ) : (
        <CallRunner
          key={section.id}
          section={section}
          lang={lang}
          studio={activeStudio}
          resolveVar={resolveVar}
          resolveRef={resolveRef}
          resolveId={resolveId}
          canEdit={canEdit}
          onEdit={() => setEditingFlow(true)}
        />
      );
  } else if (section) {
    content = <div className="space-y-3">{renderItems(section)}</div>;
  } else if (sectionId) {
    content = (
      <EmptyCard>
        Раздел не найден — его могли удалить. Откройте{" "}
        <Link to="/scripts" className="text-link underline hover:text-link-hover">
          «Все скрипты»
        </Link>
        .
      </EmptyCard>
    );
  } else if (sections.length) {
    content = sections.map((sec) => (
      <section key={sec.id} className="space-y-3">
        <div className="flex items-center gap-2 pt-2">
          <h2 className="text-lg font-semibold">
            <Link
              to="/scripts/$sectionId"
              params={{ sectionId: sec.id }}
              search={{}}
              className="hover:underline"
            >
              {sec.title}
            </Link>
          </h2>
          {sec.kind !== "call" && (
            <StatusChip className="tabular-nums">{sec.items.length}</StatusChip>
          )}
          <span className="ml-auto">{sectionMenu(sec)}</span>
        </div>
        {sec.kind === "call" && sec.flow ? (
          <Link
            to="/scripts/$sectionId"
            params={{ sectionId: sec.id }}
            search={{}}
            className="flex flex-wrap items-center gap-3 rounded-lg border bg-background px-4 py-3 hover:border-foreground/30"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Сценарий звонка</span>
              <span className="text-sm text-muted-foreground">
                {sec.flow.nodes.filter((n) => n.group === "main").length} этапов ·{" "}
                {sec.flow.nodes.filter((n) => n.group === "objection").length} возражений — читайте
                с экрана и кликайте ответы клиента
              </span>
            </span>
            <span className="text-sm font-medium">Начать звонок →</span>
          </Link>
        ) : (
          renderItems(sec)
        )}
      </section>
    ));
  } else {
    content = (
      <EmptyCard>
        Скриптов пока нет.{" "}
        {canEdit
          ? "Создайте первый раздел кнопкой «Раздел» вверху или перенесите скрипты из «Аудиоаналитики» в «Настройках» → «Импорт»."
          : "Их добавит тот, кто правит скрипты."}
      </EmptyCard>
    );
  }

  return (
    <AdminShell title={title} actions={actions || undefined}>
      {/* Колонка чтения — по левому краю, как у остальных разделов с
          ограниченной шириной: по центру плашка поиска стояла не там, где в
          соседних разделах. */}
      <div className={isCall && !searching ? "space-y-3" : "max-w-4xl space-y-3"}>
        {/* Поиск, язык и студия закреплены над прокруткой: нашли скрипт в
            длинном списке — язык меняется здесь же, без пути наверх.
            Липкость считается от паддинга main: отрицательные top и отступ
            забирают его, чтобы карточки уходили под полосу канвы, а не
            просвечивали над панелью. */}
        <div className="sticky -top-3 z-20 -mx-1 sm:-top-4 lg:-top-6 -mt-3 bg-canvas px-1 pt-3 pb-2 sm:-mt-4 sm:pt-4 lg:-mt-6 lg:pt-6">
          <TableToolbar>
            <SearchInput
              ref={searchRef}
              value={query}
              onChange={setQuery}
              placeholder="Поиск: «дорого», «адрес», «шпагат»…"
              aria-label="Поиск по скриптам"
              wrapperClassName="toolbar-search w-full max-w-96"
              emptyHint={
                // Одна клавиша «/» быстрее, чем дотянуться до поля мышью.
                <kbd
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border px-1.5 text-xs text-muted-foreground max-sm:hidden"
                >
                  /
                </kbd>
              }
            />
            <SegmentedControl
              aria-label="Язык текста"
              value={lang}
              onChange={setLang}
              options={LANGS.map((l) => ({ value: l.key, label: l.label }))}
            />
            {studios.length > 1 && (
              <SegmentedControl
                aria-label="Клуб"
                value={activeStudio}
                onChange={setStudio}
                options={studios.map((s) => ({ value: s, label: s }))}
              />
            )}
          </TableToolbar>
        </div>
        {!isLoading && access ? (
          <p className="text-sm text-muted-foreground">{hint}</p>
        ) : (
          <Skeleton className="h-4 w-48" />
        )}
        {content}
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing && (
            <ScriptEditor
              key={editing.item?.id ?? "new"}
              initial={editing.draft}
              initialTitle={editing.item?.title}
              sections={textSections}
              studios={studios}
              variables={insertable}
              isNew={!editing.item}
              onSave={(draft, note) => saveItem(editing.item, draft, note)}
              onDelete={editing.item ? () => deleteItem(editing.item!) : undefined}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!sectionForm} onOpenChange={(open) => !open && setSectionForm(null)}>
        <DialogContent className="max-w-md">
          {sectionForm && (
            <SectionDialogContent
              key={sectionForm.section?.id ?? "new"}
              isNew={!sectionForm.section}
              initial={sectionForm.section ?? undefined}
              onSubmit={(value) => saveSection(sectionForm.section, value)}
              onClose={() => setSectionForm(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Предложить может любой, кто видит скрипты: прав на правку у
          администраторов у стойки нет, а неудачный текст замечают они. */}
      <Dialog open={!!suggesting} onOpenChange={(open) => !open && setSuggesting(null)}>
        <DialogContent className="max-w-md">
          {suggesting && (
            <SuggestDialogContent
              key={suggesting.id}
              target={suggesting}
              onClose={() => setSuggesting(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

/**
 * «⋯» у раздела. Нужно редко — поэтому в меню, а не кнопками в шапке, где
 * они отвлекали бы от скриптов. Порядок двигают, не закрывая меню: раздел
 * часто переносят на несколько позиций подряд.
 */
function SectionMenu({
  title,
  canDelete,
  isFirst,
  isLast,
  onEdit,
  onMove,
  onDelete,
}: {
  title: string;
  canDelete: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`Раздел «${title}»: действия`}>
          <Ellipsis />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <ListItemButton
          onClick={() => {
            setOpen(false);
            onEdit();
          }}
        >
          <Pencil className="text-muted-foreground" />
          Название и иконка
        </ListItemButton>
        <ListItemButton disabled={isFirst} onClick={() => onMove(-1)}>
          <ArrowUp className="text-muted-foreground" />
          Выше в меню
        </ListItemButton>
        <ListItemButton disabled={isLast} onClick={() => onMove(1)}>
          <ArrowDown className="text-muted-foreground" />
          Ниже в меню
        </ListItemButton>
        {/* Раздел со скриптами не удаляется вовсе: вместе с ним ушли бы
            скрипты, которые кто-то писал и переводил на три языка. */}
        {canDelete && (
          <ListItemButton
            className="text-destructive hover:text-destructive"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 />
            Удалить раздел
          </ListItemButton>
        )}
      </PopoverContent>
    </Popover>
  );
}
