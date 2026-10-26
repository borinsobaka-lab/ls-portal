import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { StudioLabel, StudioSelect } from "@/components/studio-label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { Textarea } from "@/components/ui/textarea";
import type { Studio } from "@/hooks/use-studios";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { supabase } from "@/integrations/supabase/client";
import { FormattedText } from "@/lib/formatted-text";
import { cn } from "@/lib/utils";
import { WORKDAY_KEY, useWorkdayGroups } from "@/lib/workday/data";
import {
  formatCheckedAt,
  formatDueTime,
  moveId,
  timeInputValue,
  workdayErrorText,
  type WorkdayData,
  type WorkdayGroup,
  type WorkdayRow,
  type WorkdaySection,
} from "@/lib/workday/logic";

const TIPS = {
  time: "К какому времени сделать — ориентировочно. Не отмечен к этому времени — у пункта и на кнопке «Рабочий день» загорается «!». Пусто — пункт без времени.",
  details:
    "Подробная инструкция: раскрывается у пункта по стрелке. Можно жирный текст, списки и ссылки на документы.",
};

type DialogState =
  | { kind: "item"; item: WorkdayRow | null; sectionId: string }
  | { kind: "section"; section: WorkdaySection | null }
  | { kind: "copy" }
  | null;

/**
 * Панель «Рабочий день» (шторка справа): блоки дня, пункты с ориентировочным
 * временем и отметками за сегодня. Отмечает любой сотрудник клуба, отметку
 * видят все; владелец клуба по «Настроить» правит блоки и пункты.
 */
export function WorkdayPanel({
  studios,
  studio,
  onStudio,
}: {
  studios: Studio[];
  studio: Studio;
  onStudio: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: me } = useStaffProfile();
  const { query, now, groups, summary } = useWorkdayGroups(studio.id);
  const canEdit = studio.roles.includes("owner");
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { confirm, confirmDialog } = useConfirm();
  const key = [WORKDAY_KEY, studio.id, now.day];
  const refresh = () => queryClient.invalidateQueries({ queryKey: [WORKDAY_KEY, studio.id] });

  const today = new Date().toLocaleDateString("ru-RU", {
    timeZone: "Asia/Tbilisi",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // Отметка — сразу на экране, до ответа базы; ошибка — назад и тост.
  // Дубль (коллега отметил тот же пункт секундой раньше) — не ошибка.
  const toggle = async (row: WorkdayRow, checked: boolean) => {
    const prev = queryClient.getQueryData<WorkdayData>(key);
    queryClient.setQueryData<WorkdayData>(key, (d) =>
      d
        ? {
            ...d,
            checks: [
              ...d.checks.filter((c) => c.item_id !== row.id),
              ...(checked
                ? [
                    {
                      item_id: row.id,
                      day: now.day,
                      checked_by: me?.id ?? null,
                      checked_by_name: me?.fullName ?? null,
                      checked_at: new Date().toISOString(),
                    },
                  ]
                : []),
            ],
          }
        : d,
    );
    const { error } = checked
      ? await supabase.from("workday_checks").insert({ item_id: row.id })
      : await supabase.from("workday_checks").delete().eq("item_id", row.id).eq("day", now.day);
    if (error && !(checked && error.code === "23505")) {
      queryClient.setQueryData(key, prev);
      toast.error(`Не удалось сохранить отметку: ${workdayErrorText(error.message)}`);
    }
    void refresh();
  };

  const reorder = async (kind: "section" | "item", ids: string[] | null) => {
    if (!ids) return;
    const { error } = await supabase.rpc("workday_reorder", { p_kind: kind, p_ids: ids });
    if (error) toast.error(`Не удалось переставить: ${workdayErrorText(error.message)}`);
    void refresh();
  };

  const removeItem = async (row: WorkdayRow) => {
    if (!(await confirm({ title: "Удалить пункт?", description: row.title }))) return;
    const { error } = await supabase.from("workday_items").delete().eq("id", row.id);
    if (error) toast.error(`Не удалось удалить: ${workdayErrorText(error.message)}`);
    void refresh();
  };

  const removeSection = async (g: WorkdayGroup) => {
    const ok = await confirm({
      title: "Удалить блок?",
      description: g.rows.length
        ? `«${g.section.title}» и его пункты (${g.rows.length}) удалятся вместе с отметками.`
        : `«${g.section.title}»`,
    });
    if (!ok) return;
    const { error } = await supabase.from("workday_sections").delete().eq("id", g.section.id);
    if (error) toast.error(`Не удалось удалить: ${workdayErrorText(error.message)}`);
    void refresh();
  };

  const sectionIds = groups.map((g) => g.section.id);
  const percent = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;

  return (
    <>
      <SheetHeader className="shrink-0 space-y-3 border-b px-6 py-4 pr-12">
        <div className="space-y-1">
          <SheetTitle>Рабочий день</SheetTitle>
          <SheetDescription className="first-letter:uppercase">{today}</SheetDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {studios.length > 1 ? (
            <div className="min-w-0 flex-1">
              <StudioSelect studios={studios} value={studio.id} onChange={onStudio} />
            </div>
          ) : (
            <StudioLabel studio={studio} className="flex-1 text-sm font-medium" />
          )}
          {canEdit && (
            <Button
              variant={editing ? "default" : "outline"}
              aria-pressed={editing}
              onClick={() => setEditing((v) => !v)}
            >
              <Settings2 />
              {editing ? "Готово" : "Настроить"}
            </Button>
          )}
        </div>
        {summary.total > 0 && !editing && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>
                Выполнено{" "}
                <span className="font-semibold tabular-nums">
                  {summary.done} из {summary.total}
                </span>
              </span>
              {summary.overdue > 0 && (
                <StatusChip tone="negative">Просрочено: {summary.overdue}</StatusChip>
              )}
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Выполнено за день"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-4">
        {query.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              Порядок рабочего дня клуба «{studio.name}» ещё не заполнен.
            </p>
            {canEdit ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setDialog({ kind: "section", section: null })}>
                  <Plus />
                  Блок
                </Button>
                {studios.length > 1 && (
                  <Button variant="outline" onClick={() => setDialog({ kind: "copy" })}>
                    <Copy />
                    Скопировать из клуба
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Его заполняет владелец клуба.</p>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.section.id} aria-label={g.section.title} className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 flex-1 text-sm font-semibold">{g.section.title}</h3>
                {editing ? (
                  <RowTools
                    label={`блок «${g.section.title}»`}
                    onUp={() => void reorder("section", moveId(sectionIds, g.section.id, -1))}
                    onDown={() => void reorder("section", moveId(sectionIds, g.section.id, 1))}
                    first={g.section.id === sectionIds[0]}
                    last={g.section.id === sectionIds[sectionIds.length - 1]}
                    onEdit={() => setDialog({ kind: "section", section: g.section })}
                    onDelete={() => void removeSection(g)}
                  />
                ) : (
                  <>
                    {g.overdue > 0 && (
                      <StatusChip tone="negative" size="sm">
                        ! {g.overdue}
                      </StatusChip>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {g.done} из {g.rows.length}
                    </span>
                  </>
                )}
              </div>
              <ul className="divide-y">
                {g.rows.map((row) => {
                  const ids = g.rows.map((r) => r.id);
                  const open = expanded.has(row.id);
                  const checkboxId = `workday-${row.id}`;
                  return (
                    <li key={row.id} className="py-2">
                      <div className="flex items-start gap-3">
                        {!editing && (
                          <Checkbox
                            id={checkboxId}
                            className="mt-0.5 size-5"
                            checked={!!row.check}
                            onCheckedChange={(v) => void toggle(row, v === true)}
                          />
                        )}
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-start gap-2">
                            <label
                              htmlFor={editing ? undefined : checkboxId}
                              className={cn(
                                "min-w-0 flex-1 text-sm leading-5",
                                !editing && "cursor-pointer",
                                row.check && "text-muted-foreground line-through",
                              )}
                            >
                              {row.title}
                            </label>
                            {row.due_time && (
                              <StatusChip
                                tone={row.overdue ? "negative" : "neutral"}
                                size="sm"
                                className="mt-0.5 tabular-nums"
                                title={
                                  row.overdue
                                    ? `Просрочено: нужно было сделать к ${formatDueTime(row.due_time)}`
                                    : `Сделать к ${formatDueTime(row.due_time)}`
                                }
                              >
                                {row.overdue && <span className="font-bold">!</span>}
                                {formatDueTime(row.due_time)}
                              </StatusChip>
                            )}
                            {row.details && !editing && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="-my-1.5 -mr-2"
                                aria-expanded={open}
                                aria-label={open ? "Скрыть инструкцию" : "Подробнее"}
                                title={open ? "Скрыть инструкцию" : "Подробнее"}
                                onClick={() =>
                                  setExpanded((s) => {
                                    const next = new Set(s);
                                    if (next.has(row.id)) next.delete(row.id);
                                    else next.add(row.id);
                                    return next;
                                  })
                                }
                              >
                                <ChevronDown
                                  className={cn("transition-transform", open && "rotate-180")}
                                />
                              </Button>
                            )}
                            {editing && (
                              <RowTools
                                label={`пункт «${row.title}»`}
                                onUp={() => void reorder("item", moveId(ids, row.id, -1))}
                                onDown={() => void reorder("item", moveId(ids, row.id, 1))}
                                first={row.id === ids[0]}
                                last={row.id === ids[ids.length - 1]}
                                onEdit={() =>
                                  setDialog({ kind: "item", item: row, sectionId: row.section_id })
                                }
                                onDelete={() => void removeItem(row)}
                              />
                            )}
                          </div>
                          {row.check && !editing && (
                            <p className="text-xs text-muted-foreground">
                              {row.check.checked_by_name || "Сотрудник"},{" "}
                              {formatCheckedAt(row.check.checked_at)}
                            </p>
                          )}
                          {editing && row.details && (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              Есть инструкция
                            </p>
                          )}
                          {open && row.details && !editing && (
                            <FormattedText
                              text={row.details}
                              className="mt-1.5 rounded-md bg-muted/50 p-3 text-sm"
                              linkClass="font-medium text-brand-on-light underline underline-offset-2"
                            />
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {editing && (
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => setDialog({ kind: "item", item: null, sectionId: g.section.id })}
                >
                  <Plus />
                  Пункт
                </Button>
              )}
            </section>
          ))
        )}

        {editing && groups.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="outline" onClick={() => setDialog({ kind: "section", section: null })}>
              <Plus />
              Блок
            </Button>
            {studios.length > 1 && (
              <Button variant="outline" onClick={() => setDialog({ kind: "copy" })}>
                <Copy />
                Скопировать из клуба
              </Button>
            )}
          </div>
        )}
      </div>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-lg">
          {dialog?.kind === "item" && (
            <ItemForm
              key={dialog.item?.id ?? "new"}
              item={dialog.item}
              sectionId={dialog.sectionId}
              sections={groups.map((g) => g.section)}
              nextOrder={
                (groups.find((g) => g.section.id === dialog.sectionId)?.rows.at(-1)?.sort_order ??
                  0) + 1
              }
              onDone={() => {
                setDialog(null);
                void refresh();
              }}
            />
          )}
          {dialog?.kind === "section" && (
            <SectionForm
              key={dialog.section?.id ?? "new"}
              studioId={studio.id}
              section={dialog.section}
              nextOrder={(groups.at(-1)?.section.sort_order ?? 0) + 1}
              onDone={() => {
                setDialog(null);
                void refresh();
              }}
            />
          )}
          {dialog?.kind === "copy" && (
            <CopyForm
              studio={studio}
              sources={studios.filter((s) => s.id !== studio.id)}
              replacing={summary.total > 0 || groups.length > 0}
              onDone={() => {
                setDialog(null);
                void refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

/** Действия строки в режиме настройки: выше, ниже, изменить, удалить. */
function RowTools({
  label,
  first,
  last,
  onUp,
  onDown,
  onEdit,
  onDelete,
}: {
  label: string;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="-my-1.5 flex shrink-0 items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={first}
        onClick={onUp}
        aria-label={`Выше: ${label}`}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={last}
        onClick={onDown}
        aria-label={`Ниже: ${label}`}
      >
        <ArrowDown />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Изменить ${label}`}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Удалить ${label}`}>
        <Trash2 />
      </Button>
    </div>
  );
}

function ItemForm({
  item,
  sectionId,
  sections,
  nextOrder,
  onDone,
}: {
  item: WorkdayRow | null;
  sectionId: string;
  sections: WorkdaySection[];
  nextOrder: number;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [section, setSection] = useState(item?.section_id ?? sectionId);
  const [time, setTime] = useState(timeInputValue(item?.due_time));
  const [details, setDetails] = useState(item?.details ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("Напишите, что сделать");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        section_id: section,
        title: title.trim(),
        due_time: time || null,
        details: details.trim() || null,
      };
      // Перенос в другой блок — в его конец.
      const { error } = item
        ? await supabase
            .from("workday_items")
            .update(section === item.section_id ? payload : { ...payload, sort_order: 10_000 })
            .eq("id", item.id)
        : await supabase.from("workday_items").insert({ ...payload, sort_order: nextOrder });
      if (error) {
        toast.error(`Не удалось сохранить: ${workdayErrorText(error.message)}`);
        return;
      }
      toast.success(item ? "Пункт сохранён" : "Пункт добавлен");
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Пункт рабочего дня" : "Новый пункт"}</DialogTitle>
        <DialogDescription>Его видят и отмечают все сотрудники клуба.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Что сделать" required>
              <Textarea
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Включить свет и кондиционеры"
                rows={2}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Блок" required>
                <Select value={section} onValueChange={setSection}>
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
              <FormField label="Сделать к" tip={TIPS.time} optional>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Подробная инструкция" tip={TIPS.details} htmlFor={null} optional>
              <FormattedTextarea
                value={details}
                onChange={setDetails}
                placeholder="Как сделать, примеры, ссылки на документы"
                rows={5}
                previewLabel="Как увидят сотрудники"
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

function SectionForm({
  studioId,
  section,
  nextOrder,
  onDone,
}: {
  studioId: string;
  section: WorkdaySection | null;
  nextOrder: number;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(section?.title ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("Укажите название блока");
      return;
    }
    setSaving(true);
    try {
      const { error } = section
        ? await supabase
            .from("workday_sections")
            .update({ title: title.trim() })
            .eq("id", section.id)
        : await supabase
            .from("workday_sections")
            .insert({ studio_id: studioId, title: title.trim(), sort_order: nextOrder });
      if (error) {
        toast.error(`Не удалось сохранить: ${workdayErrorText(error.message)}`);
        return;
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{section ? "Название блока" : "Новый блок"}</DialogTitle>
        <DialogDescription>
          Часть дня: «Начало рабочего дня», «Конец рабочего дня»…
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <FormField label="Название" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Начало рабочего дня"
              maxLength={120}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

function CopyForm({
  studio,
  sources,
  replacing,
  onDone,
}: {
  studio: Studio;
  sources: Studio[];
  replacing: boolean;
  onDone: () => void;
}) {
  const [from, setFrom] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!from) {
      toast.error("Выберите клуб");
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("workday_copy", { p_from: from, p_to: studio.id });
      if (error) {
        toast.error(`Не удалось скопировать: ${workdayErrorText(error.message)}`);
        return;
      }
      toast.success(`Скопировано пунктов: ${data ?? 0}`);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Скопировать из клуба</DialogTitle>
        <DialogDescription>
          Блоки и пункты другого клуба — в «{studio.name}», дальше их можно поправить.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Откуда" htmlFor={null} required>
              <StudioSelect studios={sources} value={from} onChange={setFrom} />
            </FormField>
            {replacing && (
              <InfoNote variant="warning">
                Нынешние блоки и пункты клуба «{studio.name}» заменятся копией, сегодняшние отметки
                сбросятся.
              </InfoNote>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Копируем…" : "Скопировать"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}
