/**
 * Человек портала: аватарка и имя, по нажатию — карточка сотрудника
 * (решение владельца 2026-10-27). Одинаково в упоминаниях «@», у автора
 * статьи и в списках людей. В карточке — «Написать», «Задача» (поставить
 * ему задачу) и «Встреча» (новое событие календаря с ним), отсутствие
 * сейчас или ближайшее. Данные — lib/people.ts.
 */
import { lazy, Suspense, useState } from "react";
import {
  Building2,
  Cake,
  CalendarDays,
  CalendarOff,
  CheckSquare,
  Copy,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Users,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { chatErrorText, openDirect } from "@/lib/chats/data";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StatusChip } from "@/components/ui/status-chip";
import { MEMBER_ROLE_LABEL, USER_TYPE_LABEL } from "@/lib/access/logic";
import { CLUB_ROLE_LABEL, usePersonCard, usePersonShort } from "@/lib/people";
import { absenceOn, absenceText, addDaysISO, dayMonth } from "@/lib/people-calendar";
import { birthdayQuery, useAbsences, useTodayISO } from "@/lib/people-calendar-data";
import { cn } from "@/lib/utils";

// Форма задачи — только по «Задача»: карточка есть почти везде, тянуть форму в каждый раздел незачем.
const NewTaskDialog = lazy(() =>
  import("@/components/tasks/task-form").then((m) => ({ default: m.NewTaskDialog })),
);

/** Нажимаемая обёртка: по нажатию — карточка сотрудника. */
export function PersonButton({
  userId,
  className,
  children,
}: {
  userId: string | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!userId) return <span className={className}>{children}</span>;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Строка таблицы или упоминание в тексте не должны получить нажатие.
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          "cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </button>
      <PersonCardDialog userId={open ? userId : null} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * Аватарка и имя одной строкой, нажимается. Имя и аватарку можно передать
 * (уже есть в строке списка), иначе — из people_cards.
 */
export function PersonChip({
  userId,
  name,
  avatar,
  size = "sm",
  className,
}: {
  userId: string | null | undefined;
  name?: string | null;
  avatar?: string | null;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const known = name !== undefined && avatar !== undefined;
  const { data } = usePersonShort(known ? null : userId);
  const label = name || data?.full_name || "Сотрудник";
  return (
    <PersonButton
      userId={userId}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-2 hover:underline", className)}
    >
      <StaffAvatar
        value={known ? avatar : data?.avatar_url}
        name={label}
        className={cn(
          "shrink-0",
          size === "xs" && "size-5 text-[9px]",
          size === "sm" && "size-7 text-xs",
          size === "md" && "size-10 text-sm",
        )}
      />
      <span className="truncate font-medium">{label}</span>
    </PersonButton>
  );
}

/** Карточка сотрудника компании; `userId` null — окно закрыто. */
export function PersonCardDialog({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!userId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        {userId && <PersonCardBody userId={userId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function PersonCardBody({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { data: card, isLoading } = usePersonCard(userId);
  if (isLoading) {
    return (
      <div>
        <DialogTitle className="sr-only">Сотрудник</DialogTitle>
        <div className="flex flex-col items-center gap-3 border-b bg-muted/40 px-6 pt-8 pb-5">
          <Skeleton className="size-20 rounded-full" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-10 w-28 rounded-full" />
            <Skeleton className="h-10 w-24 rounded-full" />
            <Skeleton className="h-10 w-24 rounded-full" />
          </div>
        </div>
        <div className="space-y-4 px-6 py-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }
  if (!card) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <DialogTitle className="mb-1 text-base text-foreground">Сотрудник</DialogTitle>
        Этого человека больше нет в портале.
      </div>
    );
  }
  const name = card.full_name || "Сотрудник";
  const sub = [card.position_name, card.user_type ? USER_TYPE_LABEL[card.user_type] : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="overflow-y-auto">
      <div className="flex flex-col items-center gap-3 border-b bg-muted/40 px-6 pt-8 pb-5 text-center">
        <StaffAvatar value={card.avatar_url} name={name} className="size-20 text-2xl" />
        <div className="min-w-0">
          <DialogTitle className="text-lg font-semibold">{name}</DialogTitle>
          {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
        </div>
        <PersonStatusLine userId={userId} />
        {(card.blocked || !card.active) && (
          <StatusChip tone="neutral">
            {card.blocked ? "Заблокирован" : "Нет доступа к порталу"}
          </StatusChip>
        )}
        {card.active && !card.blocked && <PersonActions userId={userId} onDone={onClose} />}
      </div>
      <div className="space-y-4 px-6 py-5 text-sm">
        {(card.email || card.phone) && (
          <Section title="Контакты">
            {card.email && <Contact icon={Mail} value={card.email} href={`mailto:${card.email}`} />}
            {card.phone && (
              <Contact
                icon={Phone}
                value={card.phone}
                href={`tel:${card.phone.replace(/[^\d+]/g, "")}`}
              />
            )}
          </Section>
        )}
        {card.units.length > 0 && (
          <Section title="Подразделения" icon={Users}>
            {card.units.map((u) => (
              <Line key={u.name} label={u.name} value={MEMBER_ROLE_LABEL[u.role]} />
            ))}
          </Section>
        )}
        {(card.clubs.length > 0 || card.owned_clubs.length > 0) && (
          <Section title="Клубы" icon={Building2}>
            {card.owned_clubs.map((c) => (
              <Line key={`own-${c}`} label={c} value="Собственник" />
            ))}
            {card.clubs
              .filter((c) => !card.owned_clubs.includes(c.name))
              .map((c) => (
                <Line
                  key={c.name}
                  label={c.name}
                  value={c.role === "owner" ? "Собственник" : CLUB_ROLE_LABEL[c.role]}
                />
              ))}
          </Section>
        )}
        {!card.email &&
          !card.phone &&
          card.units.length === 0 &&
          card.clubs.length === 0 &&
          card.owned_clubs.length === 0 && (
            <p className="text-muted-foreground">Других сведений о сотруднике пока нет.</p>
          )}
      </div>
    </div>
  );
}

/** «В отпуске до 15 ноября» (или ближайшее за месяц), «День рождения — 12 ноября». */
function PersonStatusLine({ userId }: { userId: string }) {
  const today = useTodayISO();
  const absence = absenceOn(useAbsences(), userId, today, addDaysISO(today, 30));
  const { data: bd } = useQuery(birthdayQuery(userId));
  if (!absence && !bd?.day) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2 text-xs">
      {absence && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800">
          <CalendarOff className="size-3.5" /> {absenceText(absence, today)}
        </span>
      )}
      {bd?.day && (
        <span className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-muted-foreground">
          <Cake className="size-3.5" /> {dayMonth(bd.day)}
        </span>
      )}
    </div>
  );
}

/**
 * Действия карточки: «Написать» — личный чат, «Задача» — поставить задачу
 * этому человеку, «Встреча» — новое событие календаря с ним.
 */
function PersonActions({ userId, onDone }: { userId: string; onDone: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useStaffProfile();
  const [busy, setBusy] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const self = me?.id === userId;
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const chatId = await openDirect(userId);
            await qc.invalidateQueries({ queryKey: ["chat_list"] });
            onDone();
            void navigate({ to: "/chats/$chatId", params: { chatId } });
          } catch (e) {
            toast.error(chatErrorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <MessageCircle />}
        {self ? "Избранное" : "Написать"}
      </Button>
      {!self && (
        <>
          <Button variant="outline" title="Поставить задачу" onClick={() => setTaskOpen(true)}>
            <CheckSquare /> Задача
          </Button>
          <Button
            variant="outline"
            title="Новое событие в календаре с этим сотрудником"
            onClick={() => {
              onDone();
              void navigate({ to: "/calendar", search: { new: true, with: userId } });
            }}
          >
            <CalendarDays /> Встреча
          </Button>
          {taskOpen && (
            <Suspense fallback={null}>
              <NewTaskDialog open onClose={() => setTaskOpen(false)} initialAssignee={userId} />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof Users;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {title}
      </h3>
      <div className="divide-y rounded-md border">{children}</div>
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

function Contact({ icon: Icon, value, href }: { icon: typeof Mail; value: string; href: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <a href={href} className="min-w-0 flex-1 truncate hover:underline">
        {value}
      </a>
      <button
        type="button"
        aria-label="Скопировать"
        title="Скопировать"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => toast.success("Скопировано"),
            () => toast.error("Не удалось скопировать"),
          )
        }
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}
