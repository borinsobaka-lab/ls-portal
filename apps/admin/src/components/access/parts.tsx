import { StaffAvatar } from "@/components/employee-photo";
import { StatusChip } from "@/components/ui/status-chip";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_TONE, type UserStatusKey } from "@/lib/access/logic";

export function UserStatusChip({ status }: { status: UserStatusKey }) {
  return <StatusChip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusChip>;
}

/** Роль — точкой цвета и названием. */
export function RoleChip({
  name,
  color,
  muted,
  className,
}: {
  name: string;
  color: string | null | undefined;
  /** Не действует сейчас (срок) или унаследована. */
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs font-medium",
        muted && "border-dashed text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "#94a3b8" }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function PersonLine({
  name,
  email,
  avatar,
  className,
}: {
  name: string | null;
  email?: string | null;
  avatar: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <StaffAvatar value={avatar} name={name ?? email ?? ""} className="size-8 shrink-0 text-xs" />
      <div className="min-w-0">
        <div className="truncate font-medium">{name || email || "—"}</div>
        {email && name && <div className="truncate text-xs text-muted-foreground">{email}</div>}
      </div>
    </div>
  );
}

/** Секция карточки: заголовок, пояснение, действие справа. */
export function AccessSection({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3 rounded-lg border bg-background p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
