/**
 * Человек портала: аватарка и имя, по нажатию — карточка сотрудника
 * (решение владельца 2026-10-27). Одинаково в упоминаниях «@», у автора
 * статьи и в списках людей. Данные — lib/people.ts.
 */
import { useState } from "react";
import { Building2, Copy, Loader2, Mail, Phone, Users } from "lucide-react";
import { toast } from "sonner";

import { StaffAvatar } from "@/components/employee-photo";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StatusChip } from "@/components/ui/status-chip";
import { MEMBER_ROLE_LABEL, USER_TYPE_LABEL } from "@/lib/access/logic";
import { CLUB_ROLE_LABEL, usePersonCard, usePersonShort } from "@/lib/people";
import { cn } from "@/lib/utils";

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
        {userId && <PersonCardBody userId={userId} />}
      </DialogContent>
    </Dialog>
  );
}

function PersonCardBody({ userId }: { userId: string }) {
  const { data: card, isLoading } = usePersonCard(userId);
  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        <DialogTitle className="sr-only">Сотрудник</DialogTitle>
        <Loader2 className="mr-2 size-4 animate-spin" /> Загружаем…
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
        {(card.blocked || !card.active) && (
          <StatusChip tone="neutral">
            {card.blocked ? "Заблокирован" : "Нет доступа к порталу"}
          </StatusChip>
        )}
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
                <Line key={c.name} label={c.name} value={CLUB_ROLE_LABEL[c.role]} />
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
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
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
