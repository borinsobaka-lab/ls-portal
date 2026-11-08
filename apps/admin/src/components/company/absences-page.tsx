/**
 * «Компания» → «Отсутствия» (TASKS_CHATS_PLAN.md, этап 2, бриф 8.8): кто
 * сейчас не на месте и кто уйдёт в ближайшие 90 дней — отпуск, больничный,
 * командировка, отгул. Добавить — себе; руководитель — своим людям,
 * управляющий пользователями — любому (проверяет база). Те же отсутствия
 * видны в карточке сотрудника и при постановке задачи.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import type { StatusTone } from "@/components/ui/status-chip-styles";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { usePeople } from "@/lib/chats/people";
import {
  ABSENCE_KIND_LABEL,
  absencePeriod,
  addDaysISO,
  type Absence,
  type AbsenceKind,
} from "@/lib/people-calendar";
import {
  absencesQuery,
  deleteAbsence,
  peopleErrorText,
  saveAbsence,
  useTodayISO,
} from "@/lib/people-calendar-data";

const KIND_TONE: Record<AbsenceKind, StatusTone> = {
  vacation: "positive",
  sick: "negative",
  trip: "info",
  dayoff: "warning",
  other: "neutral",
};

const period = (a: Absence) => absencePeriod(a.starts_on, a.ends_on);

export function AbsencesPage() {
  const qc = useQueryClient();
  const today = useTodayISO();
  const { data: list = [], isPending } = useQuery(absencesQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Absence | "new" | null>(null);
  const now = useMemo(
    () => list.filter((a) => a.starts_on <= today && a.ends_on >= today),
    [list, today],
  );
  const soon = useMemo(() => list.filter((a) => a.starts_on > today), [list, today]);

  const remove = async (a: Absence) => {
    if (!(await confirm({ title: "Удалить отсутствие?", confirmLabel: "Удалить" }))) return;
    void deleteAbsence(qc, a.id).catch((e) => toast.error(peopleErrorText(e)));
  };

  return (
    <AdminShell
      title="Отсутствия"
      actions={
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" /> Добавить отсутствие
        </Button>
      }
    >
      <div className="max-w-3xl space-y-4">
        <AbsenceSection
          title="Сейчас нет на месте"
          empty="Сегодня все на месте"
          list={now}
          pending={isPending}
          onEdit={setEditing}
          onRemove={(a) => void remove(a)}
        />
        <AbsenceSection
          title="Скоро — ближайшие 90 дней"
          empty="Пока никто не планирует"
          list={soon}
          pending={isPending}
          onEdit={setEditing}
          onRemove={(a) => void remove(a)}
        />
      </div>
      <AbsenceDialog value={editing} today={today} onClose={() => setEditing(null)} />
      {confirmDialog}
    </AdminShell>
  );
}

function AbsenceSection({
  title,
  empty,
  list,
  pending,
  onEdit,
  onRemove,
}: {
  title: string;
  empty: string;
  list: Absence[];
  pending: boolean;
  onEdit: (a: Absence) => void;
  onRemove: (a: Absence) => void;
}) {
  const { name, person } = usePeople();
  return (
    <section className="rounded-lg border bg-background">
      <h2 className="border-b px-4 py-3 font-semibold">{title}</h2>
      {pending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <PersonButton
                userId={a.user_id}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <StaffAvatar
                  value={person(a.user_id)?.avatar_url ?? null}
                  name={name(a.user_id)}
                  className="size-9 text-xs"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{name(a.user_id)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {a.note || person(a.user_id)?.position_name || ""}
                  </span>
                </span>
              </PersonButton>
              <StatusChip tone={KIND_TONE[a.kind]} size="sm">
                {ABSENCE_KIND_LABEL[a.kind]}
              </StatusChip>
              <span className="w-36 shrink-0 text-right text-sm tabular-nums max-sm:w-auto">
                {period(a)}
              </span>
              {a.can_edit && (
                <span className="flex shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Изменить"
                    onClick={() => onEdit(a)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive"
                    aria-label="Удалить"
                    onClick={() => onRemove(a)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AbsenceDialog({
  value,
  today,
  onClose,
}: {
  value: Absence | "new" | null;
  today: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {value && (
          <AbsenceForm
            key={value === "new" ? "new" : value.id}
            value={value}
            today={today}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AbsenceForm({
  value,
  today,
  onClose,
}: {
  value: Absence | "new";
  today: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: me } = useStaffProfile();
  const a = value === "new" ? null : value;
  const [userId, setUserId] = useState<string | null>(a?.user_id ?? me?.id ?? null);
  const [kind, setKind] = useState<AbsenceKind>(a?.kind ?? "vacation");
  const [from, setFrom] = useState(a?.starts_on ?? today);
  const [to, setTo] = useState(a?.ends_on ?? addDaysISO(today, 6));
  const [note, setNote] = useState(a?.note ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!userId) {
          toast.error("Выберите сотрудника");
          return;
        }
        if (!from || !to || to < from) {
          toast.error("«По» — не раньше «С»");
          return;
        }
        setBusy(true);
        try {
          await saveAbsence(qc, {
            id: a?.id,
            user_id: userId,
            kind,
            starts_on: from,
            ends_on: to,
            note,
          });
          toast.success("Сохранено");
          onClose();
        } catch (e) {
          toast.error(peopleErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{a ? "Отсутствие" : "Новое отсутствие"}</DialogTitle>
        <DialogDescription>
          Коллеги увидят это в «Компании», в карточке и при постановке задачи.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField
          label="Кто"
          required
          htmlFor={null}
          hint="Себе — всегда; руководитель — своим людям"
        >
          <PeopleField
            single
            value={userId ? [userId] : []}
            onChange={(ids) => setUserId(ids[0] ?? null)}
          />
        </FormField>
        <FormField label="Что" required>
          <Select value={kind} onValueChange={(v) => setKind(v as AbsenceKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ABSENCE_KIND_LABEL) as AbsenceKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {ABSENCE_KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="С" required htmlFor="absence-from">
            <Input
              id="absence-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </FormField>
          <FormField label="По" required htmlFor="absence-to">
            <Input
              id="absence-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Заметка" optional hint="Видят только те, кто может править">
          <Input
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Например: на связи в Telegram"
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />} Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
