/**
 * «Компания» → «Дни рождения» (TASKS_CHATS_PLAN.md, этап 2, бриф 3.7):
 * сегодня и ближайшие 30 дней, «Поздравить» — личный чат; свой день
 * рождения — сверху (год — по желанию). Указать дату коллеге — его
 * руководитель или тот, кто управляет пользователями (проверяет база).
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cake, Loader2, MessageCircle, Pencil } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
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
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { chatErrorText, openDirect } from "@/lib/chats/data";
import { usePeople } from "@/lib/chats/people";
import { ageText, birthdayWhen, dayMonth } from "@/lib/people-calendar";
import {
  birthdayQuery,
  birthdaysQuery,
  peopleErrorText,
  saveBirthday,
  useTodayISO,
} from "@/lib/people-calendar-data";
import { cn } from "@/lib/utils";

const TIPS = {
  year: "Без года коллеги видят только день и месяц; возраст — тоже нет.",
};

export function BirthdaysPage() {
  const { data: me } = useStaffProfile();
  const today = useTodayISO();
  const navigate = useNavigate();
  const { name, person } = usePeople();
  const { data: list = [], isPending } = useQuery(birthdaysQuery(30));
  const [editing, setEditing] = useState<string | "pick" | null>(null);

  const congratulate = async (userId: string) => {
    try {
      const chatId = await openDirect(userId);
      void navigate({ to: "/chats/$chatId", params: { chatId } });
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  return (
    <AdminShell title="Дни рождения">
      <div className="max-w-3xl space-y-4">
        {me?.id && <MyBirthday userId={me.id} onEdit={() => setEditing(me.id)} />}
        <section className="rounded-lg border bg-background">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <h2 className="font-semibold">Ближайшие 30 дней</h2>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setEditing("pick")}
            >
              <Pencil className="size-4" /> Указать дату коллеге
            </Button>
          </div>
          {isPending ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              В ближайший месяц дней рождения нет — или коллеги их не указали.
            </p>
          ) : (
            <ul className="divide-y">
              {list.map((b) => {
                const isToday = b.date === today;
                return (
                  <li
                    key={b.user_id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5",
                      isToday && "bg-amber-50/70 dark:bg-amber-950/20",
                    )}
                  >
                    <PersonButton
                      userId={b.user_id}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <StaffAvatar
                        value={person(b.user_id)?.avatar_url ?? null}
                        name={name(b.user_id)}
                        className="size-9 text-xs"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {name(b.user_id)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {person(b.user_id)?.position_name ?? ""}
                        </span>
                      </span>
                    </PersonButton>
                    <span
                      className={cn(
                        "shrink-0 text-right text-sm",
                        isToday && "font-semibold text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {isToday && <Cake className="mr-1 inline size-4" />}
                      {birthdayWhen(b.date, today)}
                      {b.age != null && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {ageText(b.age)}
                        </span>
                      )}
                    </span>
                    {b.user_id !== me?.id && (
                      <Button
                        size="sm"
                        variant={isToday ? "default" : "outline"}
                        className="shrink-0"
                        onClick={() => void congratulate(b.user_id)}
                      >
                        <MessageCircle className="size-4" />
                        <span className="max-sm:hidden">Поздравить</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <BirthdayDialog target={editing} onClose={() => setEditing(null)} />
    </AdminShell>
  );
}

function MyBirthday({ userId, onEdit }: { userId: string; onEdit: () => void }) {
  const { data, isPending } = useQuery(birthdayQuery(userId));
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border bg-background px-4 py-3">
      <Cake className="size-5 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Мой день рождения</p>
        <p className="text-sm text-muted-foreground">
          {isPending
            ? "…"
            : data?.day
              ? `${dayMonth(data.day)}${data.year && data.show_year ? ` ${data.year}` : ""}${
                  data.show_year ? "" : " · год видите только вы"
                }`
              : "Не указан — коллеги не узнают, когда поздравить"}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onEdit}>
        {data?.day ? "Изменить" : "Указать"}
      </Button>
    </section>
  );
}

function BirthdayDialog({
  target,
  onClose,
}: {
  target: string | "pick" | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {target && <BirthdayForm key={target} target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BirthdayForm({ target, onClose }: { target: string | "pick"; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: me } = useStaffProfile();
  const [userId, setUserId] = useState<string | null>(target === "pick" ? null : target);
  const { data, isPending } = useQuery({ ...birthdayQuery(userId ?? ""), enabled: !!userId });
  const own = userId === me?.id;
  return (
    <BirthdayFields
      key={`${userId}:${data?.day ?? ""}:${data?.year ?? ""}`}
      own={own}
      userId={userId}
      onUser={target === "pick" ? setUserId : undefined}
      loading={!!userId && isPending}
      initialDate={data?.day && data.year ? `${data.year}-${data.day}` : ""}
      initialShowYear={data?.show_year ?? false}
      hasDate={!!data?.day}
      onClose={onClose}
      onSave={(date, showYear) => saveBirthday(qc, userId!, date, showYear)}
    />
  );
}

function BirthdayFields({
  own,
  userId,
  onUser,
  loading,
  initialDate,
  initialShowYear,
  hasDate,
  onClose,
  onSave,
}: {
  own: boolean;
  userId: string | null;
  onUser?: (id: string | null) => void;
  loading: boolean;
  initialDate: string;
  initialShowYear: boolean;
  hasDate: boolean;
  onClose: () => void;
  onSave: (date: string | null, showYear: boolean) => Promise<void>;
}) {
  const [date, setDate] = useState(initialDate);
  const [showYear, setShowYear] = useState(initialShowYear);
  const [busy, setBusy] = useState(false);
  const run = async (value: string | null) => {
    if (!userId) {
      toast.error("Выберите сотрудника");
      return;
    }
    if (value !== null && !value) {
      toast.error("Укажите дату");
      return;
    }
    setBusy(true);
    try {
      await onSave(value, showYear);
      toast.success(value ? "Сохранено" : "Убрано");
      onClose();
    } catch (e) {
      toast.error(peopleErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm onSubmit={() => void run(date)}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{own ? "Мой день рождения" : "День рождения сотрудника"}</DialogTitle>
        <DialogDescription>
          Коллеги по подразделению получат утром напоминание поздравить.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {onUser && (
          <FormField label="Сотрудник" required htmlFor={null}>
            <PeopleField
              single
              value={userId ? [userId] : []}
              onChange={(ids) => onUser(ids[0] ?? null)}
              addLabel="Выбрать"
            />
          </FormField>
        )}
        {loading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <FormField label="Дата рождения" required htmlFor="birthday-date">
              <Input
                id="birthday-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </FormField>
            <SwitchRow
              title="Показывать год и возраст"
              tip={TIPS.year}
              checked={showYear}
              onCheckedChange={setShowYear}
            />
          </>
        )}
      </DialogBody>
      <DialogFooter className="items-center">
        {hasDate && (
          <Button
            variant="ghost"
            className="mr-auto text-destructive"
            disabled={busy}
            onClick={() => void run(null)}
          >
            Убрать дату
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy || loading}>
          {busy && <Loader2 className="size-4 animate-spin" />} Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
