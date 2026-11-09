/**
 * «Компания» → «Дни рождения» (TASKS_CHATS_PLAN.md, этап 2, бриф 3.7):
 * сегодня и ближайшие 30 дней, «Поздравить» — личный чат; свой день
 * рождения — сверху: день и месяц, год видят коллеги только с «Показывать
 * год». Указать дату коллеге — его руководитель или тот, кто управляет
 * пользователями (проверяет база; кнопку видят только они).
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cake, Loader2, MessageCircle, Pencil } from "lucide-react";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { useTaskCounters } from "@/lib/tasks/data";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  year: "Без этого коллеги видят только день и месяц; возраст — тоже нет.",
};

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const daysIn = (month: number, year?: number) =>
  new Date(Date.UTC(year && year > 1900 ? year : 2024, month, 0)).getUTCDate();

export function BirthdaysPage() {
  const { data: me } = useStaffProfile();
  const today = useTodayISO();
  const navigate = useNavigate();
  const { name, person } = usePeople();
  const { data: list = [], isPending } = useQuery(birthdaysQuery(30));
  const [editing, setEditing] = useState<string | "pick" | null>(null);
  const access = useAdminAccess();
  const { leader } = useTaskCounters();
  // Дату коллеге ставит руководитель или управляющий пользователями — база
  // проверит конкретного человека, но кнопку видят только они.
  const canEditOthers = hasRight(access, "users.manage") || !!leader;

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
            {canEditOthers && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setEditing("pick")}
              >
                <Pencil /> Указать дату коллеге
              </Button>
            )}
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
                        aria-label={`Поздравить: ${name(b.user_id)}`}
                        title="Поздравить — личный чат"
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
        <div className="text-sm text-muted-foreground">
          {isPending ? (
            <Skeleton className="mt-1 h-4 w-48" />
          ) : data?.day ? (
            `${dayMonth(data.day)}${data.year && data.show_year ? ` ${data.year}` : ""}${
              data.show_year ? "" : " · год видите только вы"
            }`
          ) : (
            "Не указан — коллеги не узнают, когда поздравить"
          )}
        </div>
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
  const [y0, m0, d0] = initialDate ? initialDate.split("-") : ["", "", ""];
  const [day, setDay] = useState(d0 ? String(Number(d0)) : "");
  const [month, setMonth] = useState(m0 ? String(Number(m0)) : "");
  const [year, setYear] = useState(y0);
  const [showYear, setShowYear] = useState(initialShowYear);
  const [errors, setErrors] = useState<{ user?: string; date?: string; year?: string }>({});
  const [busy, setBusy] = useState(false);
  const thisYear = new Date().getFullYear();
  const maxDay = month ? daysIn(Number(month), Number(year) || undefined) : 31;

  const run = async (remove: boolean) => {
    let value: string | null = null;
    if (!remove) {
      const e: typeof errors = {};
      if (!userId) e.user = "Выберите сотрудника";
      if (!day || !month) e.date = "Выберите день и месяц";
      const y = Number(year);
      if (!year) e.year = "Укажите год";
      else if (!Number.isInteger(y) || y < 1900 || y > thisYear) e.year = "Проверьте год";
      else if (day && month && Number(day) > daysIn(Number(month), y)) e.date = "Такого дня нет";
      if (Object.keys(e).length) {
        setErrors(e);
        return;
      }
      value = `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
    setBusy(true);
    try {
      await onSave(value, showYear);
      toast.success(value ? "Сохранено" : "Дата убрана");
      onClose();
    } catch (e) {
      toast.error(peopleErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm onSubmit={() => void run(false)}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>{own ? "Мой день рождения" : "День рождения сотрудника"}</DialogTitle>
        <DialogDescription>
          {own
            ? "Коллеги по подразделению утром в этот день получат напоминание поздравить вас."
            : "Коллеги этого сотрудника по подразделению утром в этот день получат напоминание поздравить."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {onUser && (
          <FormField label="Сотрудник" required htmlFor={null} error={errors.user}>
            <PeopleField
              single
              value={userId ? [userId] : []}
              onChange={(ids) => {
                onUser(ids[0] ?? null);
                setErrors((x) => ({ ...x, user: undefined }));
              }}
              addLabel="Выбрать"
            />
          </FormField>
        )}
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            <FormField label="День и месяц" required htmlFor={null} error={errors.date}>
              <div className="flex gap-2">
                <Select
                  value={day}
                  onValueChange={(v) => {
                    setDay(v);
                    setErrors((x) => ({ ...x, date: undefined }));
                  }}
                >
                  <SelectTrigger aria-label="День" className="w-24">
                    <SelectValue placeholder="День" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                      <SelectItem key={d} value={d} disabled={Number(d) > maxDay}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={month}
                  onValueChange={(v) => {
                    setMonth(v);
                    setErrors((x) => ({ ...x, date: undefined }));
                  }}
                >
                  <SelectTrigger aria-label="Месяц" className="min-w-0 flex-1">
                    <SelectValue placeholder="Месяц" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </FormField>
            <FormField
              label="Год"
              required
              htmlFor="birthday-year"
              error={errors.year}
              hint="Год нужен, чтобы сохранить дату. Коллеги его не увидят, пока не включите «Показывать год и возраст»."
            >
              <Input
                id="birthday-year"
                inputMode="numeric"
                maxLength={4}
                className="w-28"
                placeholder="1990"
                value={year}
                onChange={(e) => {
                  setYear(e.target.value.replace(/\D/g, ""));
                  setErrors((x) => ({ ...x, year: undefined }));
                }}
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
            onClick={() => void run(true)}
          >
            Убрать дату
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy || loading}>
          {busy && <Loader2 className="animate-spin" />} Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
