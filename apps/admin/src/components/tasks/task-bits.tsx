/**
 * Мелкие части задач: статус, срок (красный — просрочен), срочность, человек
 * строкой, поле выбора людей (исполнитель, соисполнители, наблюдатели).
 */
import { useState } from "react";
import { AlertTriangle, CalendarOff, Plus, X } from "lucide-react";

import { PeoplePicker } from "@/components/chats/dialogs";
import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusChip } from "@/components/ui/status-chip";
import { usePeople } from "@/lib/chats/people";
import { absenceOn, absenceText, localISO } from "@/lib/people-calendar";
import { useAbsences, useTodayISO } from "@/lib/people-calendar-data";
import { formatDeadline, isOverdue, STATUS_LABEL, STATUS_TONE } from "@/lib/tasks/logic";
import type { TaskRow, TaskStatus } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

export function TaskStatusChip({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <StatusChip tone={STATUS_TONE[status]} className={className}>
      {STATUS_LABEL[status]}
    </StatusChip>
  );
}

export function DeadlineText({
  task,
  tz,
  className,
}: {
  task: Pick<TaskRow, "deadline" | "status">;
  tz: string;
  className?: string;
}) {
  if (!task.deadline)
    return <span className={cn("text-muted-foreground", className)}>без срока</span>;
  const late = isOverdue(task);
  return (
    <span
      className={cn(late && "font-medium text-destructive", className)}
      title={late ? "Просрочена" : undefined}
    >
      {formatDeadline(task.deadline, tz)}
    </span>
  );
}

/** Проект задачи: цветная точка и название. */
export function ProjectTag({
  project,
  className,
}: {
  project: { title: string; color: string | null };
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: project.color ?? "var(--muted-foreground)" }}
      />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

export function UrgentMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive",
        className,
      )}
    >
      <AlertTriangle className="size-3" /> Срочно
    </span>
  );
}

export function PersonLine({
  id,
  size = "sm",
  className,
}: {
  id: string | null | undefined;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { name, person } = usePeople();
  if (!id) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <StaffAvatar
        value={person(id)?.avatar_url ?? null}
        name={name(id)}
        className={size === "xs" ? "size-6 text-[9px]" : "size-7 text-[10px]"}
      />
      <span className="truncate">{name(id)}</span>
    </span>
  );
}

/** Выбор людей: чипы и «Добавить» (окно со справочником «Компании»). */
export function PeopleField({
  value,
  onChange,
  single = false,
  exclude = [],
  addLabel = "Добавить",
  disabled = false,
  id,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  exclude?: string[];
  addLabel?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const { name } = usePeople();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((uid) => (
        <span
          key={uid}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pr-1 pl-0.5 text-sm"
        >
          <PersonLine id={uid} size="xs" />
          {!disabled && (
            <button
              type="button"
              aria-label={`Убрать: ${name(uid)}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onChange(value.filter((x) => x !== uid))}
            >
              <X className="size-3.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button id={id} variant="outline" size="sm" className="h-8">
              <Plus className="size-4" />
              {single && value.length ? "Сменить" : addLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
            <PeoplePicker
              selected={value}
              exclude={exclude}
              single={single}
              onToggle={(uid) => {
                if (single) {
                  onChange([uid]);
                  setOpen(false);
                } else {
                  onChange(value.includes(uid) ? value.filter((x) => x !== uid) : [...value, uid]);
                }
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/**
 * Кто из выбранных людей не на месте с сегодня до срока (бриф 8.8: «при
 * постановке задачи видеть, кто в отпуске»).
 */
export function AbsentNote({
  ids,
  until,
  className,
}: {
  ids: string[];
  /** Срок задачи (ISO) — до какого дня смотреть; нет — только сегодня. */
  until?: string | null;
  className?: string;
}) {
  const { name } = usePeople();
  const today = useTodayISO();
  const list = useAbsences();
  const to = until ? localISO(new Date(until)) : today;
  const away = ids
    .map((id) => ({ id, a: absenceOn(list, id, today, to < today ? today : to) }))
    .filter((x) => x.a);
  if (away.length === 0) return null;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
        className,
      )}
    >
      <CalendarOff className="mt-0.5 size-4 shrink-0" />
      <span>
        {away.map((x, i) => (
          <span key={x.id}>
            {i > 0 && "; "}
            {name(x.id)} — {absenceText(x.a!, today)}
          </span>
        ))}
      </span>
    </div>
  );
}
