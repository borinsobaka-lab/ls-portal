/**
 * Окно события календаря: создать или изменить (TASKS_CHATS_PLAN.md, этап
 * 2, раздел 4 брифа; упрощение — UI_REVIEW_CHATS_TASKS_CALENDAR.md, 5.3).
 * Сначала главное — название, время, повтор под дату, участники; календарь —
 * внизу и только когда писать можно в два и больше. Ошибки — под полями,
 * закрыть заполненную форму — с вопросом. Событие серии правится «только
 * это» (отдельное событие) или «все» (время серии сдвигается на столько
 * же). Проверки прав — у базы (db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql).
 */
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { PeopleField } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import { DateField, TimeField } from "@/components/ui/date-field";
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
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WeekdayToggle } from "@/components/ui/weekday-toggle";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { calendarsQuery, saveEvent, saveOccurrence } from "@/lib/calendar/data";
import {
  allDayReminder,
  applyRepeatPreset,
  calColor,
  calErrorText,
  dayTitle,
  defaultCalendarId,
  eventToForm,
  FORM_FIELD_ORDER,
  formErrors,
  formPayload,
  newEventForm,
  REMINDERS_ALL_DAY,
  REMINDERS_TIMED,
  reminderLabel,
  repeatOptions,
  repeatPresetOf,
  type EventForm,
  type EventFormField,
  type RepeatPreset,
  writableCalendars,
} from "@/lib/calendar/logic";
import type { CalEvent, RRuleFreq } from "@/lib/calendar/types";
import { useChatCallsEnabled } from "@/lib/chats/calls-config";
import { usePeople } from "@/lib/chats/people";
import { timezoneLabel } from "@/lib/notifications/settings-logic";
import { absenceOn, absenceText } from "@/lib/people-calendar";
import { useAbsences, useTodayISO } from "@/lib/people-calendar-data";
import { useTaskClock } from "@/lib/tasks/data";
import { localDay } from "@/lib/tasks/logic";

export type EventPick = {
  day: string;
  time?: string;
  endDay?: string;
  endTime?: string;
  allDay?: boolean;
};

export type EventDraft =
  | {
      mode: "new";
      calendarId?: string;
      pick?: EventPick;
      /** Уже введённое (быстрое создание → «Ещё параметры»). */
      form?: EventForm;
    }
  | { mode: "edit"; event: CalEvent; scope: "one" | "all" };

const TIPS = {
  calendar:
    "Кто увидит событие: личный календарь — только вы и участники, общий — все, кому он открыт.",
  attendees:
    "Им придёт приглашение — ответят «Приду / Возможно / Не приду». Встреча появится и в их календаре.",
  video:
    "У встречи появится кнопка «Подключиться» — видеозвонок портала в чате встречи. Участников позовёт тот, кто подключится первым.",
  reminders: "Придут уведомлением в портале и на устройство. Участник может поменять свои.",
};

const FREQ_CUSTOM: { value: RRuleFreq; label: string }[] = [
  { value: "daily", label: "Дни" },
  { value: "weekly", label: "Недели" },
  { value: "monthly", label: "Месяцы" },
  { value: "yearly", label: "Годы" },
];

export function EventFormDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: EventDraft | null;
  onClose: () => void;
  onSaved?: (id: string, calendarId: string) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const dirty = useRef(false);
  const tryClose = async () => {
    if (
      dirty.current &&
      !(await confirm({
        title: "Закрыть без сохранения?",
        description: "Введённое в форму пропадёт.",
        confirmLabel: "Закрыть",
        cancelLabel: "Вернуться к форме",
      }))
    )
      return;
    dirty.current = false;
    onClose();
  };
  return (
    <>
      <Dialog open={!!draft} onOpenChange={(o) => !o && void tryClose()}>
        <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-xl">
          {draft && (
            <EventFormBody
              key={draft.mode === "new" ? "new" : `${draft.event.id}:${draft.scope}`}
              draft={draft}
              onDirty={(d) => {
                dirty.current = d;
              }}
              onCancel={() => void tryClose()}
              onDone={() => {
                dirty.current = false;
                onClose();
              }}
              onSaved={onSaved}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

function EventFormBody({
  draft,
  onDirty,
  onCancel,
  onDone,
  onSaved,
}: {
  draft: EventDraft;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
  onSaved?: (id: string, calendarId: string) => void;
}) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { data: me } = useStaffProfile();
  const { data: calendars = [] } = useQuery(calendarsQuery);
  const callsEnabled = useChatCallsEnabled();
  const editing = draft.mode === "edit" ? draft.event : null;
  const scope = draft.mode === "edit" ? draft.scope : null;
  const organizer = editing?.organizer_id ?? me?.id ?? null;
  const writable = writableCalendars(calendars);

  const [initial] = useState<EventForm>(() => {
    if (editing) {
      const form = eventToForm(editing, tz);
      return { ...form, attendees: form.attendees.filter((id) => id !== editing.organizer_id) };
    }
    if (draft.mode === "new" && draft.form) return draft.form;
    return newEventForm(
      defaultCalendarId(calendars, draft.mode === "new" ? draft.calendarId : undefined),
      tz,
      new Date(),
      draft.mode === "new" ? draft.pick : undefined,
    );
  });
  const [f, setF] = useState<EventForm>(initial);
  const [preset, setPreset] = useState<RepeatPreset>(() => repeatPresetOf(initial));
  const [errors, setErrors] = useState<Partial<Record<EventFormField, string>>>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<EventForm>, clear?: EventFormField[]) => {
    const next = { ...f, ...patch };
    setF(next);
    onDirty(JSON.stringify(next) !== JSON.stringify(initial));
    if (clear?.some((k) => errors[k])) {
      setErrors((e) => {
        const next = { ...e };
        for (const k of clear) delete next[k];
        return next;
      });
    }
  };

  // Серия целиком — с повтором; одно событие серии и отдельное событие серии — без.
  const recurrenceShown = !editing || (!editing.series_id && scope !== "one");
  const calendarLocked = !!editing?.series_id || scope === "one";
  const currentCal = calendars.find((c) => c.id === f.calendarId);
  const calOptions = useMemo(() => {
    const list = [...writable];
    if (currentCal && !list.some((c) => c.id === currentCal.id)) list.unshift(currentCal);
    if (editing && !currentCal) {
      list.unshift({
        id: editing.calendar.id,
        kind: editing.calendar.kind,
        name: editing.calendar.name,
        color: editing.calendar.color,
        description: null,
        owner_id: null,
        level: "view",
      });
    }
    return list;
  }, [writable, currentCal, editing]);
  // Календарь — только если есть из чего выбрать (у большинства — один личный).
  const calendarShown = writable.length >= 2;

  const changeDayFrom = (dayFrom: string) => {
    // Конец едет вслед за началом, повтор «под дату» — тоже.
    const shift = f.dayTo && f.dayFrom ? daysBetween(f.dayFrom, f.dayTo) : 0;
    const patch: Partial<EventForm> = {
      dayFrom,
      dayTo: dayFrom ? addDaysSafe(dayFrom, shift) : f.dayTo,
    };
    if (preset !== "custom" && preset !== "none") {
      Object.assign(patch, applyRepeatPreset({ ...f, dayFrom }, preset));
    }
    set(patch, ["time", "until"]);
  };

  const pickPreset = (p: RepeatPreset) => {
    setPreset(p);
    set(applyRepeatPreset(f, p), ["weekdays", "until"]);
  };

  const submit = async () => {
    const problems = formErrors(f, tz);
    const first = FORM_FIELD_ORDER.find((k) => problems[k]);
    if (first) {
      setErrors(problems);
      const target: Record<EventFormField, string> = {
        title: "cal-title",
        time: "cal-day-from",
        weekdays: "cal-weekdays",
        until: "cal-until",
      };
      const el = document.getElementById(target[first]);
      (el?.matches("button, input") ? el : el?.querySelector<HTMLElement>("button"))?.focus();
      return;
    }
    setBusy(true);
    try {
      let id: string;
      if (!editing) {
        id = await saveEvent(qc, null, formPayload(f, tz));
        toast.success(
          f.attendees.length ? "Встреча создана, приглашения отправлены" : "Событие создано",
        );
      } else if (editing.rrule && scope === "one") {
        const p = formPayload(f, tz);
        delete p.rrule;
        delete p.calendar_id;
        id = await saveOccurrence(qc, editing.id, editing.occ_start, p);
        toast.success("Событие изменено");
      } else if (editing.rrule) {
        id = await saveEvent(
          qc,
          editing.id,
          formPayload(f, tz, {
            occStart: editing.occ_start,
            occEnd: editing.occ_end,
            seriesStart: editing.starts_at,
            seriesEnd: editing.ends_at,
          }),
        );
        toast.success("Серия изменена");
      } else {
        const p = formPayload(f, tz);
        if (editing.series_id) {
          delete p.rrule;
          delete p.calendar_id;
        }
        id = await saveEvent(qc, editing.id, p);
        toast.success("Событие изменено");
      }
      onSaved?.(id, f.calendarId);
      onDone();
    } catch (e) {
      toast.error(calErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const occDay = editing ? localDay(new Date(editing.occ_start), tz) : "";
  const description = !editing
    ? "Встреча, планёрка, акция или напоминание себе."
    : editing.rrule && scope === "one"
      ? `Только это событие, ${dayTitle(occDay, false)}`
      : editing.rrule
        ? "Все события серии. Если поменять время или повтор, отдельно изменённые даты вернутся к общему правилу."
        : "Участники получат уведомление, если поменять время.";

  return (
    <DialogForm onSubmit={submit}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{editing ? "Изменить событие" : "Новое событие"}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название" required htmlFor="cal-title" error={errors.title}>
          <Input
            id="cal-title"
            autoFocus={!editing}
            maxLength={200}
            value={f.title}
            placeholder="Например: Планёрка отдела маркетинга"
            onChange={(e) => set({ title: e.target.value }, ["title"])}
          />
        </FormField>

        <SwitchRow
          title="Весь день"
          checked={f.allDay}
          onCheckedChange={(allDay) =>
            set({
              allDay,
              reminders: allDay
                ? f.reminders.filter((m) => m < 0 || REMINDERS_ALL_DAY.includes(m)).length
                  ? f.reminders.filter((m) => m < 0 || REMINDERS_ALL_DAY.includes(m))
                  : [-540]
                : f.reminders.filter((m) => REMINDERS_TIMED.includes(m)).length
                  ? f.reminders.filter((m) => REMINDERS_TIMED.includes(m))
                  : [15],
            })
          }
        />

        <div className="space-y-3">
          <FormField label="Начало" required htmlFor={null}>
            <div className="flex gap-2">
              <DateField
                id="cal-day-from"
                aria-label="День начала"
                className="min-w-0 flex-1"
                value={f.dayFrom}
                onChange={changeDayFrom}
              />
              {!f.allDay && (
                <TimeField
                  step={15}
                  aria-label="Время начала"
                  value={f.timeFrom}
                  onChange={(timeFrom) => {
                    const dur = minutesBetween(f.timeFrom, f.timeTo);
                    set({ timeFrom, timeTo: shiftTime(timeFrom, dur) }, ["time"]);
                  }}
                />
              )}
            </div>
          </FormField>
          <FormField
            label="Окончание"
            required
            htmlFor={null}
            error={errors.time}
            hint={f.allDay ? undefined : `Время — ${timezoneLabel(tz)}`}
          >
            <div className="flex gap-2">
              <DateField
                aria-label="День окончания"
                className="min-w-0 flex-1"
                value={f.dayTo}
                min={f.dayFrom}
                onChange={(dayTo) => set({ dayTo }, ["time"])}
              />
              {!f.allDay && (
                <TimeField
                  step={15}
                  aria-label="Время окончания"
                  value={f.timeTo}
                  onChange={(timeTo) => set({ timeTo }, ["time"])}
                />
              )}
            </div>
          </FormField>
        </div>

        {recurrenceShown && (
          <div className="space-y-3">
            <FormField label="Повтор">
              <Select value={preset} onValueChange={(v) => pickPreset(v as RepeatPreset)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repeatOptions(f.dayFrom).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {preset === "custom" && (
              <div className="space-y-3 rounded-md border p-3">
                <FormField label="Каждые" htmlFor={null}>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Каждые сколько"
                      type="number"
                      min={1}
                      max={99}
                      className="w-20"
                      value={f.freq === "workdays" ? 1 : f.interval}
                      disabled={f.freq === "workdays"}
                      onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
                    />
                    <Select
                      value={f.freq === "workdays" || f.freq === "none" ? "weekly" : f.freq}
                      onValueChange={(v) => set({ freq: v as RRuleFreq }, ["weekdays"])}
                    >
                      <SelectTrigger aria-label="Единица повтора" className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FREQ_CUSTOM.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </FormField>
                {f.freq === "weekly" && (
                  <FormField label="По дням" htmlFor={null} error={errors.weekdays}>
                    <WeekdayToggle
                      id="cal-weekdays"
                      value={f.weekdays}
                      invalid={!!errors.weekdays}
                      onChange={(weekdays) => set({ weekdays }, ["weekdays"])}
                    />
                  </FormField>
                )}
                <FormField label="До" optional htmlFor={null} error={errors.until}>
                  <DateField
                    id="cal-until"
                    aria-label="Последний день повтора"
                    placeholder="Без конца"
                    allowClear
                    value={f.until}
                    min={f.dayFrom}
                    onChange={(until) => set({ until }, ["until"])}
                  />
                </FormField>
              </div>
            )}
          </div>
        )}

        <FormField label="Участники" htmlFor={null} tip={TIPS.attendees}>
          <div className="space-y-2">
            {organizer && (
              <p className="text-xs text-muted-foreground">
                Организатор — {organizer === me?.id ? "вы" : <OrganizerName id={organizer} />}
              </p>
            )}
            <PeopleField
              value={f.attendees}
              exclude={organizer ? [organizer] : []}
              onChange={(attendees) => set({ attendees })}
              addLabel="Пригласить"
            />
            <AwayNote ids={f.attendees} from={f.dayFrom} to={f.allDay ? f.dayTo : f.dayFrom} />
          </div>
        </FormField>

        {callsEnabled && (
          <SwitchRow
            title="Видеовстреча"
            tip={TIPS.video}
            checked={f.video}
            onCheckedChange={(video) => set({ video })}
          />
        )}

        <FormField label="Место" optional htmlFor="cal-location">
          <Input
            id="cal-location"
            maxLength={300}
            value={f.location}
            placeholder="Переговорная, адрес или ссылка"
            onChange={(e) => set({ location: e.target.value })}
          />
        </FormField>

        <FormField label="Описание" optional htmlFor="cal-description">
          <Textarea
            id="cal-description"
            rows={3}
            maxLength={5000}
            value={f.description}
            placeholder="Повестка, ссылки, что подготовить"
            onChange={(e) => set({ description: e.target.value })}
          />
        </FormField>

        <FormField label="Напоминания" htmlFor={null} tip={TIPS.reminders}>
          <ReminderPicker
            value={f.reminders}
            allDay={f.allDay}
            onChange={(reminders) => set({ reminders })}
          />
        </FormField>

        {calendarShown && (
          <FormField
            label="Календарь"
            tip={TIPS.calendar}
            hint={calendarLocked ? "Календарь меняется у всей серии" : undefined}
          >
            <Select
              value={f.calendarId}
              disabled={calendarLocked}
              onValueChange={(v) => set({ calendarId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Календарь" />
              </SelectTrigger>
              <SelectContent>
                {calOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={c.level === "view"}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: calColor(c.color) }}
                      />
                      {c.kind === "personal" ? "Личный календарь" : c.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {editing ? "Сохранить" : "Создать"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

function OrganizerName({ id }: { id: string }) {
  const { name } = usePeople();
  return <>{name(id)}</>;
}

/** Кто из приглашённых не на месте в дни встречи. */
function AwayNote({ ids, from, to }: { ids: string[]; from: string; to: string }) {
  const { name } = usePeople();
  const list = useAbsences();
  const today = useTodayISO();
  if (!from) return null;
  const away = ids
    .map((id) => ({ id, a: absenceOn(list, id, from, to < from ? from : to) }))
    .filter((x) => x.a);
  if (away.length === 0) return null;
  return (
    <InfoNote variant="warning">
      {away.map((x, i) => (
        <span key={x.id}>
          {i > 0 && "; "}
          {name(x.id)} — {absenceText(x.a!, today)}
        </span>
      ))}
    </InfoNote>
  );
}

const ALL_DAY_OFFSETS: { days: number; label: string }[] = [
  { days: 0, label: "В день события" },
  { days: 1, label: "За день" },
  { days: 2, label: "За 2 дня" },
  { days: 7, label: "За неделю" },
];
const REMINDER_HOURS = Array.from({ length: 17 }, (_, i) => i + 6); // 06:00–22:00

/**
 * Напоминания: чипы и «+ Добавить напоминание» — меню вариантов. У события
 * на весь день — ещё и час, в который придёт напоминание.
 */
export function ReminderPicker({
  value,
  allDay,
  onChange,
  disabled = false,
}: {
  value: number[];
  allDay: boolean;
  onChange: (v: number[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hour, setHour] = useState(9);
  const options = REMINDERS_TIMED.filter((m) => !value.includes(m));
  const add = (m: number) => {
    if (!value.includes(m)) onChange([...value, m]);
    setOpen(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...value]
        .sort((a, b) => a - b)
        .map((m) => (
          <span
            key={m}
            className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pr-1 pl-2.5 text-sm"
          >
            {reminderLabel(m, allDay)}
            {!disabled && (
              <button
                type="button"
                aria-label={`Убрать: ${reminderLabel(m, allDay)}`}
                title="Убрать"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onChange(value.filter((x) => x !== m))}
              >
                <X className="size-3.5" />
              </button>
            )}
          </span>
        ))}
      {value.length === 0 && <span className="text-sm text-muted-foreground">Без напоминаний</span>}
      {!disabled && value.length < 5 && (allDay || options.length > 0) && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="link" size="inline">
              <Plus /> Добавить напоминание
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            {allDay ? (
              <>
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Во сколько</span>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                    <SelectTrigger aria-label="Час напоминания" className="ml-auto w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {REMINDER_HOURS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {String(h).padStart(2, "0")}:00
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {ALL_DAY_OFFSETS.map((o) => {
                  const m = allDayReminder(o.days, hour);
                  return (
                    <ListItemButton
                      key={o.days}
                      disabled={value.includes(m)}
                      onClick={() => add(m)}
                    >
                      {o.label} в {String(hour).padStart(2, "0")}:00
                    </ListItemButton>
                  );
                })}
              </>
            ) : (
              options.map((m) => (
                <ListItemButton key={m} onClick={() => add(m)}>
                  {reminderLabel(m, false)}
                </ListItemButton>
              ))
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
function addDaysSafe(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t)
    ? day
    : new Date(t + Math.max(0, n) * 86_400_000).toISOString().slice(0, 10);
}
function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  const d = bh * 60 + bm - (ah * 60 + am);
  return Number.isFinite(d) && d > 0 ? d : 60;
}
function shiftTime(t: string, mins: number): string {
  const [h, m] = t.split(":").map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + mins);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
