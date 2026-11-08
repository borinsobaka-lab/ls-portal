/**
 * Окно события календаря: создать или изменить (TASKS_CHATS_PLAN.md, этап
 * 2, раздел 4 брифа). Повторение серии правится «только это» (отдельное
 * событие) или «все» (время серии сдвигается на столько же). Проверки
 * прав — у базы (db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql).
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { PeopleField } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { calendarsQuery, saveEvent, saveOccurrence } from "@/lib/calendar/data";
import {
  calColor,
  calErrorText,
  eventToForm,
  formPayload,
  formProblem,
  FREQ_OPTIONS,
  newEventForm,
  REMINDERS_ALL_DAY,
  REMINDERS_TIMED,
  reminderLabel,
  WEEKDAYS,
  type EventForm,
} from "@/lib/calendar/logic";
import type { CalEvent, RRuleFreq } from "@/lib/calendar/types";
import { useChatCallsEnabled } from "@/lib/chats/calls-config";
import { usePeople } from "@/lib/chats/people";
import { absenceOn, absenceText } from "@/lib/people-calendar";
import { useAbsences, useTodayISO } from "@/lib/people-calendar-data";
import { useTaskClock } from "@/lib/tasks/data";
import { cn } from "@/lib/utils";

export type EventDraft =
  | {
      mode: "new";
      calendarId?: string;
      pick?: { day: string; time?: string; endDay?: string; endTime?: string; allDay?: boolean };
    }
  | { mode: "edit"; event: CalEvent; scope: "one" | "all" };

const TIPS = {
  calendar:
    "Кто увидит событие: личный календарь — только вы и участники, общий — все, кому он открыт.",
  attendees:
    "Им придёт приглашение «Приду / Не приду» и напоминания. Встреча будет и в их календаре.",
  video:
    "У встречи появится кнопка «Подключиться» — видеозвонок портала в чате встречи. Участников позовёт тот, кто подключится первым.",
  reminders: "Придут уведомлением в портале и пушем. Участник может поменять свои.",
};

export function EventFormDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: EventDraft | null;
  onClose: () => void;
  onSaved?: (id: string, calendarId: string) => void;
}) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-xl">
        {draft && (
          <EventFormBody
            key={draft.mode === "new" ? "new" : `${draft.event.id}:${draft.scope}`}
            draft={draft}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EventFormBody({
  draft,
  onClose,
  onSaved,
}: {
  draft: EventDraft;
  onClose: () => void;
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
  const personal = calendars.find((c) => c.kind === "personal");
  const writable = calendars.filter((c) => c.level === "edit" || c.level === "manage");

  const [f, setF] = useState<EventForm>(() => {
    if (editing) {
      const form = eventToForm(editing, tz);
      return { ...form, attendees: form.attendees.filter((id) => id !== editing.organizer_id) };
    }
    const calId =
      (draft.mode === "new" && draft.calendarId && writable.some((c) => c.id === draft.calendarId)
        ? draft.calendarId
        : personal?.id) ?? "";
    return newEventForm(calId, tz, new Date(), draft.mode === "new" ? draft.pick : undefined);
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<EventForm>) => setF((x) => ({ ...x, ...patch }));
  // Серия целиком — с повтором; одно повторение и отдельное событие серии — без.
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

  const submit = async () => {
    const problem = formProblem(f, tz);
    if (problem) {
      toast.error(problem);
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
        toast.success("Это повторение изменено");
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
        toast.success("Все повторения изменены");
      } else {
        const p = formPayload(f, tz);
        if (editing.series_id) {
          delete p.rrule;
          delete p.calendar_id;
        }
        id = await saveEvent(qc, editing.id, p);
        toast.success("Сохранено");
      }
      onSaved?.(id, f.calendarId);
      onClose();
    } catch (e) {
      toast.error(calErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const title = !editing
    ? "Новое событие"
    : editing.rrule && scope === "one"
      ? "Это повторение"
      : editing.rrule
        ? "Все повторения"
        : "Событие";

  return (
    <DialogForm onSubmit={submit}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {editing?.rrule && scope === "all"
            ? "Смена времени или повтора сбросит изменённые и отменённые отдельно повторения."
            : "Встреча, планёрка, акция или напоминание себе."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название" required htmlFor="cal-title">
          <Input
            id="cal-title"
            autoFocus={!editing}
            maxLength={200}
            value={f.title}
            placeholder="Например: Планёрка отдела маркетинга"
            onChange={(e) => set({ title: e.target.value })}
          />
        </FormField>

        <FormField label="Календарь" required tip={TIPS.calendar}>
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
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: calColor(c.color) }}
                    />
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <SwitchRow
          title="Весь день"
          checked={f.allDay}
          onCheckedChange={(allDay) =>
            set({
              allDay,
              reminders: allDay
                ? f.reminders.filter((m) => REMINDERS_ALL_DAY.includes(m)).length
                  ? f.reminders.filter((m) => REMINDERS_ALL_DAY.includes(m))
                  : [-540]
                : f.reminders.filter((m) => REMINDERS_TIMED.includes(m)).length
                  ? f.reminders.filter((m) => REMINDERS_TIMED.includes(m))
                  : [15],
            })
          }
        />

        <div className="grid grid-cols-[1fr_auto] gap-3 sm:grid-cols-[1fr_8rem]">
          <FormField label={f.allDay ? "С" : "Начало"} required htmlFor="cal-day-from">
            <Input
              id="cal-day-from"
              type="date"
              value={f.dayFrom}
              onChange={(e) => {
                const dayFrom = e.target.value;
                // Конец едет вслед за началом.
                const shift = f.dayTo && f.dayFrom ? daysBetween(f.dayFrom, f.dayTo) : 0;
                set({ dayFrom, dayTo: dayFrom ? addDaysSafe(dayFrom, shift) : f.dayTo });
              }}
            />
          </FormField>
          {!f.allDay && (
            <FormField label="Время" required htmlFor="cal-time-from">
              <Input
                id="cal-time-from"
                type="time"
                value={f.timeFrom}
                onChange={(e) => {
                  const timeFrom = e.target.value;
                  const dur = minutesBetween(f.timeFrom, f.timeTo);
                  set({ timeFrom, timeTo: timeFrom ? shiftTime(timeFrom, dur) : f.timeTo });
                }}
              />
            </FormField>
          )}
          <FormField label={f.allDay ? "По" : "Окончание"} required htmlFor="cal-day-to">
            <Input
              id="cal-day-to"
              type="date"
              value={f.dayTo}
              min={f.dayFrom}
              onChange={(e) => set({ dayTo: e.target.value })}
            />
          </FormField>
          {!f.allDay && (
            <FormField label="Время" required htmlFor="cal-time-to">
              <Input
                id="cal-time-to"
                type="time"
                value={f.timeTo}
                onChange={(e) => set({ timeTo: e.target.value })}
              />
            </FormField>
          )}
        </div>

        {recurrenceShown && (
          <div className="space-y-3">
            <FormField label="Повтор">
              <Select value={f.freq} onValueChange={(v) => set({ freq: v as RRuleFreq | "none" })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQ_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {f.freq === "weekly" && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Дни недели">
                {WEEKDAYS.map((d, i) => {
                  const on = f.weekdays.includes(i + 1);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      className={cn(
                        "size-9 rounded-full border text-sm font-medium transition-colors",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-background hover:bg-muted",
                      )}
                      onClick={() =>
                        set({
                          weekdays: on
                            ? f.weekdays.filter((x) => x !== i + 1)
                            : [...f.weekdays, i + 1],
                        })
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            )}
            {f.freq !== "none" && (
              <div className="grid grid-cols-2 gap-3">
                {f.freq !== "workdays" ? (
                  <FormField
                    label="Каждые"
                    htmlFor="cal-interval"
                    hint={intervalUnit(f.freq, f.interval)}
                  >
                    <Input
                      id="cal-interval"
                      type="number"
                      min={1}
                      max={99}
                      value={f.interval}
                      onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </FormField>
                ) : (
                  <div />
                )}
                <FormField label="До" optional htmlFor="cal-until" hint="Пусто — без конца">
                  <Input
                    id="cal-until"
                    type="date"
                    value={f.until}
                    min={f.dayFrom}
                    onChange={(e) => set({ until: e.target.value })}
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
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {editing ? "Сохранить" : f.attendees.length ? "Пригласить" : "Создать"}
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

/** Напоминания: чипы и «Добавить». */
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
  const options = (allDay ? REMINDERS_ALL_DAY : REMINDERS_TIMED).filter((m) => !value.includes(m));
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
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onChange(value.filter((x) => x !== m))}
              >
                <X className="size-3.5" />
              </button>
            )}
          </span>
        ))}
      {value.length === 0 && <span className="text-sm text-muted-foreground">Без напоминаний</span>}
      {!disabled && value.length < 5 && options.length > 0 && (
        <Select value="" onValueChange={(v) => onChange([...value, Number(v)])}>
          <SelectTrigger
            aria-label="Добавить напоминание"
            className="h-8 w-auto gap-1 rounded-full px-3 text-sm"
          >
            <Plus className="size-4" />
            <span>Добавить</span>
          </SelectTrigger>
          <SelectContent>
            {options.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {reminderLabel(m, allDay)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function intervalUnit(freq: RRuleFreq | "none", n: number): string {
  const one = n % 10 === 1 && n % 100 !== 11;
  const few = [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100);
  const pick = (a: string, b: string, c: string) => (one ? a : few ? b : c);
  if (freq === "daily") return pick("день", "дня", "дней");
  if (freq === "weekly") return pick("неделю", "недели", "недель");
  if (freq === "monthly") return pick("месяц", "месяца", "месяцев");
  if (freq === "yearly") return pick("год", "года", "лет");
  return "";
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
