import type * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusChip } from "@/components/ui/status-chip";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TRAINER_ROLES, type TrainerRole } from "@/lib/staff-directory";
import { useStorageUrl } from "@/lib/storage";

/** Фото сотрудника справочника (бакет trainer-photos), без фото — инициалы. */
export function EmployeePhoto({
  value,
  name,
  className,
}: {
  value: string | null;
  name: string;
  className?: string;
}) {
  const src = useStorageUrl("trainers", value);
  return (
    <Avatar className={className}>
      {src && <AvatarImage src={src} alt={name} />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** Аватарка учётной записи сотрудника (profiles.avatar_url, бакет avatars), без неё — инициалы. */
export function StaffAvatar({
  value,
  name,
  className,
}: {
  value: string | null | undefined;
  name: string;
  className?: string;
}) {
  const src = useStorageUrl("avatars", value);
  return (
    <Avatar className={className}>
      {src && <AvatarImage src={src} alt={name} />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Сотрудник в выпадающем списке — аватарка и имя (решение владельца
 * 2026-10-11: во всех списках сотрудников админки, так проще найти глазами).
 * `photo` — фото из справочника «Сотрудники» (trainers.photo_url); у учётных
 * записей админки (касса) — `avatar` (profiles.avatar_url). Видно и в
 * закрытом поле: SelectValue повторяет содержимое пункта.
 */
export function StaffOption({
  name,
  photo,
  avatar,
  children,
}: {
  name: string;
  photo?: string | null;
  avatar?: string | null;
  /** Подпись вместо имени (например, «Имя (вы)»). */
  children?: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {avatar !== undefined ? (
        <StaffAvatar value={avatar} name={name} className="size-5 shrink-0 text-xs" />
      ) : (
        <EmployeePhoto value={photo ?? null} name={name} className="size-5 shrink-0 text-xs" />
      )}
      <span className="truncate">{children ?? name}</span>
    </span>
  );
}

export function TrainerRoleBadge({ role }: { role: TrainerRole }) {
  const r = TRAINER_ROLES[role] ?? TRAINER_ROLES.trainer;
  return (
    // Роль — не статус и не оценка: нейтральная метка (system.md, «Чипы и
    // бейджи»). Свои цвета ролей (голубой, фиолетовый, зелёный) спорили со
    // статусами в той же строке — зелёный «Массажист» читался как «Активен».
    <StatusChip tone="neutral">{r.label}</StatusChip>
  );
}
