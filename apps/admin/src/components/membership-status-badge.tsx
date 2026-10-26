import { useActiveStudio } from "@/hooks/use-studios";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import {
  MEMBERSHIP_STATUS_LABEL,
  effectiveStatus,
  type MembershipStatusInput,
} from "@/lib/membership-status";

// Статусы и effectiveStatus — lib/membership-status.ts (их проверяют тесты).

const TONE: Record<string, StatusTone> = {
  active: "positive",
  frozen: "info",
  pending: "info",
  awaiting: "info",
  replaced: "neutral",
  expired: "neutral",
  cancelled: "negative",
  refunded: "negative",
};

export function MembershipStatusBadge({ m }: { m: MembershipStatusInput }) {
  const s = effectiveStatus(m);
  return <StatusChip tone={TONE[s] ?? "neutral"}>{MEMBERSHIP_STATUS_LABEL[s] ?? s}</StatusChip>;
}

/** У пакетов тренировок автопродления нет — в пакетной студии бейдж не нужен. */
export function AutoRenewBadge({ on }: { on: boolean | null | undefined }) {
  const format = useActiveStudio()?.format;
  if (format === "packages") return null;
  return (
    <StatusChip tone={on ? "info" : "neutral"}>
      {on ? "Автопродление: вкл" : "Автопродление: выкл"}
    </StatusChip>
  );
}
